const express = require('express');
const router = express.Router();
const torrentController = require('../controllers/torrentController');

// Ensure you have valid callback functions for each route
router.get('/:id', torrentController.getTorrentById);

module.exports = router;
