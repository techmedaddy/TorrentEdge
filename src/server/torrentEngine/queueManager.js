const EventEmitter = require('events');

/**
 * Manages torrent download queue with priority and concurrency control
 */
class QueueManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.maxConcurrent = options.maxConcurrent || 3;
    this.maxConnectionsTotal = options.maxConnectionsTotal || 200;
    this.maxConnectionsPerTorrent = options.maxConnectionsPerTorrent || 50;
    this.onQueueChange = options.onQueueChange || null;
    
    // Queue storage
    this.queue = []; // Array of QueuedTorrent objects
    this.active = new Map(); // infoHash -> Torrent
    this.paused = new Map(); // infoHash -> Torrent
    this.completed = new Map(); // infoHash -> Torrent
    
    // Connection tracking
    this.totalConnections = 0;
    
    // Position counter for queue ordering
    this._nextPosition = 0;
  }
  
  /**
   * Adds a torrent to the queue
   * @param {Torrent} torrent - Torrent instance
   * @param {Object} options - { priority?: 'low' | 'normal' | 'high', startPaused?: boolean }
   */
  add(torrent, options = {}) {
    const infoHash = torrent.infoHash;
    
    // Check if already exists
    if (this._exists(infoHash)) {
      throw new Error(`Torrent ${infoHash} already exists in queue manager`);
    }
    
    const priority = options.priority || 'normal';
    const startPaused = options.startPaused || false;
    
    // Create queued torrent object
    const queuedTorrent = {
      infoHash,
      torrent,
      priority,
      addedAt: Date.now(),
      position: this._nextPosition++
    };
    
    // Setup torrent event listeners
    this._setupTorrentListeners(torrent);
    
    if (startPaused) {
      // Add to paused map
      this.paused.set(infoHash, torrent);
      
      this.emit('queue:add', {
        infoHash,
        name: torrent.name,
        priority,
        status: 'paused'
      });
    } else if (this._canActivate()) {
      // Start immediately if under limit
      this.active.set(infoHash, torrent);
      this._startTorrent(torrent);
      
      this.emit('queue:start', {
        infoHash,
        name: torrent.name,
        priority
      });
    } else {
      // Add to queue
      this.queue.push(queuedTorrent);
      this._sortQueue();
      
      this.emit('queue:add', {
        infoHash,
        name: torrent.name,
        priority,
        position: this._getQueuePosition(infoHash),
        status: 'queued'
      });
    }
    
    this._notifyQueueChange();
  }
  
  /**
   * Removes a torrent from queue/active/paused/completed
   * @param {string} infoHash
   * @returns {boolean} Success
   */
  remove(infoHash) {
    let removed = false;
    let status = null;
    
    // Check active
    if (this.active.has(infoHash)) {
      const torrent = this.active.get(infoHash);
      this._stopTorrent(torrent);
      this._removeTorrentListeners(torrent);
      this.active.delete(infoHash);
      removed = true;
      status = 'active';
      
      // Process queue to start next torrent
      this._processQueue();
    }
    
    // Check paused
    if (this.paused.has(infoHash)) {
      const torrent = this.paused.get(infoHash);
      this._removeTorrentListeners(torrent);
      this.paused.delete(infoHash);
      removed = true;
      status = 'paused';
    }
    
    // Check completed
    if (this.completed.has(infoHash)) {
      const torrent = this.completed.get(infoHash);
      this._removeTorrentListeners(torrent);
      this.completed.delete(infoHash);
      removed = true;
      status = 'completed';
    }
    
    // Check queue
    const queueIndex = this.queue.findIndex(q => q.infoHash === infoHash);
    if (queueIndex !== -1) {
      const queuedTorrent = this.queue[queueIndex];
      this._removeTorrentListeners(queuedTorrent.torrent);
      this.queue.splice(queueIndex, 1);
      removed = true;
      status = 'queued';
    }
    
    if (removed) {
      this.emit('queue:remove', { infoHash, status });
      this._notifyQueueChange();
    }
    
    return removed;
  }
  
  /**
   * Starts a paused or queued torrent
   * @param {string} infoHash
   * @returns {boolean} Success
   */
  start(infoHash) {
    // Check if paused
    if (this.paused.has(infoHash)) {
      const torrent = this.paused.get(infoHash);
      this.paused.delete(infoHash);
      
      if (this._canActivate()) {
        // Start immediately
        this.active.set(infoHash, torrent);
        this._startTorrent(torrent);
        
        this.emit('queue:start', {
          infoHash,
          name: torrent.name,
          from: 'paused'
        });
        
        this._notifyQueueChange();
        return true;
      } else {
        // Move to front of queue
        const queuedTorrent = {
          infoHash,
          torrent,
          priority: 'high',
          addedAt: Date.now(),
          position: this._nextPosition++
        };
        this.queue.unshift(queuedTorrent);
        this._sortQueue();
        
        this.emit('queue:reorder', {
          infoHash,
          position: 0,
          from: 'paused'
        });
        
        this._notifyQueueChange();
        return true;
      }
    }
    
    // Check if queued - move to front
    const queueIndex = this.queue.findIndex(q => q.infoHash === infoHash);
    if (queueIndex !== -1) {
      const queuedTorrent = this.queue[queueIndex];
      queuedTorrent.priority = 'high';
      queuedTorrent.addedAt = Date.now();
      this._sortQueue();
      
      // Try to process queue
      this._processQueue();
      
      this.emit('queue:reorder', {
        infoHash,
        position: this._getQueuePosition(infoHash),
        priority: 'high'
      });
      
      this._notifyQueueChange();
      return true;
    }
    
    // Already active or completed
    return false;
  }
  
  /**
   * Pauses an active torrent
   * @param {string} infoHash
   * @returns {boolean} Success
   */
  pause(infoHash) {
    if (!this.active.has(infoHash)) {
      return false;
    }
    
    const torrent = this.active.get(infoHash);
    this.active.delete(infoHash);
    
    // Pause the torrent
    this._pauseTorrent(torrent);
    
    // Move to paused map
    this.paused.set(infoHash, torrent);
    
    this.emit('queue:pause', {
      infoHash,
      name: torrent.name
    });
    
    // Process queue to start next torrent
    this._processQueue();
    
    this._notifyQueueChange();
    return true;
  }
  
  /**
   * Updates max concurrent limit
   * @param {number} max
   */
  setMaxConcurrent(max) {
    if (max < 1) {
      throw new Error('maxConcurrent must be at least 1');
    }
    
    const oldMax = this.maxConcurrent;
    this.maxConcurrent = max;
    
    if (max > oldMax) {
      // Increased limit - process queue
      this._processQueue();
    } else if (max < oldMax && this.active.size > max) {
      // Decreased limit - pause excess active torrents
      const excess = this.active.size - max;
      const toMove = Array.from(this.active.entries())
        .slice(-excess)
        .map(([infoHash]) => infoHash);
      
      for (const infoHash of toMove) {
        this.pause(infoHash);
      }
    }
    
    this._notifyQueueChange();
  }
  
  /**
   * Sets priority for a torrent
   * @param {string} infoHash
   * @param {'low' | 'normal' | 'high'} priority
   */
  setPriority(infoHash, priority) {
    const validPriorities = ['low', 'normal', 'high'];
    if (!validPriorities.includes(priority)) {
      throw new Error(`Invalid priority: ${priority}. Must be one of: ${validPriorities.join(', ')}`);
    }
    
    // Find in queue
    const queueIndex = this.queue.findIndex(q => q.infoHash === infoHash);
    if (queueIndex === -1) {
      return false;
    }
    
    const queuedTorrent = this.queue[queueIndex];
    const oldPriority = queuedTorrent.priority;
    
    if (oldPriority === priority) {
      return true; // No change
    }
    
    queuedTorrent.priority = priority;
    this._sortQueue();
    
    this.emit('queue:reorder', {
      infoHash,
      oldPriority,
      newPriority: priority,
      position: this._getQueuePosition(infoHash)
    });
    
    this._notifyQueueChange();
    return true;
  }
  
  /**
   * Moves a torrent to a specific position in queue
   * @param {string} infoHash
   * @param {number} newPosition
   */
  moveInQueue(infoHash, newPosition) {
    const queueIndex = this.queue.findIndex(q => q.infoHash === infoHash);
    if (queueIndex === -1) {
      throw new Error(`Torrent ${infoHash} not found in queue`);
    }
    
    if (newPosition < 0 || newPosition >= this.queue.length) {
      throw new Error(`Invalid position: ${newPosition}. Must be 0-${this.queue.length - 1}`);
    }
    
    // Remove from current position
    const [queuedTorrent] = this.queue.splice(queueIndex, 1);
    
    // Insert at new position
    this.queue.splice(newPosition, 0, queuedTorrent);
    
    this.emit('queue:reorder', {
      infoHash,
      oldPosition: queueIndex,
      newPosition
    });
    
    this._notifyQueueChange();
  }
  
  /**
   * Gets queue statistics
   * @returns {Object} Statistics
   */
  getStats() {
    let totalDownloadSpeed = 0;
    let totalUploadSpeed = 0;
    let totalConnections = 0;
    
    // Calculate from active torrents
    for (const torrent of this.active.values()) {
      totalDownloadSpeed += torrent.downloadSpeed || 0;
      totalUploadSpeed += torrent.uploadSpeed || 0;
      
      if (torrent.peers) {
        totalConnections += torrent.peers.connected || 0;
      }
    }
    
    return {
      activeCount: this.active.size,
      queuedCount: this.queue.length,
      pausedCount: this.paused.size,
      completedCount: this.completed.size,
      totalDownloadSpeed,
      totalUploadSpeed,
      totalConnections,
      maxConcurrent: this.maxConcurrent
    };
  }
  
  /**
   * Gets all torrents with status
   * @returns {Array<Object>} Torrent info array
   */
  getAll() {
    const result = [];
    
    // Active torrents
    for (const [infoHash, torrent] of this.active.entries()) {
      result.push(this._getTorrentInfo(torrent, 'active'));
    }
    
    // Queued torrents
    for (const queuedTorrent of this.queue) {
      result.push(this._getTorrentInfo(queuedTorrent.torrent, 'queued', {
        priority: queuedTorrent.priority,
        addedAt: queuedTorrent.addedAt,
        position: this._getQueuePosition(queuedTorrent.infoHash)
      }));
    }
    
    // Paused torrents
    for (const [infoHash, torrent] of this.paused.entries()) {
      result.push(this._getTorrentInfo(torrent, 'paused'));
    }
    
    // Completed torrents
    for (const [infoHash, torrent] of this.completed.entries()) {
      result.push(this._getTorrentInfo(torrent, 'completed'));
    }
    
    return result;
  }
  
  /**
   * Processes queue to start next torrents
   * @private
   */
  _processQueue() {
    while (this._canActivate() && this.queue.length > 0) {
      // Get highest priority torrent
      const queuedTorrent = this.queue.shift();
      
      // Move to active
      this.active.set(queuedTorrent.infoHash, queuedTorrent.torrent);
      
      // Start torrent
      this._startTorrent(queuedTorrent.torrent);
      
      this.emit('queue:start', {
        infoHash: queuedTorrent.infoHash,
        name: queuedTorrent.torrent.name,
        priority: queuedTorrent.priority,
        from: 'queue'
      });
    }
    
    this._notifyQueueChange();
  }
  
  /**
   * Handles torrent completion
   * @param {string} infoHash
   * @private
   */
  _onTorrentComplete(infoHash) {
    if (!this.active.has(infoHash)) {
      return;
    }
    
    const torrent = this.active.get(infoHash);
    this.active.delete(infoHash);
    
    // Move to completed
    this.completed.set(infoHash, torrent);
    
    this.emit('queue:complete', {
      infoHash,
      name: torrent.name,
      size: torrent.size
    });
    
    // Process queue to start next torrent
    this._processQueue();
    
    this._notifyQueueChange();
  }
  
  /**
   * Checks if can activate another torrent
   * @returns {boolean}
   * @private
   */
  _canActivate() {
    return this.active.size < this.maxConcurrent;
  }
  
  /**
   * Sorts queue by priority and addedAt
   * @private
   */
  _sortQueue() {
    const priorityWeight = {
      'high': 3,
      'normal': 2,
      'low': 1
    };
    
    this.queue.sort((a, b) => {
      // First sort by priority (higher first)
      const priorityDiff = priorityWeight[b.priority] - priorityWeight[a.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      
      // Then by addedAt (earlier first - FIFO)
      return a.addedAt - b.addedAt;
    });
  }
  
  /**
   * Checks if torrent exists in any collection
   * @param {string} infoHash
   * @returns {boolean}
   * @private
   */
  _exists(infoHash) {
    return this.active.has(infoHash) ||
           this.paused.has(infoHash) ||
           this.completed.has(infoHash) ||
           this.queue.some(q => q.infoHash === infoHash);
  }
  
  /**
   * Gets position of torrent in queue
   * @param {string} infoHash
   * @returns {number}
   * @private
   */
  _getQueuePosition(infoHash) {
    return this.queue.findIndex(q => q.infoHash === infoHash);
  }
  
  /**
   * Starts a torrent
   * @param {Torrent} torrent
   * @private
   */
  _startTorrent(torrent) {
    if (typeof torrent.start === 'function') {
      torrent.start().catch(err => {
        console.error(`[QueueManager] Error starting torrent ${torrent.infoHash}:`, err);
        this.emit('error', {
          infoHash: torrent.infoHash,
          error: err.message
        });
      });
    }
  }
  
  /**
   * Pauses a torrent
   * @param {Torrent} torrent
   * @private
   */
  _pauseTorrent(torrent) {
    if (typeof torrent.pause === 'function') {
      try {
        torrent.pause();
      } catch (err) {
        console.error(`[QueueManager] Error pausing torrent ${torrent.infoHash}:`, err);
      }
    }
  }
  
  /**
   * Stops a torrent
   * @param {Torrent} torrent
   * @private
   */
  _stopTorrent(torrent) {
    if (typeof torrent.stop === 'function') {
      try {
        torrent.stop();
      } catch (err) {
        console.error(`[QueueManager] Error stopping torrent ${torrent.infoHash}:`, err);
      }
    }
  }
  
  /**
   * Sets up event listeners for torrent
   * @param {Torrent} torrent
   * @private
   */
  _setupTorrentListeners(torrent) {
    // Listen for completion
    const onComplete = () => {
      this._onTorrentComplete(torrent.infoHash);
    };
    
    // Listen for errors
    const onError = (error) => {
      this.emit('torrent:error', {
        infoHash: torrent.infoHash,
        name: torrent.name,
        error: error.message || error
      });
    };
    
    torrent.on('complete', onComplete);
    torrent.on('error', onError);
    
    // Store listeners for cleanup
    if (!torrent._queueListeners) {
      torrent._queueListeners = { onComplete, onError };
    }
  }
  
  /**
   * Removes event listeners from torrent
   * @param {Torrent} torrent
   * @private
   */
  _removeTorrentListeners(torrent) {
    if (torrent._queueListeners) {
      torrent.removeListener('complete', torrent._queueListeners.onComplete);
      torrent.removeListener('error', torrent._queueListeners.onError);
      delete torrent._queueListeners;
    }
  }
  
  /**
   * Gets torrent info object
   * @param {Torrent} torrent
   * @param {string} status
   * @param {Object} extra
   * @returns {Object}
   * @private
   */
  _getTorrentInfo(torrent, status, extra = {}) {
    const stats = typeof torrent.getStats === 'function' ? torrent.getStats() : {};
    
    return {
      infoHash: torrent.infoHash,
      name: torrent.name || 'Unknown',
      size: torrent.size || 0,
      downloaded: stats.downloaded || 0,
      uploaded: stats.uploaded || 0,
      downloadSpeed: torrent.downloadSpeed || 0,
      uploadSpeed: torrent.uploadSpeed || 0,
      progress: stats.percentage || 0,
      status,
      peers: torrent.peers || { connected: 0, total: 0 },
      ...extra
    };
  }
  
  /**
   * Notifies queue change callback
   * @private
   */
  _notifyQueueChange() {
    if (typeof this.onQueueChange === 'function') {
      try {
        this.onQueueChange(this.getStats());
      } catch (err) {
        console.error('[QueueManager] Error in onQueueChange callback:', err);
      }
    }
  }
  
  /**
   * Cleans up all torrents and stops downloads
   */
  async cleanup() {
    // Stop all active torrents
    for (const torrent of this.active.values()) {
      this._stopTorrent(torrent);
      this._removeTorrentListeners(torrent);
    }
    
    // Remove listeners from all torrents
    for (const queuedTorrent of this.queue) {
      this._removeTorrentListeners(queuedTorrent.torrent);
    }
    
    for (const torrent of this.paused.values()) {
      this._removeTorrentListeners(torrent);
    }
    
    for (const torrent of this.completed.values()) {
      this._removeTorrentListeners(torrent);
    }
    
    // Clear all collections
    this.active.clear();
    this.queue = [];
    this.paused.clear();
    this.completed.clear();
    
    this.emit('cleanup');
  }
}

module.exports = { QueueManager };
