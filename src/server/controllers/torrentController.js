const Torrent = require('../models/torrent');
const mongoose = require('mongoose');

// Helper to validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Get all torrents for the authenticated user
exports.getAllTorrents = async (req, res) => {
  try {
    const torrents = await Torrent.find({ uploadedBy: req.user.id })
      .sort({ addedAt: -1 })
      .populate('uploadedBy', 'username');
    res.json(torrents);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get torrent by ID
exports.getTorrentById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid torrent ID format' });
    }

    const torrent = await Torrent.findById(req.params.id)
      .populate('uploadedBy', 'username email');

    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    res.json(torrent);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Create a new torrent
exports.createTorrent = async (req, res) => {
  try {
    const { name, infoHash, magnetURI, size, trackers } = req.body;

    // Check if torrent already exists
    const existingTorrent = await Torrent.findOne({ infoHash });
    if (existingTorrent) {
      return res.status(400).json({ message: 'Torrent already exists' });
    }

    const torrent = new Torrent({
      name,
      infoHash,
      magnetURI,
      size,
      trackers,
      uploadedBy: req.user.id,
      status: 'pending'
    });

    await torrent.save();
    res.status(201).json(torrent);
  } catch (error) {
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid torrent ID format' });
    }

    const torrent = await Torrent.findById(req.params.id);
    
    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Only owner or admin can delete
    if (torrent.uploadedBy.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this torrent' });
    }

    await Torrent.findByIdAndDelete(req.params.id);
    res.json({ message: 'Torrent deleted successfully' });
  } catch (error) {
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

    res.json(torrents);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};
