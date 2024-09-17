const socketIo = require('socket.io');

module.exports = (server) => {
  const io = socketIo(server);
  io.on('connection', (socket) => {
    console.log('New chat client connected');

    socket.on('chat message', (message) => {
      io.emit('chat message', message);
    });

    socket.on('disconnect', () => {
      console.log('Chat client disconnected');
    });
  });
};
