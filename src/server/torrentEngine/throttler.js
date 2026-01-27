const EventEmitter = require('events');

/**
 * Token bucket throttler for bandwidth limiting
 */
class Throttler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.downloadLimit = options.downloadLimit || 0; // 0 = unlimited
    this.uploadLimit = options.uploadLimit || 0; // 0 = unlimited
    this.interval = options.interval || 100; // Token refill interval (ms)
    
    // Token buckets (current available tokens in bytes)
    this.downloadTokens = 0;
    this.uploadTokens = 0;
    
    // Maximum bucket capacity (1 second worth of tokens for bursts)
    this._maxDownloadTokens = this.downloadLimit;
    this._maxUploadTokens = this.uploadLimit;
    
    // Token refill timer
    this._refillTimer = null;
    this._isPaused = false;
    
    // Rate tracking
    this._downloadBytesThisSecond = 0;
    this._uploadBytesThisSecond = 0;
    this._downloadRate = 0;
    this._uploadRate = 0;
    this._rateResetTimer = null;
    
    // Queues for waiting requests
    this._downloadQueue = [];
    this._uploadQueue = [];
    
    // Start token refill
    this._startRefill();
    this._startRateTracking();
  }
  
  /**
   * Requests permission to download bytes
   * @param {number} bytes - Number of bytes to download
   * @returns {Promise<number>} Number of bytes allowed (may be less than requested)
   */
  async requestDownload(bytes) {
    // Unlimited
    if (this.downloadLimit === 0) {
      this._trackDownload(bytes);
      return bytes;
    }
    
    // If paused, wait
    if (this._isPaused) {
      await this._waitForResume();
    }
    
    // If tokens available, grant immediately
    if (this.downloadTokens >= bytes) {
      this.downloadTokens -= bytes;
      this._trackDownload(bytes);
      return bytes;
    }
    
    // Partial grant if some tokens available
    if (this.downloadTokens > 0) {
      const allowed = Math.floor(this.downloadTokens);
      this.downloadTokens = 0;
      this._trackDownload(allowed);
      return allowed;
    }
    
    // Wait for tokens to be refilled
    return new Promise((resolve) => {
      this._downloadQueue.push({ bytes, resolve });
    });
  }
  
  /**
   * Requests permission to upload bytes
   * @param {number} bytes - Number of bytes to upload
   * @returns {Promise<number>} Number of bytes allowed
   */
  async requestUpload(bytes) {
    // Unlimited
    if (this.uploadLimit === 0) {
      this._trackUpload(bytes);
      return bytes;
    }
    
    // If paused, wait
    if (this._isPaused) {
      await this._waitForResume();
    }
    
    // If tokens available, grant immediately
    if (this.uploadTokens >= bytes) {
      this.uploadTokens -= bytes;
      this._trackUpload(bytes);
      return bytes;
    }
    
    // Partial grant if some tokens available
    if (this.uploadTokens > 0) {
      const allowed = Math.floor(this.uploadTokens);
      this.uploadTokens = 0;
      this._trackUpload(allowed);
      return allowed;
    }
    
    // Wait for tokens
    return new Promise((resolve) => {
      this._uploadQueue.push({ bytes, resolve });
    });
  }
  
  /**
   * Sets download limit
   * @param {number} bytesPerSecond - Limit in bytes/second (0 = unlimited)
   */
  setDownloadLimit(bytesPerSecond) {
    this.downloadLimit = bytesPerSecond;
    this._maxDownloadTokens = bytesPerSecond;
    
    // Cap current tokens to new limit
    if (this.downloadTokens > this._maxDownloadTokens) {
      this.downloadTokens = this._maxDownloadTokens;
    }
    
    this.emit('limit:changed', { type: 'download', limit: bytesPerSecond });
  }
  
  /**
   * Sets upload limit
   * @param {number} bytesPerSecond - Limit in bytes/second (0 = unlimited)
   */
  setUploadLimit(bytesPerSecond) {
    this.uploadLimit = bytesPerSecond;
    this._maxUploadTokens = bytesPerSecond;
    
    // Cap current tokens to new limit
    if (this.uploadTokens > this._maxUploadTokens) {
      this.uploadTokens = this._maxUploadTokens;
    }
    
    this.emit('limit:changed', { type: 'upload', limit: bytesPerSecond });
  }
  
  /**
   * Gets throttler statistics
   * @returns {Object}
   */
  getStats() {
    return {
      downloadLimit: this.downloadLimit,
      uploadLimit: this.uploadLimit,
      downloadTokens: Math.floor(this.downloadTokens),
      uploadTokens: Math.floor(this.uploadTokens),
      downloadRate: this._downloadRate,
      uploadRate: this._uploadRate,
      downloadQueueLength: this._downloadQueue.length,
      uploadQueueLength: this._uploadQueue.length,
      isPaused: this._isPaused
    };
  }
  
  /**
   * Pauses throttler (stops token refill)
   */
  pause() {
    if (this._isPaused) return;
    
    this._isPaused = true;
    this.emit('paused');
  }
  
  /**
   * Resumes throttler
   */
  resume() {
    if (!this._isPaused) return;
    
    this._isPaused = false;
    this.emit('resumed');
  }
  
  /**
   * Starts token refill interval
   * @private
   */
  _startRefill() {
    if (this._refillTimer) {
      clearInterval(this._refillTimer);
    }
    
    this._refillTimer = setInterval(() => {
      if (this._isPaused) return;
      
      // Calculate tokens to add based on interval
      const intervalSeconds = this.interval / 1000;
      
      // Refill download tokens
      if (this.downloadLimit > 0) {
        const downloadTokensToAdd = this.downloadLimit * intervalSeconds;
        this.downloadTokens = Math.min(
          this.downloadTokens + downloadTokensToAdd,
          this._maxDownloadTokens
        );
        
        // Process download queue
        this._processQueue(this._downloadQueue, 'downloadTokens');
      }
      
      // Refill upload tokens
      if (this.uploadLimit > 0) {
        const uploadTokensToAdd = this.uploadLimit * intervalSeconds;
        this.uploadTokens = Math.min(
          this.uploadTokens + uploadTokensToAdd,
          this._maxUploadTokens
        );
        
        // Process upload queue
        this._processQueue(this._uploadQueue, 'uploadTokens');
      }
    }, this.interval);
    
    // Don't keep process alive
    if (this._refillTimer.unref) {
      this._refillTimer.unref();
    }
  }
  
  /**
   * Starts rate tracking
   * @private
   */
  _startRateTracking() {
    if (this._rateResetTimer) {
      clearInterval(this._rateResetTimer);
    }
    
    this._rateResetTimer = setInterval(() => {
      this._downloadRate = this._downloadBytesThisSecond;
      this._uploadRate = this._uploadBytesThisSecond;
      
      this._downloadBytesThisSecond = 0;
      this._uploadBytesThisSecond = 0;
    }, 1000);
    
    if (this._rateResetTimer.unref) {
      this._rateResetTimer.unref();
    }
  }
  
  /**
   * Processes waiting queue
   * @private
   */
  _processQueue(queue, tokensProperty) {
    while (queue.length > 0 && this[tokensProperty] > 0) {
      const request = queue[0];
      
      if (this[tokensProperty] >= request.bytes) {
        // Grant full request
        queue.shift();
        this[tokensProperty] -= request.bytes;
        
        if (tokensProperty === 'downloadTokens') {
          this._trackDownload(request.bytes);
        } else {
          this._trackUpload(request.bytes);
        }
        
        request.resolve(request.bytes);
      } else if (this[tokensProperty] > 0) {
        // Grant partial request
        const allowed = Math.floor(this[tokensProperty]);
        queue.shift();
        this[tokensProperty] = 0;
        
        if (tokensProperty === 'downloadTokens') {
          this._trackDownload(allowed);
        } else {
          this._trackUpload(allowed);
        }
        
        request.resolve(allowed);
        break;
      } else {
        break;
      }
    }
  }
  
  /**
   * Tracks download for rate calculation
   * @private
   */
  _trackDownload(bytes) {
    this._downloadBytesThisSecond += bytes;
  }
  
  /**
   * Tracks upload for rate calculation
   * @private
   */
  _trackUpload(bytes) {
    this._uploadBytesThisSecond += bytes;
  }
  
  /**
   * Waits for throttler to be resumed
   * @private
   */
  _waitForResume() {
    return new Promise((resolve) => {
      const checkResume = () => {
        if (!this._isPaused) {
          resolve();
        } else {
          setTimeout(checkResume, 50);
        }
      };
      checkResume();
    });
  }
  
  /**
   * Cleans up timers
   */
  destroy() {
    if (this._refillTimer) {
      clearInterval(this._refillTimer);
      this._refillTimer = null;
    }
    
    if (this._rateResetTimer) {
      clearInterval(this._rateResetTimer);
      this._rateResetTimer = null;
    }
    
    // Reject all pending requests
    for (const request of this._downloadQueue) {
      request.resolve(0);
    }
    
    for (const request of this._uploadQueue) {
      request.resolve(0);
    }
    
    this._downloadQueue = [];
    this._uploadQueue = [];
  }
}

