const EventEmitter = require('events');
const fs = require('fs').promises;
const crypto = require('crypto');
const { parseTorrent } = require('./torrentParser');
const { announce } = require('./tracker');
const { PeerManager } = require('./peerManager');
const { DownloadManager } = require('./downloadManager');
const { FileWriter } = require('./fileWriter');

class Torrent extends EventEmitter {
  constructor(options = {}) {
    super();

    if (!options.torrentPath && !options.torrentBuffer && !options.magnetURI) {
      throw new Error('Must provide torrentPath, torrentBuffer, or magnetURI');
    }

    this._options = options;
    this._torrentPath = options.torrentPath;
    this._torrentBuffer = options.torrentBuffer;
    this._magnetURI = options.magnetURI;
    this._downloadPath = options.downloadPath || './downloads';
    this._port = options.port || 6881;
    this._peerId = options.peerId || this._generatePeerId();

    this._metadata = null;
    this._tracker = null;
    this._peerManager = null;
    this._downloadManager = null;
    this._fileWriter = null;

    this._announceInterval = null;
    this._statsInterval = null;
    this._state = 'idle';
    
    this._downloadedBytesHistory = [];
    this._uploadedBytesHistory = [];
    this._lastStatsUpdate = Date.now();
    this._totalDownloaded = 0;
    this._totalUploaded = 0;

    this._connectedPeers = 0;
    this._totalPeers = 0;
    this._seeds = 0;
    this._leeches = 0;

    this._initPromise = this._initialize();
  }

  _generatePeerId() {
    // Generate peer ID: -TR2940-<12 random bytes>
    const prefix = '-TE0001-'; // TorrentEdge v0.0.1
    const random = crypto.randomBytes(12).toString('hex').substring(0, 12);
    return Buffer.from(prefix + random, 'utf8');
  }

  async _initialize() {
    try {
      if (this._magnetURI) {
        throw new Error('Magnet links not yet supported');
      }

      let torrentBuffer;
      if (this._torrentBuffer) {
        torrentBuffer = this._torrentBuffer;
      } else if (this._torrentPath) {
        console.log(`[Torrent] Loading torrent file: ${this._torrentPath}`);
        torrentBuffer = await fs.readFile(this._torrentPath);
      }

      console.log('[Torrent] Parsing torrent metadata');
      this._metadata = parseTorrent(torrentBuffer);

      console.log(`[Torrent] Torrent: ${this._metadata.name}`);
      console.log(`[Torrent] Info hash: ${this._metadata.infoHash.toString('hex')}`);
      console.log(`[Torrent] Size: ${this._formatBytes(this._metadata.length)}`);
      console.log(`[Torrent] Pieces: ${this._metadata.pieces.length}`);
      console.log(`[Torrent] Files: ${this._metadata.files ? this._metadata.files.length : 1}`);

      this.emit('ready');
    } catch (error) {
      console.error(`[Torrent] Initialization error: ${error.message}`);
      this._state = 'error';
      this.emit('error', { message: error.message });
      throw error;
    }
  }

  async start() {
    await this._initPromise;

    if (this._state === 'downloading' || this._state === 'seeding') {
      console.log('[Torrent] Already running');
      return;
    }

    try {
      console.log('[Torrent] Starting download');
      this._state = 'checking';

      // Initialize FileWriter
      console.log('[Torrent] Initializing file writer');
      this._fileWriter = new FileWriter({
        torrent: this._metadata,
        downloadPath: this._downloadPath
      });

      await this._fileWriter.initialize();

      // Check existing pieces (resume support)
      console.log('[Torrent] Checking existing pieces');
      const verifyResult = await this._fileWriter.verify();
      
      if (verifyResult.valid.length > 0) {
        console.log(`[Torrent] Found ${verifyResult.valid.length} valid pieces on disk`);
      }
      if (verifyResult.invalid.length > 0) {
        console.log(`[Torrent] Found ${verifyResult.invalid.length} invalid pieces (will re-download)`);
      }

      // Initialize PeerManager
      console.log('[Torrent] Initializing peer manager');
      this._peerManager = new PeerManager({
        infoHash: this._metadata.infoHash,
        peerId: this._peerId,
        numPieces: this._metadata.pieces.length,
        port: this._port
      });

      this._peerManager.on('peer:connected', (peer) => {
        this._connectedPeers++;
        console.log(`[Torrent] Peer connected: ${peer.ip}:${peer.port} (${this._connectedPeers} total)`);
        this.emit('peer:connect', { ip: peer.ip, port: peer.port });
      });

      this._peerManager.on('peer:disconnected', (peer) => {
        this._connectedPeers--;
        console.log(`[Torrent] Peer disconnected: ${peer.ip}:${peer.port} (${this._connectedPeers} total)`);
        this.emit('peer:disconnect', { ip: peer.ip, port: peer.port });
      });

      this._peerManager.on('error', (error) => {
        console.error(`[Torrent] PeerManager error: ${error.message}`);
        this.emit('warning', { message: `Peer error: ${error.message}` });
      });

      // Initialize DownloadManager
      console.log('[Torrent] Initializing download manager');
      this._downloadManager = new DownloadManager({
        torrent: this._metadata,
        peerManager: this._peerManager,
        downloadPath: this._downloadPath,
        fileWriter: this._fileWriter,
        maxActiveRequests: 5
      });

      // Mark already verified pieces as complete
      for (const pieceIndex of verifyResult.valid) {
        this._downloadManager.completedPieces.add(pieceIndex);
        const piece = this._downloadManager.getPieceByIndex(pieceIndex);
        this._downloadManager.downloadedBytes += piece.length;
      }

      this._setupDownloadManagerEvents();

      // Announce to tracker(s) and get peers
      console.log('[Torrent] Announcing to tracker');
      await this._announceToTracker('started');

      // Start download manager
      console.log('[Torrent] Starting download manager');
      this._downloadManager.start();

      this._state = 'downloading';
      this.emit('started');

      // Set up periodic re-announce
      const announceInterval = this._metadata.announceInterval || 1800; // 30 minutes default
      this._announceInterval = setInterval(() => {
        this._announceToTracker('').catch((error) => {
          console.error(`[Torrent] Re-announce failed: ${error.message}`);
          this.emit('warning', { message: `Tracker announce failed: ${error.message}` });
        });
      }, announceInterval * 1000);

      // Set up stats calculation
      this._statsInterval = setInterval(() => {
        this._updateStats();
      }, 1000);

    } catch (error) {
      console.error(`[Torrent] Start error: ${error.message}`);
      this._state = 'error';
      this.emit('error', { message: error.message });
      throw error;
    }
  }

