const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const { Piece } = require('./piece');
const { MESSAGE_TYPES } = require('./peerConnection');

class DownloadManager extends EventEmitter {
  constructor(options) {
    super();

    this.torrent = options.torrent;
    this.peerManager = options.peerManager;
    this.downloadPath = options.downloadPath;
    this.maxActiveRequests = options.maxActiveRequests || 5;

    this.pieces = [];
    this.activePieces = new Map();
    this.completedPieces = new Set();
    this.pendingRequests = new Map();
    
    this.downloadedBytes = 0;
    this.isComplete = false;
    this.isPaused = false;
    this.isRunning = false;

    this.downloadStartTime = null;
    this.lastProgressUpdate = 0;

    this._initializePieces();
    this._setupPeerListeners();
  }

  _initializePieces() {
    const numPieces = this.torrent.pieces.length;
    const pieceLength = this.torrent.pieceLength;
    const totalLength = this.torrent.length;

    for (let i = 0; i < numPieces; i++) {
      const isLastPiece = i === numPieces - 1;
      const length = isLastPiece ? totalLength - (i * pieceLength) : pieceLength;
      
      this.pieces.push(null); // Lazy initialization
    }
  }

  _setupPeerListeners() {
    this.peerManager.on('peer:connected', (peer) => {
      console.log(`[DownloadManager] Peer connected: ${peer.ip}:${peer.port}`);
      
      // Send our bitfield to the peer
      const bitfield = this.getBitfield();
      if (this.completedPieces.size > 0) {
        try {
          peer.sendBitfield(bitfield);
          console.log(`[DownloadManager] Sent bitfield to ${peer.ip}:${peer.port}`);
        } catch (error) {
          console.error(`[DownloadManager] Failed to send bitfield: ${error.message}`);
        }
      }

      // Send interested message
      try {
        peer.sendInterested();
        console.log(`[DownloadManager] Sent interested to ${peer.ip}:${peer.port}`);
      } catch (error) {
        console.error(`[DownloadManager] Failed to send interested: ${error.message}`);
      }

      // Request blocks if we're running
      if (this.isRunning && !this.isPaused) {
        setImmediate(() => this.requestBlocks());
      }
    });

    this.peerManager.on('peer:message', ({ connection: peer, message }) => {
      try {
        switch (message.id) {
          case MESSAGE_TYPES.BITFIELD:
            this.handleBitfieldMessage(peer, message.payload);
            break;

          case MESSAGE_TYPES.HAVE:
            this.handleHaveMessage(peer, message.pieceIndex);
            break;

          case MESSAGE_TYPES.UNCHOKE:
            console.log(`[DownloadManager] Peer ${peer.ip}:${peer.port} unchoked us`);
            peer.peerChoking = false;
            // Peer unchoked us, we can now request pieces
            if (this.isRunning && !this.isPaused) {
              setImmediate(() => this.requestBlocks());
            }
            break;

          case MESSAGE_TYPES.CHOKE:
            console.log(`[DownloadManager] Peer ${peer.ip}:${peer.port} choked us`);
            peer.peerChoking = true;
            // Peer choked us, cancel pending requests to this peer
            this.cancelPeerRequests(peer);
            break;

          case MESSAGE_TYPES.PIECE:
            this.handlePieceMessage(peer, message.index, message.begin, message.block);
            break;

          case MESSAGE_TYPES.INTERESTED:
            console.log(`[DownloadManager] Peer ${peer.ip}:${peer.port} is interested`);
            peer.peerInterested = true;
            break;

          case MESSAGE_TYPES.NOT_INTERESTED:
            console.log(`[DownloadManager] Peer ${peer.ip}:${peer.port} is not interested`);
            peer.peerInterested = false;
            break;

          default:
            // Other message types handled elsewhere or ignored
            break;
        }
      } catch (error) {
        console.error(`[DownloadManager] Error handling message from ${peer.ip}:${peer.port}: ${error.message}`);
      }
    });

    this.peerManager.on('peer:disconnected', (peer) => {
      console.log(`[DownloadManager] Peer disconnected: ${peer.ip}:${peer.port}`);
      this.cancelPeerRequests(peer);
    });
  }

