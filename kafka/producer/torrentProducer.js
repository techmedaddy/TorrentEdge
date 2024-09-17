const { Kafka } = require('kafkajs');

const kafka = new Kafka({
    clientId: 'torrentEdge-torrent',
    brokers: ['localhost:9092'] // Update with your actual Kafka broker(s)
});

const producer = kafka.producer();

const produceTorrentMessage = async (message) => {
    await producer.connect();
    await producer.send({
        topic: 'torrent-topic',
        messages: [
            { value: message },
        ],
    });
    await producer.disconnect();
};

module.exports = { produceTorrentMessage };
