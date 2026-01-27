/**
 * TorrentEdge BitTorrent Client Engine
 * 
 * A complete BitTorrent client implementation for Node.js
 * 
 * @module torrentEngine
 * @example
 * const { TorrentEngine, Torrent } = require('./torrentEngine');
 * 
 * // Create engine instance
 * const engine = new TorrentEngine({
 *   downloadPath: './downloads',
 *   maxActiveTorrents: 5,
 *   port: 6881
 * });
 * 
 * // Add a torrent
 * const torrent = await engine.addTorrent({
 *   torrentPath: './sample.torrent',
 *   autoStart: true
 * });
 * 
 * // Listen to events
 * torrent.on('progress', (progress) => {
 *   console.log(`Downloaded: ${progress.percentage.toFixed(2)}%`);
 * });
 * 
 * torrent.on('done', () => {
 *   console.log('Download complete!');
 * });
 * 
 * @example
 * // Use default singleton instance
 * const { defaultEngine } = require('./torrentEngine');
 * 
 * await defaultEngine.addTorrent({
 *   torrentPath: './sample.torrent'
 * });
 */

const { TorrentEngine } = require('./engine');
const { Torrent } = require('./torrent');
const { PeerManager } = require('./peerManager');
const { PeerConnection, MESSAGE_TYPES } = require('./peerConnection');
const { DownloadManager } = require('./downloadManager');
const { FileWriter } = require('./fileWriter');
const { Piece } = require('./piece');
const bencode = require('./bencode');
const { parseTorrent } = require('./torrentParser');
const { announce } = require('./tracker');

/**
 * Create a new TorrentEngine instance with the provided configuration
 * 
 * @param {Object} options - Engine configuration options
 * @param {string} [options.downloadPath='./downloads'] - Default download directory
 * @param {number} [options.maxActiveTorrents=5] - Maximum number of concurrent active torrents
 * @param {number} [options.port=6881] - Port for incoming peer connections
 * @returns {TorrentEngine} A new TorrentEngine instance
 * 
 * @example
 * const { createEngine } = require('./torrentEngine');
 * 
 * const engine = createEngine({
 *   downloadPath: '/var/torrents',
 *   maxActiveTorrents: 10,
 *   port: 6881
 * });
 */
function createEngine(options = {}) {
  return new TorrentEngine(options);
}

/**
 * Generate a random BitTorrent peer ID
 * Uses the format: -TE0001-<12 random hex characters>
 * 
 * @returns {Buffer} 20-byte peer ID
 * 
 * @example
 * const { generatePeerId } = require('./torrentEngine');
 * const peerId = generatePeerId();
 * console.log(peerId.toString('utf8')); // '-TE0001-xxxxxxxxxxxx'
 */
function generatePeerId() {
  const crypto = require('crypto');
  const prefix = '-TE0001-';
  const random = crypto.randomBytes(12).toString('hex').substring(0, 12);
  return Buffer.from(prefix + random, 'utf8');
}

/**
 * Default singleton TorrentEngine instance
 * Pre-configured with environment variables or defaults
 * 
 * @type {TorrentEngine}
 * @example
 * const { defaultEngine } = require('./torrentEngine');
 * 
 * await defaultEngine.addTorrent({
 *   torrentPath: './file.torrent'
 * });
 * 
 * const stats = defaultEngine.getGlobalStats();
 * console.log(`Active torrents: ${stats.activeTorrents}`);
 */
const defaultEngine = new TorrentEngine({
  downloadPath: process.env.DOWNLOAD_PATH || './downloads',
  maxActiveTorrents: parseInt(process.env.MAX_ACTIVE_TORRENTS) || 5,
  port: parseInt(process.env.TORRENT_PORT) || 6881
});

/**
 * @typedef {Object} TorrentOptions
 * @property {string} [torrentPath] - Path to .torrent file
 * @property {Buffer} [torrentBuffer] - Buffer containing .torrent file data
 * @property {string} [magnetURI] - Magnet link (not yet supported)
 * @property {string} [downloadPath] - Directory to save downloaded files
 * @property {number} [port] - Port for incoming connections
 * @property {Buffer} [peerId] - Custom peer ID (auto-generated if not provided)
 */

