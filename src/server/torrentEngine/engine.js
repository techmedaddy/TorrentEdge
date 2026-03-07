const EventEmitter = require('events');
const net  = require('net');
const fs   = require('fs').promises;
const path = require('path');
const { Torrent } = require('./torrent');
const { QueueManager } = require('./queueManager');
const { StateManager } = require('./stateManager');
const DHTNode = require('./dht/node');
const { 
  emitTorrentAdded, 
  emitTorrentStarted, 
  emitProgress, 
  emitPieceCompleted, 
  emitTorrentCompleted,
  emitTorrentError,
  emitTorrentPaused,
  emitTorrentResumed,
  emitTorrentRemoved,
  emitPeerConnected,
  emitPeerDisconnected,
  emitSpeedUpdate
} = require('../socket');
const { getProducer, closeProducer, EVENT_TYPES } = require('./kafkaProducer');
const { getIO } = require('../socket');

class TorrentEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this.downloadPath = options.downloadPath || './downloads';
    this.maxActiveTorrents = options.maxActiveTorrents || 5;
    this.port = options.port || 6881;

    this.torrents = new Map();
    this.isRunning = false;
    
    // Store options for later use
    this._options = options;

    this._stateFilePath = path.join(this.downloadPath, '.torrentedge', 'state.json');
    
    // Kafka producer
    this._kafkaProducer = null;
    this._kafkaEnabled = options.kafka?.enabled || false;
    
    // Kafka progress throttling (5 seconds)
    this._kafkaProgressThrottle = new Map(); // infoHash -> { lastSent, timer }
    this._kafkaProgressInterval = 5000;
    
    // State manager for persistence
    this._stateManager = new StateManager({
      stateDir: options.stateDir || './data/state',
      saveInterval: options.saveInterval || 30000,
      maxBackups: options.maxBackups || 3
    });
    
    // Resume options
    this._autoResume = options.autoResume !== false; // default true
    this._verifyOnResume = options.verifyOnResume || false;
    
    // Initialize Queue Manager
    this._queueManager = new QueueManager({
      maxConcurrent: options.maxConcurrent || 3,
      maxConnectionsTotal: options.maxConnectionsTotal || 200,
      maxConnectionsPerTorrent: options.maxConnectionsPerTorrent || 50,
      onQueueChange: () => this._emitQueueUpdate()
    });
    
    // Setup queue manager event listeners
    this._setupQueueManagerEvents();

    console.log('[TorrentEngine] Initialized');
    console.log(`[TorrentEngine] Download path: ${this.downloadPath}`);
    console.log(`[TorrentEngine] Max active torrents: ${this.maxActiveTorrents}`);
    console.log(`[TorrentEngine] Max concurrent (queue): ${options.maxConcurrent || 3}`);
    console.log(`[TorrentEngine] Auto-resume: ${this._autoResume}`);
    console.log(`[TorrentEngine] Verify on resume: ${this._verifyOnResume}`);
    console.log(`[TorrentEngine] Port: ${this.port}`);
    
    // Initialize Kafka if enabled
    if (this._kafkaEnabled) {
      this._initKafka(options.kafka).catch(error => {
        console.error(`[TorrentEngine] Kafka initialization failed: ${error.message}`);
      });
    }
    
    // Speed history tracking (circular buffer for last 60 samples)
    this._speedHistory = [];
    this._speedHistoryMaxSize = 60;
    this._speedHistoryInterval = null;
    this._startSpeedHistoryTracking();
    
    // DHT node for decentralized peer discovery
    this._dht = null;
    this._dhtEnabled = options.dht?.enabled !== false; // enabled by default
    this._dhtPort = options.dht?.port || this.port;
    
    if (this._dhtEnabled) {
      this._initDHT().catch(error => {
        console.error(`[TorrentEngine] DHT initialization failed: ${error.message}`);
      });
    }
  }
  
  /**
   * Initialize DHT node
   */
  async _initDHT() {
    try {
      console.log('[TorrentEngine] Initializing DHT node...');
      
      this._dht = new DHTNode({
        port: this._dhtPort,
        onPeers: (infoHash, peers) => {
          // Forward peers to the appropriate torrent
          const torrent = this.torrents.get(infoHash);
          if (torrent) {
            console.log(`[TorrentEngine] DHT found ${peers.length} peers for ${infoHash.substring(0, 8)}...`);
            peers.forEach(peer => {
              torrent.addPeer(peer.host, peer.port);
            });
          }
        },
        onReady: () => {
          console.log('[TorrentEngine] DHT node ready');
          this.emit('dht:ready');
        }
      });
      
      await this._dht.start();
      console.log(`[TorrentEngine] DHT node started on port ${this._dhtPort}`);
      
    } catch (error) {
      console.error(`[TorrentEngine] Failed to start DHT: ${error.message}`);
      this._dht = null;
    }
  }
  
  /**
   * Get DHT stats
   */
  getDHTStats() {
    if (!this._dht) {
      return {
        enabled: false,
        running: false,
        nodes: 0,
        port: null
      };
    }
    
    return {
      enabled: true,
      running: this._dht.isReady,
      nodes: this._dht.nodesCount,
      port: this._dhtPort,
      nodeId: this._dht.nodeId?.toString('hex')
    };
  }
  
  /**
   * Start tracking speed history (samples every 1 second)
   */
  _startSpeedHistoryTracking() {
    if (this._speedHistoryInterval) {
      clearInterval(this._speedHistoryInterval);
    }
    
    this._speedHistoryInterval = setInterval(() => {
      const stats = this.getGlobalStats();
      const sample = {
        timestamp: Date.now(),
        downloadSpeed: stats.totalDownloadSpeed || 0,
        uploadSpeed: stats.totalUploadSpeed || 0
      };
      
      this._speedHistory.push(sample);
      
      // Keep only last 60 samples (circular buffer)
      if (this._speedHistory.length > this._speedHistoryMaxSize) {
        this._speedHistory.shift();
      }
      
      // Emit live speed update via Socket.IO
      emitSpeedUpdate(sample);
    }, 1000);
    
    console.log('[TorrentEngine] Speed history tracking started (1s interval, 60 samples)');
  }
  
  /**
   * Stop speed history tracking
   */
  _stopSpeedHistoryTracking() {
    if (this._speedHistoryInterval) {
      clearInterval(this._speedHistoryInterval);
      this._speedHistoryInterval = null;
      console.log('[TorrentEngine] Speed history tracking stopped');
    }
  }
  
  /**
   * Get speed history for graphs
   * @returns {Array} Array of { timestamp, downloadSpeed, uploadSpeed }
   */
  getSpeedHistory() {
    return [...this._speedHistory];
  }
  
  /**
   * Initializes engine and resumes torrents from saved state
   */
  async initialize() {
    console.log('[TorrentEngine] Initializing engine...');
    
    try {
      // Initialize state manager
      await this._stateManager.initialize();
      
      // Resume torrents if enabled
      if (this._autoResume) {
        await this._resumeTorrents();
      }
      
      // Start auto-save
      this._stateManager.startAutoSave();
      
      console.log('[TorrentEngine] Engine initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      console.error(`[TorrentEngine] Initialization failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Resumes torrents from saved state
   * @private
   */
  async _resumeTorrents() {
    console.log('[TorrentEngine] Resuming torrents from saved state...');
    
    const savedStates = this._stateManager.getAllTorrentStates();
    const torrentCount = Object.keys(savedStates).length;
    
    if (torrentCount === 0) {
      console.log('[TorrentEngine] No torrents to resume');
      return;
    }
    
    console.log(`[TorrentEngine] Found ${torrentCount} torrents in saved state`);
    
    let resumed = 0;
    let failed = 0;
    
    for (const [infoHash, state] of Object.entries(savedStates)) {
      try {
        console.log(`[TorrentEngine] Resuming: ${state.magnetURI || state.torrentPath || infoHash}`);
        
        // Create torrent options
        const torrentOptions = {
          downloadPath: state.downloadPath || this.downloadPath,
          port: this.port,
          autoStart: false // Don't auto-start, let queue manager handle it
        };
        
        // Use saved metadata if available (for magnet links)
        if (state.metadata) {
          try {
            torrentOptions.torrentBuffer = Buffer.from(state.metadata, 'base64');
          } catch (error) {
            console.warn(`[TorrentEngine] Failed to restore metadata for ${infoHash}: ${error.message}`);
          }
        }
        
        // Add torrent source
        if (state.magnetURI) {
          torrentOptions.magnetURI = state.magnetURI;
        } else if (state.torrentPath) {
          torrentOptions.torrentPath = state.torrentPath;
        } else {
          console.warn(`[TorrentEngine] No torrent source for ${infoHash}, skipping`);
          failed++;
          continue;
        }
        
        // Create torrent instance
        const torrent = new Torrent(torrentOptions);
        
        // Wait for torrent to be ready
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Torrent initialization timeout'));
          }, 30000); // 30 second timeout
          
          torrent.once('ready', () => {
            clearTimeout(timeout);
            resolve();
          });
          
          torrent.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        
        // Verify infoHash matches
        if (torrent.infoHash !== infoHash) {
          console.warn(`[TorrentEngine] InfoHash mismatch for resumed torrent (expected: ${infoHash}, got: ${torrent.infoHash})`);
          failed++;
          continue;
        }
        
        // Restore torrent state
        await this._restoreTorrentState(torrent, state);
        
        // Setup event forwarding
        this._setupTorrentEvents(torrent, infoHash);
        
        // Add to torrents map
        this.torrents.set(infoHash, torrent);
        
        // Determine if should start or stay paused
        const shouldStart = state.state === 'downloading' || state.state === 'seeding' || state.state === 'queued';
        const startPaused = state.state === 'paused' || !shouldStart;
        
        // Add to queue manager
        this._queueManager.add(torrent, {
          priority: state.priority || 'normal',
          startPaused
        });
        
        resumed++;
        console.log(`[TorrentEngine] Resumed: ${torrent.name} (${state.state})`);
        
      } catch (error) {
        console.error(`[TorrentEngine] Failed to resume ${infoHash}: ${error.message}`);
        failed++;
        
        // Remove from state if resume failed
        this._stateManager.removeTorrentState(infoHash);
      }
    }
    
    console.log(`[TorrentEngine] Resume complete: ${resumed} succeeded, ${failed} failed`);
  }
  
  /**
   * Restores state to a torrent instance
   * @private
   */
  async _restoreTorrentState(torrent, state) {
    console.log(`[TorrentEngine] Restoring state for ${torrent.name}...`);
    
    try {
      // Restore completed pieces if available
      if (state.completedPieces && Array.isArray(state.completedPieces) && state.completedPieces.length > 0) {
        console.log(`[TorrentEngine] Restoring ${state.completedPieces.length} completed pieces`);
        
        if (this._verifyOnResume) {
          // Verify pieces on resume
          console.log('[TorrentEngine] Verifying pieces on resume...');
          
          // This will be handled by the torrent's verify method
          // For now, just trust the saved state
        }
        
        // Set completed pieces (this should be implemented in Torrent class)
        if (typeof torrent.setCompletedPieces === 'function') {
          torrent.setCompletedPieces(state.completedPieces);
        }
      }
      
      // Restore statistics
      if (state.totalDownloaded) {
        torrent._totalDownloaded = state.totalDownloaded;
      }
      
      if (state.totalUploaded) {
        torrent._totalUploaded = state.totalUploaded;
      }
      
      console.log(`[TorrentEngine] State restored for ${torrent.name}`);
      
    } catch (error) {
      console.error(`[TorrentEngine] Failed to restore state: ${error.message}`);
      throw error;
    }
  }

  /**
   * Initialize Kafka producer
   * @private
   */
  async _initKafka(config) {
    try {
      console.log('[TorrentEngine] Initializing Kafka producer...');
      
      this._kafkaProducer = await getProducer({
        brokers: config.brokers || ['localhost:9092'],
        clientId: config.clientId || 'torrentedge',
        topic: config.topic || 'torrent-events'
      });
      
      console.log('[TorrentEngine] Kafka producer connected');
      
    } catch (error) {
      console.error(`[TorrentEngine] Kafka connection failed: ${error.message}`);
      console.warn('[TorrentEngine] Continuing without Kafka (optional feature)');
      this._kafkaProducer = null;
    }
  }
  
  /**
   * Send event to Kafka
   * @private
   */
  async _sendKafkaEvent(type, infoHash, data) {
    if (!this._kafkaProducer) {
      return;
    }
    
    try {
      await this._kafkaProducer.sendEvent({
        type,
        infoHash,
        timestamp: Date.now(),
        data
      });
    } catch (error) {
      console.error(`[TorrentEngine] Kafka send failed for ${type}: ${error.message}`);
    }
  }
  
  /**
   * Setup queue manager event listeners
   * @private
   */
  _setupQueueManagerEvents() {
    this._queueManager.on('queue:add', (data) => {
      console.log(`[TorrentEngine] Queue: Added ${data.name} (${data.status})`);
      this._emitQueueUpdate();
    });
    
    this._queueManager.on('queue:start', (data) => {
      console.log(`[TorrentEngine] Queue: Started ${data.name}`);
      this._emitQueueUpdate();
    });
    
    this._queueManager.on('queue:pause', (data) => {
      console.log(`[TorrentEngine] Queue: Paused ${data.name}`);
      this._emitQueueUpdate();
    });
    
    this._queueManager.on('queue:complete', (data) => {
      console.log(`[TorrentEngine] Queue: Completed ${data.name}`);
      this._emitQueueUpdate();
    });
    
    this._queueManager.on('queue:remove', (data) => {
      console.log(`[TorrentEngine] Queue: Removed torrent (${data.status})`);
      this._emitQueueUpdate();
    });
    
    this._queueManager.on('queue:reorder', (data) => {
      console.log(`[TorrentEngine] Queue: Reordered ${data.infoHash}`);
      this._emitQueueUpdate();
    });
    
    this._queueManager.on('torrent:error', (data) => {
      console.error(`[TorrentEngine] Queue: Torrent error - ${data.name}: ${data.error}`);
    });
  }
  
  /**
   * Emits queue state update via Socket.IO
   * @private
   */
  _emitQueueUpdate() {
    try {
      const io = getIO();
      if (!io) return;
      
      const stats = this._queueManager.getStats();
      const allTorrents = this._queueManager.getAll();
      
      io.to('all').emit('queue:updated', {
        stats,
        torrents: allTorrents,
        timestamp: Date.now()
      });
    } catch (error) {
      console.warn(`[TorrentEngine] Failed to emit queue update: ${error.message}`);
    }
  }
  
  /**
   * Send progress event to Kafka (throttled)
   * @private
   */
  _sendKafkaProgress(infoHash, data) {
    if (!this._kafkaProducer) {
      return;
    }
    
    let throttleState = this._kafkaProgressThrottle.get(infoHash);
    
    if (!throttleState) {
      throttleState = {
        lastSent: 0,
        timer: null,
        pendingData: null
      };
      this._kafkaProgressThrottle.set(infoHash, throttleState);
    }
    
    const now = Date.now();
    const timeSinceLastSent = now - throttleState.lastSent;
    
    // Send immediately if enough time has passed
    if (timeSinceLastSent >= this._kafkaProgressInterval) {
      this._sendKafkaEvent(EVENT_TYPES.TORRENT_PROGRESS, infoHash, data);
      throttleState.lastSent = now;
      throttleState.pendingData = null;
      
      if (throttleState.timer) {
        clearTimeout(throttleState.timer);
        throttleState.timer = null;
      }
    } else {
      // Buffer the data
      throttleState.pendingData = data;
      
      // Schedule send if not already scheduled
      if (!throttleState.timer) {
        const delay = this._kafkaProgressInterval - timeSinceLastSent;
        throttleState.timer = setTimeout(() => {
          if (throttleState.pendingData) {
            this._sendKafkaEvent(EVENT_TYPES.TORRENT_PROGRESS, infoHash, throttleState.pendingData);
            throttleState.lastSent = Date.now();
            throttleState.pendingData = null;
          }
          throttleState.timer = null;
        }, delay);
      }
    }
  }

  async addTorrent(options = {}) {
    try {
      // Validate input
      if (!options.torrentPath && !options.torrentBuffer && !options.magnetURI) {
        throw new Error('Must provide torrentPath, torrentBuffer, or magnetURI');
      }

      const downloadPath = options.downloadPath || this.downloadPath;
      const autoStart = options.autoStart !== undefined ? options.autoStart : true;
      const priority = options.priority || 'normal';
      const startPaused = options.startPaused || false;

      console.log('[TorrentEngine] Adding torrent');

      // Create Torrent instance (but don't auto-start)
      const torrent = new Torrent({
        torrentPath: options.torrentPath,
        torrentBuffer: options.torrentBuffer,
        magnetURI: options.magnetURI,
        downloadPath,
        port: this.port,
        peerId: options.peerId,
        dht: this._dht // Pass DHT node for peer discovery
      });

      // Wait for torrent to be ready (metadata parsed)
      await new Promise((resolve, reject) => {
        torrent.once('ready', resolve);
        torrent.once('error', reject);
      });

      const infoHash = torrent.infoHash;

      // Check for duplicates
      if (this.torrents.has(infoHash)) {
        console.log(`[TorrentEngine] Torrent already exists: ${infoHash}`);
        throw new Error(`Torrent already exists: ${torrent.name}`);
      }

      // Set up event forwarding
      this._setupTorrentEvents(torrent, infoHash);

      // Add to map
      this.torrents.set(infoHash, torrent);

      console.log(`[TorrentEngine] Added torrent: ${torrent.name} (${infoHash})`);
      this.emit('torrent:added', { infoHash, name: torrent.name });
      
      // Emit Socket.IO event
      try {
        emitTorrentAdded(infoHash, {
          name: torrent.name,
          size: torrent.size,
          files: torrent.files,
          state: torrent.state,
          addedAt: Date.now()
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:added: ${error.message}`);
      }
      
      // Send Kafka event
      await this._sendKafkaEvent(EVENT_TYPES.TORRENT_ADDED, infoHash, {
        name: torrent.name,
        size: torrent.size,
        files: torrent.files,
        fileCount: torrent.files.length,
        state: torrent.state,
        addedAt: Date.now(),
        downloadPath: torrent.downloadPath
      });

      // Add to queue manager (will auto-start if slots available)
      this._queueManager.add(torrent, {
        priority,
        startPaused: startPaused || !autoStart
      });
      
      // Save initial state
      this._stateManager.setTorrentState(infoHash, {
        infoHash,
        magnetURI: options.magnetURI,
        torrentPath: options.torrentPath,
        downloadPath: torrent.downloadPath,
        priority,
        state: startPaused || !autoStart ? 'paused' : 'queued',
        addedAt: Date.now(),
        completedPieces: [],
        downloadedBytes: 0,
        uploadedBytes: 0,
        totalDownloaded: 0,
        totalUploaded: 0
      });

      return torrent;

    } catch (error) {
      console.error(`[TorrentEngine] Failed to add torrent: ${error.message}`);
      throw error;
    }
  }

  // ── Phase 3.1 ─────────────────────────────────────────────────────────────

  /**
   * seedFromFile — add a torrent and immediately seed it from an existing file.
   *
   * Flow:
   *  1. Copy the source file to the engine's download path so FileWriter finds it
   *  2. Call addTorrent() with the .torrent buffer
   *  3. When the Torrent's verify() runs it finds ALL pieces valid → skips download
   *  4. Engine transitions directly to seeding state
   *  5. Announces to trackers with left=0 (seeder)
   *
   * @param {Object} options
   * @param {Buffer} options.torrentBuffer  - The .torrent file bytes
   * @param {string} options.sourcePath     - Absolute path to the file to seed
   * @param {string} [options.downloadPath] - Where engine stores files (default: engine path)
   * @param {boolean} [options.autoStart=true]
   *
   * @returns {Promise<Torrent>} The running torrent instance
   */
  async seedFromFile(options = {}) {
    const { torrentBuffer, sourcePath, autoStart = true } = options;

    if (!torrentBuffer || !Buffer.isBuffer(torrentBuffer)) {
      throw new Error('seedFromFile: torrentBuffer is required and must be a Buffer');
    }
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new Error('seedFromFile: sourcePath is required and must be a string');
    }

    const downloadPath = options.downloadPath || this.downloadPath;

    // ── Step 1: Parse the torrent to get the name ─────────────────────────
    // We need the torrent name to know where FileWriter expects the file
    const { parseTorrent } = require('./torrentParser');
    let metadata;
    try {
      metadata = parseTorrent(torrentBuffer);
    } catch (err) {
      throw new Error(`seedFromFile: Failed to parse torrent buffer: ${err.message}`);
    }

    const torrentName = metadata.name;
    const isMultiFile = metadata.isMultiFile || (metadata.files && metadata.files.length > 1);

    // ── Step 2: Place the source file where FileWriter expects it ─────────
    // Single-file torrent: engine looks for <downloadPath>/<torrentName>
    // We symlink (preferred) or copy to avoid duplicating large files on disk
    let linkedPath;

    if (isMultiFile) {
      // Multi-file not supported for seed-from-file yet — would need the whole dir
      throw new Error('seedFromFile: Multi-file torrents are not yet supported for seeding from a single file');
    }

    linkedPath = path.resolve(downloadPath, torrentName);

    // Ensure download directory exists
    await fs.mkdir(downloadPath, { recursive: true });

    // Check if target already exists (previous seed or partial download)
    let needsLink = true;
    try {
      const existing = await fs.stat(linkedPath);
      if (existing.size === metadata.length) {
        // File already in place and correct size — skip linking
        needsLink = false;
        console.log(`[TorrentEngine] seedFromFile: file already in place: ${linkedPath}`);
      } else {
        // Wrong size — remove and re-link
        await fs.unlink(linkedPath).catch(() => {});
      }
    } catch {
      // File doesn't exist — need to link
    }

    if (needsLink) {
      // Try symlink first (zero-copy, space-efficient)
      // IMPORTANT: use absolute resolved paths so the symlink is valid regardless
      // of cwd — relative symlinks resolve relative to the symlink's own directory
      // which would produce a broken path (e.g. downloads/seeds/downloads/...)
      try {
        await fs.symlink(path.resolve(sourcePath), linkedPath);
        console.log(`[TorrentEngine] seedFromFile: symlinked ${sourcePath} → ${linkedPath}`);
      } catch (symlinkErr) {
        // Symlink failed (e.g. cross-device, Windows) — fall back to hard copy
        console.warn(`[TorrentEngine] seedFromFile: symlink failed (${symlinkErr.code}), copying file`);
        await fs.copyFile(sourcePath, linkedPath);
        console.log(`[TorrentEngine] seedFromFile: copied ${sourcePath} → ${linkedPath}`);
      }
    }

    // ── Step 3: Add torrent to engine with the .torrent buffer ────────────
    // The engine calls torrent.start() → FileWriter.verify() → finds all pieces valid
    // → DownloadManager sees 100% complete → transitions to seeding state
    console.log(`[TorrentEngine] seedFromFile: adding torrent "${torrentName}" as seeder`);

    const torrent = await this.addTorrent({
      torrentBuffer,
      downloadPath,
      autoStart,
    });

    console.log(`[TorrentEngine] seedFromFile: "${torrentName}" is now seeding (${torrent.infoHash})`);

    // ── Phase 3.3: Ensure inbound peer TCP server is listening ────────────
    // Idempotent — only opens once even if seedFromFile is called many times
    // Non-fatal: if all ports are in use, seeding still works via DHT/PEX
    try {
      await this.startPeerListener();
    } catch (listenErr) {
      console.warn(`[TorrentEngine] seedFromFile: peer listener failed (non-fatal): ${listenErr.message}`);
    }

    // ── Phase 3.2: Announce to trackers as seeder ──────────────────────────
    // Fire-and-forget — we don't await so seedFromFile returns fast.
    // The engine's own start() already calls _announceToTracker('completed'),
    // but we also do an explicit seeder announce with correct left=0 params
    // to ensure trackers categorise us as a seeder (not a downloader).
    const trackerUrls = metadata.announceList && metadata.announceList.length > 0
      ? metadata.announceList.flat().filter(Boolean).map(u =>
          Buffer.isBuffer(u) ? u.toString('utf8') : String(u))
      : metadata.announce
        ? [ Buffer.isBuffer(metadata.announce) ? metadata.announce.toString('utf8') : String(metadata.announce) ]
        : [];

    if (trackerUrls.length > 0) {
      setImmediate(() => {
        this.announceAsSeeder({
          infoHash: torrent.infoHash,
          fileSize: metadata.length,
          trackers: trackerUrls,
          port:     this.port,
        }).catch(err => {
          // Non-fatal — seeding still works via DHT/PEX even if trackers fail
          console.warn(`[TorrentEngine] seedFromFile announce failed (non-fatal): ${err.message}`);
        });
      });
    } else {
      console.warn(`[TorrentEngine] seedFromFile: no trackers found in torrent — skipping announce (DHT only)`);
    }

    return torrent;
  }

  // ── Phase 3.2 ─────────────────────────────────────────────────────────────

  /**
   * announceAsSeeder — announce to all trackers that we are a seeder.
   *
   * Sends a BEP-3 compliant tracker announce with:
   *   uploaded   = 0       (fresh seed, nothing uploaded yet)
   *   downloaded = fileSize (we have the complete file)
   *   left       = 0       (nothing left to download — we're 100%)
   *   event      = 'started' (first announce)
   *
   * Called automatically by seedFromFile after the engine torrent is ready,
   * but can also be called standalone (e.g. on server restart to re-register).
   *
   * @param {Object} options
   * @param {string}   options.infoHash   - Hex info hash (40 chars)
   * @param {number}   options.fileSize   - Total file size in bytes
   * @param {string[]} options.trackers   - Tracker announce URLs
   * @param {number}   [options.port]     - Port we're listening on (default 6881)
   * @param {Buffer}   [options.peerId]   - Our peer ID (default: generate fresh)
   *
   * @returns {Promise<{
   *   results: Array<{ tracker: string, ok: boolean, peers: number, error?: string }>,
   *   successCount: number,
   *   totalPeers: number,
   * }>}
   */
  async announceAsSeeder(options = {}) {
    const { infoHash, fileSize, trackers = [], port = this.port } = options;

    // ── Validate ────────────────────────────────────────────────────────────
    if (!infoHash || typeof infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(infoHash)) {
      throw new Error('announceAsSeeder: infoHash must be a 40-char hex string');
    }
    if (typeof fileSize !== 'number' || fileSize <= 0) {
      throw new Error('announceAsSeeder: fileSize must be a positive number');
    }
    if (!Array.isArray(trackers) || trackers.length === 0) {
      throw new Error('announceAsSeeder: trackers must be a non-empty array');
    }

    // ── Build announce params (seeder: left=0, downloaded=fileSize) ─────────
    const { announce, generatePeerId } = require('./tracker');

    const infoHashBuffer = Buffer.from(infoHash, 'hex'); // 20-byte Buffer
    const peerId         = options.peerId || generatePeerId();

    const announceParams = {
      infoHash:   infoHashBuffer,
      peerId,
      port,
      uploaded:   0,          // Fresh seed — nothing uploaded yet
      downloaded: fileSize,   // We have the whole file
      left:       0,          // Nothing left to download
      event:      'started',  // First announce to this tracker
      compact:    1,
    };

    console.log(`[TorrentEngine] announceAsSeeder: ${infoHash} (${trackers.length} trackers, left=0, downloaded=${fileSize})`);

    // ── Announce to each tracker, collect results ────────────────────────────
    // We fire all tracker announces in parallel — don't wait for slow ones.
    // Each result is independent; one tracker failing doesn't block others.
    const announcePromises = trackers.map(async (trackerUrl) => {
      try {
        const result = await announce({
          ...announceParams,
          announceUrl: trackerUrl,
        });

        const peerCount = result.peers ? result.peers.length : 0;
        console.log(`[TorrentEngine] announceAsSeeder: ✅ ${trackerUrl} → ${peerCount} peers`);

        return {
          tracker:  trackerUrl,
          ok:       true,
          peers:    peerCount,
          interval: result.interval,
          seeders:  result.complete,
          leechers: result.incomplete,
        };
      } catch (err) {
        console.warn(`[TorrentEngine] announceAsSeeder: ⚠️  ${trackerUrl} failed — ${err.message}`);
        return {
          tracker: trackerUrl,
          ok:      false,
          peers:   0,
          error:   err.message,
        };
      }
    });

    const results      = await Promise.all(announcePromises);
    const successCount = results.filter(r => r.ok).length;
    const totalPeers   = results.reduce((sum, r) => sum + r.peers, 0);

    console.log(`[TorrentEngine] announceAsSeeder: ${successCount}/${trackers.length} trackers OK, ${totalPeers} total peers seen`);

    // ── Schedule re-announces ────────────────────────────────────────────────
    // Trackers expect periodic re-announces (typically every 30 min).
    // We use the shortest interval reported by any successful tracker.
    const successResults  = results.filter(r => r.ok && r.interval > 0);
    const reAnnounceAfter = successResults.length > 0
      ? Math.min(...successResults.map(r => r.interval)) * 1000
      : 30 * 60 * 1000; // default 30 min

    if (successCount > 0) {
      const reAnnounceKey = `reannounce:${infoHash}`;

      // Clear any existing re-announce timer for this torrent
      if (this._reAnnounceTimers) {
        clearTimeout(this._reAnnounceTimers.get(reAnnounceKey));
      } else {
        this._reAnnounceTimers = new Map();
      }

      const timer = setTimeout(() => {
        console.log(`[TorrentEngine] Re-announcing seeder: ${infoHash}`);
        this.announceAsSeeder({ ...options, event: '' }).catch(err => {
          console.warn(`[TorrentEngine] Re-announce failed for ${infoHash}: ${err.message}`);
        });
      }, reAnnounceAfter);

      // Don't prevent process exit
      if (timer.unref) timer.unref();
      this._reAnnounceTimers.set(reAnnounceKey, timer);

      console.log(`[TorrentEngine] Re-announce scheduled for ${infoHash} in ${Math.round(reAnnounceAfter / 1000 / 60)} min`);
    }

    return { results, successCount, totalPeers };
  }

  async removeTorrent(infoHash, deleteFiles = false) {
    const torrent = this.torrents.get(infoHash);

    if (!torrent) {
      throw new Error(`Torrent not found: ${infoHash}`);
    }

    try {
      console.log(`[TorrentEngine] Removing torrent: ${torrent.name} (${infoHash})`);

      // Remove from queue manager (handles stopping if active)
      this._queueManager.remove(infoHash);

      // Stop torrent if still active
      if (torrent.state !== 'idle') {
        await torrent.stop();
      }
      
      // Remove from state
      this._stateManager.removeTorrentState(infoHash);
      await this._stateManager.flush(); // Save immediately

      // Delete files if requested
      if (deleteFiles) {
        console.log(`[TorrentEngine] Deleting files for: ${torrent.name}`);
        try {
          const filePath = path.join(torrent.downloadPath, torrent.name);
          await fs.rm(filePath, { recursive: true, force: true });
        } catch (error) {
          console.error(`[TorrentEngine] Failed to delete files: ${error.message}`);
        }
      }

      // Remove from map
      this.torrents.delete(infoHash);

      // Clean up
      await torrent.destroy();

      console.log(`[TorrentEngine] Removed torrent: ${infoHash}`);
      this.emit('torrent:removed', { infoHash });
      
      // Emit Socket.IO event
      try {
        emitTorrentRemoved(infoHash, {
          name: torrent.name,
          deletedFiles: deleteFiles
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:removed: ${error.message}`);
      }
      
      // Send Kafka event
      await this._sendKafkaEvent(EVENT_TYPES.TORRENT_REMOVED, infoHash, {
        name: torrent.name,
        deletedFiles: deleteFiles,
        removedAt: Date.now()
      });
      
      // Clean up Kafka throttle state
      const throttleState = this._kafkaProgressThrottle.get(infoHash);
      if (throttleState?.timer) {
        clearTimeout(throttleState.timer);
      }
      this._kafkaProgressThrottle.delete(infoHash);

    } catch (error) {
      console.error(`[TorrentEngine] Failed to remove torrent: ${error.message}`);
      throw error;
    }
  }

  getTorrent(infoHash) {
    return this.torrents.get(infoHash) || null;
  }

  getAllTorrents() {
    return Array.from(this.torrents.values());
  }
  
  async pauseTorrent(infoHash) {
    const torrent = this.torrents.get(infoHash);
    
    if (!torrent) {
      throw new Error(`Torrent not found: ${infoHash}`);
    }
    
    try {
      // Delegate to queue manager
      const paused = this._queueManager.pause(infoHash);
      
      if (!paused) {
        console.log(`[TorrentEngine] Cannot pause: ${torrent.name} is not active`);
        return;
      }
      
      console.log(`[TorrentEngine] Paused torrent: ${torrent.name}`);
      this.emit('torrent:paused', { infoHash });
      
      // Update state
      this._stateManager.setTorrentState(infoHash, {
        state: 'paused'
      });
      await this._stateManager.flush(); // Save immediately on state change
      
      // Emit Socket.IO event
      try {
        emitTorrentPaused(infoHash, {
          name: torrent.name,
          state: torrent.state
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:paused: ${error.message}`);
      }
      
      // Send Kafka event
      const stats = torrent.getStats();
      await this._sendKafkaEvent(EVENT_TYPES.TORRENT_PAUSED, infoHash, {
        name: torrent.name,
        state: torrent.state,
        progress: stats.percentage,
        downloaded: stats.downloaded,
        pausedAt: Date.now()
      });
    } catch (error) {
      console.error(`[TorrentEngine] Failed to pause torrent: ${error.message}`);
      throw error;
    }
  }
  
  async resumeTorrent(infoHash) {
    const torrent = this.torrents.get(infoHash);
    
    if (!torrent) {
      throw new Error(`Torrent not found: ${infoHash}`);
    }
    
    try {
      // Delegate to queue manager
      const resumed = this._queueManager.start(infoHash);
      
      if (!resumed) {
        console.log(`[TorrentEngine] Cannot resume: ${torrent.name} is not paused or queued`);
        return;
      }
      
      console.log(`[TorrentEngine] Resumed torrent: ${torrent.name}`);
      this.emit('torrent:resumed', { infoHash });
      
      // Update state
      this._stateManager.setTorrentState(infoHash, {
        state: 'downloading'
      });
      await this._stateManager.flush(); // Save immediately on state change
      
      // Emit Socket.IO event
      try {
        emitTorrentResumed(infoHash, {
          name: torrent.name,
          state: torrent.state
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:resumed: ${error.message}`);
      }
      
      // Send Kafka event
      const stats = torrent.getStats();
      await this._sendKafkaEvent(EVENT_TYPES.TORRENT_RESUMED, infoHash, {
        name: torrent.name,
        state: torrent.state,
        progress: stats.percentage,
        downloaded: stats.downloaded,
        resumedAt: Date.now()
      });
    } catch (error) {
      console.error(`[TorrentEngine] Failed to resume torrent: ${error.message}`);
      throw error;
    }
  }

  async startAll() {
    console.log('[TorrentEngine] Starting all torrents');
    
    const torrents = this.getAllTorrents();
    const idleTorrents = torrents.filter(t => t.state === 'idle' || t.state === 'paused');

    // Start torrents respecting maxActiveTorrents
    let started = 0;
    for (const torrent of idleTorrents) {
      if (this.activeTorrents >= this.maxActiveTorrents) {
        console.log(`[TorrentEngine] Max active torrents reached (${this.maxActiveTorrents})`);
        break;
      }

      try {
        await this._startTorrent(torrent);
        started++;
      } catch (error) {
        console.error(`[TorrentEngine] Failed to start ${torrent.name}: ${error.message}`);
      }
    }

    console.log(`[TorrentEngine] Started ${started}/${idleTorrents.length} torrents`);
  }

  async stopAll() {
    console.log('[TorrentEngine] Stopping all torrents');
    
    const torrents = this.getAllTorrents();
    const promises = torrents.map(async (torrent) => {
      try {
        if (torrent.state !== 'idle') {
          await torrent.stop();
        }
      } catch (error) {
        console.error(`[TorrentEngine] Failed to stop ${torrent.name}: ${error.message}`);
      }
    });

    await Promise.all(promises);
    console.log('[TorrentEngine] All torrents stopped');
  }

  getGlobalStats() {
    const torrents = this.getAllTorrents();

    let totalDownloadSpeed = 0;
    let totalUploadSpeed = 0;
    let totalDownloaded = 0;
    let totalUploaded = 0;
    let activeTorrents = 0;

    for (const torrent of torrents) {
      const stats = torrent.getStats();
      
      totalDownloadSpeed += stats.downloadSpeed;
      totalUploadSpeed += stats.uploadSpeed;
      totalDownloaded += stats.downloaded;
      totalUploaded += 0; // TODO: Implement upload tracking

      if (torrent.state === 'downloading' || torrent.state === 'seeding') {
        activeTorrents++;
      }
    }

    return {
      totalDownloadSpeed,
      totalUploadSpeed,
      activeTorrents,
      totalTorrents: torrents.length,
      totalDownloaded,
      totalUploaded
    };
  }

  // ==================== SETTINGS ====================
  
  /**
   * Get current engine settings
   */
  getSettings() {
    return {
      downloadPath: this.downloadPath,
      maxActiveTorrents: this.maxActiveTorrents,
      maxConcurrent: this._queueManager?.maxConcurrent || 3,
      port: this.port,
      dht: {
        enabled: this._dhtEnabled,
        port: this._dhtPort,
        running: this._dht?.isReady || false,
        nodes: this._dht?.nodesCount || 0
      },
      speedLimits: {
        download: this._globalThrottler?.downloadLimit || 0,
        upload: this._globalThrottler?.uploadLimit || 0
      }
    };
  }
  
  /**
   * Update engine settings
   * @param {Object} settings - New settings
   */
  updateSettings(settings) {
    const changes = [];
    
    // Download path
    if (settings.downloadPath && settings.downloadPath !== this.downloadPath) {
      this.downloadPath = settings.downloadPath;
      changes.push(`downloadPath: ${settings.downloadPath}`);
    }
    
    // Max active torrents
    if (settings.maxActiveTorrents && settings.maxActiveTorrents !== this.maxActiveTorrents) {
      this.maxActiveTorrents = settings.maxActiveTorrents;
      changes.push(`maxActiveTorrents: ${settings.maxActiveTorrents}`);
    }
    
    // Max concurrent
    if (settings.maxConcurrent && this._queueManager) {
      this._queueManager.maxConcurrent = settings.maxConcurrent;
      changes.push(`maxConcurrent: ${settings.maxConcurrent}`);
    }
    
    // Speed limits
    if (settings.speedLimits) {
      this.setSpeedLimits(settings.speedLimits.download, settings.speedLimits.upload);
      changes.push(`speedLimits: DL=${settings.speedLimits.download}, UL=${settings.speedLimits.upload}`);
    }
    
    if (changes.length > 0) {
      console.log(`[TorrentEngine] Settings updated: ${changes.join(', ')}`);
      this.emit('settings:changed', this.getSettings());
    }
    
    return this.getSettings();
  }
  
  /**
   * Set global speed limits
   * @param {number} downloadLimit - Download limit in bytes/sec (0 = unlimited)
   * @param {number} uploadLimit - Upload limit in bytes/sec (0 = unlimited)
   */
  setSpeedLimits(downloadLimit = 0, uploadLimit = 0) {
    if (!this._globalThrottler) {
      // Create global throttler if not exists
      const { GlobalThrottler } = require('./throttler');
      this._globalThrottler = new GlobalThrottler({
        downloadLimit,
        uploadLimit
      });
      console.log('[TorrentEngine] Created global throttler');
    } else {
      this._globalThrottler.setLimits(downloadLimit, uploadLimit);
    }
    
    console.log(`[TorrentEngine] Speed limits set: DL=${downloadLimit} B/s, UL=${uploadLimit} B/s`);
  }

  async saveState() {
    try {
      console.log('[TorrentEngine] Saving state');

      // Create state directory
      const stateDir = path.dirname(this._stateFilePath);
      await fs.mkdir(stateDir, { recursive: true });

      const state = {
        version: 1,
        savedAt: new Date().toISOString(),
        downloadPath: this.downloadPath,
        maxActiveTorrents: this.maxActiveTorrents,
        port: this.port,
        torrents: []
      };

      // Save torrent info
      for (const [infoHash, torrent] of this.torrents) {
        const stats = torrent.getStats();
        
        state.torrents.push({
          infoHash,
          name: torrent.name,
          downloadPath: torrent.downloadPath,
          state: torrent.state,
          downloaded: stats.downloaded,
          total: stats.total,
          percentage: stats.percentage,
          completedPieces: stats.completedPieces,
          // Store torrent file path if available
          torrentPath: torrent._torrentPath || null
        });
      }

      await fs.writeFile(this._stateFilePath, JSON.stringify(state, null, 2), 'utf8');
      console.log(`[TorrentEngine] State saved to ${this._stateFilePath}`);

    } catch (error) {
      console.error(`[TorrentEngine] Failed to save state: ${error.message}`);
      throw error;
    }
  }

  async loadState() {
    try {
      console.log('[TorrentEngine] Loading state');

      // Check if state file exists
      try {
        await fs.access(this._stateFilePath);
      } catch (error) {
        console.log('[TorrentEngine] No saved state found');
        return;
      }

      const data = await fs.readFile(this._stateFilePath, 'utf8');
      const state = JSON.parse(data);

      console.log(`[TorrentEngine] Found ${state.torrents.length} torrents in saved state`);

      // Restore settings
      if (state.downloadPath) {
        this.downloadPath = state.downloadPath;
      }
      if (state.maxActiveTorrents) {
        this.maxActiveTorrents = state.maxActiveTorrents;
      }
      if (state.port) {
        this.port = state.port;
      }

      // Restore torrents
      for (const torrentInfo of state.torrents) {
        try {
          if (!torrentInfo.torrentPath) {
            console.warn(`[TorrentEngine] Cannot restore ${torrentInfo.name}: no torrent file path`);
            continue;
          }

          // Check if torrent file still exists
          try {
            await fs.access(torrentInfo.torrentPath);
          } catch (error) {
            console.warn(`[TorrentEngine] Torrent file not found: ${torrentInfo.torrentPath}`);
            continue;
          }

          console.log(`[TorrentEngine] Restoring: ${torrentInfo.name}`);

          await this.addTorrent({
            torrentPath: torrentInfo.torrentPath,
            downloadPath: torrentInfo.downloadPath,
            autoStart: false // Don't auto-start, we'll start later
          });

        } catch (error) {
          console.error(`[TorrentEngine] Failed to restore ${torrentInfo.name}: ${error.message}`);
        }
      }

      console.log(`[TorrentEngine] Restored ${this.torrents.size} torrents`);

    } catch (error) {
      console.error(`[TorrentEngine] Failed to load state: ${error.message}`);
      throw error;
    }
  }

  async _startTorrent(torrent) {
    if (this.activeTorrents >= this.maxActiveTorrents) {
      throw new Error(`Maximum active torrents (${this.maxActiveTorrents}) reached`);
    }

    await torrent.start();
    console.log(`[TorrentEngine] Started torrent: ${torrent.name}`);
    this.emit('torrent:started', { infoHash: torrent.infoHash });
  }

  _setupTorrentEvents(torrent, infoHash) {
    // Download completed
    torrent.on('done', () => {
      console.log(`[TorrentEngine] Torrent complete: ${torrent.name}`);
      this.emit('torrent:complete', {
        infoHash,
        name: torrent.name,
        path: path.join(torrent.downloadPath, torrent.name)
      });
      
      // Update state
      this._stateManager.setTorrentState(infoHash, {
        state: 'completed',
        completedAt: Date.now()
      });
      this._stateManager.flush(); // Save immediately on completion
      
      // Emit Socket.IO event
      try {
        emitTorrentCompleted(infoHash, {
          name: torrent.name,
          size: torrent.size,
          downloadTime: Date.now() - (torrent._startTime || Date.now())
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:completed: ${error.message}`);
      }
      
      // Send Kafka event with detailed analytics
      const downloadTime = Date.now() - (torrent._startTime || Date.now());
      const stats = torrent.getStats();
      this._sendKafkaEvent(EVENT_TYPES.TORRENT_COMPLETED, infoHash, {
        name: torrent.name,
        size: torrent.size,
        downloadTime,
        averageSpeed: downloadTime > 0 ? (torrent.size / (downloadTime / 1000)) : 0,
        totalPieces: stats.pieceCount,
        completedAt: Date.now()
      });
    });

    // Error occurred
    torrent.on('error', ({ message }) => {
      console.error(`[TorrentEngine] Torrent error (${torrent.name}): ${message}`);
      this.emit('torrent:error', { infoHash, error: message });
      
      // Emit Socket.IO event
      try {
        emitTorrentError(infoHash, {
          error: message
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:error: ${error.message}`);
      }
      
      // Send Kafka event with more details
      this._sendKafkaEvent(EVENT_TYPES.TORRENT_ERROR, infoHash, {
        error: message,
        torrentName: torrent.name,
        state: torrent.state,
        timestamp: Date.now()
      });
    });

    // Started downloading
    torrent.on('started', () => {
      console.log(`[TorrentEngine] Torrent started: ${torrent.name}`);
      torrent._startTime = Date.now(); // Track start time for download duration
      
      // Update state
      this._stateManager.setTorrentState(infoHash, {
        state: 'downloading'
      });
      
      // Emit Socket.IO event
      try {
        emitTorrentStarted(infoHash, {
          name: torrent.name,
          state: 'downloading'
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:started: ${error.message}`);
      }
      
      // Send Kafka event
      this._sendKafkaEvent(EVENT_TYPES.TORRENT_STARTED, infoHash, {
        name: torrent.name,
        size: torrent.size,
        state: 'downloading',
        startedAt: torrent._startTime
      });
    });

    // Stopped
    torrent.on('stopped', () => {
      console.log(`[TorrentEngine] Torrent stopped: ${torrent.name}`);
    });
    
    // Progress updates (throttled state saves)
    let lastStateSave = 0;
    const stateSaveInterval = 10000; // Save state every 10 seconds during progress
    
    torrent.on('progress', (data) => {
      // Emit Socket.IO event (throttled by socket layer at 500ms)
      try {
        const stats = torrent.getStats();
        const progressData = {
          progress: stats.percentage,
          downloadSpeed: stats.downloadSpeed,
          uploadSpeed: stats.uploadSpeed,
          peers: stats.peers.connected,
          downloaded: stats.downloaded,
          uploaded: stats.uploaded || 0,
          eta: stats.eta
        };
        
        emitProgress(infoHash, progressData);
        
        // Throttled state save for progress
        const now = Date.now();
        if (now - lastStateSave >= stateSaveInterval) {
          this._stateManager.setTorrentState(infoHash, {
            downloadedBytes: stats.downloaded,
            uploadedBytes: stats.uploaded || 0,
            totalDownloaded: torrent._totalDownloaded || 0,
            totalUploaded: torrent._totalUploaded || 0
          });
          lastStateSave = now;
        }
        
        // Send to Kafka with more aggressive throttling (5 seconds)
        this._sendKafkaProgress(infoHash, {
          ...progressData,
          totalPieces: stats.pieceCount,
          completedPieces: stats.completedPieces,
          activePieces: stats.activePieces,
          pendingRequests: stats.pendingRequests
        });
      } catch (error) {
        // Don't log for progress updates (too verbose)
      }
    });
    
    // Piece completed - update completed pieces in state (batched)
    let pieceUpdateBatch = [];
    let pieceUpdateTimer = null;
    
    torrent.on('piece', ({ index }) => {
      // Add to batch
      pieceUpdateBatch.push(index);
      
      // Emit Socket.IO event
      try {
        const stats = torrent.getStats();
        emitPieceCompleted(infoHash, {
          pieceIndex: index,
          totalPieces: stats.pieceCount,
          completedPieces: stats.completedPieces
        });
        
        // Send Kafka event
        this._sendKafkaEvent(EVENT_TYPES.PIECE_COMPLETED, infoHash, {
          pieceIndex: index,
          totalPieces: stats.pieceCount,
          completedPieces: stats.completedPieces,
          progress: stats.percentage
        });
      } catch (error) {
        console.warn(`[TorrentEngine] Failed to emit torrent:piece: ${error.message}`);
      }
      
      // Batch update state (save every 10 pieces or every 5 seconds)
      if (!pieceUpdateTimer) {
        pieceUpdateTimer = setTimeout(() => {
          if (pieceUpdateBatch.length > 0) {
            const currentState = this._stateManager.getTorrentState(infoHash);
            const completedPieces = currentState?.completedPieces || [];
            const updatedPieces = [...new Set([...completedPieces, ...pieceUpdateBatch])];
            
            this._stateManager.setTorrentState(infoHash, {
              completedPieces: updatedPieces
            });
            
            pieceUpdateBatch = [];
          }
          pieceUpdateTimer = null;
        }, 5000);
      }
      
      // Force save every 10 pieces
      if (pieceUpdateBatch.length >= 10) {
        if (pieceUpdateTimer) {
          clearTimeout(pieceUpdateTimer);
          pieceUpdateTimer = null;
        }
        
        const currentState = this._stateManager.getTorrentState(infoHash);
        const completedPieces = currentState?.completedPieces || [];
        const updatedPieces = [...new Set([...completedPieces, ...pieceUpdateBatch])];
        
        this._stateManager.setTorrentState(infoHash, {
          completedPieces: updatedPieces
        });
        
        pieceUpdateBatch = [];
      }
    });
    
    // Peer connected
    torrent.on('peer:connect', ({ ip, port }) => {
      try {
        emitPeerConnected(infoHash, {
          ip,
          port
        });
        
        // Send Kafka event
        this._sendKafkaEvent(EVENT_TYPES.PEER_CONNECTED, infoHash, {
          ip,
          port,
          connectedAt: Date.now()
        });
      } catch (error) {
        // Don't log peer events (too verbose)
      }
    });
    
    // Peer disconnected
    torrent.on('peer:disconnect', ({ ip, port }) => {
      try {
        emitPeerDisconnected(infoHash, {
          ip,
          port
        });
        
        // Send Kafka event
        this._sendKafkaEvent(EVENT_TYPES.PEER_DISCONNECTED, infoHash, {
          ip,
          port,
          disconnectedAt: Date.now()
        });
      } catch (error) {
        // Don't log peer events (too verbose)
      }
    });
  }

  get activeTorrents() {
    let count = 0;
    for (const torrent of this.torrents.values()) {
      if (torrent.state === 'downloading' || torrent.state === 'seeding') {
        count++;
      }
    }
    return count;
  }
  
  /**
   * Sets maximum concurrent torrents
   * @param {number} max
   */
  setMaxConcurrent(max) {
    this._queueManager.setMaxConcurrent(max);
    console.log(`[TorrentEngine] Max concurrent set to: ${max}`);
  }
  
  /**
   * Sets priority for a torrent
   * @param {string} infoHash
   * @param {'low' | 'normal' | 'high'} priority
   */
  setPriority(infoHash, priority) {
    const success = this._queueManager.setPriority(infoHash, priority);
    
    if (success) {
      console.log(`[TorrentEngine] Set priority for ${infoHash} to ${priority}`);
    }
    
    return success;
  }
  
  /**
   * Gets queue position for a torrent
   * @param {string} infoHash
   * @returns {number} Position in queue (-1 if not queued)
   */
  getQueuePosition(infoHash) {
    const allTorrents = this._queueManager.getAll();
    const torrentInfo = allTorrents.find(t => t.infoHash === infoHash);
    
    return torrentInfo && torrentInfo.position !== undefined ? torrentInfo.position : -1;
  }
  
  /**
   * Moves torrent to specific position in queue
   * @param {string} infoHash
   * @param {number} position
   */
  moveInQueue(infoHash, position) {
    this._queueManager.moveInQueue(infoHash, position);
    console.log(`[TorrentEngine] Moved ${infoHash} to position ${position}`);
  }
  
  /**
   * Gets queue statistics
   * @returns {Object}
   */
  getQueueStats() {
    return this._queueManager.getStats();
  }
  
  /**
   * Gets comprehensive engine statistics including queue
   * @returns {Object}
   */
  getStats() {
    const queueStats = this._queueManager.getStats();
    const allTorrents = this.getAllTorrents();
    
    let totalSize = 0;
    let totalDownloaded = 0;
    let totalUploaded = 0;
    
    for (const torrent of allTorrents) {
      totalSize += torrent.size || 0;
      const stats = torrent.getStats ? torrent.getStats() : {};
      totalDownloaded += stats.downloaded || 0;
      totalUploaded += stats.uploaded || 0;
    }
    
    return {
      totalTorrents: this.torrents.size,
      activeTorrents: this.activeTorrents,
      totalSize,
      totalDownloaded,
      totalUploaded,
      totalDownloadSpeed: queueStats.totalDownloadSpeed,
      totalUploadSpeed: queueStats.totalUploadSpeed,
      totalConnections: queueStats.totalConnections,
      queue: {
        active: queueStats.activeCount,
        queued: queueStats.queuedCount,
        paused: queueStats.pausedCount,
        completed: queueStats.completedCount,
        maxConcurrent: queueStats.maxConcurrent
      }
    };
  }
  
  /**
   * Shutdown the engine gracefully
   */
  // ── Phase 3.3 ─────────────────────────────────────────────────────────────

  /**
   * startPeerListener — opens a TCP server on this.port so inbound peers
   * can connect and download pieces from us.
   *
   * BitTorrent peers initiate connections by sending a handshake:
   *   [pstrlen=19][pstr="BitTorrent protocol"][8 reserved bytes][infoHash][peerId]
   *
   * We read the infoHash from the handshake, find the matching torrent in our
   * map, and delegate piece serving to that torrent's UploadManager.
   *
   * Already called by seedFromFile — idempotent (safe to call multiple times).
   *
   * @returns {Promise<number>} The port actually bound to
   */
  async startPeerListener() {
    // Idempotent — don't open a second server if already listening
    if (this._peerServer && this._peerServer.listening) {
      return this._peerListenPort;
    }

    const { PeerConnection, MESSAGE_TYPES } = require('./peerConnection');
    const { generatePeerId }                = require('./tracker');

    // Our engine-level peerId (shared across all torrents we seed)
    if (!this._enginePeerId) {
      this._enginePeerId = generatePeerId();
    }

    return new Promise((resolve, reject) => {
      const tryListen = (port) => {
        const server = net.createServer((socket) => {
          this._handleInboundPeer(socket, MESSAGE_TYPES);
        });

        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            const fallback = port + 1;
            console.warn(`[TorrentEngine] Port ${port} in use, trying ${fallback}`);
            tryListen(fallback);
          } else {
            console.error(`[TorrentEngine] Peer listener error: ${err.message}`);
            reject(err);
          }
        });

        server.listen(port, () => {
          this._peerServer     = server;
          this._peerListenPort = server.address().port;
          console.log(`[TorrentEngine] Peer listener started on port ${this._peerListenPort}`);
          this.emit('listener:started', { port: this._peerListenPort });
          resolve(this._peerListenPort);
        });
      };

      tryListen(this.port);
    });
  }

  /**
   * Handles a single inbound TCP connection from a remote peer.
   * Reads the BitTorrent handshake, routes to the right torrent, delegates.
   * @private
   */
  _handleInboundPeer(socket, MESSAGE_TYPES) {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TorrentEngine] Inbound peer: ${remoteAddr}`);

    // 68-byte handshake: 1 + 19 + 8 + 20 + 20
    const HANDSHAKE_LEN = 68;
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length < HANDSHAKE_LEN) return; // wait for full handshake

      // Parse handshake
      const pstrLen = buffer[0];
      if (pstrLen !== 19) {
        console.warn(`[TorrentEngine] Invalid pstrlen from ${remoteAddr}: ${pstrLen}`);
        socket.destroy();
        return;
      }

      const pstr     = buffer.slice(1, 20).toString('ascii');
      if (pstr !== 'BitTorrent protocol') {
        console.warn(`[TorrentEngine] Unknown protocol from ${remoteAddr}: ${pstr}`);
        socket.destroy();
        return;
      }

      // infoHash is bytes 28-47
      const infoHashBuf = buffer.slice(28, 48);
      const infoHashHex = infoHashBuf.toString('hex');
      const remotePeerId = buffer.slice(48, 68);

      console.log(`[TorrentEngine] Handshake from ${remoteAddr} for ${infoHashHex}`);

      // Remove data listener — torrent takes over from here
      socket.removeListener('data', onData);

      // Find matching torrent
      const torrent = this.torrents.get(infoHashHex);
      if (!torrent) {
        console.warn(`[TorrentEngine] No torrent for ${infoHashHex} — closing ${remoteAddr}`);
        socket.destroy();
        return;
      }

      // Only accept if we're seeding (have the file)
      const state = torrent.state || torrent._state;
      if (state !== 'seeding') {
        console.warn(`[TorrentEngine] Torrent ${infoHashHex} not seeding (state: ${state}) — closing ${remoteAddr}`);
        socket.destroy();
        return;
      }

      // ── Send our handshake response ────────────────────────────────────
      const handshake = Buffer.alloc(HANDSHAKE_LEN);
      let offset = 0;
      handshake[offset++] = 19;
      Buffer.from('BitTorrent protocol').copy(handshake, offset); offset += 19;
      // Reserved bytes (8) — already zero
      offset += 8;
      infoHashBuf.copy(handshake, offset); offset += 20;
      this._enginePeerId.copy(handshake, offset);
      socket.write(handshake);

      // ── Send bitfield (we have all pieces) ────────────────────────────
      this._sendBitfield(socket, torrent);

      // ── Send unchoke so they can start requesting ──────────────────────
      const unchoke = Buffer.alloc(5);
      unchoke.writeUInt32BE(1, 0); // length = 1
      unchoke[4] = MESSAGE_TYPES.UNCHOKE;
      socket.write(unchoke);

      // ── Forward remaining data to torrent's handlePieceRequest ────────
      const remaining = buffer.slice(HANDSHAKE_LEN);

      // Create a lightweight peer proxy so UploadManager can write back
      const peer = this._buildPeerProxy(socket, remotePeerId, remoteAddr, MESSAGE_TYPES);

      if (remaining.length > 0) {
        this._dispatchPeerMessage(peer, remaining, torrent);
      }

      socket.on('data', (data) => {
        this._dispatchPeerMessage(peer, data, torrent);
      });

      socket.on('close', () => {
        console.log(`[TorrentEngine] Peer disconnected: ${remoteAddr}`);
        this.emit('peer:disconnected', { addr: remoteAddr, infoHash: infoHashHex });
      });

      socket.on('error', (err) => {
        console.warn(`[TorrentEngine] Peer socket error ${remoteAddr}: ${err.message}`);
      });

      this.emit('peer:connected', { addr: remoteAddr, infoHash: infoHashHex });
    };

    socket.on('data', onData);

    // 30s timeout for handshake — close dead connections
    socket.setTimeout(30_000, () => {
      if (buffer.length < HANDSHAKE_LEN) {
        console.warn(`[TorrentEngine] Handshake timeout from ${remoteAddr}`);
        socket.destroy();
      }
    });

    socket.on('error', (err) => {
      console.warn(`[TorrentEngine] Pre-handshake error from ${remoteAddr}: ${err.message}`);
    });
  }

  /**
   * Sends a bitfield message telling the peer we have ALL pieces.
   * @private
   */
  _sendBitfield(socket, torrent) {
    // Get piece count from torrent metadata
    const metadata   = torrent._metadata;
    if (!metadata || !metadata.pieces) return;

    const numPieces   = metadata.pieces.length;
    const byteCount   = Math.ceil(numPieces / 8);
    const bitfield    = Buffer.alloc(byteCount, 0xFF); // all 1s = have everything

    // Zero out spare bits at the end (spec requirement)
    const spareBits = (byteCount * 8) - numPieces;
    if (spareBits > 0) {
      bitfield[byteCount - 1] &= (0xFF << spareBits) & 0xFF;
    }

    // Message: [length 4B][id=5 1B][bitfield nB]
    const msg = Buffer.alloc(4 + 1 + byteCount);
    msg.writeUInt32BE(1 + byteCount, 0);
    msg[4] = 5; // BITFIELD message id
    bitfield.copy(msg, 5);
    socket.write(msg);
  }

  /**
   * Parses incoming peer messages and dispatches to torrent.
   * Handles REQUEST (id=6) and CANCEL (id=8) — the only ones we care about as seeder.
   * @private
   */
  _dispatchPeerMessage(peer, data, torrent) {
    // Messages: [4-byte length][1-byte id][payload...]
    // May receive multiple messages in one chunk
    let offset = 0;

    while (offset < data.length) {
      if (offset + 4 > data.length) break; // incomplete length prefix

      const msgLen = data.readUInt32BE(offset);
      offset += 4;

      if (msgLen === 0) continue; // keepalive

      if (offset + msgLen > data.length) break; // incomplete message

      const msgId = data[offset];
      const payload = data.slice(offset + 1, offset + msgLen);
      offset += msgLen;

      if (msgId === 6) {
        // REQUEST: [pieceIndex 4B][begin 4B][length 4B]
        if (payload.length < 12) continue;
        const pieceIndex = payload.readUInt32BE(0);
        const begin      = payload.readUInt32BE(4);
        const length     = payload.readUInt32BE(8);
        torrent.handlePieceRequest(peer, pieceIndex, begin, length);
      } else if (msgId === 8) {
        // CANCEL: same format as REQUEST
        if (payload.length < 12) continue;
        const pieceIndex = payload.readUInt32BE(0);
        const begin      = payload.readUInt32BE(4);
        const length     = payload.readUInt32BE(8);
        torrent.handleCancelRequest(peer, pieceIndex, begin, length);
      }
      // Ignore CHOKE, UNCHOKE, INTERESTED, etc. — we're seeder-only here
    }
  }

  /**
   * Builds a minimal peer proxy object that UploadManager can use.
   * UploadManager calls peer.send() / peer.sendPiece() to write data back.
   * @private
   */
  _buildPeerProxy(socket, remotePeerId, remoteAddr, MESSAGE_TYPES) {
    const peerIdStr = remotePeerId.toString('hex').slice(0, 8);

    return {
      id:       peerIdStr,
      ip:       socket.remoteAddress,
      port:     socket.remotePort,
      choked:   false, // we unchoked them already
      _socket:  socket,

      // Send a PIECE message back to the peer
      // Format: [length 4B][id=7 1B][pieceIndex 4B][begin 4B][data nB]
      sendPiece(pieceIndex, begin, data) {
        if (!socket.writable) return;
        const msgLen = 1 + 4 + 4 + data.length;
        const msg    = Buffer.alloc(4 + msgLen);
        msg.writeUInt32BE(msgLen, 0);
        msg[4] = MESSAGE_TYPES ? MESSAGE_TYPES.PIECE : 7;
        msg.writeUInt32BE(pieceIndex, 5);
        msg.writeUInt32BE(begin, 9);
        data.copy(msg, 13);
        socket.write(msg);
      },

      // Generic send for other messages (choke, etc.)
      send(msgId, payload = Buffer.alloc(0)) {
        if (!socket.writable) return;
        const msg = Buffer.alloc(4 + 1 + payload.length);
        msg.writeUInt32BE(1 + payload.length, 0);
        msg[4] = msgId;
        if (payload.length > 0) payload.copy(msg, 5);
        socket.write(msg);
      },

      destroy() {
        socket.destroy();
      },
    };
  }

  /**
   * stopPeerListener — closes the inbound TCP server cleanly.
   * Called by shutdown().
   */
  async stopPeerListener() {
    if (!this._peerServer) return;
    return new Promise((resolve) => {
      this._peerServer.close(() => {
        console.log('[TorrentEngine] Peer listener stopped');
        this._peerServer = null;
        resolve();
      });
    });
  }

  async shutdown() {
    console.log('[TorrentEngine] Shutting down...');
    
    try {
      // Stop speed history tracking
      this._stopSpeedHistoryTracking();
      
      // Stop DHT node
      if (this._dht) {
        console.log('[TorrentEngine] Stopping DHT node...');
        await this._dht.stop();
        this._dht = null;
      }
      
      // Stop auto-save and flush state
      console.log('[TorrentEngine] Saving final state...');
      await this._stateManager.stopAutoSave();
      await this._stateManager.flush();
      
      // Cleanup queue manager
      await this._queueManager.cleanup();
      
      // Stop all torrents
      await this.stopAll();
      
      // Clean up Kafka throttle timers
      for (const [infoHash, state] of this._kafkaProgressThrottle.entries()) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
      this._kafkaProgressThrottle.clear();
      
      // Disconnect Kafka producer
      if (this._kafkaProducer) {
        console.log('[TorrentEngine] Closing Kafka producer...');
        await closeProducer();
        this._kafkaProducer = null;
      }
      
      // Stop peer listener (Phase 3.3)
      await this.stopPeerListener();

      // Final state cleanup
      await this._stateManager.cleanup();
      
      console.log('[TorrentEngine] Shutdown complete');
      
    } catch (error) {
      console.error(`[TorrentEngine] Shutdown error: ${error.message}`);
      throw error;
    }
  }
}

module.exports = { TorrentEngine };
