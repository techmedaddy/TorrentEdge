const EventEmitter = require('events');
const { SpeedTracker } = require('./speedTracker');

/**
 * Manages uploading pieces to peers (seeding)
 */
class UploadManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.fileWriter = options.fileWriter;
    this.pieceManager = options.pieceManager;
    this.throttler = options.throttler;
    
    this.maxUploadsPerTorrent = options.maxUploadsPerTorrent || 4;
    this.maxUploadsTotal = options.maxUploadsTotal || 20;
    
    // Active uploads: peerId -> Upload
    this.activeUploads = new Map();
    
    // Upload queue (FIFO)
    this.uploadQueue = [];
    
    // Peer state: peerId -> PeerState
    this._peerStates = new Map();
    
    // Statistics
    this.totalUploaded = 0;
    this.uploadSpeed = new SpeedTracker();
    
    // Choking algorithm state
    this._chokingInterval = null;
    this._optimisticUnchokeInterval = null;
    this._currentOptimisticPeer = null;
    this._lastChokingTime = 0;
    
    // Super-seeding mode
    this._superSeedingEnabled = false;
    this._superSeedingPieces = new Map(); // pieceIndex -> peerId (who we sent it to)
    
    // Start choking algorithm
    this._startChokingAlgorithm();
  }
  
  /**
   * Handles piece request from peer
   * @param {Object} peer - PeerConnection instance
   * @param {number} pieceIndex
   * @param {number} offset
   * @param {number} length
   */
  handleRequest(peer, pieceIndex, offset, length) {
    const peerId = peer.id || peer.peerId;
    
    // Validate we have the piece
    if (!this.pieceManager || !this.pieceManager.isPieceComplete(pieceIndex)) {
      console.log(`[UploadManager] Don't have piece ${pieceIndex}, rejecting request from ${peerId}`);
      return;
    }
    
    // Get or create peer state
    const peerState = this._getOrCreatePeerState(peer);
    
    // Check if peer is choked
    if (peerState.isChoked) {
      console.log(`[UploadManager] Peer ${peerId} is choked, rejecting request`);
      return;
    }
    
    // Super-seeding check
    if (this._superSeedingEnabled) {
      if (this._superSeedingPieces.has(pieceIndex)) {
        // Already sent this piece to someone, don't send again yet
        console.log(`[UploadManager] Super-seeding: piece ${pieceIndex} already distributed`);
        return;
      }
    }
    
    // Validate request size (typically 16KB)
    if (length > 16384 * 2) {
      console.warn(`[UploadManager] Request too large: ${length} bytes from ${peerId}`);
      return;
    }
    
    // Create upload
    const upload = {
      peerId,
      peer,
      pieceIndex,
      offset,
      length,
      startedAt: Date.now(),
      queuedAt: Date.now()
    };
    
    // Track request for this peer
    peerState.requestsReceived++;
    
    // Check if we can start immediately
    if (this.activeUploads.size < this.maxUploadsTotal) {
      this._startUpload(upload);
    } else {
      // Queue it
      this.uploadQueue.push(upload);
      this.emit('upload:queued', { peerId, pieceIndex, offset, length });
    }
  }
  
  /**
   * Cancels a pending upload request
   * @param {Object} peer
   * @param {number} pieceIndex
   * @param {number} offset
   * @param {number} length
   */
  cancelRequest(peer, pieceIndex, offset, length) {
    const peerId = peer.id || peer.peerId;
    
    // Remove from queue
    const initialLength = this.uploadQueue.length;
    this.uploadQueue = this.uploadQueue.filter(upload => {
      return !(
        upload.peerId === peerId &&
        upload.pieceIndex === pieceIndex &&
        upload.offset === offset &&
        upload.length === length
      );
    });
    
    if (this.uploadQueue.length < initialLength) {
      console.log(`[UploadManager] Cancelled queued upload for ${peerId} piece ${pieceIndex}`);
      this.emit('upload:cancelled', { peerId, pieceIndex, offset, length });
    }
    
    // Check if it's an active upload (harder to cancel)
    const activeKey = `${peerId}-${pieceIndex}-${offset}`;
    if (this.activeUploads.has(activeKey)) {
      // Mark for cancellation (actual upload may be in progress)
      const upload = this.activeUploads.get(activeKey);
      upload.cancelled = true;
      console.log(`[UploadManager] Marked active upload for cancellation: ${peerId} piece ${pieceIndex}`);
    }
  }
  
  /**
   * Starts an upload
   * @private
   */
  _startUpload(upload) {
    const activeKey = `${upload.peerId}-${upload.pieceIndex}-${upload.offset}`;
    
    // Check if already uploading this
    if (this.activeUploads.has(activeKey)) {
      return;
    }
    
    this.activeUploads.set(activeKey, upload);
    upload.startedAt = Date.now();
    
    this.emit('upload:started', {
      peerId: upload.peerId,
      pieceIndex: upload.pieceIndex,
      offset: upload.offset,
      length: upload.length
    });
    
    // Process upload asynchronously
    this._processUpload(upload).catch(error => {
      console.error(`[UploadManager] Upload error for ${upload.peerId}:`, error.message);
      this.emit('upload:error', { upload, error });
    }).finally(() => {
      this.activeUploads.delete(activeKey);
      
      // Process next queued upload
      this._processQueue();
    });
  }
  
  /**
   * Processes an upload
   * @private
   */
  async _processUpload(upload) {
    const { peer, pieceIndex, offset, length } = upload;
    const peerId = upload.peerId;
    
    try {
      // Check if cancelled
      if (upload.cancelled) {
        console.log(`[UploadManager] Upload cancelled for ${peerId} piece ${pieceIndex}`);
        return;
      }
      
      // Read block from disk
      const block = await this.fileWriter.readPiece(pieceIndex, offset, length);
      
      if (!block || block.length === 0) {
        throw new Error(`Failed to read piece ${pieceIndex} at offset ${offset}`);
      }
      
      // Check if cancelled after read
      if (upload.cancelled) {
        return;
      }
      
      // Throttle upload if needed
      if (this.throttler) {
        let sentBytes = 0;
        const blockLength = block.length;
        
        while (sentBytes < blockLength) {
          const remaining = blockLength - sentBytes;
          const allowed = await this.throttler.requestUpload(remaining);
          
          if (allowed > 0) {
            const chunk = block.slice(sentBytes, sentBytes + allowed);
            
            // Send piece message to peer
            if (peer.sendPiece) {
              peer.sendPiece(pieceIndex, offset + sentBytes, chunk);
            } else if (peer.write) {
              // Fallback: construct piece message manually
              this._sendPieceMessage(peer, pieceIndex, offset + sentBytes, chunk);
            }
            
            sentBytes += allowed;
            
            // Track statistics
            this._trackUpload(peerId, allowed);
          } else {
            // Wait a bit if no tokens available
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
      } else {
        // No throttling, send directly
        if (peer.sendPiece) {
          peer.sendPiece(pieceIndex, offset, block);
        } else {
          this._sendPieceMessage(peer, pieceIndex, offset, block);
        }
        
        // Track statistics
        this._trackUpload(peerId, block.length);
      }
      
      // Super-seeding: mark piece as sent
      if (this._superSeedingEnabled) {
        this._superSeedingPieces.set(pieceIndex, peerId);
      }
      
      const duration = Date.now() - upload.startedAt;
      
      this.emit('upload:complete', {
        peerId,
        pieceIndex,
        offset,
        length,
        duration
      });
      
    } catch (error) {
      console.error(`[UploadManager] Error uploading to ${peerId}:`, error.message);
      this.emit('upload:error', { upload, error });
      throw error;
    }
  }
  
  /**
   * Processes upload queue
   * @private
   */
  _processQueue() {
    while (this.uploadQueue.length > 0 && this.activeUploads.size < this.maxUploadsTotal) {
      const upload = this.uploadQueue.shift();
      
      // Check if peer is still unchoked
      const peerState = this._peerStates.get(upload.peerId);
      if (peerState && !peerState.isChoked) {
        this._startUpload(upload);
      }
    }
  }
  
  /**
   * Sends piece message to peer (fallback)
   * @private
   */
  _sendPieceMessage(peer, pieceIndex, offset, block) {
    // BitTorrent piece message format:
    // <length><id><index><begin><block>
    // length = 4 bytes (9 + block.length)
    // id = 1 byte (7 for piece)
    // index = 4 bytes
    // begin = 4 bytes
    // block = variable
    
    const messageLength = 9 + block.length;
    const buffer = Buffer.allocUnsafe(4 + messageLength);
    
    buffer.writeUInt32BE(messageLength, 0);
    buffer.writeUInt8(7, 4); // piece message id
    buffer.writeUInt32BE(pieceIndex, 5);
    buffer.writeUInt32BE(offset, 9);
    block.copy(buffer, 13);
    
    if (peer.write) {
      peer.write(buffer);
    } else if (peer.socket && peer.socket.write) {
      peer.socket.write(buffer);
    }
  }
  
  /**
   * Tracks upload statistics
   * @private
   */
  _trackUpload(peerId, bytes) {
    this.totalUploaded += bytes;
    this.uploadSpeed.addBytes(bytes);
    
    // Track per-peer
    const peerState = this._peerStates.get(peerId);
    if (peerState) {
      peerState.uploaded += bytes;
    }
  }
  
  /**
   * Unchokes a peer (allows requests)
   * @param {Object} peer
   */
  unchokePeer(peer) {
    const peerId = peer.id || peer.peerId;
    const peerState = this._getOrCreatePeerState(peer);
    
    if (!peerState.isChoked) {
      return; // Already unchoked
    }
    
    peerState.isChoked = false;
    
    // Send unchoke message
    if (peer.sendUnchoke) {
      peer.sendUnchoke();
    } else if (peer.unchoke) {
      peer.unchoke();
    }
    
    console.log(`[UploadManager] Unchoked peer ${peerId}`);
    this.emit('peer:unchoked', { peerId });
    
    // Process any queued uploads for this peer
    this._processQueue();
  }
  
  /**
   * Chokes a peer (blocks requests)
   * @param {Object} peer
   */
  chokePeer(peer) {
    const peerId = peer.id || peer.peerId;
    const peerState = this._getOrCreatePeerState(peer);
    
    if (peerState.isChoked) {
      return; // Already choked
    }
    
    peerState.isChoked = true;
    
    // Send choke message
    if (peer.sendChoke) {
      peer.sendChoke();
    } else if (peer.choke) {
      peer.choke();
    }
    
    // Cancel pending uploads to this peer
    this.uploadQueue = this.uploadQueue.filter(upload => upload.peerId !== peerId);
    
    // Mark active uploads for cancellation
    for (const [key, upload] of this.activeUploads.entries()) {
      if (upload.peerId === peerId) {
        upload.cancelled = true;
      }
    }
    
    console.log(`[UploadManager] Choked peer ${peerId}`);
    this.emit('peer:choked', { peerId });
  }
  
  /**
   * Gets or creates peer state
   * @private
   */
  _getOrCreatePeerState(peer) {
    const peerId = peer.id || peer.peerId;
    
    if (!this._peerStates.has(peerId)) {
      this._peerStates.set(peerId, {
        peer,
        peerId,
        isChoked: true, // Start choked
        uploaded: 0,
        downloaded: 0,
        requestsReceived: 0,
        lastActive: Date.now()
      });
    }
    
    return this._peerStates.get(peerId);
  }
  
  /**
   * Updates peer download statistics (called by download manager)
   * @param {string} peerId
   * @param {number} bytes
   */
  updatePeerDownload(peerId, bytes) {
    const peerState = this._peerStates.get(peerId);
    if (peerState) {
      peerState.downloaded += bytes;
      peerState.lastActive = Date.now();
    }
  }
  
  /**
   * Starts the choking algorithm
   * @private
   */
  _startChokingAlgorithm() {
    // Run choking algorithm every 10 seconds
    this._chokingInterval = setInterval(() => {
      this.runChokingAlgorithm();
    }, 10000);
    
    // Rotate optimistic unchoke every 30 seconds
    this._optimisticUnchokeInterval = setInterval(() => {
      this._rotateOptimisticUnchoke();
    }, 30000);
    
    if (this._chokingInterval.unref) {
      this._chokingInterval.unref();
    }
    if (this._optimisticUnchokeInterval.unref) {
      this._optimisticUnchokeInterval.unref();
    }
  }
  
  /**
   * Runs the tit-for-tat choking algorithm
   */
  runChokingAlgorithm() {
    const peers = Array.from(this._peerStates.values());
    
    if (peers.length === 0) {
      return;
    }
    
    console.log(`[UploadManager] Running choking algorithm for ${peers.length} peers`);
    
    // Sort peers by download rate (how much they've uploaded to us)
    // Reward peers that upload to us
    const sortedPeers = peers
      .filter(p => p.peer && (p.peer.socket || p.peer.connected))
      .sort((a, b) => b.downloaded - a.downloaded);
    
    const unchokeSlots = 4; // Top 4 uploaders
    const peersToUnchoke = new Set();
    
    // Unchoke top uploaders
    for (let i = 0; i < Math.min(unchokeSlots - 1, sortedPeers.length); i++) {
      peersToUnchoke.add(sortedPeers[i].peerId);
    }
    
    // Add optimistic unchoke (if we have one)
    if (this._currentOptimisticPeer) {
      peersToUnchoke.add(this._currentOptimisticPeer);
    } else if (sortedPeers.length > 0) {
      // Pick a random peer for optimistic unchoke
      const randomPeer = sortedPeers[Math.floor(Math.random() * sortedPeers.length)];
      this._currentOptimisticPeer = randomPeer.peerId;
      peersToUnchoke.add(randomPeer.peerId);
    }
    
    // Apply choking/unchoking
    for (const peerState of peers) {
      if (peersToUnchoke.has(peerState.peerId)) {
        this.unchokePeer(peerState.peer);
      } else {
        this.chokePeer(peerState.peer);
      }
    }
    
    this._lastChokingTime = Date.now();
    
    this.emit('choking:updated', {
      unchoked: Array.from(peersToUnchoke),
      choked: peers.filter(p => !peersToUnchoke.has(p.peerId)).map(p => p.peerId)
    });
  }
  
  /**
   * Rotates optimistic unchoke to a new peer
   * @private
   */
  _rotateOptimisticUnchoke() {
    const peers = Array.from(this._peerStates.values())
      .filter(p => p.peer && (p.peer.socket || p.peer.connected));
    
    if (peers.length === 0) {
      return;
    }
    
    // Find a peer that isn't currently in top uploaders
    const sortedPeers = peers.sort((a, b) => b.downloaded - a.downloaded);
    const topUploaders = new Set(sortedPeers.slice(0, 3).map(p => p.peerId));
    
    const candidates = peers.filter(p => !topUploaders.has(p.peerId));
    
    if (candidates.length > 0) {
      const newOptimistic = candidates[Math.floor(Math.random() * candidates.length)];
      this._currentOptimisticPeer = newOptimistic.peerId;
      
      console.log(`[UploadManager] Rotated optimistic unchoke to ${newOptimistic.peerId}`);
      this.emit('optimistic:rotated', { peerId: newOptimistic.peerId });
    }
  }
  
  /**
   * Enables or disables super-seeding mode
   * @param {boolean} enabled
   */
  setSuperSeeding(enabled) {
    this._superSeedingEnabled = enabled;
    
    if (enabled) {
      console.log('[UploadManager] Super-seeding mode enabled');
      this._superSeedingPieces.clear();
    } else {
      console.log('[UploadManager] Super-seeding mode disabled');
    }
    
    this.emit('superseeding:changed', { enabled });
  }
  
  /**
   * Notifies that a piece has been distributed (for super-seeding)
   * @param {number} pieceIndex
   */
  onPieceDistributed(pieceIndex) {
    if (this._superSeedingEnabled && this._superSeedingPieces.has(pieceIndex)) {
      console.log(`[UploadManager] Piece ${pieceIndex} distributed, can send to others`);
      this._superSeedingPieces.delete(pieceIndex);
    }
  }
  
  /**
   * Removes a peer
   * @param {string} peerId
   */
  removePeer(peerId) {
    // Remove from peer states
    this._peerStates.delete(peerId);
    
    // Remove from queue
    this.uploadQueue = this.uploadQueue.filter(upload => upload.peerId !== peerId);
    
    // Cancel active uploads
    for (const [key, upload] of this.activeUploads.entries()) {
      if (upload.peerId === peerId) {
        upload.cancelled = true;
        this.activeUploads.delete(key);
      }
    }
    
    // Clear optimistic unchoke if it was this peer
    if (this._currentOptimisticPeer === peerId) {
      this._currentOptimisticPeer = null;
    }
    
    console.log(`[UploadManager] Removed peer ${peerId}`);
  }
  
  /**
   * Gets upload statistics
   * @returns {Object}
   */
  getStats() {
    const peers = Array.from(this._peerStates.values()).map(p => ({
      peerId: p.peerId,
      uploaded: p.uploaded,
      downloaded: p.downloaded,
      requests: p.requestsReceived,
      isChoked: p.isChoked
    }));
    
    return {
      activeUploads: this.activeUploads.size,
      queuedUploads: this.uploadQueue.length,
      totalUploaded: this.totalUploaded,
      uploadSpeed: this.uploadSpeed.getSpeed(),
      peers,
      unchokedPeers: peers.filter(p => !p.isChoked).length,
      optimisticPeer: this._currentOptimisticPeer,
      superSeedingEnabled: this._superSeedingEnabled,
      superSeedingActivePieces: this._superSeedingPieces.size
    };
  }
  
  /**
   * Gets detailed peer statistics
   * @returns {Array}
   */
  getPeerStats() {
    return Array.from(this._peerStates.values()).map(p => ({
      peerId: p.peerId,
      uploaded: p.uploaded,
      downloaded: p.downloaded,
      ratio: p.downloaded > 0 ? (p.uploaded / p.downloaded).toFixed(2) : 0,
      requestsReceived: p.requestsReceived,
      isChoked: p.isChoked,
      lastActive: p.lastActive
    }));
  }
  
  /**
   * Cleans up resources
   */
  destroy() {
    // Clear intervals
    if (this._chokingInterval) {
      clearInterval(this._chokingInterval);
      this._chokingInterval = null;
    }
    
    if (this._optimisticUnchokeInterval) {
      clearInterval(this._optimisticUnchokeInterval);
      this._optimisticUnchokeInterval = null;
    }
    
    // Cancel all uploads
    for (const upload of this.activeUploads.values()) {
      upload.cancelled = true;
    }
    
    this.activeUploads.clear();
    this.uploadQueue = [];
    this._peerStates.clear();
    this._superSeedingPieces.clear();
    
    this.removeAllListeners();
  }
}

module.exports = UploadManager;
