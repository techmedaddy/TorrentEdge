// src/server/socket.js

const socketIO = require('socket.io');

module.exports = function(server) {
  const io = socketIO(server, {
    cors: {
      origin: "http://localhost", // Adjust based on your frontend's URL
      methods: ["GET", "POST"]
    }
  });
  
  io.on('connection', (socket) => {
    console.log('New client connected');
    
    // Handle custom events here
    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
};