/**
 * Global throttler with fair bandwidth distribution across torrents
 */
class GlobalThrottler extends Throttler {
  constructor(options = {}) {
    super(options);
    
    // Torrent allocations: torrentId -> { downloadShare, uploadShare }
    this._allocations = new Map();
    
    // Total shares
    this._totalDownloadShares = 0;
    this._totalUploadShares = 0;
  }
  
  /**
   * Allocates bandwidth share to a torrent
   * @param {string} torrentId
   * @param {number} downloadShare - Relative weight (default 1.0)
   * @param {number} uploadShare - Relative weight (default 1.0)
   */
  allocate(torrentId, downloadShare = 1.0, uploadShare = 1.0) {
    if (this._allocations.has(torrentId)) {
      // Update existing allocation
      const existing = this._allocations.get(torrentId);
      this._totalDownloadShares -= existing.downloadShare;
      this._totalUploadShares -= existing.uploadShare;
    }
    
    this._allocations.set(torrentId, { downloadShare, uploadShare });
    this._totalDownloadShares += downloadShare;
    this._totalUploadShares += uploadShare;
    
    console.log(`[GlobalThrottler] Allocated: ${torrentId} (DL: ${downloadShare}, UL: ${uploadShare})`);
    this.emit('allocation:changed');
  }
  
