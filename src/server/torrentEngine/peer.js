const peer = {
    connect: (peerId) => {
        console.log('Connecting to peer:', peerId);
        // Peer connection logic
    },

    sendPiece: (peerId, piece) => {
        console.log('Sending piece to peer:', peerId);
        // Piece transfer logic
    }
};

module.exports = peer;
