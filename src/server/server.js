// src/server/server.js

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const winston = require('winston');
const morgan = require('morgan');

// Load environment variables from .env file
dotenv.config();

// Import Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const torrentRoutes = require('./routes/torrentRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const healthRoutes = require('./routes/healthRoutes'); // Newly Added Route

// Initialize Logger using Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Log errors to error.log
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    // Log all info and above to combined.log
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// If not in production, also log to the console with colorization
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Middleware
app.use(cors({
  origin: 'http://localhost', // Adjust based on your frontend's URL
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json()); // Parses incoming JSON requests

// Setup morgan to use Winston for logging HTTP requests
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/torrent', torrentRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api', healthRoutes); // Health check route

// WebSocket Setup
io.on('connection', (socket) => {
  logger.info('New client connected');

  // Handle custom events here

  socket.on('disconnect', () => {
    logger.info('Client disconnected');
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).send('Something broke!');
});
