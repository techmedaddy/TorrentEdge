const EventEmitter = require('events');

/**
 * AnalyticsService - Processes and aggregates torrent events
 * 
 * Features:
 * - Event processing and storage
 * - Statistics aggregation
 * - Batched database writes
 * - Redis caching for real-time data
 */
class AnalyticsService extends EventEmitter {
  /**
   * @param {Object} db - Database client (MongoDB/Postgres)
   * @param {Object} cache - Redis client (optional)
   */
  constructor(db, cache) {
    super();
    
    this.db = db;
    this.cache = cache;
    
    // Event buffers for batching
    this.eventBuffers = {
      torrents: [],
      completions: [],
      progress: [],
      peers: [],
      pieces: []
    };
    
    // Buffer limits
    this.maxBufferSize = 1000;
    this.flushInterval = 10000; // 10 seconds
    
    // Flush timer
    this.flushTimer = null;
    
    // Metrics
    this.metrics = {
      eventsProcessed: 0,
      dbWrites: 0,
      cacheWrites: 0,
      errors: 0
    };
    
    console.log('[Analytics] Service initialized');
    console.log(`[Analytics] Database: ${db ? 'connected' : 'not available'}`);
    console.log(`[Analytics] Cache: ${cache ? 'connected' : 'not available'}`);
    
    // Start periodic flush
    this._startPeriodicFlush();
  }
  
  /**
   * Handle torrent added event
   */
  async handleTorrentAdded(event) {
    try {
      const torrentData = {
        infoHash: event.infoHash,
        name: event.data.name,
        size: event.data.size,
        fileCount: event.data.fileCount,
        addedAt: new Date(event.timestamp),
        state: event.data.state,
        downloadPath: event.data.downloadPath,
        userId: event.userId || null
      };
      
      // Buffer for batch insert
      this.eventBuffers.torrents.push(torrentData);
      
      // Update user torrent count in cache
      if (this.cache && event.userId) {
        try {
          await this.cache.incr(`user:${event.userId}:torrent_count`);
          this.metrics.cacheWrites++;
        } catch (error) {
          console.warn('[Analytics] Cache update failed:', error.message);
        }
      }
      
      // Flush if buffer is full
      if (this.eventBuffers.torrents.length >= this.maxBufferSize) {
        await this._flushTorrents();
      }
      
      this.metrics.eventsProcessed++;
      console.log(`[Analytics] Torrent added: ${event.data.name}`);
      
    } catch (error) {
      console.error('[Analytics] Error handling torrent added:', error);
      this.metrics.errors++;
      this.emit('error', error);
    }
  }
  