  pause() {
    if (this._state !== 'downloading') {
      console.log('[Torrent] Cannot pause: not downloading');
      return;
    }

    console.log('[Torrent] Pausing');
    this._downloadManager.pause();
    this._state = 'paused';
    this.emit('paused');
  }

  resume() {
    if (this._state !== 'paused') {
      console.log('[Torrent] Cannot resume: not paused');
      return;
    }

    console.log('[Torrent] Resuming');
    this._downloadManager.resume();
    this._state = 'downloading';
    this.emit('resumed');
  }

  async stop() {
    if (this._state === 'idle') {
      console.log('[Torrent] Already stopped');
      return;
    }

    try {
      console.log('[Torrent] Stopping');

      // Clear intervals
      if (this._announceInterval) {
        clearInterval(this._announceInterval);
        this._announceInterval = null;
      }

      if (this._statsInterval) {
        clearInterval(this._statsInterval);
        this._statsInterval = null;
      }

      // Stop download manager
      if (this._downloadManager) {
        this._downloadManager.stop();
      }

      // Send 'stopped' event to tracker
      try {
        await this._announceToTracker('stopped');
      } catch (error) {
        console.error(`[Torrent] Failed to send stopped event to tracker: ${error.message}`);
      }

      // Disconnect all peers
      if (this._peerManager) {
        this._peerManager.disconnectAll();
      }

      // Close file handles
      if (this._fileWriter) {
        await this._fileWriter.close();
      }

      this._state = 'idle';
      console.log('[Torrent] Stopped');
      this.emit('stopped');

    } catch (error) {
      console.error(`[Torrent] Stop error: ${error.message}`);
      this.emit('error', { message: error.message });
    }
  }

  async destroy() {
    console.log('[Torrent] Destroying');
    await this.stop();
    this.removeAllListeners();
  }

  _setupDownloadManagerEvents() {
    this._downloadManager.on('piece:complete', ({ index }) => {
      console.log(`[Torrent] Piece ${index} complete`);
      this.emit('piece', { index });
    });

    this._downloadManager.on('progress', (progress) => {
      this.emit('progress', {
        downloaded: progress.downloaded,
        total: progress.total,
        percentage: progress.percentage,
        speed: this.downloadSpeed
      });
    });

    this._downloadManager.on('complete', () => {
      console.log('[Torrent] Download complete!');
      this._state = 'seeding';
      this.emit('done');
    });

    this._downloadManager.on('error', ({ message }) => {
      console.error(`[Torrent] DownloadManager error: ${message}`);
      this.emit('warning', { message: `Download error: ${message}` });
    });

    this._downloadManager.on('piece:failed', ({ index, reason }) => {
      console.warn(`[Torrent] Piece ${index} failed: ${reason}`);
      this.emit('warning', { message: `Piece ${index} failed: ${reason}` });
    });
  }

  async _announceToTracker(event) {
    if (!this._metadata) {
      throw new Error('Torrent not initialized');
    }

    const downloaded = this._downloadManager ? this._downloadManager.downloadedBytes : 0;
    const uploaded = this._totalUploaded;
    const left = this._metadata.length - downloaded;

    try {
      const response = await announce({
        announceUrl: this._metadata.announce,
        infoHash: this._metadata.infoHash,
        peerId: this._peerId,
        port: this._port,
        uploaded,
        downloaded,
        left,
        event,
        compact: 1
      });

      console.log(`[Torrent] Tracker response: ${response.peers.length} peers`);

      if (response.seeders !== undefined) {
        this._seeds = response.seeders;
      }
      if (response.leechers !== undefined) {
        this._leeches = response.leechers;
      }

      this._totalPeers = response.peers.length;

      // Add peers to peer manager
      if (this._peerManager) {
        for (const peer of response.peers) {
          this._peerManager.addPeer(peer.ip, peer.port);
        }
      }

      return response;
    } catch (error) {
      console.error(`[Torrent] Tracker announce error: ${error.message}`);
      throw error;
    }
  }

