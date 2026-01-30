const socketIO = require('socket.io');

// Store the initialized Socket.IO instance
let io = null;

// Store connected sockets for management
const connectedSockets = new Map();

// Throttle state for progress updates
const progressThrottle = new Map(); // infoHash -> { lastUpdate, pendingData, timer }
const PROGRESS_THROTTLE_MS = 500; // Max 2 updates per second

/**
 * Initialize Socket.IO server
 * @param {http.Server} server - HTTP server instance
 * @returns {SocketIO.Server} Socket.IO instance
 */
function initializeSocket(server) {
  if (io) {
    console.log('[Socket] Already initialized');
    return io;
  }

  console.log('[Socket] Initializing Socket.IO server...');

  io = socketIO(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Handle new connections
  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    connectedSockets.set(socket.id, socket);

    // Send connection confirmation
    socket.emit('connected', {
      socketId: socket.id,
      timestamp: Date.now()
    });

    // Handle torrent subscription
    socket.on('subscribe:torrent', (data) => {
      const { infoHash } = data;
      if (!infoHash) {
        console.warn(`[Socket] ${socket.id} tried to subscribe without infoHash`);
        return;
      }

      const room = `torrent:${infoHash}`;
      socket.join(room);
      console.log(`[Socket] ${socket.id} subscribed to torrent ${infoHash.substring(0, 8)}...`);

      socket.emit('subscribed', {
        infoHash,
        room,
        timestamp: Date.now()
      });
    });

    // Handle torrent unsubscription
    socket.on('unsubscribe:torrent', (data) => {
      const { infoHash } = data;
      if (!infoHash) {
        console.warn(`[Socket] ${socket.id} tried to unsubscribe without infoHash`);
        return;
      }

      const room = `torrent:${infoHash}`;
      socket.leave(room);
      console.log(`[Socket] ${socket.id} unsubscribed from torrent ${infoHash.substring(0, 8)}...`);

      socket.emit('unsubscribed', {
        infoHash,
        room,
        timestamp: Date.now()
      });
    });

    // Handle subscription to all torrents (dashboard view)
    socket.on('subscribe:all', () => {
      socket.join('all');
      console.log(`[Socket] ${socket.id} subscribed to all torrents`);

      socket.emit('subscribed', {
        room: 'all',
        timestamp: Date.now()
      });
    });

    // Handle unsubscription from all torrents
    socket.on('unsubscribe:all', () => {
      socket.leave('all');
      console.log(`[Socket] ${socket.id} unsubscribed from all torrents`);

      socket.emit('unsubscribed', {
        room: 'all',
        timestamp: Date.now()
      });
    });

    // Handle ping for connection testing
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} (reason: ${reason})`);
      connectedSockets.delete(socket.id);

      // Clean up any throttle timers for this socket
      // (They'll clean themselves up naturally, but we can log it)
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`[Socket] Socket error for ${socket.id}:`, error);
    });
  });

  console.log('[Socket] Socket.IO server initialized');
  return io;
}

/**
 * Get the initialized Socket.IO instance
 * @returns {SocketIO.Server} Socket.IO instance
 * @throws {Error} If Socket.IO is not initialized
 */
function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocket() first.');
  }
  return io;
}

/**
 * Emit event to a specific torrent's room and the 'all' room
 * @param {string} infoHash - Torrent info hash
 * @param {string} event - Event name
 * @param {object} data - Event data
 */
function emitToTorrent(infoHash, event, data) {
  if (!io) {
    console.warn('[Socket] Cannot emit: Socket.IO not initialized');
    return;
  }

  const room = `torrent:${infoHash}`;
  const payload = {
    ...data,
    infoHash,
    timestamp: Date.now()
  };

  // Emit to the torrent's specific room
  io.to(room).emit(event, payload);

  // Also emit to 'all' room for dashboard view
  io.to('all').emit(event, payload);

  // Log only for non-progress events (progress is too verbose)
  if (event !== 'torrent:progress') {
    console.log(`[Socket] Emitted '${event}' to ${infoHash.substring(0, 8)}...`);
  }
}

/**
 * Emit progress update with throttling
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Progress data
 */
function emitProgress(infoHash, data) {
  if (!io) {
    return;
  }

  // Get or create throttle state
  let throttleState = progressThrottle.get(infoHash);

  if (!throttleState) {
    throttleState = {
      lastUpdate: 0,
      pendingData: null,
      timer: null
    };
    progressThrottle.set(infoHash, throttleState);
  }

  const now = Date.now();
  const timeSinceLastUpdate = now - throttleState.lastUpdate;

  // If enough time has passed, emit immediately
  if (timeSinceLastUpdate >= PROGRESS_THROTTLE_MS) {
    emitToTorrent(infoHash, 'torrent:progress', data);
    throttleState.lastUpdate = now;
    throttleState.pendingData = null;

    // Clear any pending timer
    if (throttleState.timer) {
      clearTimeout(throttleState.timer);
      throttleState.timer = null;
    }
  } else {
    // Store the latest data and schedule emission
    throttleState.pendingData = data;

    // Only schedule if not already scheduled
    if (!throttleState.timer) {
      const delay = PROGRESS_THROTTLE_MS - timeSinceLastUpdate;
      throttleState.timer = setTimeout(() => {
        if (throttleState.pendingData) {
          emitToTorrent(infoHash, 'torrent:progress', throttleState.pendingData);
          throttleState.lastUpdate = Date.now();
          throttleState.pendingData = null;
        }
        throttleState.timer = null;
      }, delay);
    }
  }
}

/**
 * Emit torrent added event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Torrent data
 */
function emitTorrentAdded(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:added', data);
}

/**
 * Emit torrent started event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Torrent data
 */
function emitTorrentStarted(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:started', data);
}

/**
 * Emit piece completed event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Piece data
 */
function emitPieceCompleted(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:piece', data);
}

/**
 * Emit torrent completed event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Completion data
 */
function emitTorrentCompleted(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:completed', data);
  
  // Clean up throttle state
  const throttleState = progressThrottle.get(infoHash);
  if (throttleState?.timer) {
    clearTimeout(throttleState.timer);
  }
  progressThrottle.delete(infoHash);
}

/**
 * Emit torrent error event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Error data
 */
function emitTorrentError(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:error', data);
}

/**
 * Emit torrent paused event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Torrent data
 */
function emitTorrentPaused(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:paused', data);
}

/**
 * Emit torrent resumed event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Torrent data
 */
function emitTorrentResumed(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:resumed', data);
}

/**
 * Emit torrent removed event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Torrent data
 */
function emitTorrentRemoved(infoHash, data) {
  emitToTorrent(infoHash, 'torrent:removed', data);
  
  // Clean up throttle state
  const throttleState = progressThrottle.get(infoHash);
  if (throttleState?.timer) {
    clearTimeout(throttleState.timer);
  }
  progressThrottle.delete(infoHash);
}

/**
 * Emit peer connected event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Peer data
 */
function emitPeerConnected(infoHash, data) {
  emitToTorrent(infoHash, 'peer:connected', data);
}

/**
 * Emit peer disconnected event
 * @param {string} infoHash - Torrent info hash
 * @param {object} data - Peer data
 */
function emitPeerDisconnected(infoHash, data) {
  emitToTorrent(infoHash, 'peer:disconnected', data);
}

/**
 * Get count of connected clients
 * @returns {number} Number of connected clients
 */
function getConnectedClientCount() {
  return connectedSockets.size;
}

/**
 * Broadcast to all connected clients
 * @param {string} event - Event name
 * @param {object} data - Event data
 */
function broadcast(event, data) {
  if (!io) {
    console.warn('[Socket] Cannot broadcast: Socket.IO not initialized');
    return;
  }

  io.emit(event, {
    ...data,
    timestamp: Date.now()
  });

  // Don't log speed updates (too verbose)
  if (event !== 'stats:speed') {
    console.log(`[Socket] Broadcasted '${event}' to all clients`);
  }
}

/**
 * Emit global speed update (for live speed graph)
 * @param {object} data - { downloadSpeed, uploadSpeed, timestamp }
 */
function emitSpeedUpdate(data) {
  if (!io) {
    return;
  }

  io.to('all').emit('stats:speed', {
    downloadSpeed: data.downloadSpeed || 0,
    uploadSpeed: data.uploadSpeed || 0,
    timestamp: data.timestamp || Date.now()
  });
}

/**
 * Clean up resources
 */
function cleanup() {
  console.log('[Socket] Cleaning up...');

  // Clear all throttle timers
  for (const [infoHash, state] of progressThrottle.entries()) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
  progressThrottle.clear();

  // Disconnect all sockets
  for (const socket of connectedSockets.values()) {
    socket.disconnect(true);
  }
  connectedSockets.clear();

  // Close Socket.IO server
  if (io) {
    io.close();
    io = null;
  }

  console.log('[Socket] Cleanup complete');
}

module.exports = {
  initializeSocket,
  getIO,
  emitToTorrent,
  emitProgress,
  emitTorrentAdded,
  emitTorrentStarted,
  emitPieceCompleted,
  emitTorrentCompleted,
  emitTorrentError,
  emitTorrentPaused,
  emitTorrentResumed,
  emitTorrentRemoved,
  emitPeerConnected,
  emitPeerDisconnected,
  emitSpeedUpdate,
  getConnectedClientCount,
  broadcast,
  cleanup
};
