const EventEmitter = require('events');
const { PeerConnection } = require('./peerConnection');
const { RetryManager, PeerBanManager, TimeoutManager } = require('./retryManager');

class PeerManager extends EventEmitter {
  constructor(options) {
    super();

    this.infoHash = options.infoHash;
    this.peerId = options.peerId;
    this.numPieces = options.numPieces;
    this.maxConnections = options.maxConnections || 50;
    this.maxConnectionsPerIP = options.maxConnectionsPerIP || 3;

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
    
    // Error handling managers
    this.retryManager = new RetryManager({ maxRetries: 3, baseDelay: 1000 });
    this.banManager = new PeerBanManager();
    this.timeoutManager = new TimeoutManager();
    
    // Peer health tracking: peerId -> { success, failures, avgRtt, lastSeen }
    this.peerHealth = new Map();
    
    // IP connection tracking: ip -> count
    this.ipConnections = new Map();
    
    // Reconnection tracking: peerKey -> { attempts, lastAttempt, backoff }
    this.reconnectionQueue = new Map();
    this.maxReconnectionAttempts = 5;
    
    // Setup ban manager events
    this.banManager.on('peer:banned', ({ peerId, reason }) => {
      console.log(`[PeerManager] Peer banned: ${peerId} for ${reason}`);
      this.emit('peer:banned', { peerId, reason });
    });
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

    // Check if already connected
    if (this.activeConnections.has(peerKey)) {
      return;
    }
    
    // Check if peer is banned
    if (this.banManager.isBanned(peerKey)) {
      console.log(`[PeerManager] Skipping banned peer: ${peerKey}`);
      return;
    }
    
    // Check IP connection limit (prevent abuse)
    const ipCount = this.ipConnections.get(peer.ip) || 0;
    if (ipCount >= this.maxConnectionsPerIP) {
      console.log(`[PeerManager] IP connection limit reached for ${peer.ip}`);
      return;
    }

    const connection = new PeerConnection({
      ip: peer.ip,
      port: peer.port,
      infoHash: this.infoHash,
      peerId: this.peerId,
      timeoutManager: this.timeoutManager,
      banManager: this.banManager,
      onHandshake: (info) => this.handleHandshake(peerKey, connection, info),
      onMessage: (message) => this.handleMessage(peerKey, connection, message),
      onError: (error) => this.handleError(peerKey, connection, error),
      onClose: () => this.handleClose(peerKey, connection)
    });

    try {
      // Track IP connection
      this.ipConnections.set(peer.ip, ipCount + 1);
      
      await connection.connect();
      
      // Initialize peer health tracking
      this._initializePeerHealth(peerKey);
      
    } catch (error) {
      // Connection failed, update health and consider reconnection
      this._updatePeerHealth(peerKey, false);
      
      // Decrement IP count on failure
      const currentCount = this.ipConnections.get(peer.ip) || 0;
      if (currentCount > 0) {
        this.ipConnections.set(peer.ip, currentCount - 1);
      }
      
      // Queue for reconnection if appropriate
      this._queueReconnection(peer, error);
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
      
      // Update IP connection count
      const ipCount = this.ipConnections.get(connection.ip) || 0;
      if (ipCount > 0) {
        this.ipConnections.set(connection.ip, ipCount - 1);
      }
      
      // Update timeout manager
      if (connection.remotePeerId) {
        this.timeoutManager.removePeer(connection.remotePeerId.toString('hex'));
      }
      
      this.emit('peer:disconnected', { peerKey, connection });
      
      // Queue for reconnection if not banned and not too many failures
      const health = this.peerHealth.get(peerKey);
      if (health && health.failures < 3 && !this.banManager.isBanned(peerKey)) {
        this._queueReconnection({ ip: connection.ip, port: connection.port }, new Error('Connection closed'));
      }
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
    const slowPeers = this.timeoutManager.getSlowPeers();
    const bannedPeers = this.banManager.getBanList();
    
    return {
      connected: this.activeConnections.size,
      pool: this.peerPool.length,
      maxConnections: this.maxConnections,
      pieceAvailability: this.pieceAvailability.slice(),
      slowPeers: slowPeers.length,
      bannedPeers: bannedPeers.length,
      healthyPeers: Array.from(this.peerHealth.values()).filter(h => h.successRate > 0.8).length,
      reconnectionQueue: this.reconnectionQueue.size
    };
  }
  
  /**
   * Initializes peer health tracking
   * @private
   */
  _initializePeerHealth(peerKey) {
    if (!this.peerHealth.has(peerKey)) {
      this.peerHealth.set(peerKey, {
        success: 0,
        failures: 0,
        avgRtt: 0,
        lastSeen: Date.now(),
        successRate: 0
      });
    }
  }
  
  /**
   * Updates peer health tracking
   * @private
   */
  _updatePeerHealth(peerKey, success) {
    let health = this.peerHealth.get(peerKey);
    
    if (!health) {
      this._initializePeerHealth(peerKey);
      health = this.peerHealth.get(peerKey);
    }
    
    if (success) {
      health.success++;
    } else {
      health.failures++;
    }
    
    health.lastSeen = Date.now();
    health.successRate = health.success / (health.success + health.failures);
    
    // Get RTT from timeout manager
    const rtt = this.timeoutManager.getPeerRTT(peerKey);
    if (rtt > 0) {
      health.avgRtt = rtt;
    }
  }
  
  /**
   * Queues peer for reconnection with backoff
   * @private
   */
  _queueReconnection(peer, error) {
    const peerKey = `${peer.ip}:${peer.port}`;
    
    // Check if peer is banned
    if (this.banManager.isBanned(peerKey)) {
      return;
    }
    
    let reconnection = this.reconnectionQueue.get(peerKey);
    
    if (!reconnection) {
      reconnection = {
        peer,
        attempts: 0,
        lastAttempt: 0,
        backoff: 5000 // Start with 5 second backoff
      };
      this.reconnectionQueue.set(peerKey, reconnection);
    }
    
    reconnection.attempts++;
    
    // Give up after max attempts
    if (reconnection.attempts > this.maxReconnectionAttempts) {
      console.log(`[PeerManager] Max reconnection attempts reached for ${peerKey}`);
      this.reconnectionQueue.delete(peerKey);
      return;
    }
    
    // Calculate backoff with exponential increase
    const delay = Math.min(reconnection.backoff * Math.pow(2, reconnection.attempts - 1), 300000); // Max 5 min
    
    console.log(`[PeerManager] Queuing reconnection to ${peerKey} in ${delay}ms (attempt ${reconnection.attempts})`);
    
    setTimeout(async () => {
      reconnection.lastAttempt = Date.now();
      
      try {
        await this.connectToPeer(peer);
        // Success - remove from queue
        this.reconnectionQueue.delete(peerKey);
      } catch (error) {
        // Will be queued again by connectToPeer if appropriate
      }
    }, delay);
  }
  
  /**
   * Gets healthy peers sorted by success rate
   * @returns {Array}
   */
  getHealthyPeers() {
    const peers = [];
    
    for (const [peerKey, connection] of this.activeConnections.entries()) {
      const health = this.peerHealth.get(peerKey);
      
      if (health && health.successRate > 0.5) {
        peers.push({
          peerKey,
          connection,
          successRate: health.successRate,
          avgRtt: health.avgRtt,
          isSlow: this.timeoutManager.getSlowPeers().some(p => p.peerId === peerKey)
        });
      }
    }
    
    // Sort by success rate descending, then by RTT ascending
    return peers.sort((a, b) => {
      if (Math.abs(a.successRate - b.successRate) > 0.1) {
        return b.successRate - a.successRate;
      }
      return a.avgRtt - b.avgRtt;
    });
  }
  
  /**
   * Disconnects slow and unhealthy peers
   */
  pruneUnhealthyPeers() {
    const slowPeers = this.timeoutManager.getSlowPeers();
    const threshold = 0.3; // Disconnect peers with <30% success rate
    
    for (const [peerKey, health] of this.peerHealth.entries()) {
      const connection = this.activeConnections.get(peerKey);
      
      if (!connection) continue;
      
      const isSlow = slowPeers.some(p => p.peerId === peerKey);
      const isUnhealthy = health.successRate < threshold && (health.success + health.failures) > 10;
      
      if (isSlow || isUnhealthy) {
        console.log(`[PeerManager] Pruning unhealthy peer ${peerKey} (success rate: ${health.successRate.toFixed(2)}, slow: ${isSlow})`);
        this.disconnect(connection);
      }
    }
  }
  
  /**
   * Cleans up resources
   */
  destroy() {
    this.disconnectAll();
    
    if (this.retryManager) {
      this.retryManager.removeAllListeners();
    }
    
    if (this.banManager) {
      this.banManager.destroy();
    }
    
    if (this.timeoutManager) {
      this.timeoutManager.destroy();
    }
    
    this.peerHealth.clear();
    this.ipConnections.clear();
    this.reconnectionQueue.clear();
    this.removeAllListeners();
  }
}

module.exports = { PeerManager };
