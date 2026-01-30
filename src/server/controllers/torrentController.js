/**
 * Torrent Controller
 * 
 * Manages torrent operations using the integrated BitTorrent engine.
 * All torrents are stored in MongoDB for persistence and merged with
 * live engine stats for real-time data.
 * 
 * API Endpoints:
 * - GET    /api/torrents              - Get all user's torrents with live stats
 * - GET    /api/torrents/:id          - Get torrent by ID/infoHash with live stats
 * - POST   /api/torrents/create       - Upload .torrent file and add to engine
 * - PUT    /api/torrents/:id          - Update torrent metadata
 * - DELETE /api/torrents/:id          - Delete torrent (?deleteFiles=true to remove files)
 * - GET    /api/torrents/search       - Search torrents by name
 * - POST   /api/torrents/:id/start    - Start downloading torrent
 * - POST   /api/torrents/:id/pause    - Pause torrent download
 * - POST   /api/torrents/:id/resume   - Resume paused torrent
 * - GET    /api/torrents/:id/stats    - Get real-time torrent statistics
 * - GET    /api/torrents/stats/global - Get global engine statistics
 */

const Torrent = require('../models/torrent');
const mongoose = require('mongoose');
const { defaultEngine } = require('../torrentEngine');
const path = require('path');
const fs = require('fs').promises;

// Helper to validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Helper to merge MongoDB data with live engine stats
const mergeTorrentData = (dbTorrent, engineTorrent) => {
  if (!engineTorrent) {
    return dbTorrent.toObject();
  }

  const stats = engineTorrent.getStats();
  return {
    ...dbTorrent.toObject(),
    status: stats.state,
    progress: stats.percentage,
    downloadSpeed: stats.downloadSpeed,
    uploadSpeed: stats.uploadSpeed,
    seeds: stats.seeds,
    leeches: stats.leeches,
    peers: stats.peers,
    eta: stats.eta,
    completedPieces: stats.completedPieces,
    totalPieces: stats.pieceCount,
    activePieces: stats.activePieces,
    pendingRequests: stats.pendingRequests
  };
};

