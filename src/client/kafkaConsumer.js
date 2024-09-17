const kafkaController = require('../api/kafkaController');

const kafkaConsumer = {
    listenForUpdates: () => {
        kafkaController.consumeMessage('torrent-updates', (message) => {
            console.log('Received torrent update:', message);
        });
    }
};

module.exports = kafkaConsumer;
