const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const winston = require('winston');
const morgan = require('morgan');

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

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
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const torrentRoutes = require('./routes/torrentRoutes');  
const statisticsRoutes = require('./routes/statisticsRoutes');
const healthRoutes = require('./routes/healthRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/torrent', torrentRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api', healthRoutes);

app.get('/', (req, res) => {
  res.send("TorrentEdge Backend Running!");
});

app.use((req, res, next) => {
  res.status(404).json({ error: "API route not found" });
});

io.on('connection', (socket) => {
  logger.info('New client connected');
  socket.on('disconnect', () => {
    logger.info('Client disconnected');
  });
});

const PORT = process.env.PORT || 3029;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
});

app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});
