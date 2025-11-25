const { Kafka } = require('kafkajs');

const kafka = new Kafka({
    clientId: 'torrentEdge-peer',
    brokers: ['localhost:9092'] // Update with your actual Kafka broker(s)
});

const producer = kafka.producer();

const producePeerMessage = async (message) => {
    await producer.connect();
    await producer.send({
        topic: 'peer-topic',
        messages: [
            { value: message },
        ],
    });
    await producer.disconnect();
};

module.exports = { producePeerMessage };