  _updateStats() {
    const now = Date.now();
    const elapsed = (now - this._lastStatsUpdate) / 1000;

    if (this._downloadManager) {
      const currentDownloaded = this._downloadManager.downloadedBytes;
      const downloadedDelta = currentDownloaded - this._totalDownloaded;
      this._totalDownloaded = currentDownloaded;

      // Store in history (keep last 5 seconds)
      this._downloadedBytesHistory.push({
        timestamp: now,
        bytes: downloadedDelta
      });

      // Remove old entries (older than 5 seconds)
      this._downloadedBytesHistory = this._downloadedBytesHistory.filter(
        entry => now - entry.timestamp < 5000
      );
    }

    this._lastStatsUpdate = now;
  }

  getStats() {
    const downloaded = this._downloadManager ? this._downloadManager.downloadedBytes : 0;
    const total = this._metadata ? this._metadata.length : 0;
    const percentage = total > 0 ? (downloaded / total) * 100 : 0;

    return {
      infoHash: this.infoHash,
      name: this.name,
      size: this.size,
      downloaded,
      total,
      percentage: Math.min(100, percentage),
      downloadSpeed: this.downloadSpeed,
      uploadSpeed: this.uploadSpeed,
      eta: this.eta,
      state: this._state,
      peers: {
        connected: this._connectedPeers,
        total: this._totalPeers
      },
      seeds: this._seeds,
      leeches: this._leeches,
      pieceCount: this.pieceCount,
      completedPieces: this._downloadManager ? this._downloadManager.completedPieces.size : 0,
      activePieces: this._downloadManager ? this._downloadManager.activePieces.size : 0,
      pendingRequests: this._downloadManager ? this._downloadManager.pendingRequests.size : 0
    };
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Read-only properties
  get infoHash() {
    return this._metadata ? this._metadata.infoHash.toString('hex') : null;
  }

  get name() {
    return this._metadata ? this._metadata.name : null;
  }

  get size() {
    return this._metadata ? this._metadata.length : 0;
  }

  get pieceCount() {
    return this._metadata ? this._metadata.pieces.length : 0;
  }

  get files() {
    if (!this._metadata) return [];
    
    if (this._metadata.files) {
      return this._metadata.files.map(f => ({
        path: f.path,
        length: f.length
      }));
    } else {
      return [{
        path: this._metadata.name,
        length: this._metadata.length
      }];
    }
  }

  get downloadPath() {
    return this._downloadPath;
  }

  get state() {
    return this._state;
  }

  get progress() {
    const downloaded = this._downloadManager ? this._downloadManager.downloadedBytes : 0;
    const total = this._metadata ? this._metadata.length : 0;
    return total > 0 ? (downloaded / total) * 100 : 0;
  }

  get downloadSpeed() {
    if (this._downloadedBytesHistory.length === 0) {
      return 0;
    }

    // Calculate average speed over last 5 seconds
    const totalBytes = this._downloadedBytesHistory.reduce((sum, entry) => sum + entry.bytes, 0);
    const oldestTimestamp = this._downloadedBytesHistory[0].timestamp;
    const newestTimestamp = this._downloadedBytesHistory[this._downloadedBytesHistory.length - 1].timestamp;
    const duration = (newestTimestamp - oldestTimestamp) / 1000;

    return duration > 0 ? totalBytes / duration : 0;
  }

  get uploadSpeed() {
    // Upload speed calculation (similar to download speed)
    if (this._uploadedBytesHistory.length === 0) {
      return 0;
    }

    const totalBytes = this._uploadedBytesHistory.reduce((sum, entry) => sum + entry.bytes, 0);
    const oldestTimestamp = this._uploadedBytesHistory[0].timestamp;
    const newestTimestamp = this._uploadedBytesHistory[this._uploadedBytesHistory.length - 1].timestamp;
    const duration = (newestTimestamp - oldestTimestamp) / 1000;

    return duration > 0 ? totalBytes / duration : 0;
  }

  get peers() {
    return {
      connected: this._connectedPeers,
      total: this._totalPeers
    };
  }

  get seeds() {
    return this._seeds;
  }

  get leeches() {
    return this._leeches;
  }

  get eta() {
    if (this._state !== 'downloading') {
      return -1;
    }

    const downloaded = this._downloadManager ? this._downloadManager.downloadedBytes : 0;
    const total = this._metadata ? this._metadata.length : 0;
    const remaining = total - downloaded;

    if (remaining <= 0) {
      return 0;
    }

    const speed = this.downloadSpeed;
    if (speed <= 0) {
      return -1; // Unknown
    }

    return Math.ceil(remaining / speed);
  }
}

module.exports = { Torrent };
