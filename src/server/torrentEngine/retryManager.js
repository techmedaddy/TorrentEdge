const EventEmitter = require('events');

/**
 * Centralized retry logic for network operations
 */
class RetryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffMultiplier = options.backoffMultiplier || 2;
  }
  
  /**
   * Executes operation with automatic retry
   * @template T
   * @param {() => Promise<T>} operation - Operation to retry
   * @param {Object} options - Retry options
   * @returns {Promise<T>}
   */
  async retry(operation, options = {}) {
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : this.maxRetries;
    const retryOn = options.retryOn || (() => true);
    const onRetry = options.onRetry || (() => {});
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Try operation
        const result = await operation();
        
        // Success - emit event if this was a retry
        if (attempt > 0) {
          this.emit('retry:success', { attempt, operation: operation.name });
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Check if we should retry
        const shouldRetry = attempt < maxRetries && retryOn(error);
        
        if (!shouldRetry) {
          // Don't retry, throw error
          this.emit('retry:failed', { 
            attempt, 
            error: error.message,
            operation: operation.name 
          });
          throw error;
        }
        
        // Calculate delay with jitter
        const delay = this.calculateDelay(attempt);
        
        // Notify retry callback
        onRetry(attempt + 1, error);
        
        this.emit('retry:attempt', {
          attempt: attempt + 1,
          maxRetries,
          delay,
          error: error.message,
          operation: operation.name
        });
        
        // Wait before retry
        await this._sleep(delay);
      }
    }
    
    // All retries exhausted
    throw lastError;
  }
  
  /**
   * Calculates delay for retry attempt with exponential backoff and jitter
   * @param {number} attempt - Attempt number (0-indexed)
   * @returns {number} Delay in milliseconds
   */
  calculateDelay(attempt) {
    // Exponential backoff: baseDelay * (backoffMultiplier ^ attempt)
    const exponentialDelay = this.baseDelay * Math.pow(this.backoffMultiplier, attempt);
    
    // Add jitter (±20% random variation)
    const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
    
    // Calculate final delay with jitter
    const delayWithJitter = exponentialDelay + jitter;
    
    // Cap at maxDelay
    return Math.min(delayWithJitter, this.maxDelay);
  }
  
  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Gets retry statistics
   * @returns {Object}
   */
  getStats() {
    return {
      maxRetries: this.maxRetries,
      baseDelay: this.baseDelay,
      maxDelay: this.maxDelay,
      backoffMultiplier: this.backoffMultiplier
    };
  }
}

/**
 * Track and ban misbehaving peers
 */
class PeerBanManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.banDuration = options.banDuration || 30 * 60 * 1000; // 30 minutes
    this.maxStrikes = options.maxStrikes || 3;
    this.strikeDecay = options.strikeDecay || 10 * 60 * 1000; // 10 minutes
    
    // peerId -> { strikes: Array<{ reason, timestamp }>, bannedAt, banReason }
    this._peers = new Map();
    
    // Start cleanup interval
    this._cleanupInterval = setInterval(() => {
      this.cleanExpired();
      this._decayStrikes();
    }, 60000); // Every minute
    
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  }
  
  /**
   * Adds strike to peer
   * @param {string} peerId
   * @param {string} reason
   * @returns {boolean} True if peer is now banned
   */
  strike(peerId, reason) {
    const peerData = this._getOrCreatePeer(peerId);
    
    // Don't add strikes if already banned
    if (peerData.bannedAt) {
      return true;
    }
    
    // Add strike
    peerData.strikes.push({
      reason,
      timestamp: Date.now()
    });
    
    console.log(`[PeerBanManager] Strike ${peerData.strikes.length}/${this.maxStrikes} for ${peerId}: ${reason}`);
    
    this.emit('peer:strike', { 
      peerId, 
      reason, 
      strikes: peerData.strikes.length,
      maxStrikes: this.maxStrikes
    });
    
    // Check if should ban
    if (peerData.strikes.length >= this.maxStrikes) {
      this._banPeer(peerId, reason);
      return true;
    }
    
    return false;
  }
  
  /**
   * Bans a peer
   * @private
   */
  _banPeer(peerId, reason) {
    const peerData = this._getOrCreatePeer(peerId);
    
    peerData.bannedAt = Date.now();
    peerData.banReason = reason;
    peerData.expiresAt = Date.now() + this.banDuration;
    
    console.log(`[PeerBanManager] Banned ${peerId} for ${reason} (expires: ${new Date(peerData.expiresAt).toISOString()})`);
    
    this.emit('peer:banned', {
      peerId,
      reason,
      bannedAt: peerData.bannedAt,
      expiresAt: peerData.expiresAt,
      duration: this.banDuration
    });
  }
  
  /**
   * Checks if peer is banned
   * @param {string} peerId
   * @returns {boolean}
   */
  isBanned(peerId) {
    const peerData = this._peers.get(peerId);
    
    if (!peerData || !peerData.bannedAt) {
      return false;
    }
    
    // Check if ban expired
    if (Date.now() > peerData.expiresAt) {
      this.unban(peerId);
      return false;
    }
    
    return true;
  }
  
  /**
   * Unbans a peer
   * @param {string} peerId
   */
  unban(peerId) {
    const peerData = this._peers.get(peerId);
    
    if (peerData && peerData.bannedAt) {
      console.log(`[PeerBanManager] Unbanned ${peerId}`);
      
      peerData.bannedAt = null;
      peerData.banReason = null;
      peerData.expiresAt = null;
      peerData.strikes = [];
      
      this.emit('peer:unbanned', { peerId });
    }
  }
  
  /**
   * Gets list of banned peers
   * @returns {Array}
   */
  getBanList() {
    const banList = [];
    
    for (const [peerId, data] of this._peers.entries()) {
      if (data.bannedAt && Date.now() <= data.expiresAt) {
        banList.push({
          peerId,
          bannedAt: data.bannedAt,
          reason: data.banReason,
          expiresAt: data.expiresAt,
          timeRemaining: data.expiresAt - Date.now()
        });
      }
    }
    
    return banList;
  }
  
  /**
   * Gets peer strikes
   * @param {string} peerId
   * @returns {Array}
   */
  getStrikes(peerId) {
    const peerData = this._peers.get(peerId);
    return peerData ? peerData.strikes : [];
  }
  
  /**
   * Cleans expired bans
   */
  cleanExpired() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [peerId, data] of this._peers.entries()) {
      if (data.bannedAt && now > data.expiresAt) {
        this.unban(peerId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[PeerBanManager] Cleaned ${cleaned} expired bans`);
    }
  }
  
  /**
   * Decays old strikes
   * @private
   */
  _decayStrikes() {
    const now = Date.now();
    const cutoff = now - this.strikeDecay;
    
    for (const [peerId, data] of this._peers.entries()) {
      if (data.bannedAt) continue; // Don't decay strikes for banned peers
      
      const oldLength = data.strikes.length;
      data.strikes = data.strikes.filter(strike => strike.timestamp > cutoff);
      
      const decayed = oldLength - data.strikes.length;
      if (decayed > 0) {
        console.log(`[PeerBanManager] Decayed ${decayed} strikes for ${peerId}`);
        this.emit('peer:strike:decayed', { peerId, decayed });
      }
    }
  }
  
  /**
   * Gets or creates peer data
   * @private
   */
  _getOrCreatePeer(peerId) {
    if (!this._peers.has(peerId)) {
      this._peers.set(peerId, {
        strikes: [],
        bannedAt: null,
        banReason: null,
        expiresAt: null
      });
    }
    
    return this._peers.get(peerId);
  }
  
  /**
   * Gets statistics
   * @returns {Object}
   */
  getStats() {
    const bannedCount = Array.from(this._peers.values())
      .filter(p => p.bannedAt && Date.now() <= p.expiresAt).length;
    
    const peersWithStrikes = Array.from(this._peers.values())
      .filter(p => p.strikes.length > 0 && !p.bannedAt).length;
    
    return {
      totalPeers: this._peers.size,
      bannedPeers: bannedCount,
      peersWithStrikes,
      maxStrikes: this.maxStrikes,
      banDuration: this.banDuration,
      strikeDecay: this.strikeDecay
    };
  }
  
  /**
   * Cleans up resources
   */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    
    this._peers.clear();
    this.removeAllListeners();
  }
}

/**
 * Track timeouts and slow peers
 */
class TimeoutManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.requestTimeout = options.requestTimeout || 30000; // 30 seconds
    this.handshakeTimeout = options.handshakeTimeout || 10000; // 10 seconds
    this.keepaliveInterval = options.keepaliveInterval || 120000; // 2 minutes
    
    // requestId -> { peerId, pieceIndex, offset, startTime, type }
    this._requests = new Map();
    
    // peerId -> { rtts: [], timeouts: number, lastActivity: timestamp }
    this._peerStats = new Map();
    
    // Start timeout checker
    this._checkInterval = setInterval(() => {
      this._checkTimeouts();
    }, 5000); // Check every 5 seconds
    
    if (this._checkInterval.unref) {
      this._checkInterval.unref();
    }
  }
  
  /**
   * Tracks a piece request
   * @param {string} peerId
   * @param {number} pieceIndex
   * @param {number} offset
   * @param {string} type - 'piece' or 'handshake'
   * @returns {string} Request ID
   */
  trackRequest(peerId, pieceIndex, offset, type = 'piece') {
    const requestId = `${peerId}-${pieceIndex}-${offset}-${Date.now()}`;
    
    this._requests.set(requestId, {
      peerId,
      pieceIndex,
      offset,
      startTime: Date.now(),
      type
    });
    
    // Initialize peer stats if needed
    if (!this._peerStats.has(peerId)) {
      this._peerStats.set(peerId, {
        rtts: [],
        timeouts: 0,
        lastActivity: Date.now()
      });
    }
    
    return requestId;
  }
  
  /**
   * Marks request as complete
   * @param {string} requestId
   * @returns {number} RTT in milliseconds
   */
  completeRequest(requestId) {
    const request = this._requests.get(requestId);
    
    if (!request) {
      return -1;
    }
    
    const rtt = Date.now() - request.startTime;
    
    // Update peer stats
    const peerStats = this._peerStats.get(request.peerId);
    if (peerStats) {
      peerStats.rtts.push(rtt);
      peerStats.lastActivity = Date.now();
      
      // Keep only last 100 RTTs
      if (peerStats.rtts.length > 100) {
        peerStats.rtts.shift();
      }
    }
    
    // Remove request
    this._requests.delete(requestId);
    
    return rtt;
  }
  
  /**
   * Checks if request is timed out
   * @param {string} requestId
   * @returns {boolean}
   */
  isTimedOut(requestId) {
    const request = this._requests.get(requestId);
    
    if (!request) {
      return false;
    }
    
    const timeout = request.type === 'handshake' 
      ? this.handshakeTimeout 
      : this.requestTimeout;
    
    return Date.now() - request.startTime > timeout;
  }
  
  /**
   * Gets slow peers
   * @returns {Array}
   */
  getSlowPeers() {
    const slowPeers = [];
    
    for (const [peerId, stats] of this._peerStats.entries()) {
      if (stats.rtts.length === 0) continue;
      
      const avgRtt = stats.rtts.reduce((a, b) => a + b, 0) / stats.rtts.length;
      
      // Consider slow if avg RTT > 5 seconds or has timeouts
      if (avgRtt > 5000 || stats.timeouts > 0) {
        slowPeers.push({
          peerId,
          avgRtt,
          timeouts: stats.timeouts,
          samples: stats.rtts.length
        });
      }
    }
    
    // Sort by avgRtt descending
    return slowPeers.sort((a, b) => b.avgRtt - a.avgRtt);
  }
  
  /**
   * Gets peer RTT
   * @param {string} peerId
   * @returns {number} Average RTT
   */
  getPeerRTT(peerId) {
    const stats = this._peerStats.get(peerId);
    
    if (!stats || stats.rtts.length === 0) {
      return -1;
    }
    
    return stats.rtts.reduce((a, b) => a + b, 0) / stats.rtts.length;
  }
  
  /**
   * Checks for timed out requests
   * @private
   */
  _checkTimeouts() {
    const now = Date.now();
    const timedOut = [];
    
    for (const [requestId, request] of this._requests.entries()) {
      const timeout = request.type === 'handshake' 
        ? this.handshakeTimeout 
        : this.requestTimeout;
      
      if (now - request.startTime > timeout) {
        timedOut.push({ requestId, request });
      }
    }
    
    // Process timeouts
    for (const { requestId, request } of timedOut) {
      console.warn(`[TimeoutManager] Request timed out: ${requestId} (${request.type})`);
      
      // Update peer stats
      const peerStats = this._peerStats.get(request.peerId);
      if (peerStats) {
        peerStats.timeouts++;
      }
      
      // Emit timeout event
      this.emit('request:timeout', {
        requestId,
        peerId: request.peerId,
        pieceIndex: request.pieceIndex,
        offset: request.offset,
        type: request.type,
        duration: now - request.startTime
      });
      
      // Remove request
      this._requests.delete(requestId);
    }
  }
  
  /**
   * Checks if peer needs keepalive
   * @param {string} peerId
   * @returns {boolean}
   */
  needsKeepalive(peerId) {
    const stats = this._peerStats.get(peerId);
    
    if (!stats) {
      return false;
    }
    
    return Date.now() - stats.lastActivity > this.keepaliveInterval;
  }
  
  /**
   * Updates peer activity
   * @param {string} peerId
   */
  updateActivity(peerId) {
    const stats = this._peerStats.get(peerId);
    
    if (stats) {
      stats.lastActivity = Date.now();
    } else {
      this._peerStats.set(peerId, {
        rtts: [],
        timeouts: 0,
        lastActivity: Date.now()
      });
    }
  }
  
  /**
   * Removes peer tracking
   * @param {string} peerId
   */
  removePeer(peerId) {
    // Remove all requests for this peer
    for (const [requestId, request] of this._requests.entries()) {
      if (request.peerId === peerId) {
        this._requests.delete(requestId);
      }
    }
    
    // Remove peer stats
    this._peerStats.delete(peerId);
  }
  
  /**
   * Gets statistics
   * @returns {Object}
   */
  getStats() {
    const activeRequests = this._requests.size;
    const totalTimeouts = Array.from(this._peerStats.values())
      .reduce((sum, stats) => sum + stats.timeouts, 0);
    
    const avgRtt = this._calculateAverageRTT();
    
    return {
      activeRequests,
      totalPeers: this._peerStats.size,
      totalTimeouts,
      avgRtt,
      requestTimeout: this.requestTimeout,
      handshakeTimeout: this.handshakeTimeout,
      keepaliveInterval: this.keepaliveInterval
    };
  }
  
  /**
   * Calculates average RTT across all peers
   * @private
   */
  _calculateAverageRTT() {
    let totalRtt = 0;
    let totalSamples = 0;
    
    for (const stats of this._peerStats.values()) {
      if (stats.rtts.length > 0) {
        totalRtt += stats.rtts.reduce((a, b) => a + b, 0);
        totalSamples += stats.rtts.length;
      }
    }
    
    return totalSamples > 0 ? totalRtt / totalSamples : 0;
  }
  
  /**
   * Cleans up resources
   */
  destroy() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
    
    this._requests.clear();
    this._peerStats.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  RetryManager,
  PeerBanManager,
  TimeoutManager
};