// Get all torrents for the authenticated user
exports.getAllTorrents = async (req, res) => {
  try {
    const torrents = await Torrent.find({ uploadedBy: req.user.userId || req.user.id })
      .sort({ addedAt: -1 })
      .populate('uploadedBy', 'username');

    // Merge with live engine stats
    const mergedTorrents = torrents.map(torrent => {
      const engineTorrent = defaultEngine.getTorrent(torrent.infoHash);
      return mergeTorrentData(torrent, engineTorrent);
    });

    res.json(mergedTorrents);
  } catch (error) {
    console.error('[TorrentController] getAllTorrents error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get torrent by ID or infoHash
exports.getTorrentById = async (req, res) => {
  try {
    let torrent;
    
    // Check if it's MongoDB ObjectId or infoHash
    if (isValidObjectId(req.params.id)) {
      torrent = await Torrent.findById(req.params.id)
        .populate('uploadedBy', 'username email');
    } else {
      // Assume it's an infoHash
      torrent = await Torrent.findOne({ infoHash: req.params.id.toLowerCase() })
        .populate('uploadedBy', 'username email');
    }

    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Merge with live engine stats
    const engineTorrent = defaultEngine.getTorrent(torrent.infoHash);
    const mergedData = mergeTorrentData(torrent, engineTorrent);

    res.json(mergedData);
  } catch (error) {
    console.error('[TorrentController] getTorrentById error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Create a new torrent (from file upload or magnet URI)
exports.createTorrent = async (req, res) => {
  try {
    const { magnetURI, autoStart = true } = req.body;
    let torrentBuffer = null;
    let torrentPath = null;

    // Handle file upload
    if (req.file) {
      torrentBuffer = req.file.buffer;
      
      // Save torrent file to disk for resume support
      const torrentsDir = path.join(process.env.DOWNLOAD_PATH || './downloads', '.torrentedge', 'torrents');
      await fs.mkdir(torrentsDir, { recursive: true });
      
      torrentPath = path.join(torrentsDir, `${Date.now()}-${req.file.originalname}`);
      await fs.writeFile(torrentPath, torrentBuffer);
    } else if (magnetURI) {
      // Magnet URI support - validate the magnet link first
      const { parseMagnet } = require('../torrentEngine/magnet');
      
      let magnetInfo;
      try {
        magnetInfo = parseMagnet(magnetURI);
      } catch (error) {
        return res.status(400).json({ message: `Invalid magnet link: ${error.message}` });
      }
      
      // Check if torrent already exists
      const existingTorrent = await Torrent.findOne({ infoHash: magnetInfo.infoHash });
      if (existingTorrent) {
        return res.status(400).json({ 
          message: 'Torrent already exists',
          torrent: existingTorrent
        });
      }
      
      console.log(`[TorrentController] Adding magnet: ${magnetInfo.displayName || magnetInfo.infoHash}`);
    } else {
      return res.status(400).json({ message: 'Must provide torrent file or magnet URI' });
    }

    // Add to engine
    let engineTorrent;
    try {
      engineTorrent = await defaultEngine.addTorrent({
        torrentPath: torrentPath,
        torrentBuffer: torrentBuffer,
        magnetURI: magnetURI || null,
        autoStart: autoStart
      });
    } catch (error) {
      console.error('[TorrentController] Engine addTorrent error:', error);
      
      // Clean up saved file
      if (torrentPath) {
        await fs.unlink(torrentPath).catch(() => {});
      }
      
      if (error.message.includes('already exists')) {
        return res.status(400).json({ message: 'Torrent already exists' });
      }
      
      throw error;
    }

    // Check if torrent already exists in MongoDB
    const existingTorrent = await Torrent.findOne({ infoHash: engineTorrent.infoHash });
    if (existingTorrent) {
      return res.status(400).json({ 
        message: 'Torrent already exists in database',
        torrent: existingTorrent
      });
    }

    // Get initial stats (may fail for magnet links without metadata yet)
    let stats = null;
    try {
      stats = engineTorrent.getStats();
    } catch (err) {
      console.log('[TorrentController] Stats not available yet (magnet link fetching metadata)');
    }

    // For magnet links, we might not have full metadata yet
    let displayName = null;
    if (magnetURI) {
      try {
        displayName = require('../torrentEngine/magnet').parseMagnet(magnetURI).displayName;
      } catch (e) {}
    }
    const name = engineTorrent.name || displayName || `Magnet-${engineTorrent.infoHash.substring(0, 8)}`;

    // Save to MongoDB
    const torrent = new Torrent({
      name: name,
      infoHash: engineTorrent.infoHash,
      magnetURI: magnetURI || null,
      size: engineTorrent.size || 0,
      trackers: engineTorrent._metadata?.announce ? [engineTorrent._metadata.announce] : [],
      uploadedBy: req.user.userId || req.user.userId || req.user.id,
      status: engineTorrent.state || (magnetURI ? 'fetching_metadata' : 'pending'),
      progress: stats?.percentage || 0,
      files: (engineTorrent.files || []).map(f => ({
        name: path.basename(f.path || f.name),
        size: f.length || f.size,
        path: f.path || f.name
      }))
    });

    await torrent.save();

    console.log(`[TorrentController] Created torrent: ${torrent.name} (${torrent.infoHash})`);
    
    res.status(201).json(mergeTorrentData(torrent, engineTorrent));
  } catch (error) {
    console.error('[TorrentController] createTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Update torrent status/progress
exports.updateTorrent = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid torrent ID format' });
    }

    const { status, progress, seeds, leeches, downloadSpeed, uploadSpeed } = req.body;
    
    const torrent = await Torrent.findById(req.params.id);
    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Update allowed fields
    if (status) torrent.status = status;
    if (progress !== undefined) torrent.progress = progress;
    if (seeds !== undefined) torrent.seeds = seeds;
    if (leeches !== undefined) torrent.leeches = leeches;
    if (downloadSpeed !== undefined) torrent.downloadSpeed = downloadSpeed;
    if (uploadSpeed !== undefined) torrent.uploadSpeed = uploadSpeed;

    await torrent.save();
    res.json(torrent);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Delete a torrent
exports.deleteTorrent = async (req, res) => {
  try {
    const deleteFiles = req.query.deleteFiles === 'true';
    
    let torrent;
    if (isValidObjectId(req.params.id)) {
      torrent = await Torrent.findById(req.params.id);
    } else {
      torrent = await Torrent.findOne({ infoHash: req.params.id.toLowerCase() });
    }
    
    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Only owner or admin can delete
    if (torrent.uploadedBy.toString() !== req.user.userId || req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this torrent' });
    }

    // Remove from engine
    try {
      await defaultEngine.removeTorrent(torrent.infoHash, deleteFiles);
      console.log(`[TorrentController] Removed from engine: ${torrent.infoHash}`);
    } catch (error) {
      console.warn(`[TorrentController] Failed to remove from engine (may not be running): ${error.message}`);
    }

    // Remove from MongoDB
    await Torrent.findByIdAndDelete(torrent._id);
    
    console.log(`[TorrentController] Deleted torrent: ${torrent.name}`);
    res.json({ 
      message: 'Torrent deleted successfully',
      deletedFiles: deleteFiles
    });
  } catch (error) {
    console.error('[TorrentController] deleteTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Search torrents by name
exports.searchTorrents = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ message: 'Search query required' });
    }

    const torrents = await Torrent.find({ $text: { $search: q } })
      .sort({ score: { $meta: 'textScore' } })
      .populate('uploadedBy', 'username');

    // Merge with live engine stats
    const mergedTorrents = torrents.map(torrent => {
      const engineTorrent = defaultEngine.getTorrent(torrent.infoHash);
      return mergeTorrentData(torrent, engineTorrent);
    });

    res.json(mergedTorrents);
  } catch (error) {
    console.error('[TorrentController] searchTorrents error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Start a torrent
exports.startTorrent = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Torrent.findById(id);
    } else {
      dbTorrent = await Torrent.findOne({ infoHash: id.toLowerCase() });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    let engineTorrent = defaultEngine.getTorrent(dbTorrent.infoHash);
    
    if (!engineTorrent) {
      return res.status(400).json({ 
        message: 'Torrent not loaded in engine. Please re-add the torrent.' 
      });
    }

    // Start the torrent
    await engineTorrent.start();
    
    // Update MongoDB status
    dbTorrent.status = 'downloading';
    await dbTorrent.save();

    console.log(`[TorrentController] Started torrent: ${dbTorrent.name}`);
    
    res.json(mergeTorrentData(dbTorrent, engineTorrent));
  } catch (error) {
    console.error('[TorrentController] startTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Pause a torrent
exports.pauseTorrent = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Torrent.findById(id);
    } else {
      dbTorrent = await Torrent.findOne({ infoHash: id.toLowerCase() });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    const engineTorrent = defaultEngine.getTorrent(dbTorrent.infoHash);
    
    if (!engineTorrent) {
      return res.status(400).json({ 
        message: 'Torrent not running in engine' 
      });
    }

    // Pause the torrent
    engineTorrent.pause();
    
    // Update MongoDB status
    dbTorrent.status = 'paused';
    await dbTorrent.save();

    console.log(`[TorrentController] Paused torrent: ${dbTorrent.name}`);
    
    res.json(mergeTorrentData(dbTorrent, engineTorrent));
  } catch (error) {
    console.error('[TorrentController] pauseTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Resume a torrent
exports.resumeTorrent = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Torrent.findById(id);
    } else {
      dbTorrent = await Torrent.findOne({ infoHash: id.toLowerCase() });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    const engineTorrent = defaultEngine.getTorrent(dbTorrent.infoHash);
    
    if (!engineTorrent) {
      return res.status(400).json({ 
        message: 'Torrent not loaded in engine. Please re-add or start the torrent.' 
      });
    }

    // Resume the torrent
    engineTorrent.resume();
    
    // Update MongoDB status
    dbTorrent.status = 'downloading';
    await dbTorrent.save();

    console.log(`[TorrentController] Resumed torrent: ${dbTorrent.name}`);
    
    res.json(mergeTorrentData(dbTorrent, engineTorrent));
  } catch (error) {
    console.error('[TorrentController] resumeTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get torrent stats (real-time)
exports.getTorrentStats = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Torrent.findById(id);
    } else {
      dbTorrent = await Torrent.findOne({ infoHash: id.toLowerCase() });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    const engineTorrent = defaultEngine.getTorrent(dbTorrent.infoHash);
    
    if (!engineTorrent) {
      return res.status(400).json({ 
        message: 'Torrent not running in engine',
        dbStatus: dbTorrent.status
      });
    }

    // Return real-time stats
    const stats = engineTorrent.getStats();
    res.json(stats);
  } catch (error) {
    console.error('[TorrentController] getTorrentStats error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get files with selection status
exports.getFiles = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Torrent.findById(id);
    } else {
      dbTorrent = await Torrent.findOne({ infoHash: id.toLowerCase() });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const engineTorrent = defaultEngine.getTorrent(dbTorrent.infoHash);
    
    if (!engineTorrent) {
      // Return files from DB if engine not running
      return res.json({
        files: dbTorrent.files.map((f, index) => ({
          index,
          name: f.name,
          path: f.path,
          length: f.size,
          selected: true
        })),
        selectedCount: dbTorrent.files.length,
        totalCount: dbTorrent.files.length
      });
    }

    const files = engineTorrent.getFilesWithSelection();
    const selectedCount = files.filter(f => f.selected).length;
    
    res.json({
      files,
      selectedCount,
      totalCount: files.length
    });
  } catch (error) {
    console.error('[TorrentController] getFiles error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Select/deselect files
exports.selectFiles = async (req, res) => {
  try {
    const { id } = req.params;
    const { fileIndices, selectAll } = req.body;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Torrent.findById(id);
    } else {
      dbTorrent = await Torrent.findOne({ infoHash: id.toLowerCase() });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const engineTorrent = defaultEngine.getTorrent(dbTorrent.infoHash);
    
    if (!engineTorrent) {
      return res.status(400).json({ message: 'Torrent not running in engine' });
    }

    if (selectAll) {
      engineTorrent.selectAllFiles();
    } else if (Array.isArray(fileIndices)) {
      if (fileIndices.length === 0) {
        return res.status(400).json({ message: 'Must select at least one file' });
      }
      engineTorrent.selectFiles(fileIndices);
    } else {
      return res.status(400).json({ message: 'Must provide fileIndices array or selectAll: true' });
    }

    const files = engineTorrent.getFilesWithSelection();
    const selectedCount = files.filter(f => f.selected).length;
    
    res.json({
      message: 'File selection updated',
      files,
      selectedCount,
      totalCount: files.length
    });
  } catch (error) {
    console.error('[TorrentController] selectFiles error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get global engine stats
exports.getGlobalStats = async (req, res) => {
  try {
    const globalStats = defaultEngine.getGlobalStats();
    
    // Add MongoDB info
    const totalInDb = await Torrent.countDocuments();
    
    res.json({
      ...globalStats,
      totalInDatabase: totalInDb
    });
  } catch (error) {
    console.error('[TorrentController] getGlobalStats error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};
