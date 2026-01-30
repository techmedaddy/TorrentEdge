const express = require('express');
const router = express.Router();
const torrentController = require('../controllers/torrentController');
const authMiddleware = require('../middleware/authMiddleware');
const multer = require('multer');

// Configure multer for file uploads (store in memory)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for .torrent files
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/x-bittorrent' || 
        file.originalname.endsWith('.torrent')) {
      cb(null, true);
    } else {
      cb(new Error('Only .torrent files are allowed'));
    }
  }
});

// Apply authentication to all torrent routes
router.use(authMiddleware);

// Static routes MUST come before parameterized routes

// Global engine stats
router.get('/engine/stats', torrentController.getGlobalStats);

// Search torrents
router.get('/search', torrentController.searchTorrents);

// Get all torrents for authenticated user
router.get('/', torrentController.getAllTorrents);

// Create/upload torrent
router.post('/create', upload.single('torrent'), torrentController.createTorrent);
router.post('/upload', upload.single('torrent'), torrentController.createTorrent);

// Parameterized routes MUST come AFTER static routes

// Torrent control actions
router.post('/:id/start', torrentController.startTorrent);
router.post('/:id/pause', torrentController.pauseTorrent);
router.post('/:id/resume', torrentController.resumeTorrent);

// File selection
router.get('/:id/files', torrentController.getFiles);
router.post('/:id/files/select', torrentController.selectFiles);

// Get torrent real-time stats
router.get('/:id/stats', torrentController.getTorrentStats);

// Get torrent by ID or infoHash
router.get('/:id', torrentController.getTorrentById);

// Update torrent metadata
router.put('/:id', torrentController.updateTorrent);

// Delete torrent (?deleteFiles=true to delete downloaded files)
router.delete('/:id', torrentController.deleteTorrent);

module.exports = router;