  getPieceByIndex(index) {
    if (index < 0 || index >= this.pieces.length) {
      throw new Error(`Invalid piece index: ${index}`);
    }

    if (!this.pieces[index]) {
      const numPieces = this.torrent.pieces.length;
      const pieceLength = this.torrent.pieceLength;
      const totalLength = this.torrent.length;
      const isLastPiece = index === numPieces - 1;
      const length = isLastPiece ? totalLength - (index * pieceLength) : pieceLength;

      this.pieces[index] = new Piece({
        index,
        length,
        hash: this.torrent.pieces[index]
      });
    }

    return this.pieces[index];
  }

  selectNextPiece() {
    const needed = [];

    for (let i = 0; i < this.pieces.length; i++) {
      if (this.completedPieces.has(i) || this.activePieces.has(i)) {
        continue;
      }

      const availability = this.peerManager.pieceAvailability[i];
      if (availability > 0) {
        needed.push({ index: i, availability });
      }
    }

    if (needed.length === 0) {
      return null;
    }

    // Rarest first: sort by availability (ascending)
    needed.sort((a, b) => a.availability - b.availability);
    return needed[0].index;
  }

  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.downloadStartTime = Date.now();

    console.log('[DownloadManager] Starting download');
    this.emit('started');
    
    // Request loop - check every 100ms for new blocks to request
    this.requestLoop = setInterval(() => {
      if (!this.isPaused) {
        this.requestBlocks();
      }
    }, 100);

    // Progress update loop - every 1 second
    this.progressLoop = setInterval(() => {
      if (!this.isPaused) {
        this._updateProgress();
      }
    }, 1000);