  /**
   * Deallocates torrent bandwidth
   * @param {string} torrentId
   */
  deallocate(torrentId) {
    const allocation = this._allocations.get(torrentId);
    
    if (allocation) {
      this._totalDownloadShares -= allocation.downloadShare;
      this._totalUploadShares -= allocation.uploadShare;
      this._allocations.delete(torrentId);
      
      console.log(`[GlobalThrottler] Deallocated: ${torrentId}`);
      this.emit('allocation:changed');
    }
  }
  
  /**
   * Gets bandwidth allocation for a torrent
   * @param {string} torrentId
   * @returns {Object} { downloadLimit, uploadLimit }
   */
  getAllocation(torrentId) {
    const allocation = this._allocations.get(torrentId);
    
    if (!allocation || this._totalDownloadShares === 0 || this._totalUploadShares === 0) {
      return {
        downloadLimit: 0,
        uploadLimit: 0
      };
    }
    
    // Calculate fair share
    const downloadLimit = this.downloadLimit > 0
      ? (this.downloadLimit * allocation.downloadShare) / this._totalDownloadShares
      : 0;
    
    const uploadLimit = this.uploadLimit > 0
      ? (this.uploadLimit * allocation.uploadShare) / this._totalUploadShares
      : 0;
    
    return { downloadLimit, uploadLimit };
  }
  
  /**
   * Gets all allocations
   * @returns {Map}
   */
  getAllocations() {
    return new Map(this._allocations);
  }
  
  /**
   * Gets statistics including allocations
   * @returns {Object}
   */
  getStats() {
    const baseStats = super.getStats();
    
    return {
      ...baseStats,
      allocations: this._allocations.size,
      totalDownloadShares: this._totalDownloadShares,
      totalUploadShares: this._totalUploadShares
    };
  }
}

/**
 * Per-torrent throttler that respects global limits
 */
class TorrentThrottler extends Throttler {
  constructor(options = {}) {
    super(options);
    
    this.globalThrottler = options.globalThrottler;
    this.torrentId = options.torrentId;
    
    // Per-torrent limits (in addition to global)
    this._perTorrentDownloadLimit = options.downloadLimit || 0;
    this._perTorrentUploadLimit = options.uploadLimit || 0;
    
    // Register with global throttler
    if (this.globalThrottler && this.torrentId) {
      this.globalThrottler.allocate(
        this.torrentId,
        options.downloadShare || 1.0,
        options.uploadShare || 1.0
      );
      
      // Update limits based on global allocation
      this._updateEffectiveLimits();
      
      // Listen for global allocation changes
      this.globalThrottler.on('allocation:changed', () => {
        this._updateEffectiveLimits();
      });
    }
  }
  
