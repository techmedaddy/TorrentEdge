const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

/**
 * Manages persistent state for torrents to survive restarts
 */
class StateManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.stateDir = options.stateDir || './data/state';
    this.saveInterval = options.saveInterval || 30000; // 30 seconds
    this.maxBackups = options.maxBackups || 3;
    
    // In-memory state
    this._state = {
      version: 1,
      savedAt: Date.now(),
      torrents: {},
      settings: {
        maxConcurrent: 3,
        globalUploadLimit: 0,
        globalDownloadLimit: 0
      }
    };
    
    // State management
    this._isDirty = false;
    this._autoSaveTimer = null;
    this._isInitialized = false;
    
    // File paths
    this._stateFile = path.join(this.stateDir, 'state.json');
    this._tempFile = path.join(this.stateDir, 'state.tmp.json');
  }
  
  /**
   * Initializes state manager - loads existing state or creates new
   */
  async initialize() {
    if (this._isInitialized) {
      console.log('[StateManager] Already initialized');
      return;
    }
    
    try {
      console.log('[StateManager] Initializing...');
      
      // Ensure state directory exists
      await fs.mkdir(this.stateDir, { recursive: true });
      
      // Try to load existing state
      const loaded = await this.load();
      
      if (loaded) {
        console.log(`[StateManager] Loaded state with ${Object.keys(this._state.torrents).length} torrents`);
      } else {
        console.log('[StateManager] Starting with fresh state');
      }
      
      this._isInitialized = true;
      this.emit('initialized');
      
    } catch (error) {
      console.error(`[StateManager] Initialization failed: ${error.message}`);
      console.warn('[StateManager] Starting with empty state');
      this._isInitialized = true;
    }
  }
  
  /**
   * Loads state from disk
   * @returns {Promise<boolean>} True if state was loaded
   */
  async load() {
    try {
      // Try main state file first
      console.log('[StateManager] Loading state from disk...');
      
      try {
        const data = await fs.readFile(this._stateFile, 'utf8');
        const state = JSON.parse(data);
        
        if (this._validateState(state)) {
          this._state = state;
          console.log('[StateManager] Loaded main state file');
          return true;
        } else {
          console.warn('[StateManager] Main state file validation failed');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`[StateManager] Failed to load main state: ${error.message}`);
        }
      }
      
      // Try backup files
      for (let i = 0; i < this.maxBackups; i++) {
        const backupFile = this._getBackupPath(i);
        
        try {
          const data = await fs.readFile(backupFile, 'utf8');
          const state = JSON.parse(data);
          
          if (this._validateState(state)) {
            this._state = state;
            console.log(`[StateManager] Loaded from backup ${i}`);
            
            // Save as main file
            await this.save();
            return true;
          } else {
            console.warn(`[StateManager] Backup ${i} validation failed`);
          }
        } catch (error) {
          // Backup doesn't exist or is corrupted
          if (error.code !== 'ENOENT') {
            console.warn(`[StateManager] Failed to load backup ${i}: ${error.message}`);
          }
        }
      }
      
      console.warn('[StateManager] No valid state files found');
      return false;
      
    } catch (error) {
      console.error(`[StateManager] Load error: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Saves state to disk with backup rotation
   */
  async save() {
    try {
      // Update timestamp
      this._state.savedAt = Date.now();
      
      const stateJson = JSON.stringify(this._state, null, 2);
      
      // Write to temp file first (atomic write)
      await fs.writeFile(this._tempFile, stateJson, 'utf8');
      
      // Rotate backups if main file exists
      if (await this._fileExists(this._stateFile)) {
        await this._rotateBackups();
      }
      
      // Rename temp to main (atomic)
      await fs.rename(this._tempFile, this._stateFile);
      
      this._isDirty = false;
      this.emit('saved');
      
      console.log('[StateManager] State saved successfully');
      
    } catch (error) {
      console.error(`[StateManager] Save failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Gets state for a specific torrent
   * @param {string} infoHash
   * @returns {Object|null}
   */
  getTorrentState(infoHash) {
    return this._state.torrents[infoHash] || null;
  }
  
  /**
   * Sets or updates state for a torrent
   * @param {string} infoHash
   * @param {Object} state - Partial or full state
   */
  setTorrentState(infoHash, state) {
    if (!this._state.torrents[infoHash]) {
      // New torrent
      this._state.torrents[infoHash] = {
        infoHash,
        addedAt: Date.now(),
        state: 'queued',
        completedPieces: [],
        downloadedBytes: 0,
        uploadedBytes: 0,
        totalDownloaded: 0,
        totalUploaded: 0,
        ...state
      };
    } else {
      // Update existing
      this._state.torrents[infoHash] = {
        ...this._state.torrents[infoHash],
        ...state
      };
    }
    
    this.markDirty();
  }
  
  /**
   * Removes torrent state
   * @param {string} infoHash
   */
  removeTorrentState(infoHash) {
    if (this._state.torrents[infoHash]) {
      delete this._state.torrents[infoHash];
      this.markDirty();
      console.log(`[StateManager] Removed state for ${infoHash}`);
    }
  }
  
  /**
   * Gets all torrent states
   * @returns {Object}
   */
  getAllTorrentStates() {
    return { ...this._state.torrents };
  }
  
  /**
   * Updates global settings
   * @param {Object} settings
   */
  updateSettings(settings) {
    this._state.settings = {
      ...this._state.settings,
      ...settings
    };
    this.markDirty();
  }
  
  /**
   * Gets global settings
   * @returns {Object}
   */
  getSettings() {
    return { ...this._state.settings };
  }
  
  /**
   * Marks state as dirty (needs saving)
   */
  markDirty() {
    this._isDirty = true;
  }
  
  /**
   * Checks if state is dirty
   * @returns {boolean}
   */
  isDirty() {
    return this._isDirty;
  }
  
  /**
   * Forces immediate save
   */
  async flush() {
    if (this._isDirty) {
      console.log('[StateManager] Flushing state...');
      await this.save();
    } else {
      console.log('[StateManager] State is clean, no flush needed');
    }
  }
  
  /**
   * Starts auto-save timer
   */
  startAutoSave() {
    if (this._autoSaveTimer) {
      console.log('[StateManager] Auto-save already running');
      return;
    }
    
    console.log(`[StateManager] Starting auto-save (interval: ${this.saveInterval}ms)`);
    
    this._autoSaveTimer = setInterval(async () => {
      if (this._isDirty) {
        try {
          await this.save();
        } catch (error) {
          console.error(`[StateManager] Auto-save failed: ${error.message}`);
        }
      }
    }, this.saveInterval);
    
    // Prevent timer from keeping process alive
    if (this._autoSaveTimer.unref) {
      this._autoSaveTimer.unref();
    }
  }
  
  /**
   * Stops auto-save and flushes pending changes
   */
  async stopAutoSave() {
    if (this._autoSaveTimer) {
      console.log('[StateManager] Stopping auto-save...');
      clearInterval(this._autoSaveTimer);
      this._autoSaveTimer = null;
      
      // Flush any pending changes
      await this.flush();
    }
  }
  
  /**
   * Validates state object structure
   * @param {Object} state
   * @returns {boolean}
   * @private
   */
  _validateState(state) {
    if (!state || typeof state !== 'object') {
      console.warn('[StateManager] Invalid state: not an object');
      return false;
    }
    
    if (state.version !== 1) {
      console.warn(`[StateManager] Invalid state version: ${state.version}`);
      return false;
    }
    
    if (!state.torrents || typeof state.torrents !== 'object') {
      console.warn('[StateManager] Invalid state: missing torrents');
      return false;
    }
    
    if (!state.settings || typeof state.settings !== 'object') {
      console.warn('[StateManager] Invalid state: missing settings');
      return false;
    }
    
    // Validate each torrent state
    for (const [infoHash, torrentState] of Object.entries(state.torrents)) {
      if (!torrentState.infoHash || typeof torrentState.infoHash !== 'string') {
        console.warn(`[StateManager] Invalid torrent state: missing infoHash for ${infoHash}`);
        return false;
      }
      
      if (!Array.isArray(torrentState.completedPieces)) {
        console.warn(`[StateManager] Invalid torrent state: completedPieces not array for ${infoHash}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Rotates backup files
   * @private
   */
  async _rotateBackups() {
    try {
      // Delete oldest backup
      if (this.maxBackups > 0) {
        const oldestBackup = this._getBackupPath(this.maxBackups - 1);
        
        try {
          await fs.unlink(oldestBackup);
        } catch (error) {
          // File doesn't exist, that's fine
        }
        
        // Rotate existing backups
        for (let i = this.maxBackups - 2; i >= 0; i--) {
          const oldPath = this._getBackupPath(i);
          const newPath = this._getBackupPath(i + 1);
          
          try {
            await fs.rename(oldPath, newPath);
          } catch (error) {
            // File doesn't exist, that's fine
          }
        }
        
        // Copy main file to backup.0
        const backup0 = this._getBackupPath(0);
        await fs.copyFile(this._stateFile, backup0);
      }
    } catch (error) {
      console.warn(`[StateManager] Backup rotation failed: ${error.message}`);
      // Don't throw - this shouldn't prevent saving
    }
  }
  
  /**
   * Gets backup file path
   * @param {number} index
   * @returns {string}
   * @private
   */
  _getBackupPath(index) {
    return path.join(this.stateDir, `state.backup.${index}.json`);
  }
  
  /**
   * Checks if file exists
   * @param {string} filePath
   * @returns {Promise<boolean>}
   * @private
   */
  async _fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Gets state statistics
   * @returns {Object}
   */
  getStats() {
    const torrentCount = Object.keys(this._state.torrents).length;
    const statesByStatus = {};
    
    for (const torrent of Object.values(this._state.torrents)) {
      const state = torrent.state || 'unknown';
      statesByStatus[state] = (statesByStatus[state] || 0) + 1;
    }
    
    return {
      torrentCount,
      statesByStatus,
      isDirty: this._isDirty,
      lastSaved: this._state.savedAt,
      autoSaveEnabled: this._autoSaveTimer !== null
    };
  }
  
  /**
   * Exports state as JSON string
   * @param {boolean} pretty - Pretty print
   * @returns {string}
   */
  exportState(pretty = false) {
    return JSON.stringify(this._state, null, pretty ? 2 : 0);
  }
  
  /**
   * Imports state from JSON string
   * @param {string} json
   */
  importState(json) {
    try {
      const state = JSON.parse(json);
      
      if (this._validateState(state)) {
        this._state = state;
        this.markDirty();
        console.log('[StateManager] State imported successfully');
        this.emit('imported');
      } else {
        throw new Error('State validation failed');
      }
    } catch (error) {
      console.error(`[StateManager] Import failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Cleans up and persists final state
   */
  async cleanup() {
    console.log('[StateManager] Cleaning up...');
    
    await this.stopAutoSave();
    
    this.emit('cleanup');
  }
}

module.exports = { StateManager };
