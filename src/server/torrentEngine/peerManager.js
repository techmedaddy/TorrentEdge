const EventEmitter = require('events');
const { PeerConnection } = require('./peerConnection');

class PeerManager extends EventEmitter {
  constructor(options) {
    super();

    this.infoHash = options.infoHash;
    this.peerId = options.peerId;
    this.numPieces = options.numPieces;
    this.maxConnections = options.maxConnections || 50;

    if (!Buffer.isBuffer(this.infoHash) || this.infoHash.length !== 20) {
      throw new Error('infoHash must be a 20-byte Buffer');
    }

    if (!Buffer.isBuffer(this.peerId) || this.peerId.length !== 20) {
      throw new Error('peerId must be a 20-byte Buffer');
    }

    this.peerPool = [];
    this.activeConnections = new Map();
    this.pieceAvailability = new Array(this.numPieces).fill(0);
    this.connecting = false;
  }

  /**
   * Adds peers to the pool
   * @param {Array<{ip: string, port: number}>} peers
   */
  addPeers(peers) {
    for (const peer of peers) {
      const peerKey = `${peer.ip}:${peer.port}`;
      
      if (this.activeConnections.has(peerKey)) {
        continue;
      }

      const existsInPool = this.peerPool.some(p => `${p.ip}:${p.port}` === peerKey);
      if (!existsInPool) {
        this.peerPool.push(peer);
      }
    }
  }

