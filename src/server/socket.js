const socketIo = require('socket.io');

module.exports = (server) => {
  const io = socketIo(server);
  io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
};
