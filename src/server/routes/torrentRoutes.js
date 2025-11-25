const express = require('express');
const router = express.Router();
const Torrent = require('../models/torrent');

// GET: fetch all torrents
router.get('/', async (req, res) => {
  try {
    const torrents = await Torrent.find();
    res.json(torrents);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch torrents' });
  }
});

// POST: create a new torrent
router.post('/create', async (req, res) => {
  try {
    const { file } = req.body;

    const newTorrent = new Torrent({
      name: file,
      size: 100,
      seeds: 5,
      leeches: 2,
    });

    await newTorrent.save();

    res.status(201).json({
      message: 'Torrent created successfully',
      torrent: newTorrent,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create torrent' });
  }
});

// GET: peers (placeholder)
router.get('/peers', async (req, res) => {
  res.json({ message: 'Peers data here' });
});

// GET: status updates (placeholder)
router.get('/status-updates', async (req, res) => {
  res.json({ message: 'Status updates data here' });
});

module.exports = router;