    // Timeout check loop - every 5 seconds
    this.timeoutLoop = setInterval(() => {
      if (!this.isPaused) {
        this.handleRequestTimeout();
      }
    }, 5000);
  }

  pause() {
    this.isPaused = true;
    this.emit('paused');
  }

  resume() {
    this.isPaused = false;
    this.emit('resumed');
    this.requestBlocks();
  }

  stop() {
    this.isRunning = false;
    this.isPaused = true;
    
    if (this.requestLoop) {
      clearInterval(this.requestLoop);
      this.requestLoop = null;
    }

    if (this.progressLoop) {
      clearInterval(this.progressLoop);
      this.progressLoop = null;
    }

    if (this.timeoutLoop) {
      clearInterval(this.timeoutLoop);
      this.timeoutLoop = null;
    }

    console.log('[DownloadManager] Stopped');
    this.emit('stopped');
  }

  requestBlocks() {
    if (this.isPaused || !this.isRunning) {
      return;
    }

    const peers = this.peerManager.getConnectedPeers();

    for (const peer of peers) {
      if (peer.peerChoking || !peer.isHandshakeComplete) {
        continue;
      }

      const peerKey = `${peer.ip}:${peer.port}`;
      const peerRequests = Array.from(this.pendingRequests.values())
        .filter(req => `${req.peer.ip}:${req.peer.port}` === peerKey);

      while (peerRequests.length < this.maxActiveRequests) {
        const pieceIndex = this._selectPieceForPeer(peer);
        
        if (pieceIndex === null) {
          break;
        }

        const piece = this.getPieceByIndex(pieceIndex);
        
        if (!this.activePieces.has(pieceIndex)) {
          this.activePieces.set(pieceIndex, piece);
        }

        const block = piece.getNextMissingBlock();
        
        if (!block) {
          break;
        }

        const requestKey = `${pieceIndex}:${block.offset}`;
        
        if (this.pendingRequests.has(requestKey)) {
          break;
        }

        try {
          peer.sendRequest(pieceIndex, block.offset, block.length);
          
          this.pendingRequests.set(requestKey, {
            piece: pieceIndex,
            block: block.offset,
            peer,
            timestamp: Date.now()
          });

          console.log(`[DownloadManager] Requested piece ${pieceIndex} block ${block.offset} from ${peer.ip}:${peer.port}`);
          peerRequests.push({ piece: pieceIndex, block: block.offset });
        } catch (error) {
          break;
        }
      }
    }
  }

  _selectPieceForPeer(peer) {
    // First, try to continue downloading active pieces this peer has
    for (const [index, piece] of this.activePieces) {
      if (this.peerManager.hasPiece(peer.peerBitfield, index)) {
        const nextBlock = piece.getNextMissingBlock();
        if (nextBlock) {
          return index;
        }
      }
    }

    // Otherwise, select a new piece
    return this.selectNextPiece();
  }

  async handlePieceMessage(peer, index, begin, data) {
    const requestKey = `${index}:${begin}`;
    
    if (!this.pendingRequests.has(requestKey)) {
      console.warn(`[DownloadManager] Received unrequested piece ${index} block ${begin}`);
      return;
    }

    this.pendingRequests.delete(requestKey);
    console.log(`[DownloadManager] Received piece ${index} block ${begin} from ${peer.ip}:${peer.port}`);

    const piece = this.getPieceByIndex(index);

    try {
      const isComplete = piece.addBlock(begin, data);

      if (isComplete) {
        console.log(`[DownloadManager] Piece ${index} complete, verifying...`);
        const isValid = piece.verify();

        if (isValid) {
          console.log(`[DownloadManager] Piece ${index} verified successfully`);
          await this._handleVerifiedPiece(piece);
        } else {
          console.error(`[DownloadManager] Piece ${index} failed verification`);
          this._handleFailedPiece(piece, peer, 'Hash verification failed');
        }
      }
    } catch (error) {
      console.error(`[DownloadManager] Error handling piece data: ${error.message}`);
      this.emit('error', { message: `Error handling piece data: ${error.message}` });
    }

    // Continue requesting
    setImmediate(() => this.requestBlocks());
  }

  async _handleVerifiedPiece(piece) {
    this.completedPieces.add(piece.index);
    this.activePieces.delete(piece.index);
    this.downloadedBytes += piece.length;

    console.log(`[DownloadManager] Piece ${piece.index} added to completed pieces (${this.completedPieces.size}/${this.pieces.length})`);
    this.emit('piece:complete', { index: piece.index, hash: piece.hash });

    try {
      await this._writePieceToDisk(piece);
      console.log(`[DownloadManager] Piece ${piece.index} written to disk`);
    } catch (error) {
      console.error(`[DownloadManager] Failed to write piece ${piece.index}: ${error.message}`);
      this.emit('error', { message: `Failed to write piece ${piece.index}: ${error.message}` });
    }

    // Broadcast HAVE message to all peers
    const peers = this.peerManager.getConnectedPeers();
    for (const peer of peers) {
      try {
        peer.sendHave(piece.index);
        console.log(`[DownloadManager] Sent HAVE(${piece.index}) to ${peer.ip}:${peer.port}`);
      } catch (error) {
        console.error(`[DownloadManager] Failed to send HAVE to ${peer.ip}:${peer.port}: ${error.message}`);
      }
    }

    this._updateProgress();

    // Check if download is complete
    if (this.completedPieces.size === this.pieces.length) {
      console.log('[DownloadManager] All pieces complete! Download finished.');
      this.isComplete = true;
      this.stop();
      this.emit('complete');
      // TODO: Transition to seeding mode
    }
  }

  _handleFailedPiece(piece, peer, reason) {
    console.error(`[DownloadManager] Piece ${piece.index} failed: ${reason} (from ${peer.ip}:${peer.port})`);
    
    piece.reset();
    this.activePieces.delete(piece.index);

    // Remove all pending requests for this piece
    let canceledCount = 0;
    for (const [key, req] of this.pendingRequests) {
      if (req.piece === piece.index) {
        this.pendingRequests.delete(key);
        canceledCount++;
      }
    }

    console.log(`[DownloadManager] Canceled ${canceledCount} pending requests for piece ${piece.index}`);
    this.emit('piece:failed', { index: piece.index, reason, peer: `${peer.ip}:${peer.port}` });
  }

  async _writePieceToDisk(piece) {
    await fs.mkdir(this.downloadPath, { recursive: true });

    if (this.torrent.isMultiFile) {
      // Multi-file torrent: distribute piece data across files
      await this._writeMultiFilePiece(piece);
    } else {
      // Single-file torrent: append to single file
      const filePath = path.join(this.downloadPath, this.torrent.name);
      const fd = await fs.open(filePath, 'a');
      await fd.write(piece.data, 0, piece.length, piece.index * this.torrent.pieceLength);
      await fd.close();
    }
  }

  async _writeMultiFilePiece(piece) {
    // Simplified multi-file write (full implementation would calculate file offsets)
    const filePath = path.join(this.downloadPath, this.torrent.name, `piece_${piece.index}.tmp`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, piece.data);
  }

  handleHaveMessage(peer, pieceIndex) {
    console.log(`[DownloadManager] Peer ${peer.ip}:${peer.port} has piece ${pieceIndex}`);
    // Piece availability is already updated by PeerManager
    if (!this.completedPieces.has(pieceIndex) && !this.isPaused) {
      setImmediate(() => this.requestBlocks());
    }
  }

  handleBitfieldMessage(peer, bitfield) {
    const pieceCount = this._countPiecesInBitfield(bitfield);
    console.log(`[DownloadManager] Peer ${peer.ip}:${peer.port} sent bitfield (${pieceCount} pieces)`);
    // Bitfield is already processed by PeerManager
    if (!this.isPaused) {
      setImmediate(() => this.requestBlocks());
    }
  }

  _countPiecesInBitfield(bitfield) {
    let count = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      if (bitfield[byteIndex] & (1 << bitIndex)) {
        count++;
      }
    }
    return count;
  }

  cancelPeerRequests(peer) {
    const peerKey = `${peer.ip}:${peer.port}`;
    let canceledCount = 0;
    
    for (const [key, request] of this.pendingRequests) {
      const requestPeerKey = `${request.peer.ip}:${request.peer.port}`;
      if (requestPeerKey === peerKey) {
        this.pendingRequests.delete(key);
        
        // Mark block as not received so it can be re-requested
        const piece = this.getPieceByIndex(request.piece);
        const blockIndex = request.block / piece.blockSize;
        if (piece.blocks[blockIndex]) {
          piece.blocks[blockIndex].received = false;
        }
        
        canceledCount++;
      }
    }
    
    if (canceledCount > 0) {
      console.log(`[DownloadManager] Canceled ${canceledCount} requests from ${peerKey}`);
    }
  }

  handleRequestTimeout() {
    const now = Date.now();
    const timeout = 30000; // 30 seconds
    let timedOutCount = 0;

    for (const [key, request] of this.pendingRequests) {
      if (now - request.timestamp > timeout) {
        console.warn(`[DownloadManager] Request timed out: piece ${request.piece} block ${request.block}`);
        this.pendingRequests.delete(key);
        
        // Mark block as not received so it can be re-requested
        try {
          const piece = this.getPieceByIndex(request.piece);
          const blockIndex = request.block / piece.blockSize;
          if (piece.blocks[blockIndex]) {
            piece.blocks[blockIndex].received = false;
          }
        } catch (error) {
          console.error(`[DownloadManager] Error resetting timed out block: ${error.message}`);
        }
        
        timedOutCount++;
      }
    }

    if (timedOutCount > 0) {
      console.log(`[DownloadManager] Cleaned up ${timedOutCount} timed out requests`);
    }
  }



  _updateProgress() {
    const now = Date.now();
    
    if (now - this.lastProgressUpdate < 1000) {
      return;
    }

    this.lastProgressUpdate = now;
    const progress = this.getProgress();
    this.emit('progress', progress);
  }

  getProgress() {
    const total = this.torrent.length;
    const downloaded = this.downloadedBytes;
    const percentage = (downloaded / total) * 100;
    
    const elapsed = Date.now() - (this.downloadStartTime || Date.now());
    const speed = elapsed > 0 ? (downloaded / elapsed) * 1000 : 0; // bytes per second

    return {
      downloaded,
      total,
      percentage,
      speed,
      completedPieces: this.completedPieces.size,
      totalPieces: this.pieces.length,
      activePieces: this.activePieces.size,
      pendingRequests: this.pendingRequests.size
    };
  }

  getBitfield() {
    const numBytes = Math.ceil(this.pieces.length / 8);
    const bitfield = Buffer.alloc(numBytes, 0);

    for (const pieceIndex of this.completedPieces) {
      const byteIndex = Math.floor(pieceIndex / 8);
      const bitIndex = 7 - (pieceIndex % 8);
      bitfield[byteIndex] |= (1 << bitIndex);
    }

    return bitfield;
  }
}

module.exports = { DownloadManager };
