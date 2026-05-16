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

// Phase 2.1: Service Decomposition
const { DIRECTIVE_TYPES, TOPICS, buildDirective, validateDirective } = require('./jobDirective');
const Dispatcher = require('./dispatcher');
const WorkerConsumer = require('./workerConsumer');

// Phase 4.1: Peer-Assisted Replication
const PeerRegistry = require('./peerRegistry');
const InternalPeerDiscovery = require('./internalPeerDiscovery');

// Phase 4.2: Deduplication
const CASStore = require('./casStore');
const DeduplicationService = require('./deduplicationService');

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

// Phase 2.1: Singleton Dispatcher + embedded Worker
const defaultDispatcher = new Dispatcher({
  engine: defaultEngine,
  kafkaEnabled: process.env.KAFKA_ENABLED === 'true',
});

const defaultWorker = new WorkerConsumer({
  engine: defaultEngine,
  nodeId: process.env.WORKER_NODE_ID || `local-${process.pid}`,
  kafka: process.env.KAFKA_ENABLED === 'true' ? {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    groupId: process.env.KAFKA_CONSUMER_GROUP || 'torrentedge-workers',
  } : null,
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
  
  // ===== Phase 2.1: Service Decomposition =====
  DIRECTIVE_TYPES,
  TOPICS,
  buildDirective,
  validateDirective,
  Dispatcher,
  WorkerConsumer,
  defaultDispatcher,
  defaultWorker,

  // ===== Phase 4.1: Peer-Assisted Replication =====
  PeerRegistry,
  InternalPeerDiscovery,

  // ===== Phase 4.2: Deduplication =====
  CASStore,
  DeduplicationService,
  
  // ===== Default Instance =====
  defaultEngine
};