  /**
   * Handle torrent progress event
   */
  async handleTorrentProgress(event) {
    try {
      // Store in cache for real-time access (if available)
      if (this.cache) {
        try {
          const progressData = {
            progress: event.data.progress,
            downloadSpeed: event.data.downloadSpeed,
            uploadSpeed: event.data.uploadSpeed,
            peers: event.data.peers,
            eta: event.data.eta,
            timestamp: event.timestamp
          };
          
          await this.cache.setex(
            `torrent:${event.infoHash}:progress`,
            300, // 5 minute TTL
            JSON.stringify(progressData)
          );
          
          this.metrics.cacheWrites++;
        } catch (error) {
          console.warn('[Analytics] Cache update failed:', error.message);
        }
      }
      
      // Buffer for periodic DB snapshots (not every event)
      // Only store if significant progress change or time interval
      const shouldSnapshot = Math.random() < 0.1; // 10% sampling
      
      if (shouldSnapshot) {
        this.eventBuffers.progress.push({
          infoHash: event.infoHash,
          progress: event.data.progress,
          downloadSpeed: event.data.downloadSpeed,
          uploadSpeed: event.data.uploadSpeed,
          peers: event.data.peers,
          completedPieces: event.data.completedPieces || 0,
          totalPieces: event.data.totalPieces || 0,
          timestamp: new Date(event.timestamp)
        });
        
        if (this.eventBuffers.progress.length >= this.maxBufferSize) {
          await this._flushProgress();
        }
      }
      
      this.metrics.eventsProcessed++;
      
    } catch (error) {
      console.error('[Analytics] Error handling progress:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Handle torrent completed event
   */
  async handleTorrentCompleted(event) {
    try {
      const completionData = {
        infoHash: event.infoHash,
        name: event.data.name,
        size: event.data.size,
        downloadTime: event.data.downloadTime,
        averageSpeed: event.data.averageSpeed,
        completedAt: new Date(event.timestamp),
        userId: event.userId || null
      };
      
      // Buffer for batch insert
      this.eventBuffers.completions.push(completionData);
      
      // Update user stats in cache
      if (this.cache && event.userId) {
        try {
          const multi = this.cache.multi();
          multi.incr(`user:${event.userId}:downloads_completed`);
          multi.incrby(`user:${event.userId}:total_downloaded`, event.data.size);
          
          // Track download speed for percentiles
          multi.zadd(
            `user:${event.userId}:download_speeds`,
            event.data.averageSpeed,
            `${event.infoHash}:${event.timestamp}`
          );
          
          await multi.exec();
          this.metrics.cacheWrites += 3;
        } catch (error) {
          console.warn('[Analytics] Cache update failed:', error.message);
        }
      }
      
      // Update torrent state in DB
      if (this.db) {
        try {
          await this._updateTorrentState(event.infoHash, 'completed', completionData);
        } catch (error) {
          console.warn('[Analytics] DB update failed:', error.message);
        }
      }
      
      // Flush if buffer is full
      if (this.eventBuffers.completions.length >= this.maxBufferSize) {
        await this._flushCompletions();
      }
      
      this.metrics.eventsProcessed++;
      console.log(`[Analytics] Torrent completed: ${event.data.name} (${this._formatTime(event.data.downloadTime)})`);
      
    } catch (error) {
      console.error('[Analytics] Error handling completion:', error);
      this.metrics.errors++;
      this.emit('error', error);
    }
  }
  
  /**
   * Handle peer connected event
   */
  async handlePeerConnected(event) {
    try {
      const peerData = {
        infoHash: event.infoHash,
        ip: event.data.ip,
        port: event.data.port,
        connectedAt: new Date(event.timestamp)
      };
      
      // Buffer for batch insert
      this.eventBuffers.peers.push(peerData);
      
      // Track peer geography and client distribution in cache
      if (this.cache) {
        try {
          // Increment peer count for this torrent
          await this.cache.incr(`torrent:${event.infoHash}:peer_count`);
          
          // Track unique IPs (for peer geography analysis)
          await this.cache.sadd(`torrent:${event.infoHash}:peers`, event.data.ip);
          
          // TODO: Extract peer client info from peerId and track distribution
          
          this.metrics.cacheWrites += 2;
        } catch (error) {
          console.warn('[Analytics] Cache update failed:', error.message);
        }
      }
      
      // Flush if buffer is full
      if (this.eventBuffers.peers.length >= this.maxBufferSize) {
        await this._flushPeers();
      }
      
      this.metrics.eventsProcessed++;
      
    } catch (error) {
      console.error('[Analytics] Error handling peer connected:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Handle peer disconnected event
   */
  async handlePeerDisconnected(event) {
    try {
      // Update cache
      if (this.cache) {
        try {
          await this.cache.decr(`torrent:${event.infoHash}:peer_count`);
          this.metrics.cacheWrites++;
        } catch (error) {
          console.warn('[Analytics] Cache update failed:', error.message);
        }
      }
      
      this.metrics.eventsProcessed++;
      
    } catch (error) {
      console.error('[Analytics] Error handling peer disconnected:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Handle piece completed event
   */
  async handlePieceCompleted(event) {
    try {
      const pieceData = {
        infoHash: event.infoHash,
        pieceIndex: event.data.pieceIndex,
        totalPieces: event.data.totalPieces,
        completedPieces: event.data.completedPieces,
        progress: event.data.progress,
        completedAt: new Date(event.timestamp)
      };
      
      // Buffer for aggregation
      this.eventBuffers.pieces.push(pieceData);
      
      // Track piece availability in cache
      if (this.cache) {
        try {
          // Increment piece completion count
          await this.cache.hincrby(
            `torrent:${event.infoHash}:pieces`,
            event.data.pieceIndex,
            1
          );
          
          this.metrics.cacheWrites++;
        } catch (error) {
          console.warn('[Analytics] Cache update failed:', error.message);
        }
      }
      
      // Flush if buffer is full
      if (this.eventBuffers.pieces.length >= this.maxBufferSize) {
        await this._flushPieces();
      }
      
      this.metrics.eventsProcessed++;
      
    } catch (error) {
      console.error('[Analytics] Error handling piece completed:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Aggregate hourly statistics
   */
  async aggregateHourlyStats() {
    if (!this.db) {
      console.warn('[Analytics] Database not available for aggregation');
      return null;
    }
    
    try {
      console.log('[Analytics] Aggregating hourly statistics...');
      
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      
      // Example aggregation (adjust based on your DB schema)
      const stats = {
        hour: hourAgo.toISOString(),
        torrentsAdded: 0,
        torrentsCompleted: 0,
        totalDownloaded: 0,
        totalUploaded: 0,
        averageDownloadSpeed: 0,
        averageUploadSpeed: 0,
        peakConcurrentPeers: 0
      };
      
      // Query based on DB type (this is a generic example)
      // Adjust queries for MongoDB or PostgreSQL
      
      // For MongoDB:
      if (this.db.collection) {
        const completions = await this.db.collection('torrent_completions')
          .find({
            completedAt: { $gte: hourAgo, $lt: now }
          })
          .toArray();
        
        stats.torrentsCompleted = completions.length;
        stats.totalDownloaded = completions.reduce((sum, c) => sum + c.size, 0);
        stats.averageDownloadSpeed = completions.reduce((sum, c) => sum + c.averageSpeed, 0) / (completions.length || 1);
      }
      
      // For PostgreSQL:
      if (this.db.query) {
        const result = await this.db.query(`
          SELECT 
            COUNT(*) as torrents_completed,
            SUM(size) as total_downloaded,
            AVG(average_speed) as avg_download_speed
          FROM torrent_completions
          WHERE completed_at >= $1 AND completed_at < $2
        `, [hourAgo, now]);
        
        if (result.rows && result.rows.length > 0) {
          stats.torrentsCompleted = parseInt(result.rows[0].torrents_completed) || 0;
          stats.totalDownloaded = parseInt(result.rows[0].total_downloaded) || 0;
          stats.averageDownloadSpeed = parseFloat(result.rows[0].avg_download_speed) || 0;
        }
      }
      
      console.log('[Analytics] Hourly stats:', stats);
      return stats;
      
    } catch (error) {
      console.error('[Analytics] Error aggregating hourly stats:', error);
      this.metrics.errors++;
      throw error;
    }
  }
  
  /**
   * Aggregate user statistics
   */
  async aggregateUserStats(userId) {
    if (!userId) {
      throw new Error('userId is required');
    }
    
    try {
      console.log(`[Analytics] Aggregating stats for user: ${userId}`);
      
      const stats = {
        userId,
        totalDownloaded: 0,
        totalUploaded: 0,
        ratio: 0,
        torrentsAdded: 0,
        torrentsCompleted: 0,
        averageDownloadSpeed: 0,
        favoriteTrackers: []
      };
      
      // Try cache first
      if (this.cache) {
        try {
          const [downloaded, completed, torrentCount] = await Promise.all([
            this.cache.get(`user:${userId}:total_downloaded`),
            this.cache.get(`user:${userId}:downloads_completed`),
            this.cache.get(`user:${userId}:torrent_count`)
          ]);
          
          stats.totalDownloaded = parseInt(downloaded) || 0;
          stats.torrentsCompleted = parseInt(completed) || 0;
          stats.torrentsAdded = parseInt(torrentCount) || 0;
          
          // Get download speeds for average
          const speeds = await this.cache.zrange(`user:${userId}:download_speeds`, 0, -1, 'WITHSCORES');
          if (speeds && speeds.length > 0) {
            const speedValues = speeds.filter((_, i) => i % 2 === 1).map(Number);
            stats.averageDownloadSpeed = speedValues.reduce((a, b) => a + b, 0) / speedValues.length;
          }
          
        } catch (error) {
          console.warn('[Analytics] Cache read failed:', error.message);
        }
      }
      
      // Fallback to DB or enhance with DB data
      if (this.db) {
        // Add DB queries here based on your schema
      }
      
      // Calculate ratio
      if (stats.totalUploaded > 0) {
        stats.ratio = stats.totalDownloaded / stats.totalUploaded;
      }
      
      console.log('[Analytics] User stats:', stats);
      return stats;
      
    } catch (error) {
      console.error('[Analytics] Error aggregating user stats:', error);
      this.metrics.errors++;
      throw error;
    }
  }
  
  /**
   * Flush all buffers
   */
  async flushAll() {
    console.log('[Analytics] Flushing all buffers...');
    
    await Promise.all([
      this._flushTorrents(),
      this._flushCompletions(),
      this._flushProgress(),
      this._flushPeers(),
      this._flushPieces()
    ]);
    
    console.log('[Analytics] All buffers flushed');
  }
  
  /**
   * Flush torrents buffer
   * @private
   */
  async _flushTorrents() {
    if (this.eventBuffers.torrents.length === 0) {
      return;
    }
    
    if (!this.db) {
      console.warn('[Analytics] Database not available, discarding torrent events');
      this.eventBuffers.torrents = [];
      return;
    }
    
    try {
      const events = [...this.eventBuffers.torrents];
      this.eventBuffers.torrents = [];
      
      // MongoDB
      if (this.db.collection) {
        await this.db.collection('torrents').insertMany(events);
      }
      
      // PostgreSQL (bulk insert)
      if (this.db.query) {
        const values = events.map((e, i) => 
          `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`
        ).join(',');
        
        const params = events.flatMap(e => [
          e.infoHash, e.name, e.size, e.fileCount, e.state, e.downloadPath, e.addedAt
        ]);
        
        await this.db.query(`
          INSERT INTO torrents (info_hash, name, size, file_count, state, download_path, added_at)
          VALUES ${values}
        `, params);
      }
      
      this.metrics.dbWrites++;
      console.log(`[Analytics] Flushed ${events.length} torrent events`);
      
    } catch (error) {
      console.error('[Analytics] Error flushing torrents:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Flush completions buffer
   * @private
   */
  async _flushCompletions() {
    if (this.eventBuffers.completions.length === 0) {
      return;
    }
    
    if (!this.db) {
      this.eventBuffers.completions = [];
      return;
    }
    
    try {
      const events = [...this.eventBuffers.completions];
      this.eventBuffers.completions = [];
      
      if (this.db.collection) {
        await this.db.collection('torrent_completions').insertMany(events);
      }
      
      if (this.db.query) {
        const values = events.map((e, i) => 
          `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
        ).join(',');
        
        const params = events.flatMap(e => [
          e.infoHash, e.name, e.size, e.downloadTime, e.averageSpeed, e.completedAt
        ]);
        
        await this.db.query(`
          INSERT INTO torrent_completions (info_hash, name, size, download_time, average_speed, completed_at)
          VALUES ${values}
        `, params);
      }
      
      this.metrics.dbWrites++;
      console.log(`[Analytics] Flushed ${events.length} completion events`);
      
    } catch (error) {
      console.error('[Analytics] Error flushing completions:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Flush progress buffer
   * @private
   */
  async _flushProgress() {
    if (this.eventBuffers.progress.length === 0) {
      return;
    }
    
    if (!this.db) {
      this.eventBuffers.progress = [];
      return;
    }
    
    try {
      const events = [...this.eventBuffers.progress];
      this.eventBuffers.progress = [];
      
      if (this.db.collection) {
        await this.db.collection('torrent_progress_snapshots').insertMany(events);
      }
      
      if (this.db.query) {
        // Bulk insert for PostgreSQL
        const values = events.map((e, i) => 
          `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`
        ).join(',');
        
        const params = events.flatMap(e => [
          e.infoHash, e.progress, e.downloadSpeed, e.uploadSpeed, e.peers, e.completedPieces, e.totalPieces, e.timestamp
        ]);
        
        await this.db.query(`
          INSERT INTO torrent_progress_snapshots 
          (info_hash, progress, download_speed, upload_speed, peers, completed_pieces, total_pieces, timestamp)
          VALUES ${values}
        `, params);
      }
      
      this.metrics.dbWrites++;
      console.log(`[Analytics] Flushed ${events.length} progress snapshots`);
      
    } catch (error) {
      console.error('[Analytics] Error flushing progress:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Flush peers buffer
   * @private
   */
  async _flushPeers() {
    if (this.eventBuffers.peers.length === 0) {
      return;
    }
    
    if (!this.db) {
      this.eventBuffers.peers = [];
      return;
    }
    
    try {
      const events = [...this.eventBuffers.peers];
      this.eventBuffers.peers = [];
      
      if (this.db.collection) {
        await this.db.collection('peer_connections').insertMany(events);
      }
      
      if (this.db.query) {
        const values = events.map((e, i) => 
          `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
        ).join(',');
        
        const params = events.flatMap(e => [e.infoHash, e.ip, e.port, e.connectedAt]);
        
        await this.db.query(`
          INSERT INTO peer_connections (info_hash, ip, port, connected_at)
          VALUES ${values}
        `, params);
      }
      
      this.metrics.dbWrites++;
      console.log(`[Analytics] Flushed ${events.length} peer events`);
      
    } catch (error) {
      console.error('[Analytics] Error flushing peers:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Flush pieces buffer
   * @private
   */
  async _flushPieces() {
    if (this.eventBuffers.pieces.length === 0) {
      return;
    }
    
    if (!this.db) {
      this.eventBuffers.pieces = [];
      return;
    }
    
    try {
      const events = [...this.eventBuffers.pieces];
      this.eventBuffers.pieces = [];
      
      if (this.db.collection) {
        await this.db.collection('piece_completions').insertMany(events);
      }
      
      if (this.db.query) {
        const values = events.map((e, i) => 
          `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
        ).join(',');
        
        const params = events.flatMap(e => [
          e.infoHash, e.pieceIndex, e.totalPieces, e.completedPieces, e.progress, e.completedAt
        ]);
        
        await this.db.query(`
          INSERT INTO piece_completions 
          (info_hash, piece_index, total_pieces, completed_pieces, progress, completed_at)
          VALUES ${values}
        `, params);
      }
      
      this.metrics.dbWrites++;
      console.log(`[Analytics] Flushed ${events.length} piece events`);
      
    } catch (error) {
      console.error('[Analytics] Error flushing pieces:', error);
      this.metrics.errors++;
    }
  }
  
  /**
   * Update torrent state in database
   * @private
   */
  async _updateTorrentState(infoHash, state, additionalData = {}) {
    if (!this.db) {
      return;
    }
    
    try {
      if (this.db.collection) {
        await this.db.collection('torrents').updateOne(
          { infoHash },
          { $set: { state, ...additionalData } }
        );
      }
      
      if (this.db.query) {
        await this.db.query(
          'UPDATE torrents SET state = $1 WHERE info_hash = $2',
          [state, infoHash]
        );
      }
      
    } catch (error) {
      console.error('[Analytics] Error updating torrent state:', error);
    }
  }
  
  /**
   * Start periodic buffer flush
   * @private
   */
  _startPeriodicFlush() {
    this.flushTimer = setInterval(() => {
      console.log('[Analytics] Periodic flush triggered');
      this.flushAll().catch(error => {
        console.error('[Analytics] Periodic flush error:', error);
      });
    }, this.flushInterval);
    
    console.log(`[Analytics] Periodic flush started (interval: ${this.flushInterval}ms)`);
  }
  
  /**
   * Stop periodic buffer flush
   * @private
   */
  _stopPeriodicFlush() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      console.log('[Analytics] Periodic flush stopped');
    }
  }
  
  /**
   * Format time duration
   * @private
   */
  _formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  
  /**
   * Get service metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      bufferedEvents: {
        torrents: this.eventBuffers.torrents.length,
        completions: this.eventBuffers.completions.length,
        progress: this.eventBuffers.progress.length,
        peers: this.eventBuffers.peers.length,
        pieces: this.eventBuffers.pieces.length
      }
    };
  }
  
  /**
   * Shutdown service gracefully
   */
  async shutdown() {
    console.log('[Analytics] Shutting down...');
    
    this._stopPeriodicFlush();
    await this.flushAll();
    
    console.log('[Analytics] Shutdown complete');
  }
}

/**
 * Create analytics service instance
 * @param {Object} options
 * @param {Object} options.db - Database client
 * @param {Object} options.cache - Redis client (optional)
 * @returns {AnalyticsService}
 */
function createAnalyticsService(options = {}) {
  const { db, cache } = options;
  
  if (!db) {
    console.warn('[Analytics] No database provided - events will be buffered but not persisted');
  }
  
  if (!cache) {
    console.warn('[Analytics] No cache provided - real-time features will be limited');
  }
  
  return new AnalyticsService(db, cache);
}

module.exports = {
  AnalyticsService,
  createAnalyticsService
};
