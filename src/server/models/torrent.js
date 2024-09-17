const mongoose = require('mongoose');

const torrentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    size: {
        type: Number,
        required: true
    },
    seeds: {
        type: Number,
        default: 0
    },
    leeches: {
        type: Number,
        default: 0
    },
    addedAt: {
        type: Date,
        default: Date.now
    }
});

const Torrent = mongoose.model('Torrent', torrentSchema);

module.exports = Torrent;
