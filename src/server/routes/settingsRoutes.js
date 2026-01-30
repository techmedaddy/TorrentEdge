const express = require('express');
const router = express.Router();
const { defaultEngine } = require('../torrentEngine');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * Settings Routes
 * 
 * GET  /api/settings         - Get current engine settings
 * PUT  /api/settings         - Update engine settings
 * POST /api/settings/reset   - Reset to default settings
 */

// Apply auth to all routes
router.use(authMiddleware);

// GET /api/settings - Get current settings
router.get('/', async (req, res) => {
  try {
    const settings = defaultEngine.getSettings();
    res.json(settings);
  } catch (error) {
    console.error('[Settings] Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings - Update settings
router.put('/', async (req, res) => {
  try {
    const { 
      downloadPath,
      maxActiveTorrents,
      maxConcurrent,
      speedLimits
    } = req.body;
    
    const updatePayload = {};
    
    if (downloadPath) {
      updatePayload.downloadPath = downloadPath;
    }
    
    if (maxActiveTorrents !== undefined) {
      updatePayload.maxActiveTorrents = parseInt(maxActiveTorrents);
    }
    
    if (maxConcurrent !== undefined) {
      updatePayload.maxConcurrent = parseInt(maxConcurrent);
    }
    
    if (speedLimits) {
      updatePayload.speedLimits = {
        download: parseInt(speedLimits.download) || 0,
        upload: parseInt(speedLimits.upload) || 0
      };
    }
    
    const settings = defaultEngine.updateSettings(updatePayload);
    
    res.json({
      message: 'Settings updated successfully',
      settings
    });
  } catch (error) {
    console.error('[Settings] Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/settings/speed-limits - Quick update speed limits
router.post('/speed-limits', async (req, res) => {
  try {
    const { download = 0, upload = 0 } = req.body;
    
    defaultEngine.setSpeedLimits(
      parseInt(download) || 0,
      parseInt(upload) || 0
    );
    
    res.json({
      message: 'Speed limits updated',
      speedLimits: {
        download: parseInt(download) || 0,
        upload: parseInt(upload) || 0
      }
    });
  } catch (error) {
    console.error('[Settings] Error updating speed limits:', error);
    res.status(500).json({ error: 'Failed to update speed limits' });
  }
});

// GET /api/settings/dht - Get DHT status
router.get('/dht', async (req, res) => {
  try {
    const dhtStats = defaultEngine.getDHTStats();
    res.json(dhtStats);
  } catch (error) {
    console.error('[Settings] Error fetching DHT stats:', error);
    res.status(500).json({ error: 'Failed to fetch DHT stats' });
  }
});

module.exports = router;
