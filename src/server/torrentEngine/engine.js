const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const { Torrent } = require('./torrent');

class TorrentEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this.downloadPath = options.downloadPath || './downloads';
    this.maxActiveTorrents = options.maxActiveTorrents || 5;
    this.port = options.port || 6881;

    this.torrents = new Map();
    this.isRunning = false;

    this._stateFilePath = path.join(this.downloadPath, '.torrentedge', 'state.json');

    console.log('[TorrentEngine] Initialized');
    console.log(`[TorrentEngine] Download path: ${this.downloadPath}`);
    console.log(`[TorrentEngine] Max active torrents: ${this.maxActiveTorrents}`);
    console.log(`[TorrentEngine] Port: ${this.port}`);
  }

  async addTorrent(options = {}) {
    try {
      // Validate input
      if (!options.torrentPath && !options.torrentBuffer && !options.magnetURI) {
        throw new Error('Must provide torrentPath, torrentBuffer, or magnetURI');
      }

      const downloadPath = options.downloadPath || this.downloadPath;
      const autoStart = options.autoStart !== undefined ? options.autoStart : true;

      console.log('[TorrentEngine] Adding torrent');

      // Create Torrent instance
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

      // Auto-start if requested
      if (autoStart) {
        await this._startTorrent(torrent);
      }

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

      // Stop torrent if active
      if (torrent.state !== 'idle') {
        await torrent.stop();
      }

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
    torrent.on('done', () => {
      console.log(`[TorrentEngine] Torrent complete: ${torrent.name}`);
      this.emit('torrent:complete', {
        infoHash,
        name: torrent.name,
        path: path.join(torrent.downloadPath, torrent.name)
      });
    });

    torrent.on('error', ({ message }) => {
      console.error(`[TorrentEngine] Torrent error (${torrent.name}): ${message}`);
      this.emit('torrent:error', { infoHash, error: message });
    });

    torrent.on('started', () => {
      console.log(`[TorrentEngine] Torrent started: ${torrent.name}`);
    });

    torrent.on('stopped', () => {
      console.log(`[TorrentEngine] Torrent stopped: ${torrent.name}`);
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
}

module.exports = { TorrentEngine };
