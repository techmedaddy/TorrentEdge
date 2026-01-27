const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const { Torrent } = require('./torrent');
const { QueueManager } = require('./queueManager');
const { StateManager } = require('./stateManager');
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
  emitPeerDisconnected
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
        peerId: options.peerId
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
  async shutdown() {
    console.log('[TorrentEngine] Shutting down...');
    
    try {
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
