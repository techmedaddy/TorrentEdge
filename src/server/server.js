const dotenv = require('dotenv');
dotenv.config();

const { startTracing, shutdownTracing } = require('./observability/tracing');
startTracing();

const express = require('express');
const http = require('http');
const cors = require('cors');
const winston = require('winston');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs').promises;
const { connectSQL, sequelize } = require('./db/sql');
const requestId = require('./middleware/requestId');
const {
  createHttpMetricsMiddleware,
  createMetricsHandler,
  observeEngineMetrics,
} = require('./observability/metrics');

const app = express();
const server = http.createServer(app);

// Initialize PostgreSQL connection
connectSQL();

// Logger - write to logs directory
const logsDir = path.join(__dirname, '../../logs');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log') }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}

// PostgreSQL-based seed restore (replaces MongoDB)
// Uses async I/O to avoid blocking the event loop (Fix #4)
(async () => {
  try {
    const { Transfer } = require('./models/sql');
    const { defaultEngine } = require('./torrentEngine');
    const pathLib = require('path');

    const seedTransfers = await Transfer.findAll({
      where: { created_from_upload: true },
    }).catch(() => []);

    if (seedTransfers.length > 0) {
      logger.info(`[SeedRestore] Restoring ${seedTransfers.length} seeded torrent(s)...`);
      for (const transfer of seedTransfers) {
        try {
          const torrentFilePath = pathLib.resolve(transfer.torrent_file_path || '');
          const sourcePath = pathLib.resolve(transfer.source_path || '');

          // Async existence check (Fix #4: no readFileSync)
          try {
            await fs.access(torrentFilePath);
          } catch {
            logger.warn(`[SeedRestore] .torrent file missing for "${transfer.name}", skipping`);
            continue;
          }
          try {
            await fs.access(sourcePath);
          } catch {
            logger.warn(`[SeedRestore] Source file missing for "${transfer.name}", skipping`);
            continue;
          }

          // Async file read (Fix #4: prevents event loop blocking)
          const torrentBuffer = await fs.readFile(torrentFilePath);
          const downloadPath = pathLib.resolve(
            process.env.DOWNLOAD_PATH || './downloads', 'seeds'
          );

          setImmediate(async () => {
            try {
              await defaultEngine.seedFromFile({ torrentBuffer, sourcePath, downloadPath, autoStart: true });
              logger.info(`[SeedRestore] Resumed seeding: "${transfer.name}"`);

              const engineTorrent = defaultEngine.getTorrent(transfer.info_hash);
              if (engineTorrent && typeof engineTorrent._transitionToSeeding === 'function') {
                if (engineTorrent._state !== 'seeding') {
                  await engineTorrent._transitionToSeeding();
                  logger.info(`[SeedRestore] Force-transitioned to seeding: "${transfer.name}"`);
                }
              }

              // Update PostgreSQL status
              await Transfer.update(
                { status: 'seeding', progress: 100 },
                { where: { info_hash: transfer.info_hash } }
              );
            } catch (err) {
              logger.warn(`[SeedRestore] Failed to resume "${transfer.name}": ${err.message}`);
            }
          });
        } catch (err) {
          logger.warn(`[SeedRestore] Error processing "${transfer.name}": ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`[SeedRestore] Restore pass failed (non-fatal): ${err.message}`);
  }
})();

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  })
);

// Phase 1.3: Attach X-Request-ID correlation ID to every request
app.use(requestId);

app.use(createHttpMetricsMiddleware());

app.use(express.json());

app.use(
  morgan('combined', {
    stream: {
      write: (msg) => logger.info(msg.trim()),
    },
  })
);

const { defaultEngine, closeProducer, defaultWorker, defaultSweeper } = require('./torrentEngine');

const metricsHandler = createMetricsHandler({
  collect: () => observeEngineMetrics(defaultEngine, defaultWorker),
});

app.get('/metrics', metricsHandler);
app.get('/api/metrics', metricsHandler);

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/auth', require('./routes/authRoutes')); // Also mount at /auth for Google OAuth callback compatibility
app.use('/api/user', require('./routes/userRoutes'));
// Public artifact download — mounted BEFORE the torrent router so authMiddleware never fires.
// The 40-char infoHash acts as a capability token; if you know it, you can pull.
const torrentController = require('./controllers/torrentController');
app.get('/api/torrent/:id/download', torrentController.downloadTorrentFile);

app.use('/api/torrent', require('./routes/torrentRoutes'));
app.use('/api/statistics', require('./routes/statisticsRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api', require('./routes/healthRoutes'));

app.get('/', (req, res) => {
  res.send('TorrentEdge Backend Running!');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Socket Layer
const { initializeSocket, cleanup: cleanupSocket } = require('./socket');
initializeSocket(server);

// Phase 2.1: Start embedded worker consumer
defaultWorker.start().catch(err => {
  logger.warn(`Embedded worker start failed (non-fatal): ${err.message}`);
});

// Phase 2.3: Start the Control Plane Zombie Sweeper
if (process.env.RUN_AS_WORKER_ONLY !== 'true') {
  defaultSweeper.start();
}

// Graceful Shutdown Handler
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    // Cleanup socket connections
    if (typeof cleanupSocket === 'function') {
      cleanupSocket();
      logger.info('Socket.IO cleanup complete');
    }

    // Shutdown torrent engine (saves state)
    if (defaultEngine && typeof defaultEngine.shutdown === 'function') {
      await defaultEngine.shutdown();
      logger.info('Torrent engine shutdown complete');
    }

    // Close Kafka producer
    if (typeof closeProducer === 'function') {
      await closeProducer();
      logger.info('Kafka producer closed');
    }

    // Phase 2.1: Stop embedded worker consumer
    if (defaultWorker && typeof defaultWorker.stop === 'function') {
      await defaultWorker.stop();
      logger.info('Worker consumer stopped');
    }

    if (defaultSweeper && typeof defaultSweeper.stop === 'function') {
      defaultSweeper.stop();
      logger.info('Lease Sweeper stopped');
    }



    // Close PostgreSQL connection
    if (sequelize) {
      await sequelize.close();
      logger.info('PostgreSQL connection closed');
    }

    await shutdownTracing();
    logger.info('OpenTelemetry tracing closed');

    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start Server
const PORT = process.env.PORT || 3029;

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server };
