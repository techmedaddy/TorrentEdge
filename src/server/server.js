const express = require('express');
const path = require('path');
const app = express();
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const torrentRoutes = require('./routes/torrentRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const socketSetup = require('./socket'); // For notifications

// Middleware
app.use(express.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../../web/web-react-new/build')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/torrent', torrentRoutes);
app.use('/api/statistics', statisticsRoutes);

// Catch-all handler to serve the React app for any unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../web/web-react-new/build', 'index.html'));
});

// Socket setup
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

socketSetup(server); // Initialize WebSocket server
