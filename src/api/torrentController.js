const express = require('express');
const router = express.Router();
const torrentManager = require('../client/torrentManager');

router.post('/create', async (req, res) => {
    try {
        const { file } = req.body;
        if (!file) {
            return res.status(400).json({ error: 'File parameter is required' });
        }
        const torrent = await torrentManager.create(file);
        res.status(201).json({ message: 'Torrent created successfully', torrent });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create torrent' });
    }
});

router.get('/track/:torrentId', async (req, res) => {
    try {
        const { torrentId } = req.params;
        const torrent = await torrentManager.track(torrentId);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }
        res.json(torrent);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to track torrent' });
    }
});

module.exports = router;
