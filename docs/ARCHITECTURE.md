# TorrentEdge Architecture

Comprehensive technical documentation for the TorrentEdge BitTorrent client.

## Table of Contents

- [System Overview](#system-overview)
- [Core Components](#core-components)
- [BitTorrent Protocol Implementation](#bittorrent-protocol-implementation)
- [Data Flow](#data-flow)
- [Persistence & State Management](#persistence--state-management)
- [Real-time Events](#real-time-events)
- [Configuration](#configuration)
- [Error Handling](#error-handling)
- [Testing Strategy](#testing-strategy)
- [Performance Considerations](#performance-considerations)
- [Security](#security)
- [Deployment](#deployment)

---

## System Overview

TorrentEdge is a full-stack BitTorrent client featuring:
- Complete BitTorrent protocol implementation
- Multi-torrent queue management
- Real-time progress monitoring via Socket.IO
- Event streaming via Apache Kafka
- State persistence with MongoDB
- Production-ready error handling and recovery

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Layer                              │
│                    (API Clients / WebSocket)                    │
└───────────────┬─────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────┐
│                    Express.js + Socket.IO                       │
│             (REST API + WebSocket Server)                       │
└───────────────┬─────────────────────────────┬───────────────────┘
                │                             │
┌───────────────▼─────────────┐   ┌───────────▼───────────────────┐
│      TorrentEngine          │   │    Kafka Producer             │
│  (Core Orchestration)       │──▶│  (Event Streaming)            │
└───────────────┬─────────────┘   └───────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────┐
│                    Component Layer                              │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│ QueueManager │ StateManager │ PeerManager  │ DownloadManager   │
│ UploadManager│ FileWriter   │ PieceManager │ Throttler         │
│ RetryManager │ BanManager   │ TimeoutMgr   │ TrackerManager    │
└──────────────┴──────────────┴──────────────┴───────────────────┘
                │                             │
┌───────────────▼─────────────┐   ┌───────────▼───────────────────┐
│     Peer Network            │   │     Tracker Network           │
│  (TCP Connections)          │   │  (HTTP/UDP Announces)         │
└─────────────────────────────┘   └───────────────────────────────┘
```

---

## Core Components

### 1. Torrent Engine (`torrentEngine/`)

The central orchestrator for all torrent operations.

#### Responsibilities
- Manage torrent lifecycle (download → seeding → completion)
- Coordinate between components (peers, trackers, disk I/O)
- Emit events for UI updates and analytics
- Handle global error conditions
- Implement recovery strategies

#### Key Classes

**TorrentEngine** (`engine.js`)
- Main entry point for torrent operations
- Manages multiple torrents via `queueManager`
- Provides public API: `addTorrent()`, `removeTorrent()`, `pauseTorrent()`, etc.
- Handles global bandwidth limits

**Torrent** (`torrent.js`)
- Individual torrent state machine
- States: `pending`, `downloading`, `seeding`, `paused`, `error`, `complete`
- Integrates all sub-components
- Implements centralized error handling with categorization

**QueueManager** (`queueManager.js`)
- Multi-torrent scheduling with priorities
- Default: 3 active torrents, unlimited queued
- Priority levels: `high`, `normal`, `low`
- Automatic queue progression

**StateManager** (`stateManager.js`)
- Persists torrent state to disk
- Enables resume on restart
- Backup rotation (keeps last 5 states)
- State file format: JSON with metadata + piece bitfield

---

### 2. BitTorrent Protocol Layer

#### Wire Protocol Implementation

**PeerConnection** (`peerConnection.js`)
- Individual peer TCP connection
- Message types:
  - `choke` / `unchoke`: Upload permission control
  - `interested` / `not interested`: Download interest signaling
  - `have`: Piece availability announcement
  - `bitfield`: Full piece availability bitmap
  - `request`: Piece/block request
  - `piece`: Block data transfer
  - `cancel`: Request cancellation

**Message Flow**
```
Handshake:
  Local → Peer: [protocol][reserved][info_hash][peer_id]
  Peer → Local: [protocol][reserved][info_hash][peer_id]

Extension Handshake (BEP 10):
  Local → Peer: Extended handshake with supported extensions
  Peer → Local: Extended handshake response

Piece Exchange:
  Local → Peer: interested
  Peer → Local: unchoke
  Local → Peer: request [index, offset, length]
  Peer → Local: piece [index, offset, data]
  Local → Peer: have [index]
```

#### Piece Selection Algorithm

**Rarest First** (primary strategy)
```
1. Count piece availability across all peers
2. Select pieces with lowest availability
3. Prioritizes pieces that help swarm most
```

**Random First** (first 4 pieces)
```
1. Download 4 random pieces initially
2. Enables faster "have" announcements
3. Makes client useful to swarm quickly
```

**Endgame Mode** (last 5% of download)
```
1. Activates at 95% completion
2. Request remaining pieces from multiple peers
3. Cancel duplicates when piece arrives
4. Minimizes tail latency
```

**Implementation** (`downloadManager.js`)
```javascript
_selectPiece() {
  // Get rarity map from all peers
  const rarity = this._calculatePieceRarity();
  
  // Filter: needed, not requested, available
  const candidates = this._getAvailablePieces();
  
  if (this.completedPieces < 4) {
    // Random first
    return this._randomPiece(candidates);
  }
  
  if (this.isInEndgame) {
    // Request from multiple peers
    return this._endgamePiece(candidates);
  }
  
  // Rarest first
  return this._rarestPiece(candidates, rarity);
}
```

#### Choking Algorithm (Tit-for-Tat)

**Unchoke Selection** (`uploadManager.js`)
```javascript
// Run every 10 seconds
_unchokeAlgorithm() {
  const peers = this._getPeersByUploadRate();
  
  // Top 4 uploaders
  const topUploaders = peers.slice(0, 4);
  topUploaders.forEach(peer => peer.unchoke());
  
  // Optimistic unchoke (every 30s)
  if (this.optimisticUnchokeTick % 3 === 0) {
    const random = this._randomChokedPeer();
    if (random) random.unchoke();
  }
  
  // Choke the rest
  peers.slice(4).forEach(peer => peer.choke());
}
```

**Super-Seeding Mode**
```javascript
// Advanced seeding strategy
_superSeedingStrategy() {
  // 1. Only advertise one piece per peer
  // 2. Track piece distribution
  // 3. Prioritize rarest pieces
  // 4. Switch to normal seeding at 150% ratio
}
```

---

### 3. Peer Management

#### PeerManager (`peerManager.js`)

**Connection Pooling**
- Max 50 peers per torrent (configurable)
- Max 3 connections per IP address
- Maintains peer health statistics

**Health Tracking**
```javascript
peerHealth = {
  peerId: {
    successCount: 0,
    failureCount: 0,
    averageRTT: 0,
    successRate: 0.0,  // success / (success + failure)
    lastSeen: Date
  }
}
```

**Reconnection Logic**
- Exponential backoff: 5s → 10s → 20s → 40s → 80s → 300s (max)
- Max 5 reconnection attempts per peer
- Skips banned peers
- Prunes peers with <30% success rate

#### Error Management

**RetryManager** (`retryManager.js`)
```javascript
class RetryManager {
  // Tracks retry attempts with exponential backoff
  retryAttempts = new Map();
  
  shouldRetry(key) {
    const attempt = this.retryAttempts.get(key) || 0;
    return attempt < this.maxRetries;
  }
  
  getRetryDelay(key) {
    const attempt = this.retryAttempts.get(key) || 0;
    const delay = Math.min(
      this.baseDelay * Math.pow(2, attempt),
      this.maxDelay
    );
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  }
}
```

**PeerBanManager** (`retryManager.js`)
```javascript
class PeerBanManager {
  // Strike system for peer misbehavior
  strikes = new Map();  // peerId → strike count
  bannedPeers = new Map();  // peerId → ban expiry
  
  strike(peerId, reason) {
    const strikes = (this.strikes.get(peerId) || 0) + 1;
    this.strikes.set(peerId, strikes);
    
    if (strikes >= 3) {
      this.ban(peerId, 3600000);  // 1 hour ban
    }
  }
  
  // Strikes decay over time
  decayStrikes() {
    for (const [peerId, strikes] of this.strikes) {
      this.strikes.set(peerId, Math.max(0, strikes - 1));
    }
  }
}
```

**TimeoutManager** (`retryManager.js`)
```javascript
class TimeoutManager {
  // Adaptive timeout based on RTT
  calculateTimeout(peerId) {
    const stats = this.peerStats.get(peerId);
    if (!stats) return this.defaultTimeout;
    
    // Timeout = 2 * average RTT + variance
    return Math.min(
      2 * stats.averageRTT + stats.rttVariance,
      this.maxTimeout
    );
  }
}
```

---

### 4. Tracker Communication

#### TrackerManager (`tracker.js`)

**Multi-Tracker Support**
- Collects trackers from `announce` and `announceList`
- Automatic failover on errors
- Health state tracking per tracker

**Tracker States**
```javascript
TRACKER_STATE = {
  WORKING: 'working',      // 0 consecutive failures
  WARNING: 'warning',      // 2-4 consecutive failures
  ERROR: 'error'           // 5+ consecutive failures
}
```

**Announce Logic**
```javascript
async announce(event) {
  const trackers = this._getSortedTrackers();  // WORKING → WARNING → ERROR
  
  for (const tracker of trackers) {
    if (!this._shouldRetry(tracker)) continue;
    
    try {
      const peers = await this._announceToTracker(tracker, event);
      this._handleSuccess(tracker);
      return peers;
    } catch (error) {
      this._handleFailure(tracker, error);
      // Try next tracker
    }
  }
  
  throw new Error('All trackers failed');
}
```

**Retry Policy**
- 5xx errors: Retry with exponential backoff
- 4xx errors: Don't retry (client error)
- Network errors: Retry with backoff
- Periodic retry of failed trackers every 5 minutes

---

### 5. Download Management

#### DownloadManager (`downloadManager.js`)

**Piece Retry Logic**
```javascript
// Max 10 retries per piece
_handleFailedPiece(index, peerId) {
  const retry = this.pieceRetries.get(index) || {
    attempts: 0,
    failedPeers: new Set(),
    lastAttempt: Date.now()
  };
  
  retry.attempts++;
  retry.failedPeers.add(peerId);
  
  if (retry.attempts >= this.maxPieceRetries) {
    // Mark as problematic, emit event
    this.problematicPieces.add(index);
    this.emit('piece:problematic', { index, attempts: retry.attempts });
    return;
  }
  
  // Track peer failures per piece (max 3)
  const peerFailures = this._getPeerPieceFailures(peerId);
  if (peerFailures >= 3) {
    this.peerManager.banManager.strike(peerId, 'repeated_piece_failure');
  }
  
  // Re-request from different peer
  this._requestPiece(index, { exclude: retry.failedPeers });
}
```

**Endgame Mode**
```javascript
_checkEndgameMode() {
  const total = this.pieceManager.totalPieces;
  const completed = this.pieceManager.completedPieces;
  
  if (completed / total >= this.endgameThreshold) {
    this.isInEndgame = true;
    this._requestEndgamePieces();
  }
}

_requestEndgamePiece(index) {
  // Request from up to 3 peers
  const peers = this._getHealthyPeersWithPiece(index).slice(0, 3);
  
  peers.forEach(peer => {
    peer.requestPiece(index);
    this.endgameRequests.set(index, peers);
  });
}

_cancelDuplicateEndgameRequests(index) {
  const peers = this.endgameRequests.get(index) || [];
  peers.forEach(peer => peer.cancelPiece(index));
  this.endgameRequests.delete(index);
}
```

---

### 6. Upload Management

#### UploadManager (`uploadManager.js`)

**Choking Implementation**
- Run unchoke algorithm every 10 seconds
- Optimistic unchoke every 30 seconds
- Track upload rates per peer

**Request Queue**
```javascript
handlePieceRequest(peerId, index, offset, length) {
  if (this._isChoked(peerId)) {
    // Queue request for later
    this.requestQueues.get(peerId).push({ index, offset, length });
    return;
  }
  
  // Check if we have the piece
  if (!this.pieceManager.hasPiece(index)) {
    return;
  }
  
  // Apply bandwidth throttling
  if (!this.throttler.consumeUpload(length)) {
    // Queue for later
    this.requestQueues.get(peerId).push({ index, offset, length });
    return;
  }
  
  // Send piece
  const data = this.fileWriter.readBlock(index, offset, length);
  this.peerManager.sendPiece(peerId, index, offset, data);
}
```

---

### 7. Bandwidth Throttling

#### Throttler (`throttler.js`)

**Token Bucket Algorithm**
```javascript
class Throttler {
  constructor(uploadLimit, downloadLimit) {
    this.uploadBucket = new TokenBucket(uploadLimit);
    this.downloadBucket = new TokenBucket(downloadLimit);
  }
  
  consumeUpload(bytes) {
    return this.uploadBucket.consume(bytes);
  }
  
  consumeDownload(bytes) {
    return this.downloadBucket.consume(bytes);
  }
}

class TokenBucket {
  constructor(rate) {
    this.rate = rate;  // bytes per second
    this.capacity = rate;  // 1 second burst
    this.tokens = rate;
    this.lastRefill = Date.now();
  }
  
  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.rate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
  
  consume(tokens) {
    this.refill();
    
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    
    return false;
  }
}
```

---

## Data Flow

### Download Flow

```
1. Parse .torrent or magnet link
   ↓
2. Initialize torrent state
   - Create piece bitfield
   - Load existing state if resuming
   ↓
3. Announce to trackers
   - Get peer list
   - Store peer candidates
   ↓
4. Connect to peers
   - Handshake + extension handshake
   - Exchange bitfields
   ↓
5. Piece selection & request
   - Select piece (rarest-first)
   - Request blocks (16KB each)
   ↓
6. Receive & verify
   - Receive piece blocks
   - Verify SHA1 hash
   ↓
7. Write to disk
   - Handle multi-file alignment
   - Flush buffers
   ↓
8. Announce completion
   - Send "have" to all peers
   - Update tracker
   ↓
9. Continue until complete
   ↓
10. Enter seeding mode
```

### Upload Flow

```
1. Peer connects
   ↓
2. Send bitfield
   - Advertise available pieces
   ↓
3. Peer sends interested
   ↓
4. Apply choking algorithm
   - Unchoke if top uploader
   ↓
5. Peer requests piece
   ↓
6. Check bandwidth limit
   - Token bucket throttling
   ↓
7. Read from disk
   ↓
8. Send piece to peer
   ↓
9. Update statistics
   - Track upload rate
   - Update unchoke ranking
```

---

## Persistence & State Management

### State File Format

```json
{
  "version": "1.0",
  "infoHash": "abc123...",
  "name": "ubuntu-20.04.iso",
  "totalSize": 2097152000,
  "pieceLength": 262144,
  "totalPieces": 8000,
  "completedPieces": 4523,
  "bitfield": "base64_encoded_bitfield",
  "downloadedBytes": 1186037760,
  "uploadedBytes": 524288000,
  "peers": [
    { "ip": "1.2.3.4", "port": 6881, "lastSeen": 1234567890 }
  ],
  "trackers": [
    {
      "url": "http://tracker.example.com:8080/announce",
      "state": "working",
      "lastAnnounce": 1234567890
    }
  ],
  "files": [
    {
      "path": "ubuntu-20.04.iso",
      "length": 2097152000,
      "offset": 0
    }
  ],
  "createdAt": 1234567890,
  "lastModified": 1234567900
}
```

### Backup Strategy

```javascript
// StateManager saves state every 30 seconds
async saveState(torrent) {
  const state = this._serializeState(torrent);
  const stateFile = path.join(this.statePath, `${torrent.infoHash}.json`);
  
  // Atomic write with temp file
  const tempFile = `${stateFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
  await fs.rename(tempFile, stateFile);
  
  // Rotate backups (keep last 5)
  await this._rotateBackups(torrent.infoHash);
}
```

---

## Real-time Events

### Socket.IO Event Schema

**Torrent Events**
```javascript
// Progress update (emitted every second)
socket.emit('torrent:progress', {
  infoHash: 'abc123...',
  name: 'ubuntu.iso',
  percentage: 45.6,
  downloadSpeed: 1048576,  // bytes/sec
  uploadSpeed: 524288,
  downloaded: 957349888,
  uploaded: 239534080,
  remaining: 1139802112,
  eta: 1087,  // seconds
  peers: {
    connected: 23,
    total: 45
  },
  ratio: 0.25,
  state: 'downloading'
});

// Piece completed
socket.emit('torrent:piece', {
  infoHash: 'abc123...',
  index: 152,
  completedPieces: 153,
  totalPieces: 8000
});

// Torrent complete
socket.emit('torrent:complete', {
  infoHash: 'abc123...',
  name: 'ubuntu.iso',
  totalSize: 2097152000,
  downloadTime: 3600,  // seconds
  averageSpeed: 582542
});

// Error occurred
socket.emit('torrent:error', {
  infoHash: 'abc123...',
  category: 'VERIFICATION',
  code: 'hash_mismatch',
  message: 'Piece 152 failed verification',
  recoverable: true,
  action: 'retry'
});
```

### Kafka Topics

**torrent-updates**
```json
{
  "type": "progress",
  "infoHash": "abc123...",
  "timestamp": 1234567890,
  "data": {
    "percentage": 45.6,
    "downloadSpeed": 1048576,
    "uploadSpeed": 524288
  }
}
```

**peer-events**
```json
{
  "type": "peer_connected",
  "infoHash": "abc123...",
  "peerId": "xyz789...",
  "ip": "1.2.3.4",
  "port": 6881,
  "timestamp": 1234567890
}
```

---

## Configuration

### Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Database
MONGODB_URI=mongodb://localhost:27017/torrentedge
REDIS_HOST=localhost
REDIS_PORT=6379

# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=torrentedge

# Authentication
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=7d

# Torrent Engine
DOWNLOAD_PATH=./downloads
MAX_CONCURRENT_TORRENTS=3
MAX_PEER_CONNECTIONS=50
PIECE_LENGTH=262144
BLOCK_LENGTH=16384

# Bandwidth Limits (0 = unlimited)
UPLOAD_LIMIT=0
DOWNLOAD_LIMIT=0

# Seeding
SEED_RATIO_LIMIT=2.0
SEED_TIME_LIMIT=0

# State Management
AUTO_RESUME=true
VERIFY_ON_RESUME=false
STATE_SAVE_INTERVAL=30000

# Error Handling
MAX_PIECE_RETRIES=10
MAX_PEER_FAILURES_PER_PIECE=3
PEER_RECONNECT_DELAY=5000
PEER_BAN_DURATION=3600000
```

### Tuning Parameters

**For High-Bandwidth Connections**
```javascript
{
  maxConcurrent: 10,
  maxConnections: 100,
  uploadLimit: 10 * 1024 * 1024,  // 10 MB/s
  downloadLimit: 50 * 1024 * 1024  // 50 MB/s
}
```

**For Low-Memory Environments**
```javascript
{
  maxConcurrent: 1,
  maxConnections: 20,
  pieceBufferSize: 5,  // Buffer 5 pieces max
  verifyOnResume: false
}
```

**For Fast Seeding**
```javascript
{
  superSeeding: true,
  optimisticUnchokeInterval: 15000,  // 15s
  seedRatioLimit: 0,  // Seed forever
  uploadLimit: 0  // Unlimited upload
}
```

---

## Error Handling

### Error Categories

```javascript
const ERROR_CATEGORY = {
  TRACKER: 'tracker',          // Tracker communication
  PEER: 'peer',                // Peer protocol
  FILESYSTEM: 'filesystem',    // Disk I/O
  PROTOCOL: 'protocol',        // BitTorrent protocol
  VERIFICATION: 'verification', // Hash mismatch
  METADATA: 'metadata'         // Torrent parsing
};
```

### Error Event Structure

```javascript
{
  category: 'VERIFICATION',
  code: 'hash_mismatch',
  message: 'Piece 152 failed SHA1 verification',
  details: {
    index: 152,
    expected: 'abc123...',
    received: 'def456...'
  },
  recoverable: true,
  action: 'retry',
  timestamp: 1234567890
}
```

### Recovery Actions

| Category | Action | Strategy |
|----------|--------|----------|
| TRACKER | `retry` | Try next tracker, exponential backoff |
| PEER | `skip` | Disconnect peer, try another |
| FILESYSTEM | `pause` | Pause torrent, alert user |
| PROTOCOL | `skip` | Disconnect peer, ban if repeated |
| VERIFICATION | `retry` | Re-request piece (max 10 times) |
| METADATA | `abort` | Stop torrent, cannot continue |

### Retry Strategy

**Exponential Backoff with Jitter**
```javascript
function getRetryDelay(attempt) {
  const baseDelay = 2000;  // 2 seconds
  const maxDelay = 300000;  // 5 minutes
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * 1000;  // 0-1 second
  return delay + jitter;
}

// Attempt 0: 2-3 seconds
// Attempt 1: 4-5 seconds
// Attempt 2: 8-9 seconds
// Attempt 3: 16-17 seconds
// Attempt 4+: 300-301 seconds
```

---

## Testing Strategy

### Unit Tests

**Component Testing**
```javascript
describe('PieceManager', () => {
  it('should verify piece with correct hash', () => {
    const piece = Buffer.from('test data');
    const hash = crypto.createHash('sha1').update(piece).digest();
    
    expect(pieceManager.verify(piece, hash)).toBe(true);
  });
  
  it('should reject piece with incorrect hash', () => {
    const piece = Buffer.from('test data');
    const wrongHash = Buffer.alloc(20).fill(0);
    
    expect(pieceManager.verify(piece, wrongHash)).toBe(false);
  });
});
```

### Integration Tests

**End-to-End Flow**
```javascript
describe('Download Flow', () => {
  it('should download complete torrent', async () => {
    const engine = new TorrentEngine();
    const torrent = await engine.addTorrent('./test.torrent');
    
    // Wait for completion
    await new Promise(resolve => {
      torrent.on('complete', resolve);
    });
    
    expect(torrent.progress).toBe(100);
    expect(torrent.state).toBe('seeding');
  });
});
```

### Performance Tests

**Load Testing**
```javascript
describe('Performance', () => {
  it('should handle 100 concurrent torrents', async () => {
    const engine = new TorrentEngine({ maxConcurrent: 100 });
    const torrents = Array(100).fill(null).map(() => 
      engine.addTorrent(generateTestTorrent())
    );
    
    await Promise.all(torrents);
    
    const stats = engine.getStats();
    expect(stats.memoryUsage).toBeLessThan(2 * 1024 * 1024 * 1024);  // < 2GB
  });
});
```

---

## Performance Considerations

### Memory Management

**Piece Buffering**
- Buffer max 10 in-flight pieces per torrent
- Flush to disk immediately after verification
- Use streams for large files (>1GB)

**Connection Pooling**
- Reuse TCP connections
- Close idle connections after 2 minutes
- Limit total connections across all torrents

### Disk I/O Optimization

**Write Strategies**
```javascript
// Buffered writes (default)
fileWriter.write(index, data, { buffered: true });

// Direct writes (for SSDs)
fileWriter.write(index, data, { 
  buffered: false,
  flush: true 
});

// Batch writes
fileWriter.batchWrite([
  { index: 0, data: buffer0 },
  { index: 1, data: buffer1 }
]);
```

**File Allocation**
- Pre-allocate files on start (prevents fragmentation)
- Use sparse files on supported filesystems
- Align writes to piece boundaries

### Network Optimization

**Connection Management**
- Keep-alive on TCP connections
- Nagle's algorithm disabled for low latency
- TCP_NODELAY enabled

**Message Batching**
- Batch "have" messages (send every 100 pieces)
- Coalesce piece requests
- Pipeline requests (5-10 in flight per peer)

---

## Security

### Authentication & Authorization

**JWT-based Authentication**
```javascript
// Generate token
const token = jwt.sign(
  { userId: user._id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

// Verify token
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};
```

### Input Validation

**Torrent File Validation**
```javascript
function validateTorrent(data) {
  // Check bencode structure
  const decoded = bencode.decode(data);
  
  // Required fields
  if (!decoded.info) throw new Error('Missing info dict');
  if (!decoded.info.name) throw new Error('Missing name');
  if (!decoded.info.pieces) throw new Error('Missing pieces');
  
  // Hash validation
  const pieceLength = decoded.info['piece length'];
  const piecesBuffer = decoded.info.pieces;
  if (piecesBuffer.length % 20 !== 0) {
    throw new Error('Invalid pieces length');
  }
  
  return decoded;
}
```

### Peer Security

**IP Filtering**
- Block private IP ranges (10.x, 192.168.x, 127.x)
- Rate limit connections per IP
- Ban IPs after repeated failures

**Protocol Validation**
- Validate all incoming messages
- Enforce message size limits
- Timeout inactive connections

---

## Deployment

### Docker Compose Setup

```yaml
version: '3.8'

services:
  torrentedge:
    build: ./src/server
    ports:
      - "3000:3000"
      - "6881:6881"  # BitTorrent port
    environment:
      - MONGODB_URI=mongodb://mongo:27017/torrentedge
      - REDIS_HOST=redis
      - KAFKA_BROKERS=kafka:9092
    volumes:
      - ./downloads:/app/downloads
      - ./state:/app/state
    depends_on:
      - mongo
      - redis
      - kafka
  
  mongo:
    image: mongo:5
    volumes:
      - mongo-data:/data/db
  
  redis:
    image: redis:7-alpine
  
  kafka:
    image: confluentinc/cp-kafka:latest
    depends_on:
      - zookeeper
  
  zookeeper:
    image: confluentinc/cp-zookeeper:latest
```

### Scaling Strategy

**Horizontal Scaling**
```
┌──────────────┐
│ Load Balancer │
└──────┬───────┘
       │
   ┌───┴───┬───────┬────────┐
   │       │       │        │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐  ┌──▼──┐
│ API │ │ API │ │ API │  │ API │
│  1  │ │  2  │ │  3  │  │  4  │
└─────┘ └─────┘ └─────┘  └─────┘
   │       │       │        │
   └───────┴───┬───┴────────┘
               │
        ┌──────▼───────┐
        │ Shared State │
        │  (MongoDB)   │
        └──────────────┘
```

**Socket.IO Scaling** (Redis Adapter)
```javascript
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const io = new Server(server);

const pubClient = createClient({ host: 'redis', port: 6379 });
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));
```

---

## Future Improvements

### 1. DHT (Distributed Hash Table)
- Implement Kademlia DHT (BEP 5)
- Enable trackerless operation
- Improve peer discovery

### 2. WebRTC Support
- Browser-based peers (WebTorrent compatibility)
- Hybrid protocol support
- STUN/TURN server integration

### 3. Selective Download
- File priority system
- Skip unwanted files
- Partial torrent completion

### 4. Streaming Support
- Sequential piece selection
- Piece prioritization
- HTTP streaming interface

### 5. Advanced Features
- IPv6 support
- UPnP port mapping
- NAT traversal
- Encryption (BEP 52)
- PEX (Peer Exchange, BEP 11)

---

**For questions or contributions, see the main [README.md](../README.md).**
