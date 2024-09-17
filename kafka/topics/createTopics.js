const { Kafka } = require('kafkajs');
const topicConfig = require('./topicConfig.json');

const kafka = new Kafka({
    clientId: 'torrentEdge-admin',
    brokers: ['localhost:9092'] // Update with your actual Kafka broker(s)
});

const admin = kafka.admin();

const run = async () => {
    await admin.connect();
    
    await admin.createTopics({
        topics: topicConfig,
    });
    
    await admin.disconnect();
    console.log('Topics created successfully');
};

run().catch(console.error);