/**
 * @typedef {Object} TorrentStats
 * @property {string} infoHash - Torrent info hash (hex string)
 * @property {string} name - Torrent name
 * @property {number} size - Total size in bytes
 * @property {number} downloaded - Bytes downloaded
 * @property {number} total - Total bytes
 * @property {number} percentage - Download percentage (0-100)
 * @property {number} downloadSpeed - Download speed (bytes/sec)
 * @property {number} uploadSpeed - Upload speed (bytes/sec)
 * @property {number} eta - Estimated time remaining (seconds, -1 if unknown)
 * @property {string} state - Current state (idle, checking, downloading, seeding, paused, error)
 * @property {Object} peers - Peer information
 * @property {number} peers.connected - Number of connected peers
 * @property {number} peers.total - Total number of known peers
 * @property {number} seeds - Number of seeders
 * @property {number} leeches - Number of leechers
 * @property {number} pieceCount - Total number of pieces
 * @property {number} completedPieces - Number of completed pieces
 * @property {number} activePieces - Number of pieces currently downloading
 * @property {number} pendingRequests - Number of pending block requests
 */

/**
 * @typedef {Object} GlobalStats
 * @property {number} totalDownloadSpeed - Combined download speed (bytes/sec)
 * @property {number} totalUploadSpeed - Combined upload speed (bytes/sec)
 * @property {number} activeTorrents - Number of active torrents
 * @property {number} totalTorrents - Total number of torrents
 * @property {number} totalDownloaded - Total bytes downloaded
 * @property {number} totalUploaded - Total bytes uploaded
 */

module.exports = {
  // ===== Main Classes =====
  
  /**
   * Main torrent engine for managing multiple torrents
   * @see TorrentEngine
   */
  TorrentEngine,
  
  /**
   * Individual torrent instance
   * @see Torrent
   */
  Torrent,
  
  // ===== Core Components (Advanced Usage) =====
  
  /**
   * Manages multiple peer connections
   * @see PeerManager
   */
  PeerManager,
  
  /**
   * Individual peer TCP connection handler
   * @see PeerConnection
   */
  PeerConnection,
  
  /**
   * Coordinates piece/block downloads across peers
   * @see DownloadManager
   */
  DownloadManager,
  
  /**
   * Handles writing pieces to disk (multi-file support)
   * @see FileWriter
   */
  FileWriter,
  
  /**
   * Represents a single piece with block-level management
   * @see Piece
   */
  Piece,
  
  // ===== Utilities =====
  
  /**
   * Bencode encoder/decoder for .torrent files
   * @namespace bencode
   * @property {function(Buffer): *} decode - Decode bencoded data
   * @property {function(*): Buffer} encode - Encode data to bencode format
   */
  bencode,
  
  /**
   * Parse .torrent file and extract metadata
   * @function parseTorrent
   * @param {Buffer} buffer - .torrent file buffer
   * @returns {Object} Parsed torrent metadata
   */
  parseTorrent,
  
  /**
   * Tracker communication utilities
   * @namespace tracker
   */
  tracker: {
    /**
     * Announce to tracker and get peer list
     * @function announce
     * @param {Object} options - Announce options
     * @returns {Promise<Object>} Tracker response with peer list
     */
    announce,
    
    /**
     * Generate a random peer ID
     * @function generatePeerId
     * @returns {Buffer} 20-byte peer ID
     */
    generatePeerId
  },
  
  // ===== Constants =====
  
  /**
   * BitTorrent peer wire protocol message types
   * @enum {number}
   * @property {number} CHOKE - 0
   * @property {number} UNCHOKE - 1
   * @property {number} INTERESTED - 2
   * @property {number} NOT_INTERESTED - 3
   * @property {number} HAVE - 4
   * @property {number} BITFIELD - 5
   * @property {number} REQUEST - 6
   * @property {number} PIECE - 7
   * @property {number} CANCEL - 8
   * @property {number} PORT - 9
   */
  MESSAGE_TYPES,
  
  // ===== Factory Functions =====
  
  /**
   * Create a new TorrentEngine instance
   * @function createEngine
   */
  createEngine,
  
  // ===== Default Instance =====
  
  /**
   * Pre-configured singleton TorrentEngine instance
   * @type {TorrentEngine}
   */
  defaultEngine
};
