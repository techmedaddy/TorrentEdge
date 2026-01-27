const { Kafka } = require('kafkajs');
const EventEmitter = require('events');
const { EVENT_TYPES } = require('./kafkaProducer');

/**
 * TorrentEventConsumer - Kafka consumer for processing torrent events
 * 
 * Use cases:
 * - Analytics aggregation
 * - Notification triggers
 * - Audit logging
 * - Cross-service communication
 */
class TorrentEventConsumer extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string[]} options.brokers - Kafka broker addresses
   * @param {string} options.groupId - Consumer group ID
   * @param {string[]} options.topics - Topics to subscribe
   * @param {Map<string, Function>} options.handlers - Event handlers
   */
  constructor(options = {}) {
    super();
    
    this.brokers = options.brokers || ['localhost:9092'];
    this.groupId = options.groupId || 'torrentedge-consumer';
    this.topics = options.topics || ['torrent-events'];
    
    // Initialize Kafka client
    this.kafka = new Kafka({
      clientId: `${this.groupId}-client`,
      brokers: this.brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8
      }
    });
    
    this.consumer = null;
    this.isConnected = false;
    this.isRunning = false;
    
    // Event handlers
    this.handlers = new Map(options.handlers || []);
    
    // Metrics
    this.metrics = {
      messagesProcessed: 0,
      errorsCount: 0,
      lastMessageAt: null,
      processingTimes: [],
      avgProcessingTime: 0
    };
    
    // Register default handlers
    this._registerDefaultHandlers();
    
    console.log('[KafkaConsumer] TorrentEventConsumer initialized');
    console.log(`[KafkaConsumer] Brokers: ${this.brokers.join(', ')}`);
    console.log(`[KafkaConsumer] Group ID: ${this.groupId}`);
    console.log(`[KafkaConsumer] Topics: ${this.topics.join(', ')}`);
  }
  
  /**
   * Connect to Kafka cluster
   */
  async connect() {
    if (this.isConnected) {
      console.log('[KafkaConsumer] Already connected');
      return;
    }
    
    try {
      console.log('[KafkaConsumer] Connecting to Kafka cluster...');
      
      // Create consumer
      this.consumer = this.kafka.consumer({
        groupId: this.groupId,
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
        maxBytesPerPartition: 1048576, // 1MB
        retry: {
          initialRetryTime: 100,
          retries: 8
        }
      });
      
      await this.consumer.connect();
      
      // Subscribe to topics
      for (const topic of this.topics) {
        await this.consumer.subscribe({
          topic,
          fromBeginning: false
        });
        console.log(`[KafkaConsumer] Subscribed to topic: ${topic}`);
      }
      
      this.isConnected = true;
      console.log('[KafkaConsumer] Connected successfully');
      
      this.emit('connected');
      
    } catch (error) {
      console.error(`[KafkaConsumer] Connection failed: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Disconnect from Kafka cluster
   */
  async disconnect() {
    if (!this.isConnected) {
      console.log('[KafkaConsumer] Not connected');
      return;
    }
    
    try {
      console.log('[KafkaConsumer] Disconnecting...');
      
      // Stop consuming first
      if (this.isRunning) {
        await this.stop();
      }
      
      // Disconnect consumer
      if (this.consumer) {
        await this.consumer.disconnect();
      }
      
      this.isConnected = false;
      console.log('[KafkaConsumer] Disconnected successfully');
      
      this.emit('disconnected');
      
    } catch (error) {
      console.error(`[KafkaConsumer] Disconnect error: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Register handler for specific event type
   * @param {string} eventType - Event type
   * @param {Function} handler - Handler function (async)
   */
  registerHandler(eventType, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }
    
    this.handlers.set(eventType, handler);
    console.log(`[KafkaConsumer] Registered handler for: ${eventType}`);
  }
  
  /**
   * Start consuming messages
   */
  async start() {
    if (!this.isConnected) {
      throw new Error('Consumer not connected. Call connect() first.');
    }
    
    if (this.isRunning) {
      console.log('[KafkaConsumer] Already running');
      return;
    }
    
    try {
      console.log('[KafkaConsumer] Starting message consumption...');
      
      this.isRunning = true;
      
      await this.consumer.run({
        autoCommit: true,
        autoCommitInterval: 5000,
        eachMessage: async ({ topic, partition, message }) => {
          await this._handleMessage(topic, partition, message);
        }
      });
      
      console.log('[KafkaConsumer] Consuming messages');
      this.emit('started');
      
    } catch (error) {
      console.error(`[KafkaConsumer] Failed to start: ${error.message}`);
      this.isRunning = false;
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Stop consuming messages
   */
  async stop() {
    if (!this.isRunning) {
      console.log('[KafkaConsumer] Not running');
      return;
    }
    
    try {
      console.log('[KafkaConsumer] Stopping...');
      
      // Kafka consumer doesn't have explicit stop, so we just mark as not running
      // Disconnecting will stop consumption
      this.isRunning = false;
      
      console.log('[KafkaConsumer] Stopped');
      this.emit('stopped');
      
    } catch (error) {
      console.error(`[KafkaConsumer] Stop error: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Handle incoming message
   * @private
   */
  async _handleMessage(topic, partition, message) {
    const startTime = Date.now();
    
    try {
      // Parse message
      const value = message.value.toString();
      const event = JSON.parse(value);
      
      // Validate event structure
      if (!this._validateEvent(event)) {
        console.warn('[KafkaConsumer] Invalid event structure:', event);
        this.metrics.errorsCount++;
        return;
      }
      
      const eventType = event.type;
      
      // Get handler for this event type
      const handler = this.handlers.get(eventType);
      
      if (handler) {
        try {
          await handler(event);
          
          // Update metrics
          this.metrics.messagesProcessed++;
          this.metrics.lastMessageAt = Date.now();
          
          const processingTime = Date.now() - startTime;
          this._updateProcessingTime(processingTime);
          
          this.emit('message', { event, processingTime });
          
        } catch (handlerError) {
          console.error(`[KafkaConsumer] Handler error for ${eventType}:`, handlerError);
          this.metrics.errorsCount++;
          this.emit('handlerError', { event, error: handlerError });
        }
      } else {
        // No handler registered, just log
        console.log(`[KafkaConsumer] No handler for event type: ${eventType}`);
      }
      
    } catch (error) {
      console.error(`[KafkaConsumer] Message processing error:`, error);
      this.metrics.errorsCount++;
      this.emit('processingError', { error, message });
    }
  }
  
  /**
   * Validate event structure
   * @private
   */
  _validateEvent(event) {
    return (
      event &&
      typeof event === 'object' &&
      event.type &&
      event.infoHash &&
      event.timestamp
    );
  }
  
  /**
   * Update average processing time
   * @private
   */
  _updateProcessingTime(time) {
    this.metrics.processingTimes.push(time);
    
    // Keep only last 100 times for rolling average
    if (this.metrics.processingTimes.length > 100) {
      this.metrics.processingTimes.shift();
    }
    
    // Calculate average
    const sum = this.metrics.processingTimes.reduce((a, b) => a + b, 0);
    this.metrics.avgProcessingTime = sum / this.metrics.processingTimes.length;
  }
  
  /**
   * Register default handlers
   * @private
   */
  _registerDefaultHandlers() {
    // Handler for torrent completion
    this.registerHandler(EVENT_TYPES.TORRENT_COMPLETED, async (event) => {
      console.log(`[KafkaConsumer] Torrent completed: ${event.data.name}`);
      console.log(`[KafkaConsumer] Download time: ${event.data.downloadTime}ms`);
      console.log(`[KafkaConsumer] Average speed: ${this._formatBytes(event.data.averageSpeed)}/s`);
    });
    
    // Handler for errors
    this.registerHandler(EVENT_TYPES.TORRENT_ERROR, async (event) => {
      console.error(`[KafkaConsumer] Torrent error: ${event.data.torrentName}`);
      console.error(`[KafkaConsumer] Error: ${event.data.error}`);
      console.error(`[KafkaConsumer] State: ${event.data.state}`);
    });
    
    // Handler for piece completion (aggregate for analytics)
    this.registerHandler(EVENT_TYPES.PIECE_COMPLETED, async (event) => {
      // This would typically update analytics database
      console.log(`[KafkaConsumer] Piece ${event.data.pieceIndex}/${event.data.totalPieces} completed`);
      console.log(`[KafkaConsumer] Progress: ${event.data.progress.toFixed(2)}%`);
    });
  }
  
  /**
   * Format bytes for display
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  /**
   * Get consumer metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      isRunning: this.isRunning,
      isConnected: this.isConnected,
      registeredHandlers: Array.from(this.handlers.keys())
    };
  }
  
  /**
   * Get consumer status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      running: this.isRunning,
      brokers: this.brokers,
      groupId: this.groupId,
      topics: this.topics,
      handlers: Array.from(this.handlers.keys()),
      metrics: this.metrics
    };
  }
}

/**
 * Create pre-configured consumer for analytics
 * @param {Object} dbClient - Database client for writing analytics
 * @returns {TorrentEventConsumer}
 */
function createAnalyticsConsumer(dbClient) {
  console.log('[KafkaConsumer] Creating analytics consumer');
  
  const consumer = new TorrentEventConsumer({
    groupId: 'torrentedge-analytics',
    topics: ['torrent-events']
  });
  
  // Register analytics handlers
  consumer.registerHandler(EVENT_TYPES.TORRENT_ADDED, async (event) => {
    if (dbClient) {
      try {
        // Example: Write to database
        await dbClient.query(
          'INSERT INTO torrent_events (info_hash, event_type, name, size, timestamp) VALUES ($1, $2, $3, $4, $5)',
          [event.infoHash, 'added', event.data.name, event.data.size, new Date(event.timestamp)]
        );
        console.log(`[KafkaConsumer] Analytics: Recorded torrent added - ${event.data.name}`);
      } catch (error) {
        console.error(`[KafkaConsumer] Analytics DB error:`, error);
      }
    }
  });
  
  consumer.registerHandler(EVENT_TYPES.TORRENT_COMPLETED, async (event) => {
    if (dbClient) {
      try {
        await dbClient.query(
          'INSERT INTO torrent_completions (info_hash, name, size, download_time, avg_speed, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
          [
            event.infoHash,
            event.data.name,
            event.data.size,
            event.data.downloadTime,
            event.data.averageSpeed,
            new Date(event.timestamp)
          ]
        );
        console.log(`[KafkaConsumer] Analytics: Recorded completion - ${event.data.name}`);
      } catch (error) {
        console.error(`[KafkaConsumer] Analytics DB error:`, error);
      }
    }
  });
  
  consumer.registerHandler(EVENT_TYPES.TORRENT_PROGRESS, async (event) => {
    if (dbClient) {
      try {
        // Aggregate progress data
        await dbClient.query(
          'INSERT INTO torrent_progress_snapshots (info_hash, progress, download_speed, upload_speed, peers, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
          [
            event.infoHash,
            event.data.progress,
            event.data.downloadSpeed,
            event.data.uploadSpeed,
            event.data.peers,
            new Date(event.timestamp)
          ]
        );
      } catch (error) {
        console.error(`[KafkaConsumer] Analytics DB error:`, error);
      }
    }
  });
  
  return consumer;
}

/**
 * Setup graceful shutdown handlers
 * @param {TorrentEventConsumer} consumer
 */
function setupGracefulShutdown(consumer) {
  const shutdown = async (signal) => {
    console.log(`[KafkaConsumer] Received ${signal}, shutting down gracefully...`);
    
    try {
      await consumer.stop();
      await consumer.disconnect();
      console.log('[KafkaConsumer] Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[KafkaConsumer] Shutdown error:', error);
      process.exit(1);
    }
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  TorrentEventConsumer,
  createAnalyticsConsumer,
  setupGracefulShutdown
};
