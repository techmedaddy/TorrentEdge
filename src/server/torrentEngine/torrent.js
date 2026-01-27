const EventEmitter = require('events');
const fs = require('fs').promises;
const crypto = require('crypto');
const { parseTorrent } = require('./torrentParser');
const { parseMagnet } = require('./magnet');
const { announce } = require('./tracker');
const { PeerManager } = require('./peerManager');
const { DownloadManager } = require('./downloadManager');
const { FileWriter } = require('./fileWriter');
const { MetadataDownloader } = require('./extensionProtocol');

/**
 * SpeedTracker - Calculates smoothed speed using exponential moving average
 */
class SpeedTracker {
  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.lastUpdate = Date.now();
  }
  
  addBytes(bytes) {
    const now = Date.now();
    this.samples.push({
      bytes,
      timestamp: now
    });
    
    // Remove old samples outside the window
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter(s => s.timestamp >= cutoff);
    
    this.lastUpdate = now;
  }
  
  getSpeed() {
    if (this.samples.length === 0) {
      return 0;
    }
    
    // Calculate speed over the window
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recentSamples = this.samples.filter(s => s.timestamp >= cutoff);
    
    if (recentSamples.length === 0) {
      return 0;
    }
    
    const totalBytes = recentSamples.reduce((sum, s) => sum + s.bytes, 0);
    const oldestTimestamp = recentSamples[0].timestamp;
    const duration = (now - oldestTimestamp) / 1000;
    
    return duration > 0 ? totalBytes / duration : 0;
  }
  
  reset() {
    this.samples = [];
  }
}

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
    this._dht = options.dht || null; // DHT node for peer discovery
    
    // Progress tracking configuration
    this._progressInterval = options.progressInterval || 500;

    this._metadata = null;
    this._tracker = null;
    this._peerManager = null;
    this._downloadManager = null;
    this._fileWriter = null;
    this._metadataDownloader = null;
    
    // Magnet link specific properties
    this._needsMetadata = false;
    this._magnetPeers = [];
    this._metadataTimeout = null;

    this._announceInterval = null;
    this._statsInterval = null;
    this._progressIntervalTimer = null;
    this._state = 'idle';
    
    // Speed trackers with exponential moving average
    this._downloadSpeedTracker = new SpeedTracker(5000);
    this._uploadSpeedTracker = new SpeedTracker(5000);
    
    this._downloadedBytesHistory = [];
    this._uploadedBytesHistory = [];
    this._lastStatsUpdate = Date.now();
    this._lastProgressEmit = Date.now();
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
        console.log('[Torrent] Parsing magnet link');
        const magnet = parseMagnet(this._magnetURI);
        
        // Create partial metadata from magnet link
        this._metadata = {
          infoHash: magnet.infoHash,
          infoHashBuffer: magnet.infoHashBuffer,
          name: magnet.displayName || 'Unknown',
          announce: magnet.trackers[0] || null,
          announceList: magnet.trackers.length > 1 ? [magnet.trackers] : [],
          // These will be filled in after metadata download
          pieceLength: null,
          pieces: null,
          length: null,
          files: null
        };
        
        this._needsMetadata = true;
        this._magnetPeers = magnet.peers || [];
        
        console.log(`[Torrent] Magnet link info hash: ${this._metadata.infoHash}`);
        console.log(`[Torrent] Magnet name: ${this._metadata.name}`);
        console.log(`[Torrent] Trackers: ${magnet.trackers.length}`);
        console.log(`[Torrent] Direct peers: ${this._magnetPeers.length}`);
        
        // Emit 'ready' asynchronously - ready to fetch metadata
        setImmediate(() => this.emit('ready'));
        return;
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

      // Emit 'ready' asynchronously to allow listeners to be registered
      setImmediate(() => this.emit('ready'));
    } catch (error) {
      console.error(`[Torrent] Initialization error: ${error.message}`);
      this._state = 'error';
      setImmediate(() => this.emit('error', { message: error.message }));
      throw error;
    }
  }

  async start() {
    await this._initPromise;

    if (this._state === 'downloading' || this._state === 'seeding' || this._state === 'fetching_metadata') {
      console.log('[Torrent] Already running');
      return;
    }

    try {
      // If this is a magnet link, fetch metadata first
      if (this._needsMetadata) {
        console.log('[Torrent] Fetching metadata from peers...');
        this._state = 'fetching_metadata';
        this.emit('fetching_metadata');
        
        await this._downloadMetadata();
        
        // Now we have full metadata, continue normal start
        this._needsMetadata = false;
        console.log('[Torrent] Metadata fetched successfully');
        console.log(`[Torrent] Torrent: ${this._metadata.name}`);
        console.log(`[Torrent] Size: ${this._formatBytes(this._metadata.length)}`);
        console.log(`[Torrent] Pieces: ${this._metadata.pieces.length}`);
        console.log(`[Torrent] Files: ${this._metadata.files ? this._metadata.files.length : 1}`);
      }
      
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
        infoHash: this._metadata.infoHashBuffer,
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
      
      // Clear metadata timeout
      if (this._metadataTimeout) {
        clearTimeout(this._metadataTimeout);
        this._metadataTimeout = null;
      }
      
      // Stop metadata downloader
      if (this._metadataDownloader) {
        this._metadataDownloader.stop();
        this._metadataDownloader = null;
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

  async _downloadMetadata() {
    return new Promise(async (resolve, reject) => {
      try {
        console.log('[Torrent] Starting metadata download...');
        
        // Set timeout for metadata download (5 minutes)
        this._metadataTimeout = setTimeout(() => {
          console.error('[Torrent] Metadata download timeout');
          if (this._metadataDownloader) {
            this._metadataDownloader.stop();
          }
          reject(new Error('Metadata download timeout after 5 minutes'));
        }, 5 * 60 * 1000);
        
        // Initialize PeerManager for metadata fetching
        this._peerManager = new PeerManager({
          infoHash: this._metadata.infoHashBuffer,
          peerId: this._peerId,
          numPieces: 0, // Don't know yet
          port: this._port
        });
        
        // Track peer connections for metadata
        this._peerManager.on('peer:connected', (peer) => {
          this._connectedPeers++;
          console.log(`[Torrent] Metadata peer connected: ${peer.ip}:${peer.port}`);
        });
        
        this._peerManager.on('peer:disconnected', (peer) => {
          this._connectedPeers--;
          console.log(`[Torrent] Metadata peer disconnected: ${peer.ip}:${peer.port}`);
        });
        
        // Create MetadataDownloader
        this._metadataDownloader = new MetadataDownloader({
          infoHash: this._metadata.infoHashBuffer,
          peerManager: this._peerManager,
          onMetadata: (metadata, infoDict) => {
            this._handleMetadataComplete(metadata, infoDict, resolve);
          }
        });
        
        // Handle metadata events
        this._metadataDownloader.on('size', (size) => {
          console.log(`[Torrent] Metadata size: ${this._formatBytes(size)}`);
          this.emit('metadata:size', { size });
        });
        
        this._metadataDownloader.on('piece', ({ index, data }) => {
          console.log(`[Torrent] Metadata piece ${index} received (${data.length} bytes)`);
          this.emit('metadata:piece', { index, size: data.length });
        });
        
        this._metadataDownloader.on('error', (error) => {
          console.error(`[Torrent] Metadata download error: ${error.message}`);
          clearTimeout(this._metadataTimeout);
          reject(error);
        });
        
        // Add direct peers from magnet link
        if (this._magnetPeers && this._magnetPeers.length > 0) {
          console.log(`[Torrent] Adding ${this._magnetPeers.length} direct peers from magnet`);
          this._peerManager.addPeers(this._magnetPeers);
        }
        
        // Announce to trackers to get more peers
        if (this._metadata.announce) {
          try {
            console.log('[Torrent] Announcing to tracker for peers...');
            await this._announceToTracker('started');
          } catch (error) {
            console.warn(`[Torrent] Tracker announce failed: ${error.message}`);
            // Continue anyway, we might have DHT or direct peers
          }
        }
        
        // Use DHT to find peers
        if (this._dht) {
          console.log('[Torrent] Using DHT to find peers...');
          try {
            const infoHashHex = this._metadata.infoHashBuffer.toString('hex');
            
            // Listen for peers from DHT
            this._dht.on('peer', (data) => {
              if (data.infoHash === infoHashHex) {
                console.log(`[Torrent] DHT found peer: ${data.peer.host}:${data.peer.port}`);
                this._peerManager.addPeers([data.peer]);
              }
            });
            
            // Start DHT lookup
            await this._dht.getPeers(this._metadata.infoHashBuffer, (peers) => {
              if (peers && peers.length > 0) {
                console.log(`[Torrent] DHT returned ${peers.length} peers`);
                this._peerManager.addPeers(peers);
              }
            });
          } catch (error) {
            console.warn(`[Torrent] DHT peer discovery failed: ${error.message}`);
            // Continue anyway
          }
        }
        
        // Start metadata downloader
        this._metadataDownloader.start();
        
        // If no peers after 30 seconds, error out
        setTimeout(() => {
          if (this._connectedPeers === 0) {
            console.error('[Torrent] No peers connected after 30 seconds');
            clearTimeout(this._metadataTimeout);
            if (this._metadataDownloader) {
              this._metadataDownloader.stop();
            }
            reject(new Error('No peers available for metadata download'));
          }
        }, 30000);
        
      } catch (error) {
        console.error(`[Torrent] Metadata download setup error: ${error.message}`);
        clearTimeout(this._metadataTimeout);
        reject(error);
      }
    });
  }
  
  _handleMetadataComplete(metadata, infoDict, resolve) {
    try {
      console.log('[Torrent] Metadata download complete!');
      
      // Clear timeout
      if (this._metadataTimeout) {
        clearTimeout(this._metadataTimeout);
        this._metadataTimeout = null;
      }
      
      // Parse the info dictionary to update metadata
      const { parseTorrent } = require('./torrentParser');
      
      // Create a minimal torrent structure with the info dict
      const bencode = require('./bencode');
      const fullTorrent = bencode.encode({
        info: infoDict
      });
      
      // Parse it to get proper metadata structure
      const fullMetadata = parseTorrent(fullTorrent);
      
      // Update our metadata with the full info
      this._metadata.name = fullMetadata.name;
      this._metadata.pieceLength = fullMetadata.pieceLength;
      this._metadata.pieces = fullMetadata.pieces;
      this._metadata.length = fullMetadata.length;
      this._metadata.files = fullMetadata.files;
      
      console.log(`[Torrent] Metadata verified and parsed successfully`);
      console.log(`[Torrent] Name: ${this._metadata.name}`);
      console.log(`[Torrent] Size: ${this._formatBytes(this._metadata.length)}`);
      console.log(`[Torrent] Pieces: ${this._metadata.pieces.length}`);
      
      this.emit('metadata:complete', {
        name: this._metadata.name,
        size: this._metadata.length,
        pieceCount: this._metadata.pieces.length
      });
      
      resolve();
      
    } catch (error) {
      console.error(`[Torrent] Error processing metadata: ${error.message}`);
      throw error;
    }
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
        infoHash: this._metadata.infoHashBuffer,
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
      if (this._peerManager && response.peers.length > 0) {
        this._peerManager.addPeers(response.peers);
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

      // Add to speed tracker instead of history array
      if (downloadedDelta > 0) {
        this._downloadSpeedTracker.addBytes(downloadedDelta);
      }

      // Store in history (keep last 5 seconds) - kept for backwards compatibility
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
    
    // Emit progress event at configured interval
    if (now - this._lastProgressEmit >= this._progressInterval) {
      const progress = this._calculateProgress();
      this.emit('progress', progress);
      this._lastProgressEmit = now;
    }
  }

  getStats() {
    const downloaded = this._downloadManager ? this._downloadManager.downloadedBytes : 0;
    const total = this._metadata ? this._metadata.length : 0;
    const percentage = total > 0 ? (downloaded / total) * 100 : 0;

    const stats = {
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
    
    // Add metadata progress if fetching
    if (this._state === 'fetching_metadata' && this._metadataDownloader) {
      stats.metadataProgress = this._metadataDownloader.getProgress();
    }
    
    return stats;
  }
  
  /**
   * Calculate comprehensive progress statistics
   * @returns {Object} Detailed progress information
   */
  _calculateProgress() {
    const downloaded = this._downloadManager ? this._downloadManager.downloadedBytes : 0;
    const total = this._metadata ? this._metadata.length : 0;
    const percentage = total > 0 ? (downloaded / total) * 100 : 0;
    
    const downloadSpeed = this.downloadSpeed;
    const uploadSpeed = this.uploadSpeed;
    
    // Calculate ETA
    let eta = null;
    if (downloadSpeed > 0 && total > downloaded) {
      eta = Math.ceil((total - downloaded) / downloadSpeed);
    }
    
    // Piece statistics
    const totalPieces = this.pieceCount;
    const completedPieces = this._downloadManager ? this._downloadManager.completedPieces.size : 0;
    const activePieces = this._downloadManager ? this._downloadManager.activePieces.size : 0;
    const pendingRequests = this._downloadManager ? this._downloadManager.pendingRequests.size : 0;
    
    // Calculate share ratio
    const ratio = downloaded > 0 ? this._totalUploaded / downloaded : 0;
    
    return {
      infoHash: this.infoHash,
      name: this.name,
      size: total,
      downloaded,
      uploaded: this._totalUploaded,
      percentage: Math.min(100, percentage),
      downloadSpeed,
      uploadSpeed,
      eta,
      ratio,
      state: this._state,
      peers: {
        connected: this._connectedPeers,
        total: this._totalPeers,
        seeds: this._seeds,
        leeches: this._leeches
      },
      pieces: {
        total: totalPieces,
        completed: completedPieces,
        active: activePieces,
        pending: pendingRequests
      },
      // Add metadata progress if fetching
      ...(this._state === 'fetching_metadata' && this._metadataDownloader && {
        metadataProgress: this._metadataDownloader.getProgress()
      })
    };
  }
  
  /**
   * Get piece completion bitmap for visualization
   * @returns {Uint8Array} Bitmap where 1=completed, 0=not completed
   */
  getPieceBitmap() {
    if (!this._metadata || !this._downloadManager) {
      return new Uint8Array(0);
    }
    
    const totalPieces = this.pieceCount;
    const bitmap = new Uint8Array(totalPieces);
    
    for (let i = 0; i < totalPieces; i++) {
      bitmap[i] = this._downloadManager.completedPieces.has(i) ? 1 : 0;
    }
    
    return bitmap;
  }
  
  /**
   * Get piece availability map (how many peers have each piece)
   * @returns {Uint8Array} Count of peers per piece
   */
  getPieceAvailability() {
    if (!this._metadata || !this._peerManager) {
      return new Uint8Array(0);
    }
    
    const totalPieces = this.pieceCount;
    const availability = new Uint8Array(totalPieces);
    
    // Get all connected peers
    const peers = this._peerManager.peers || [];
    
    for (let pieceIndex = 0; pieceIndex < totalPieces; pieceIndex++) {
      let peerCount = 0;
      
      for (const peer of peers) {
        // Check if peer has this piece
        if (peer.bitfield && peer.bitfield.has(pieceIndex)) {
          peerCount++;
        }
      }
      
      availability[pieceIndex] = Math.min(255, peerCount); // Cap at 255 for Uint8Array
    }
    
    return availability;
  }
  
  /**
   * Get detailed statistics including piece bitmaps and file progress
   * @returns {Object} Comprehensive stats with visualization data
   */
  getDetailedStats() {
    const baseStats = this._calculateProgress();
    
    // Add piece bitmap as base64 for easy transmission
    const pieceBitmap = this.getPieceBitmap();
    const pieceAvailability = this.getPieceAvailability();
    
    // Convert to base64 for JSON serialization
    const pieceBitmapBase64 = Buffer.from(pieceBitmap).toString('base64');
    const pieceAvailabilityBase64 = Buffer.from(pieceAvailability).toString('base64');
    
    // File-level progress if multi-file torrent
    let fileProgress = [];
    if (this._metadata && this._metadata.files && this._fileWriter) {
      fileProgress = this._metadata.files.map((file, index) => {
        // Calculate which pieces belong to this file
        const fileStart = file.offset;
        const fileEnd = file.offset + file.length;
        const pieceLength = this._metadata.pieceLength;
        
        const firstPiece = Math.floor(fileStart / pieceLength);
        const lastPiece = Math.floor((fileEnd - 1) / pieceLength);
        
        let completedBytes = 0;
        for (let i = firstPiece; i <= lastPiece; i++) {
          if (this._downloadManager && this._downloadManager.completedPieces.has(i)) {
            const pieceStart = i * pieceLength;
            const pieceEnd = Math.min(pieceStart + pieceLength, this._metadata.length);
            
            // Calculate overlap with this file
            const overlapStart = Math.max(pieceStart, fileStart);
            const overlapEnd = Math.min(pieceEnd, fileEnd);
            
            if (overlapEnd > overlapStart) {
              completedBytes += overlapEnd - overlapStart;
            }
          }
        }
        
        return {
          path: file.path,
          length: file.length,
          completed: completedBytes,
          percentage: (completedBytes / file.length) * 100
        };
      });
    }
    
    return {
      ...baseStats,
      pieceBitmap: pieceBitmapBase64,
      pieceAvailability: pieceAvailabilityBase64,
      files: fileProgress,
      health: this._calculateHealth()
    };
  }
  
  /**
   * Calculate torrent health score (0-1 based on seeds/peers ratio)
   * @returns {number} Health score
   */
  _calculateHealth() {
    if (this._totalPeers === 0) return 0;
    
    const seedRatio = this._seeds / this._totalPeers;
    const peerAvailability = Math.min(1, this._connectedPeers / 50); // Normalized to 50 peers
    
    // Combined health score
    return (seedRatio * 0.7 + peerAvailability * 0.3);
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
    return this._downloadSpeedTracker.getSpeed();
  }

  get uploadSpeed() {
    return this._uploadSpeedTracker.getSpeed();
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
