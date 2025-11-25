const { Kafka } = require('kafkajs');

const kafka = new Kafka({
    clientId: 'torrentEdge-peer',
    brokers: ['localhost:9092'] // Update with your actual Kafka broker(s)
});

const consumer = kafka.consumer({ groupId: 'peer-group' });

const run = async () => {
    await consumer.connect();
    await consumer.subscribe({ topic: 'peer-topic', fromBeginning: true });

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            console.log({
                value: message.value.toString(),
            });
            // Handle peer-related message processing here
        },
    });
};

run().catch(console.error);

module.exports = consumer;
