const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const winston = require('winston');
const morgan = require('morgan');
const mongoose = require('mongoose');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
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

// Global error handler (must be defined before server.listen)
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Socket Layer
require('./socket')(server);

// Start Server
const PORT = process.env.PORT || 3029;

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
