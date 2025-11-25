const kafkaController = require('../api/kafkaController');

const kafkaProducer = {
    sendTorrentUpdate: (message) => {
        kafkaController.produceMessage('torrent-updates', message);
    }
};

module.exports = kafkaProducer;
