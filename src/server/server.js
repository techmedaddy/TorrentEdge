const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const winston = require('winston');
const morgan = require('morgan');
const mongoose = require('mongoose');
const path = require('path');

dotenv.config();

const app = express();
const server = http.createServer(app);

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

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/torrentedge')
  .then(() => logger.info('MongoDB connected successfully'))
  .catch((err) => logger.error('MongoDB connection error:', err));

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  })
);

app.use(express.json());

app.use(
  morgan('combined', {
    stream: {
      write: (msg) => logger.info(msg.trim()),
    },
  })
);

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/torrent', require('./routes/torrentRoutes'));
app.use('/api/statistics', require('./routes/statisticsRoutes'));
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

// Import engine for graceful shutdown
const { defaultEngine, closeProducer } = require('./torrentEngine');

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

    // Close MongoDB connection
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');

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
