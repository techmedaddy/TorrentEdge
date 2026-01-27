/**
 * TorrentEdge BitTorrent Client Engine
 * 
 * A complete BitTorrent client implementation for Node.js
 * 
 * @module torrentEngine
 */

const { TorrentEngine } = require('./engine');
const { Torrent } = require('./torrent');
const { PeerManager } = require('./peerManager');
const { PeerConnection, MESSAGE_TYPES } = require('./peerConnection');
const { DownloadManager } = require('./downloadManager');
const { FileWriter } = require('./fileWriter');
const { Piece } = require('./piece');
const { PieceManager } = require('./pieceManager');
const bencode = require('./bencode');
const { parseTorrent } = require('./torrentParser');
const { announce, TrackerManager, generatePeerId } = require('./tracker');
const { parseMagnet, createMagnet } = require('./magnet');
const { SpeedTracker } = require('./speedTracker');

// Phase 4 components
const { QueueManager } = require('./queueManager');
const { StateManager } = require('./stateManager');
const { Throttler, GlobalThrottler, TorrentThrottler } = require('./throttler');
const UploadManager = require('./uploadManager');
const { RetryManager, PeerBanManager, TimeoutManager } = require('./retryManager');

// Kafka components
const { TorrentEventProducer, getProducer, closeProducer, EVENT_TYPES } = require('./kafkaProducer');
const { TorrentEventConsumer, createAnalyticsConsumer } = require('./kafkaConsumer');

// DHT components
const DHTNode = require('./dht/node');
const RoutingTable = require('./dht/routingTable');

/**
 * Create a new TorrentEngine instance
 */
function createEngine(options = {}) {
  return new TorrentEngine(options);
}

/**
 * Default singleton TorrentEngine instance
 */
const defaultEngine = new TorrentEngine({
  downloadPath: process.env.DOWNLOAD_PATH || './downloads',
  maxActiveTorrents: parseInt(process.env.MAX_ACTIVE_TORRENTS) || 5,
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 3,
  port: parseInt(process.env.TORRENT_PORT) || 6881,
  autoResume: process.env.AUTO_RESUME !== 'false',
  kafka: {
    enabled: process.env.KAFKA_ENABLED === 'true',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    topic: process.env.KAFKA_TOPIC || 'torrent-events'
  }
});

module.exports = {
  // ===== Main Classes =====
  TorrentEngine,
  Torrent,
  
  // ===== Core Components =====
  PeerManager,
  PeerConnection,
  DownloadManager,
  FileWriter,
  Piece,
  PieceManager,
  
  // ===== Phase 2: Magnet + DHT =====
  DHTNode,
  RoutingTable,
  parseMagnet,
  createMagnet,
  
  // ===== Phase 3: Real-time + Kafka =====
  TorrentEventProducer,
  TorrentEventConsumer,
  getProducer,
  closeProducer,
  createAnalyticsConsumer,
  EVENT_TYPES,
  
  // ===== Phase 4: Production Polish =====
  QueueManager,
  StateManager,
  Throttler,
  GlobalThrottler,
  TorrentThrottler,
  UploadManager,
  RetryManager,
  PeerBanManager,
  TimeoutManager,
  SpeedTracker,
  TrackerManager,
  
  // ===== Utilities =====
  bencode,
  parseTorrent,
  generatePeerId,
  tracker: {
    announce,
    generatePeerId,
    TrackerManager
  },
  
  // ===== Constants =====
  MESSAGE_TYPES,
  
  // ===== Factory Functions =====
  createEngine,
  
  // ===== Default Instance =====
  defaultEngine
};
