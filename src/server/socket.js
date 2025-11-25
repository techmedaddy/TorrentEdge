const socketIO = require('socket.io');

module.exports = function (server) {
  const io = socketIO(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:3001",
      methods: ["GET", "POST"],
    },
  });

  io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
};
