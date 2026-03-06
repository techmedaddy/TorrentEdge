const express = require('express');
const router = express.Router();
const torrentController = require('../controllers/torrentController');
const authMiddleware = require('../middleware/authMiddleware');
const multer = require('multer');

// ── Multer: .torrent file uploads (existing) ──────────────────────────────────
const uploadTorrent = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB — .torrent files are tiny
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

// ── Multer: any file for torrent creation (Phase 2.1) ─────────────────────────
// Accepts PDF, MP3, MP4, ZIP, DOCX — anything the user wants to share.
// Size limit is configurable via MAX_SEED_FILE_SIZE env var (default 2GB).
// Multer enforces the limit at the HTTP layer — controller double-checks below.
const MAX_SEED_FILE_BYTES = parseInt(process.env.MAX_SEED_FILE_SIZE, 10) || (2 * 1024 * 1024 * 1024);

const uploadAnyFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SEED_FILE_BYTES },
  // No fileFilter — accept all MIME types intentionally (controller warns, never blocks)
});

// Apply authentication to all torrent routes
router.use(authMiddleware);

// ── Static routes MUST come before parameterized routes ──────────────────────

// Global engine stats
router.get('/engine/stats', torrentController.getGlobalStats);

// Search torrents
router.get('/search', torrentController.searchTorrents);

// Get all torrents for authenticated user
router.get('/', torrentController.getAllTorrents);

// Create/upload .torrent file or magnet link (existing)
router.post('/create', uploadTorrent.single('torrent'), torrentController.createTorrent);
router.post('/upload', uploadTorrent.single('torrent'), torrentController.createTorrent);

// ── Phase 2.1: Create torrent FROM any user file ──────────────────────────────
// POST /api/torrent/create-from-file
// Multer error handler wraps the route so LIMIT_FILE_SIZE surfaces as 413
router.post('/create-from-file', (req, res, next) => {
  uploadAnyFile.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      const limitMB = (MAX_SEED_FILE_BYTES / (1024 * 1024)).toFixed(0);
      return res.status(413).json({
        error: `File too large. Maximum allowed size is ${limitMB} MB.`,
        maxBytes: MAX_SEED_FILE_BYTES,
      });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, torrentController.createTorrentFromFile);

// ── Parameterized routes MUST come AFTER static routes ───────────────────────

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

