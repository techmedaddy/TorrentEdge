const express = require('express');
const router = express.Router();
const torrentController = require('../controllers/torrentController');
const authMiddleware = require('../middleware/authMiddleware');

// Static routes MUST come before parameterized routes (:id)

// GET: search torrents
router.get('/search', torrentController.searchTorrents);

// GET: peers (placeholder)
router.get('/peers', async (req, res) => {
  res.json({ message: 'Peers data here' });
});

// GET: status updates (placeholder)
router.get('/status-updates', async (req, res) => {
  res.json({ message: 'Status updates data here' });
});

// GET: fetch all torrents for authenticated user
router.get('/', authMiddleware, torrentController.getAllTorrents);

// POST: create a new torrent (protected)
router.post('/create', authMiddleware, torrentController.createTorrent);

// Parameterized routes MUST come AFTER static routes
// GET: fetch torrent by ID
router.get('/:id', torrentController.getTorrentById);

// PUT: update torrent (protected)
router.put('/:id', authMiddleware, torrentController.updateTorrent);

// DELETE: remove torrent (protected)
router.delete('/:id', authMiddleware, torrentController.deleteTorrent);

module.exports = router;