  /**
   * Updates effective limits based on global allocation
   * @private
   */
  _updateEffectiveLimits() {
    if (!this.globalThrottler || !this.torrentId) return;
    
    const allocation = this.globalThrottler.getAllocation(this.torrentId);
    
    // Effective limit is minimum of per-torrent and allocated global
    if (this._perTorrentDownloadLimit > 0 && allocation.downloadLimit > 0) {
      this.downloadLimit = Math.min(this._perTorrentDownloadLimit, allocation.downloadLimit);
    } else if (this._perTorrentDownloadLimit > 0) {
      this.downloadLimit = this._perTorrentDownloadLimit;
    } else if (allocation.downloadLimit > 0) {
      this.downloadLimit = allocation.downloadLimit;
    } else {
      this.downloadLimit = 0; // Unlimited
    }
    
    if (this._perTorrentUploadLimit > 0 && allocation.uploadLimit > 0) {
      this.uploadLimit = Math.min(this._perTorrentUploadLimit, allocation.uploadLimit);
    } else if (this._perTorrentUploadLimit > 0) {
      this.uploadLimit = this._perTorrentUploadLimit;
    } else if (allocation.uploadLimit > 0) {
      this.uploadLimit = allocation.uploadLimit;
    } else {
      this.uploadLimit = 0; // Unlimited
    }
    
    // Update max token capacities
    this._maxDownloadTokens = this.downloadLimit;
    this._maxUploadTokens = this.uploadLimit;
  }
  
  /**
   * Requests download with global throttler awareness
   * @param {number} bytes
   * @returns {Promise<number>}
   */
  async requestDownload(bytes) {
    // Request from global throttler first (if exists)
    if (this.globalThrottler) {
      const globalAllowed = await this.globalThrottler.requestDownload(bytes);
      
      // Then apply per-torrent limit
      return super.requestDownload(globalAllowed);
    }
    
    return super.requestDownload(bytes);
  }
  
  /**
   * Requests upload with global throttler awareness
   * @param {number} bytes
   * @returns {Promise<number>}
   */
  async requestUpload(bytes) {
    // Request from global throttler first (if exists)
    if (this.globalThrottler) {
      const globalAllowed = await this.globalThrottler.requestUpload(bytes);
      
      // Then apply per-torrent limit
      return super.requestUpload(globalAllowed);
    }
    
    return super.requestUpload(bytes);
  }
  
  /**
   * Sets per-torrent download limit
   * @param {number} bytesPerSecond
   */
  setDownloadLimit(bytesPerSecond) {
    this._perTorrentDownloadLimit = bytesPerSecond;
    this._updateEffectiveLimits();
  }
  
  /**
   * Sets per-torrent upload limit
   * @param {number} bytesPerSecond
   */
  setUploadLimit(bytesPerSecond) {
    this._perTorrentUploadLimit = bytesPerSecond;
    this._updateEffectiveLimits();
  }
  
  /**
   * Gets statistics including global info
   * @returns {Object}
   */
  getStats() {
    const baseStats = super.getStats();
    
    return {
      ...baseStats,
      perTorrentDownloadLimit: this._perTorrentDownloadLimit,
      perTorrentUploadLimit: this._perTorrentUploadLimit,
      hasGlobalThrottler: !!this.globalThrottler
    };
  }
  
  /**
   * Cleanup and deregister from global throttler
   */
  destroy() {
    if (this.globalThrottler && this.torrentId) {
      this.globalThrottler.deallocate(this.torrentId);
    }
    
    super.destroy();
  }
}

/**
 * Helper functions for integration with peer connections
 */

/**
 * Reads from socket with throttling
 * @param {Socket} socket
 * @param {Throttler} throttler
 * @param {number} bytes
 * @returns {Promise<Buffer>}
 */
async function readThrottled(socket, throttler, bytes) {
  if (!throttler) {
    return socket.read(bytes);
  }
  
  const allowed = await throttler.requestDownload(bytes);
  return socket.read(allowed);
}

/**
 * Writes to socket with throttling
 * @param {Socket} socket
 * @param {Throttler} throttler
 * @param {Buffer} data
 * @returns {Promise<void>}
 */
async function writeThrottled(socket, throttler, data) {
  if (!throttler) {
    return socket.write(data);
  }
  
  let offset = 0;
  
  while (offset < data.length) {
    const remaining = data.length - offset;
    const allowed = await throttler.requestUpload(remaining);
    
    if (allowed > 0) {
      const chunk = data.slice(offset, offset + allowed);
      await new Promise((resolve, reject) => {
        socket.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      
      offset += allowed;
    } else {
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

module.exports = {
  Throttler,
  GlobalThrottler,
  TorrentThrottler,
  readThrottled,
  writeThrottled
};