  /**
   * Connects to peers from the pool
   * @param {number} count - Number of peers to connect to
   * @returns {Promise<void>}
   */
  async connectToPeers(count) {
    if (this.connecting) {
      return;
    }

    this.connecting = true;

    try {
      const connectPromises = [];
      let connected = 0;

      while (connected < count && this.peerPool.length > 0 && 
             this.activeConnections.size < this.maxConnections) {
        const peer = this.peerPool.shift();
        connectPromises.push(this.connectToPeer(peer));
        connected++;

        // Rate limiting: delay between connection attempts
        if (connected < count && this.peerPool.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      await Promise.allSettled(connectPromises);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Connects to a single peer
   * @param {{ip: string, port: number}} peer
   * @returns {Promise<void>}
   */
  async connectToPeer(peer) {
    const peerKey = `${peer.ip}:${peer.port}`;

    if (this.activeConnections.has(peerKey)) {
      return;
    }

    const connection = new PeerConnection({
      ip: peer.ip,
      port: peer.port,
      infoHash: this.infoHash,
      peerId: this.peerId,
      onHandshake: (info) => this.handleHandshake(peerKey, connection, info),
      onMessage: (message) => this.handleMessage(peerKey, connection, message),
      onError: (error) => this.handleError(peerKey, connection, error),
      onClose: () => this.handleClose(peerKey, connection)
    });

    try {
      await connection.connect();
    } catch (error) {
      // Connection failed, peer will be removed or retried later
    }
  }

  /**
   * Handles peer handshake completion
   */
  handleHandshake(peerKey, connection, info) {
    this.activeConnections.set(peerKey, connection);
    this.emit('peer:connected', { peerKey, connection, info });

    // Basic choking strategy: send interested if we need data
    connection.sendInterested();
  }

  /**
   * Handles incoming messages from peer
   */
  handleMessage(peerKey, connection, message) {
    if (message.type === 'bitfield') {
      this.updatePieceAvailability(connection, message.bitfield);
    } else if (message.type === 'have') {
      this.updatePieceAvailabilityForPiece(connection, message.pieceIndex);
    }

    // Basic choking strategy: unchoke peers who unchoke us
    if (connection.peerChoking === false && connection.amChoking === true) {
      connection.sendUnchoke();
    }

    this.emit('peer:message', { peerKey, connection, message });
  }

  /**
   * Handles peer errors
   */
  handleError(peerKey, connection, error) {
    this.emit('peer:error', { peerKey, connection, error });
  }

  /**
   * Handles peer connection close
   */
  handleClose(peerKey, connection) {
    if (this.activeConnections.has(peerKey)) {
      this.removePeerPieceAvailability(connection);
      this.activeConnections.delete(peerKey);
      this.emit('peer:disconnected', { peerKey, connection });
    }
  }

  /**
   * Updates piece availability when peer sends bitfield
   */
  updatePieceAvailability(connection, bitfield) {
    if (!connection.peerBitfield) {
      // First time seeing this peer's pieces
      for (let i = 0; i < this.numPieces; i++) {
        if (this.hasPiece(bitfield, i)) {
          this.pieceAvailability[i]++;
          this.emit('piece:available', { pieceIndex: i, count: this.pieceAvailability[i] });
        }
      }
    }
  }

  /**
   * Updates piece availability when peer sends have message
   */
  updatePieceAvailabilityForPiece(connection, pieceIndex) {
    if (pieceIndex >= 0 && pieceIndex < this.numPieces) {
      this.pieceAvailability[pieceIndex]++;
      this.emit('piece:available', { pieceIndex, count: this.pieceAvailability[pieceIndex] });
    }
  }

  /**
   * Removes peer's contribution to piece availability
   */
  removePeerPieceAvailability(connection) {
    if (connection.peerBitfield) {
      for (let i = 0; i < this.numPieces; i++) {
        if (this.hasPiece(connection.peerBitfield, i)) {
          this.pieceAvailability[i] = Math.max(0, this.pieceAvailability[i] - 1);
        }
      }
    }
  }

  /**
   * Checks if bitfield indicates peer has piece
   */
  hasPiece(bitfield, pieceIndex) {
    const byteIndex = Math.floor(pieceIndex / 8);
    const bitIndex = 7 - (pieceIndex % 8);
    
    if (byteIndex >= bitfield.length) {
      return false;
    }

    return (bitfield[byteIndex] & (1 << bitIndex)) !== 0;
  }

  /**
   * Gets all connected peers
   * @returns {PeerConnection[]}
   */
  getConnectedPeers() {
    return Array.from(this.activeConnections.values());
  }

  /**
   * Gets peers that have a specific piece
   * @param {number} pieceIndex
   * @returns {PeerConnection[]}
   */
  getPeersWithPiece(pieceIndex) {
    return this.getConnectedPeers().filter(peer => {
      if (!peer.peerBitfield) {
        return false;
      }
      return this.hasPiece(peer.peerBitfield, pieceIndex);
    });
  }

  /**
   * Broadcasts a message to all connected peers
   * @param {string} messageType - Type of message (e.g., 'interested', 'have')
   * @param {...any} args - Arguments for the message
   */
  broadcast(messageType, ...args) {
    const peers = this.getConnectedPeers();
    
    for (const peer of peers) {
      if (!peer.isConnected || !peer.isHandshakeComplete) {
        continue;
      }

      try {
        switch (messageType) {
          case 'choke':
            peer.sendChoke();
            break;
          case 'unchoke':
            peer.sendUnchoke();
            break;
          case 'interested':
            peer.sendInterested();
            break;
          case 'notInterested':
            peer.sendNotInterested();
            break;
          case 'have':
            peer.sendHave(args[0]);
            break;
          case 'bitfield':
            peer.sendBitfield(args[0]);
            break;
          default:
            break;
        }
      } catch (error) {
        // Ignore errors for individual peers
      }
    }
  }

  /**
   * Disconnects a specific peer
   * @param {PeerConnection} peer
   */
  disconnect(peer) {
    const peerKey = `${peer.ip}:${peer.port}`;
    
    if (this.activeConnections.has(peerKey)) {
      peer.disconnect();
      this.activeConnections.delete(peerKey);
      this.removePeerPieceAvailability(peer);
      this.emit('peer:disconnected', { peerKey, connection: peer });
    }
  }

  /**
   * Disconnects all peers
   */
  disconnectAll() {
    const peers = Array.from(this.activeConnections.values());
    
    for (const peer of peers) {
      peer.disconnect();
    }

    this.activeConnections.clear();
    this.pieceAvailability.fill(0);
  }

  /**
   * Gets connection statistics
   */
  getStats() {
    return {
      connected: this.activeConnections.size,
      pool: this.peerPool.length,
      maxConnections: this.maxConnections,
      pieceAvailability: this.pieceAvailability.slice()
    };
  }
}

module.exports = { PeerManager };
