const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const winston = require('winston');
const morgan = require('morgan');

// Load environment variables from .env file
dotenv.config();

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Logger using Winston
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

// Log to console in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3001', // Allow frontend access
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json()); // Parses JSON request body

// Logging HTTP requests using Morgan & Winston
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Import & Use Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const torrentRoutes = require('./routes/torrentRoutes');  // ✅ Fixed import path if needed
const statisticsRoutes = require('./routes/statisticsRoutes');
const healthRoutes = require('./routes/healthRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/torrent', torrentRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api', healthRoutes);

// Default Route
app.get('/', (req, res) => {
  res.send("TorrentEdge Backend Running!");
});

// Handle 404 Errors
app.use((req, res, next) => {
  res.status(404).json({ error: "API route not found" });
});

// WebSocket Setup
io.on('connection', (socket) => {
  logger.info('New client connected');

  socket.on('disconnect', () => {
    logger.info('Client disconnected');
  });
});

// Start Server
const PORT = process.env.PORT || 3029; // ✅ Changed default port to match frontend requests
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});
