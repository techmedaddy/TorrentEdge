const express = require('express');
const router = express.Router();
/**
 * Phase 3.1/3.2 — Health & Readiness Probes
 *
 * Kubernetes-compatible probe endpoints:
 *   /api/health    — Liveness probe (is the process alive?)
 *   /api/ready     — Readiness probe (are all dependencies connected?)
 *   /api/startup   — Startup probe (has the app finished initializing?)
 */

/**
 * GET /api/health — Liveness probe
 * Returns 200 if the Node.js event loop is responsive.
 * Kubernetes restarts the pod if this fails.
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  });
});

/**
 * GET /api/ready — Readiness probe
 * Returns 200 only when all critical dependencies are reachable.
 * Kubernetes removes the pod from the Service's endpoints if this fails.
 */
router.get('/ready', async (req, res) => {
  const checks = {};
  let healthy = true;

  // 1. PostgreSQL (via Sequelize)
  try {
    const { sequelize } = require('../db/sql');
    await sequelize.authenticate();
    checks.postgres = 'connected';
  } catch (err) {
    checks.postgres = `error: ${err.message}`;
    healthy = false;
  }

  // 3. Redis
  try {
    const redis = require('../db/redis');
    if (redis.status === 'ready') {
      checks.redis = 'connected';
    } else {
      checks.redis = `status: ${redis.status}`;
      if (process.env.NODE_ENV === 'production') {
        healthy = false;
      }
    }
  } catch (err) {
    checks.redis = `error: ${err.message}`;
    if (process.env.NODE_ENV === 'production') {
      healthy = false;
    }
  }

  // 4. Engine status
  try {
    const { defaultEngine, defaultWorker } = require('../torrentEngine');
    checks.engine = defaultEngine ? 'initialized' : 'missing';
    checks.worker = defaultWorker?.getStats()?.isRunning ? 'running' : 'stopped';
  } catch (err) {
    checks.engine = `error: ${err.message}`;
  }

  const statusCode = healthy ? 200 : 503;
  res.status(statusCode).json({
    status: healthy ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/startup — Startup probe
 * Returns 200 once the application has completed initial bootstrap.
 * Used by Kubernetes to avoid killing slow-starting containers.
 */
let startupComplete = false;

// Mark startup as complete after a short delay to let DB connections initialize
setTimeout(() => {
  startupComplete = true;
}, 5000);

router.get('/startup', (req, res) => {
  if (startupComplete) {
    res.json({ status: 'started', timestamp: new Date().toISOString() });
  } else {
    res.status(503).json({ status: 'starting', timestamp: new Date().toISOString() });
  }
});

module.exports = router;
