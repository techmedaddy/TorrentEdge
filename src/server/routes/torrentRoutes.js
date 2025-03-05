const express = require('express');
const router = express.Router();
const torrentController = require('../../api/torrent.Controller'); // ✅ Ensured correct import

// Test Route
router.get('/', (req, res) => {
    res.send("Torrent Routes Working!");
});

// Use `router.use()` to load all routes from `torrent.Controller.js`
router.use('/', torrentController);

module.exports = router;
