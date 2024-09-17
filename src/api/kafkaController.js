const kafka = require('kafka-node');

const kafkaClient = new kafka.KafkaClient({ kafkaHost: 'localhost:9092' });
const producer = new kafka.Producer(kafkaClient);

const kafkaController = {
    produceMessage: (topic, message) => {
        const payloads = [{ topic, messages: message }];
        producer.send(payloads, (err, data) => {
            if (err) {
                console.error('Error sending message to Kafka:', err);
            } else {
                console.log('Message sent successfully:', data);
            }
        });
    },

    consumeMessage: (topic, callback) => {
        const consumer = new kafka.Consumer(kafkaClient, [{ topic, partition: 0 }], { autoCommit: true });
        consumer.on('message', (message) => {
            callback(message);
        });
    }
};

module.exports = kafkaController;
