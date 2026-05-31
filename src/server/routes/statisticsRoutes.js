const express = require('express');
const router = express.Router();
const { defaultEngine } = require('../torrentEngine');
const { Transfer, User } = require('../models/sql');
const { Op } = require('sequelize');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * Statistics Routes
 * 
 * GET /api/statistics         - Get global statistics (public)
 * GET /api/statistics/engine  - Get engine stats (auth required)
 * GET /api/statistics/user    - Get current user's stats (auth required)
 */

// GET /api/statistics - Global stats (public)
router.get('/', async (req, res) => {
  try {
    // Get counts from database
    const [totalTorrents, totalUsers, activeTorrents] = await Promise.all([
      Transfer.count(),
      User.count(),
      Transfer.count({ where: { status: { [Op.in]: ['downloading', 'seeding'] } } })
    ]);

    // Get engine stats if available
    let engineStats = null;
    let dhtStats = null;
    try {
      engineStats = defaultEngine.getGlobalStats();
      dhtStats = defaultEngine.getDHTStats();
    } catch (e) {
      // Engine may not be fully initialized
    }

    res.json({
      database: {
        totalTorrents,
        totalUsers,
        activeTorrents
      },
      engine: engineStats || {
        totalDownloadSpeed: 0,
        totalUploadSpeed: 0,
        activeTorrents: 0,
        totalTorrents: 0
      },
      dht: dhtStats || {
        enabled: false,
        running: false,
        nodes: 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Statistics] Error fetching global stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/statistics/global - Global egress savings
router.get('/global', async (req, res) => {
  try {
    // Aggregate metrics across all active torrents managed by the engine
    const torrents = defaultEngine.getAllTorrents();
    
    let totalP2PBytesDownloaded = 0;
    let totalCloudBytesDownloaded = 0; // Bytes pulled via the S3 Bridge
    
    torrents.forEach(t => {
      try {
        const stats = t.getStats();
        totalP2PBytesDownloaded += stats.downloadedFromPeers || stats.downloaded || 0;
        totalCloudBytesDownloaded += stats.downloadedFromS3 || 0;
      } catch (e) {
        // Stats not available for this torrent
      }
    });

    return res.status(200).json({
      totalP2PBytes: totalP2PBytesDownloaded,
      totalCloudBytes: totalCloudBytesDownloaded,
      activeSwarms: torrents.length
    });
  } catch (error) {
    console.error('[API] Failed to fetch egress global stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/statistics/engine - Detailed engine stats (auth required)
router.get('/engine', authMiddleware, async (req, res) => {
  try {
    const globalStats = defaultEngine.getGlobalStats();
    
    // Get all torrents with their stats
    const torrents = defaultEngine.getAllTorrents();
    const torrentStats = torrents.map(t => {
      try {
        return t.getStats();
      } catch (e) {
        return { infoHash: t.infoHash, error: e.message };
      }
    });

    res.json({
      global: globalStats,
      torrents: torrentStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Statistics] Error fetching engine stats:', error);
    res.status(500).json({ error: 'Failed to fetch engine statistics' });
  }
});

// GET /api/statistics/speed-history - Speed history for graphs (auth required)
router.get('/speed-history', authMiddleware, async (req, res) => {
  try {
    const history = defaultEngine.getSpeedHistory();
    
    res.json({
      history,
      maxSamples: 60,
      intervalMs: 1000,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Statistics] Error fetching speed history:', error);
    res.status(500).json({ error: 'Failed to fetch speed history' });
  }
});

// GET /api/statistics/dht - DHT network stats (auth required)
router.get('/dht', authMiddleware, async (req, res) => {
  try {
    const dhtStats = defaultEngine.getDHTStats();
    
    res.json({
      ...dhtStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Statistics] Error fetching DHT stats:', error);
    res.status(500).json({ error: 'Failed to fetch DHT statistics' });
  }
});

// GET /api/statistics/user - Current user's stats (auth required)
router.get('/user', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's torrent stats from database
    const userTorrents = await Transfer.findAll({ where: { uploaded_by: userId } });
    
    const stats = {
      totalTorrents: userTorrents.length,
      byStatus: {
        pending: 0,
        downloading: 0,
        seeding: 0,
        paused: 0,
        completed: 0,
        error: 0
      },
      totalSize: 0,
      totalDownloaded: 0
    };

    userTorrents.forEach(t => {
      stats.byStatus[t.status] = (stats.byStatus[t.status] || 0) + 1;
      stats.totalSize += t.size_bytes || 0;
      stats.totalDownloaded += (t.size_bytes || 0) * (t.progress || 0) / 100;
    });

    // Get live stats from engine for user's torrents
    const liveStats = [];
    for (const torrent of userTorrents) {
      const engineTorrent = defaultEngine.getTorrent(torrent.info_hash);
      if (engineTorrent) {
        try {
          liveStats.push(engineTorrent.getStats());
        } catch (e) {
          // Skip if can't get stats
        }
      }
    }

    // Calculate aggregate speeds
    const totalDownloadSpeed = liveStats.reduce((sum, s) => sum + (s.downloadSpeed || 0), 0);
    const totalUploadSpeed = liveStats.reduce((sum, s) => sum + (s.uploadSpeed || 0), 0);

    res.json({
      ...stats,
      live: {
        activeTorrents: liveStats.length,
        totalDownloadSpeed,
        totalUploadSpeed
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Statistics] Error fetching user stats:', error);
    res.status(500).json({ error: 'Failed to fetch user statistics' });
  }
});

module.exports = router;
