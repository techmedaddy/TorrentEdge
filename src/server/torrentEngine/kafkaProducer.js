const { Kafka, Partitioners } = require('kafkajs');
const EventEmitter = require('events');

/**
 * Event type constants
 */
const EVENT_TYPES = {
  TORRENT_ADDED: 'torrent:added',
  TORRENT_STARTED: 'torrent:started',
  TORRENT_PROGRESS: 'torrent:progress',
  TORRENT_COMPLETED: 'torrent:completed',
  TORRENT_ERROR: 'torrent:error',
  TORRENT_PAUSED: 'torrent:paused',
  TORRENT_RESUMED: 'torrent:resumed',
  TORRENT_REMOVED: 'torrent:removed',
  PEER_CONNECTED: 'peer:connected',
  PEER_DISCONNECTED: 'peer:disconnected',
  PIECE_COMPLETED: 'piece:completed',
  METADATA_RECEIVED: 'metadata:received'
};

/**
 * TorrentEventProducer - Kafka producer for torrent events
 * 
 * Sends torrent lifecycle events to Kafka for:
 * - Event logging and analytics
 * - Microservice communication
 * - Event replay and debugging
 */
class TorrentEventProducer extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string[]} options.brokers - Kafka broker addresses
   * @param {string} options.clientId - Kafka client ID
   * @param {string} options.topic - Topic name for events
   */
  constructor(options = {}) {
    super();
    
    this.brokers = options.brokers || ['localhost:9092'];
    this.clientId = options.clientId || 'torrentedge';
    this.topic = options.topic || 'torrent-events';
    
    // Initialize Kafka client
    this.kafka = new Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8
      }
    });
    
    this.producer = null;
    this.isConnected = false;
    
    // Batching for high-frequency events
    this.eventBuffer = [];
    this.bufferFlushInterval = null;
    this.maxBufferSize = 100;
    this.flushIntervalMs = 1000;
    
    console.log('[Kafka] TorrentEventProducer initialized');
    console.log(`[Kafka] Brokers: ${this.brokers.join(', ')}`);
    console.log(`[Kafka] Topic: ${this.topic}`);
  }
  
  /**
   * Connect to Kafka cluster
   */
  async connect() {
    if (this.isConnected) {
      console.log('[Kafka] Already connected');
      return;
    }
    
    try {
      console.log('[Kafka] Connecting to Kafka cluster...');
      
      // Create producer with optimized settings
      this.producer = this.kafka.producer({
        allowAutoTopicCreation: true,
        transactionTimeout: 30000,
        createPartitioner: Partitioners.LegacyPartitioner,
        retry: {
          initialRetryTime: 100,
          retries: 8
        },
        // Batching configuration
        compression: 1, // GZIP compression
        maxInFlightRequests: 5,
        idempotent: true,
        transactionalId: `${this.clientId}-producer`
      });
      
      await this.producer.connect();
      
      this.isConnected = true;
      console.log('[Kafka] Connected successfully');
      
      // Start buffer flush interval
      this._startBufferFlush();
      
      this.emit('connected');
      
    } catch (error) {
      console.error(`[Kafka] Connection failed: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Disconnect from Kafka cluster
   */
  async disconnect() {
    if (!this.isConnected) {
      console.log('[Kafka] Not connected');
      return;
    }
    
    try {
      console.log('[Kafka] Disconnecting...');
      
      // Stop buffer flush
      this._stopBufferFlush();
      
      // Flush any remaining buffered events
      await this._flushBuffer();
      
      // Disconnect producer
      if (this.producer) {
        await this.producer.disconnect();
      }
      
      this.isConnected = false;
      console.log('[Kafka] Disconnected successfully');
      
      this.emit('disconnected');
      
    } catch (error) {
      console.error(`[Kafka] Disconnect error: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Send a single torrent event to Kafka
   * @param {Object} event - Torrent event
   * @param {string} event.type - Event type
   * @param {string} event.infoHash - Torrent info hash
   * @param {number} event.timestamp - Unix timestamp
   * @param {Object} event.data - Event-specific data
   * @param {string} [event.userId] - Optional user ID
   * @param {string} [event.sessionId] - Optional session ID
   */
  async sendEvent(event) {
    if (!this.isConnected) {
      throw new Error('Producer not connected. Call connect() first.');
    }
    
    try {
      // Validate event
      this._validateEvent(event);
      
      // For high-frequency events, use batching
      if (event.type === EVENT_TYPES.TORRENT_PROGRESS) {
        return this._bufferEvent(event);
      }
      
      // Send immediately for other events
      const message = {
        key: event.infoHash,
        value: JSON.stringify({
          ...event,
          timestamp: event.timestamp || Date.now()
        }),
        headers: {
          eventType: event.type,
          clientId: this.clientId
        }
      };
      
      await this.producer.send({
        topic: this.topic,
        messages: [message]
      });
      
      console.log(`[Kafka] Sent event: ${event.type} for ${event.infoHash?.substring(0, 8)}...`);
      
    } catch (error) {
      console.error(`[Kafka] Failed to send event: ${error.message}`);
      this.emit('error', error);
      
      // Retry for transient errors
      if (this._isTransientError(error)) {
        console.log('[Kafka] Retrying...');
        // The kafkajs retry mechanism will handle this
      }
      
      throw error;
    }
  }
  
  /**
   * Send multiple events in batch
   * @param {Array} events - Array of torrent events
   */
  async sendBatch(events) {
    if (!this.isConnected) {
      throw new Error('Producer not connected. Call connect() first.');
    }
    
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error('Events must be a non-empty array');
    }
    
    try {
      // Validate all events
      events.forEach(event => this._validateEvent(event));
      
      // Convert events to Kafka messages
      const messages = events.map(event => ({
        key: event.infoHash,
        value: JSON.stringify({
          ...event,
          timestamp: event.timestamp || Date.now()
        }),
        headers: {
          eventType: event.type,
          clientId: this.clientId
        }
      }));
      
      await this.producer.send({
        topic: this.topic,
        messages
      });
      
      console.log(`[Kafka] Sent batch of ${events.length} events`);
      
    } catch (error) {
      console.error(`[Kafka] Failed to send batch: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Buffer event for batching (used for high-frequency events)
   * @private
   */
  _bufferEvent(event) {
    this.eventBuffer.push(event);
    
    // Flush if buffer is full
    if (this.eventBuffer.length >= this.maxBufferSize) {
      console.log(`[Kafka] Buffer full (${this.eventBuffer.length}), flushing...`);
      this._flushBuffer().catch(error => {
        console.error(`[Kafka] Buffer flush error: ${error.message}`);
      });
    }
  }
  
  /**
   * Flush buffered events to Kafka
   * @private
   */
  async _flushBuffer() {
    if (this.eventBuffer.length === 0) {
      return;
    }
    
    const eventsToSend = [...this.eventBuffer];
    this.eventBuffer = [];
    
    try {
      await this.sendBatch(eventsToSend);
    } catch (error) {
      console.error(`[Kafka] Failed to flush buffer: ${error.message}`);
      // Re-add events to buffer for retry
      this.eventBuffer.unshift(...eventsToSend);
    }
  }
  
  /**
   * Start periodic buffer flush
   * @private
   */
  _startBufferFlush() {
    if (this.bufferFlushInterval) {
      return;
    }
    
    this.bufferFlushInterval = setInterval(() => {
      if (this.eventBuffer.length > 0) {
        console.log(`[Kafka] Periodic flush: ${this.eventBuffer.length} events`);
        this._flushBuffer().catch(error => {
          console.error(`[Kafka] Periodic flush error: ${error.message}`);
        });
      }
    }, this.flushIntervalMs);
    
    console.log(`[Kafka] Started buffer flush (interval: ${this.flushIntervalMs}ms)`);
  }
  
  /**
   * Stop periodic buffer flush
   * @private
   */
  _stopBufferFlush() {
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
      console.log('[Kafka] Stopped buffer flush');
    }
  }
  
  /**
   * Validate event structure
   * @private
   */
  _validateEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('Event must be an object');
    }
    
    if (!event.type) {
      throw new Error('Event must have a type');
    }
    
    if (!event.infoHash) {
      throw new Error('Event must have an infoHash');
    }
    
    if (event.data && typeof event.data !== 'object') {
      throw new Error('Event data must be an object');
    }
  }
  
  /**
   * Check if error is transient (retriable)
   * @private
   */
  _isTransientError(error) {
    const transientErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'NETWORK_ERROR',
      'REQUEST_TIMED_OUT'
    ];
    
    return transientErrors.some(code => 
      error.message.includes(code) || error.code === code
    );
  }
  
  /**
   * Get current buffer size
   */
  getBufferSize() {
    return this.eventBuffer.length;
  }
  
  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      brokers: this.brokers,
      topic: this.topic,
      bufferedEvents: this.eventBuffer.length
    };
  }
}

// Singleton instance
let producerInstance = null;

/**
 * Get or create producer instance
 * @param {Object} options - Producer options
 * @returns {Promise<TorrentEventProducer>}
 */
async function getProducer(options = {}) {
  if (!producerInstance) {
    console.log('[Kafka] Creating new producer instance');
    producerInstance = new TorrentEventProducer(options);
    await producerInstance.connect();
  }
  
  return producerInstance;
}

/**
 * Close producer instance
 */
async function closeProducer() {
  if (producerInstance) {
    console.log('[Kafka] Closing producer instance');
    await producerInstance.disconnect();
    producerInstance = null;
  }
}

/**
 * Check if producer is initialized
 */
function hasProducer() {
  return producerInstance !== null;
}

module.exports = {
  TorrentEventProducer,
  EVENT_TYPES,
  getProducer,
  closeProducer,
  hasProducer
};
