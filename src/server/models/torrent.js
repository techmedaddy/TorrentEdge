const mongoose = require('mongoose');

const torrentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  infoHash: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    match: /^[a-f0-9]{40}$/  // 40-char hex SHA1 hash
  },
  magnetURI: {
    type: String,
    trim: true
  },
  size: {
    type: Number,
    required: true,
    min: 0
  },
  seeds: {
    type: Number,
    default: 0,
    min: 0
  },
  leeches: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'downloading', 'seeding', 'paused', 'error', 'completed', 'fetching_metadata', 'idle', 'checking', 'queued'],
    default: 'pending'
  },
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  downloadSpeed: {
    type: Number,
    default: 0
  },
  uploadSpeed: {
    type: Number,
    default: 0
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  files: [{
    name: String,
    size: Number,
    path: String
  }],
  trackers: [String],
  addedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true
});

// Indexes for efficient queries
torrentSchema.index({ name: 'text' });  // Text search on name
torrentSchema.index({ infoHash: 1 }, { unique: true });
torrentSchema.index({ uploadedBy: 1 });
torrentSchema.index({ status: 1 });
torrentSchema.index({ addedAt: -1 });  // Recent torrents first

module.exports = mongoose.model('Torrent', torrentSchema);
