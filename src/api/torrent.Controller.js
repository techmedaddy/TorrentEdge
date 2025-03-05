const express = require('express');
const router = express.Router();
const torrentManager = require('../client/torrentManager'); // ✅ Ensure correct path

// Debugging logs
console.log("✅ Loaded torrentManager:", torrentManager);

// Create a Torrent
router.post('/create', async (req, res) => {
    try {
        console.log("📩 Received request to create torrent:", req.body);

        const { file } = req.body;
        if (!file) {
            console.warn("⚠️ Missing 'file' parameter in request body!");
            return res.status(400).json({ error: 'File parameter is required' });
        }

        // Ensure the function exists before calling it
        if (!torrentManager || typeof torrentManager.create !== "function") {
            console.error("❌ Error: `torrentManager.create` function is missing!");
            return res.status(500).json({ error: "Internal Server Error: `create` function not found in torrentManager" });
        }

        // Call the `create` function
        const torrent = await torrentManager.create(file);
        console.log("✅ Torrent created successfully:", torrent);

        res.status(201).json({ message: 'Torrent created successfully', torrent });
    } catch (error) {
        console.error("❌ Create Torrent Error:", error);
        res.status(500).json({ error: 'Failed to create torrent' });
    }
});

// Track a Torrent
router.get('/track/:torrentId', async (req, res) => {
    try {
        console.log("🔍 Tracking torrent with ID:", req.params.torrentId);

        const { torrentId } = req.params;
        const torrent = await torrentManager.track(torrentId);

        if (!torrent) {
            console.warn("⚠️ Torrent not found for ID:", torrentId);
            return res.status(404).json({ error: 'Torrent not found' });
        }

        res.json(torrent);
    } catch (error) {
        console.error("❌ Track Torrent Error:", error);
        res.status(500).json({ error: 'Failed to track torrent' });
    }
});

module.exports = router;
