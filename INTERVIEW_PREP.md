# TorrentEdge — Interview Preparation & Pitch Guide

> **Complete Backend Documentation for Interview Pitching**

---

## Table of Contents

1. [Project Overview & Elevator Pitch](#1-project-overview--elevator-pitch)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Components Deep Dive](#3-core-components-deep-dive)
4. [BitTorrent Protocol Implementation](#4-bittorrent-protocol-implementation)
5. [API Design & Backend-Frontend Communication](#5-api-design--backend-frontend-communication)
6. [Real-Time Communication (WebSockets)](#6-real-time-communication-websockets)
7. [Database Design](#7-database-design)
8. [Advanced Features](#8-advanced-features)
9. [System Design Decisions & Trade-offs](#9-system-design-decisions--trade-offs)
10. [Scalability & Performance](#10-scalability--performance)
11. [Security Considerations](#11-security-considerations)
12. [Interview Questions & Answers](#12-interview-questions--answers)
13. [Technical Deep Dives (Talking Points)](#13-technical-deep-dives-talking-points)

---

## 1. Project Overview & Elevator Pitch

### One-Liner
> "TorrentEdge is a full-stack BitTorrent client with a custom-built torrent engine from scratch — no libraries like WebTorrent or libtorrent — implementing BEP-3 protocol, DHT peer discovery, real-time WebSocket updates, and multi-user support."

### 30-Second Pitch
> "I built TorrentEdge as a complete BitTorrent client where I implemented the entire torrent engine from the ground up. This means I wrote the bencode parser, the tracker announce protocol, the peer wire protocol, piece management with SHA1 verification, DHT for decentralized peer discovery, and even a torrent creator that generates valid .torrent files from any file. The backend uses Node.js with Express, MongoDB for persistence, and Socket.IO for real-time progress updates. The frontend communicates via REST APIs for CRUD operations and WebSockets for live stats like download speed, peer connections, and progress updates."

### What Makes It Impressive
1. **From-scratch protocol implementation** — Not using existing torrent libraries
2. **Full BEP-3 compliance** — Implements the actual BitTorrent specification
3. **Real P2P networking** — TCP connections, handshakes, piece exchanges
4. **Production-ready architecture** — Queue management, state persistence, graceful shutdown
5. **Multi-user support** — Seeders and leechers with proper access control

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React/Vite)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  Dashboard  │  │ Add Torrent │  │   Detail    │  │  Settings   │ │
│  │   (list)    │  │   Modal     │  │    View     │  │    Page     │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │        │
│         └────────────────┴────────────────┴────────────────┘        │
│                                   │                                  │
│                    ┌──────────────┴──────────────┐                  │
│                    │      api.ts (services)      │                  │
│                    │  REST calls + WebSocket     │                  │
│                    └──────────────┬──────────────┘                  │
└───────────────────────────────────┼─────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │       HTTP + WebSocket        │
                    │    (REST API + Socket.IO)     │
                    └───────────────┬───────────────┘
                                    │
┌───────────────────────────────────┼─────────────────────────────────┐
│                         BACKEND (Node.js/Express)                    │
│                                   │                                  │
│  ┌────────────────────────────────┴────────────────────────────────┐│
│  │                         server.js                                ││
│  │              (Express app + HTTP server + startup)               ││
│  └──────────────────────────────────────────────────────────────────┘│
│         │                    │                    │                  │
│  ┌──────┴──────┐     ┌───────┴───────┐    ┌──────┴──────┐          │
│  │   Routes    │     │   Socket.IO   │    │  Middleware │          │
│  │ /api/torrent│     │   (socket.js) │    │    (auth)   │          │
│  │ /api/auth   │     │               │    │             │          │
│  │ /api/stats  │     │  Real-time    │    │  JWT verify │          │
│  └──────┬──────┘     │  events       │    └─────────────┘          │
│         │            └───────┬───────┘                              │
│  ┌──────┴──────┐             │                                      │
│  │ Controllers │             │                                      │
│  │             │◄────────────┘                                      │
│  │ torrent     │                                                    │
│  │ Controller  │                                                    │
│  └──────┬──────┘                                                    │
│         │                                                           │
│  ┌──────┴──────────────────────────────────────────────────────────┐│
│  │                      TORRENT ENGINE                              ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              ││
│  │  │   engine.js │  │  torrent.js │  │  tracker.js │              ││
│  │  │  (manager)  │  │ (per-torr)  │  │ (announce)  │              ││
│  │  └──────┬──────┘  └──────┬──────┘  └─────────────┘              ││
│  │         │                │                                       ││
│  │  ┌──────┴──────┐  ┌──────┴──────┐  ┌─────────────┐              ││
│  │  │ QueueMgr   │  │DownloadMgr │  │  PeerMgr    │              ││
│  │  │ (slots)    │  │ (pieces)   │  │ (TCP conn)  │              ││
│  │  └────────────┘  └────────────┘  └─────────────┘              ││
│  │                                                                  ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              ││
│  │  │ FileWriter  │  │ PieceManager│  │    DHT      │              ││
│  │  │ (disk I/O)  │  │ (verify)    │  │   Node      │              ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘              ││
│  │                                                                  ││
│  │  ┌─────────────┐  ┌─────────────┐                               ││
│  │  │TorrentCreator│ │UploadManager│                               ││
│  │  │(.torrent gen)│ │ (seeding)   │                               ││
│  │  └─────────────┘  └─────────────┘                               ││
│  └──────────────────────────────────────────────────────────────────┘│
│         │                                                            │
│  ┌──────┴──────┐     ┌─────────────┐                                │
│  │  MongoDB    │     │   Kafka     │                                │
│  │  (persist)  │     │ (optional)  │                                │
│  └─────────────┘     └─────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React + TypeScript + Vite | UI, state management |
| API | REST (Express) | CRUD operations |
| Real-time | Socket.IO | Live progress, speed updates |
| Backend | Node.js + Express | Server, routing, business logic |
| Database | MongoDB + Mongoose | Persistence, user data |
| Protocol | Custom BitTorrent Engine | P2P file transfer |
| Events | Kafka (optional) | Event streaming for analytics |

---

## 3. Core Components Deep Dive

### 3.1 Torrent Engine (`engine.js`)

The engine is the central orchestrator managing all torrents.

```javascript
class TorrentEngine extends EventEmitter {
  constructor(options = {}) {
    this.downloadPath = options.downloadPath || './downloads';
    this.torrents = new Map();           // infoHash -> Torrent
    this._queueManager = new QueueManager();  // Controls concurrent downloads
    this._stateManager = new StateManager();  // Persistence
    this._dht = new DHTNode();           // Decentralized peer discovery
  }
}
```

**Key Methods:**
- `addTorrent(options)` — Add torrent from file/magnet/buffer
- `removeTorrent(infoHash, deleteFiles)` — Stop and remove
- `seedFromFile(options)` — Create torrent and seed immediately
- `announceAsSeeder(options)` — Register with trackers as seeder

**Why EventEmitter?**
- Decoupled architecture: UI doesn't block on torrent operations
- Multiple listeners can react to same event
- Standard Node.js pattern for async operations

### 3.2 Individual Torrent (`torrent.js`)

Each torrent is a self-contained download/upload unit.

```javascript
class Torrent extends EventEmitter {
  constructor(options) {
    this._metadata = null;        // Parsed .torrent info
    this._peerManager = null;     // Manages peer connections
    this._downloadManager = null; // Piece download orchestration
    this._fileWriter = null;      // Disk I/O
    this._uploadManager = null;   // Serving pieces to peers
    this._state = 'idle';         // idle|downloading|seeding|paused|error
  }
}
```

**State Machine:**
```
idle → downloading → seeding
  ↓         ↓
paused ← paused
  ↓
error
```

### 3.3 Peer Manager (`peerManager.js`)

Handles TCP connections to other BitTorrent clients.

```javascript
class PeerManager extends EventEmitter {
  constructor(options) {
    this.peerPool = [];           // Discovered peers to connect
    this.activeConnections = new Map();  // Connected peers
    this.pieceAvailability = [];  // Which pieces each peer has
    this.maxConnections = 50;     // Connection limit
  }
}
```

**Features:**
- Connection pooling and rate limiting
- Peer health tracking (success rate, RTT)
- Automatic ban for misbehaving peers
- IP-based connection limiting (anti-abuse)

### 3.4 Download Manager (`downloadManager.js`)

Orchestrates downloading pieces from multiple peers.

```javascript
class DownloadManager extends EventEmitter {
  constructor(options) {
    this.pieces = [];              // All pieces
    this.completedPieces = new Set();
    this.activePieces = new Map(); // Currently downloading
    this.pendingRequests = new Map();
  }
}
```

**Piece Selection Algorithm: Rarest First**
```javascript
selectNextPiece() {
  const needed = [];
  for (let i = 0; i < this.pieces.length; i++) {
    if (!this.completedPieces.has(i) && !this.activePieces.has(i)) {
      const availability = this.peerManager.pieceAvailability[i];
      if (availability > 0) {
        needed.push({ index: i, availability });
      }
    }
  }
  // Sort by availability (ascending) — rarest first
  needed.sort((a, b) => a.availability - b.availability);
  return needed[0]?.index ?? null;
}
```

**Why Rarest First?**
- Improves swarm health
- Ensures rare pieces don't become extinct
- Standard BitTorrent strategy from BEP-3

### 3.5 Torrent Creator (`torrentCreator.js`)

Creates valid .torrent files from any file.

```javascript
function createTorrent(fileBuffer, options) {
  // 1. Hash pieces (SHA1, typically 256KB each)
  const piecesBuffer = hashPieces(fileBuffer, pieceSize);
  
  // 2. Build info dict (BEP-3 compliant)
  const info = {
    name: options.name,
    length: fileBuffer.length,
    'piece length': pieceSize,
    pieces: piecesBuffer  // Concatenated SHA1 hashes
  };
  
  // 3. Calculate infoHash (SHA1 of bencoded info)
  const infoHash = crypto.createHash('sha1')
    .update(bencode(info))
    .digest('hex');
  
  // 4. Build magnet URI
  const magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${name}`;
  
  return { torrentBuffer, infoHash, magnetURI };
}
```

---

## 4. BitTorrent Protocol Implementation

### 4.1 Bencode (Encoding Format)

BitTorrent uses bencode for all data serialization.

```javascript
// bencode.js
function encode(data) {
  if (typeof data === 'number')  return `i${data}e`;
  if (Buffer.isBuffer(data))     return `${data.length}:${data}`;
  if (typeof data === 'string')  return `${data.length}:${data}`;
  if (Array.isArray(data))       return `l${data.map(encode).join('')}e`;
  if (typeof data === 'object')  return encodeDictionary(data);
}

// Examples:
// 42         → "i42e"
// "spam"     → "4:spam"
// [1, 2, 3]  → "li1ei2ei3ee"
// {a: 1}     → "d1:ai1ee"
```

### 4.2 Tracker Protocol (BEP-3)

```javascript
// tracker.js
async function announce(options) {
  const params = new URLSearchParams({
    info_hash: options.infoHash,    // 20-byte hash
    peer_id: options.peerId,        // Our identifier
    port: options.port,             // Listening port
    uploaded: options.uploaded,
    downloaded: options.downloaded,
    left: options.left,             // Bytes remaining
    compact: 1,                     // Compact peer format
    event: options.event            // started|completed|stopped
  });
  
  const response = await fetch(`${trackerUrl}?${params}`);
  // Response contains peer list, reannounce interval
}
```

### 4.3 Peer Wire Protocol

**Handshake Format (68 bytes):**
```
<pstrlen><pstr><reserved><info_hash><peer_id>
   1       19      8         20        20
```

```javascript
// peerConnection.js
_createHandshake() {
  const buffer = Buffer.alloc(68);
  buffer.writeUInt8(19, 0);                    // Protocol string length
  buffer.write('BitTorrent protocol', 1);      // Protocol string
  buffer.fill(0, 20, 28);                      // Reserved bytes
  this.infoHash.copy(buffer, 28);              // Info hash
  this.peerId.copy(buffer, 48);                // Peer ID
  return buffer;
}
```

**Message Types:**
| ID | Name | Payload | Purpose |
|----|------|---------|---------|
| 0 | choke | - | Stop sending data |
| 1 | unchoke | - | Resume sending data |
| 2 | interested | - | Want to download |
| 3 | not interested | - | Don't need data |
| 4 | have | piece index | Announce completed piece |
| 5 | bitfield | bitfield | All pieces we have |
| 6 | request | index, begin, length | Request block |
| 7 | piece | index, begin, block | Send block data |
| 8 | cancel | index, begin, length | Cancel request |

### 4.4 Piece Verification

```javascript
async function verifyPiece(pieceIndex, data) {
  const expectedHash = this.torrent.pieces[pieceIndex];
  const actualHash = crypto.createHash('sha1').update(data).digest();
  return expectedHash.equals(actualHash);
}
```

---

## 5. API Design & Backend-Frontend Communication

### 5.1 REST API Endpoints

```
Authentication:
POST   /api/auth/register     → Create account
POST   /api/auth/login        → Get JWT token
POST   /api/auth/google       → OAuth login

Torrents:
GET    /api/torrent           → List user's torrents
GET    /api/torrent/:id       → Get torrent details
POST   /api/torrent/create    → Add magnet or .torrent file
POST   /api/torrent/create-from-file → Create torrent from any file
DELETE /api/torrent/:id       → Remove torrent
POST   /api/torrent/:id/start → Start download
POST   /api/torrent/:id/pause → Pause download
POST   /api/torrent/:id/resume→ Resume download

Files:
GET    /api/torrent/:id/files        → List files in torrent
POST   /api/torrent/:id/files/select → Select files to download

Stats:
GET    /api/torrent/:id/stats        → Real-time torrent stats
GET    /api/torrent/engine/stats     → Global engine stats
GET    /api/statistics/speed-history → Historical speed data
```

### 5.2 Request/Response Flow

**Adding a Magnet Link:**
```
Frontend                    Backend                      Engine
    │                          │                            │
    │ POST /api/torrent/create │                            │
    │ { magnetURI: "magnet:?" }│                            │
    │ ─────────────────────────>                            │
    │                          │                            │
    │                          │ engine.addTorrent()        │
    │                          │ ───────────────────────────>
    │                          │                            │
    │                          │     Torrent instance       │
    │                          │ <───────────────────────────
    │                          │                            │
    │                          │ Save to MongoDB            │
    │                          │ ──────────┐                │
    │                          │ <─────────┘                │
    │                          │                            │
    │    201 { torrent data }  │                            │
    │ <─────────────────────────                            │
    │                          │                            │
    │                          │ Socket: torrent:added      │
    │ <─────────────────────────────────────────────────────
```

### 5.3 Data Merging Strategy

The controller merges MongoDB data with live engine stats:

```javascript
// torrentController.js
const mergeTorrentData = (dbTorrent, engineTorrent) => {
  if (!engineTorrent) {
    return dbTorrent.toObject();  // Engine not loaded, use DB only
  }

  const stats = engineTorrent.getStats();
  return {
    ...dbTorrent.toObject(),      // Persisted data (name, infoHash, etc.)
    status: stats.state,          // Live state
    progress: stats.percentage,   // Live progress
    downloadSpeed: stats.downloadSpeed,
    uploadSpeed: stats.uploadSpeed,
    seeds: stats.seeds,
    leeches: stats.leeches,
    peers: stats.peers,
    eta: stats.eta
  };
};
```

**Why merge?**
- DB has persistence (survives restart)
- Engine has real-time accuracy (current speed)
- Combined gives best of both worlds

---

## 6. Real-Time Communication (WebSockets)

### 6.1 Socket.IO Architecture

```javascript
// socket.js
function initializeSocket(server) {
  io = socketIO(server, {
    cors: { origin: process.env.FRONTEND_URL }
  });

  io.on('connection', (socket) => {
    // Subscribe to specific torrent updates
    socket.on('subscribe:torrent', ({ infoHash }) => {
      socket.join(`torrent:${infoHash}`);
    });
    
    // Subscribe to all torrent updates (dashboard)
    socket.on('subscribe:all', () => {
      socket.join('all');
    });
  });
}
```

### 6.2 Event Types

```javascript
// Events emitted by engine
emitTorrentAdded(infoHash, data)      // New torrent
emitTorrentStarted(infoHash, data)    // Download began
emitProgress(infoHash, data)          // Progress update (throttled)
emitPieceCompleted(infoHash, data)    // Piece downloaded
emitTorrentCompleted(infoHash, data)  // Download finished
emitTorrentPaused(infoHash, data)
emitTorrentResumed(infoHash, data)
emitTorrentRemoved(infoHash, data)
emitPeerConnected(infoHash, data)
emitPeerDisconnected(infoHash, data)
emitSpeedUpdate(data)                 // Global speed (1/sec)
```

### 6.3 Throttling Strategy

```javascript
// Progress updates throttled to max 2/sec
const PROGRESS_THROTTLE_MS = 500;

function emitProgress(infoHash, data) {
  const now = Date.now();
  const timeSinceLastUpdate = now - throttleState.lastUpdate;

  if (timeSinceLastUpdate >= PROGRESS_THROTTLE_MS) {
    // Emit immediately
    emitToTorrent(infoHash, 'torrent:progress', data);
    throttleState.lastUpdate = now;
  } else {
    // Buffer and schedule
    throttleState.pendingData = data;
    if (!throttleState.timer) {
      throttleState.timer = setTimeout(() => {
        emitToTorrent(infoHash, 'torrent:progress', throttleState.pendingData);
      }, PROGRESS_THROTTLE_MS - timeSinceLastUpdate);
    }
  }
}
```

**Why throttle?**
- Pieces complete very fast (can be 100+ per second)
- Unthrottled would flood the network
- UI only needs 2-4 updates/sec for smooth progress bar

### 6.4 Frontend Socket Integration

```typescript
// useSocket.ts (React hook)
const useSocket = () => {
  useEffect(() => {
    socket.emit('subscribe:all');
    
    socket.on('torrent:progress', (data) => {
      updateTorrentProgress(data.infoHash, data.progress);
    });
    
    socket.on('stats:speed', (data) => {
      updateSpeedGraph(data.downloadSpeed, data.uploadSpeed);
    });
    
    return () => socket.emit('unsubscribe:all');
  }, []);
};
```

---

## 7. Database Design

### 7.1 Torrent Schema

```javascript
const torrentSchema = new mongoose.Schema({
  // Identity
  name: { type: String, required: true },
  infoHash: { type: String, required: true, unique: true },
  magnetURI: String,
  
  // Size & structure
  size: { type: Number, required: true },
  files: [{
    name: String,
    size: Number,
    path: String
  }],
  
  // State
  status: {
    type: String,
    enum: ['pending', 'downloading', 'seeding', 'paused', 'error', 'completed'],
    default: 'pending'
  },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  
  // Ownership
  uploadedBy: { type: ObjectId, ref: 'User', required: true },
  downloadedBy: [{ type: ObjectId, ref: 'User' }],
  
  // Created-from-file metadata
  sourcePath: String,
  torrentFilePath: String,
  createdFromUpload: { type: Boolean, default: false },
  
  // Networking
  trackers: [String],
  seeds: { type: Number, default: 0 },
  leeches: { type: Number, default: 0 },
  
  addedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Indexes for performance
torrentSchema.index({ name: 'text' });           // Full-text search
torrentSchema.index({ infoHash: 1 }, { unique: true });
torrentSchema.index({ uploadedBy: 1, downloadedBy: 1 }); // "My torrents" query
torrentSchema.index({ status: 1 });
torrentSchema.index({ addedAt: -1 });
```

### 7.2 Multi-User Access Control

```javascript
// User can see torrents they uploaded OR are downloading
const torrents = await Torrent.find({
  $or: [
    { uploadedBy: userId },
    { downloadedBy: userId }
  ]
});

// When someone adds a magnet that already exists:
if (existingTorrent) {
  if (!existingTorrent.downloadedBy.includes(userId)) {
    existingTorrent.downloadedBy.push(userId);
    await existingTorrent.save();
    // They become a leecher
  }
}
```

---

## 8. Advanced Features

### 8.1 DHT (Distributed Hash Table)

```javascript
// dht/node.js
class DHTNode {
  constructor(options) {
    this.nodeId = crypto.randomBytes(20);  // 160-bit node ID
    this.routingTable = new RoutingTable(this.nodeId);
    this.port = options.port || 6881;
  }
  
  async findPeers(infoHash) {
    // Kademlia-like lookup
    const closest = this.routingTable.findClosest(infoHash, 8);
    // Query each node recursively...
  }
}
```

**Why DHT?**
- Works when trackers are down
- Decentralized peer discovery
- More resilient network

### 8.2 Torrent Creation & Seeding

```javascript
// Full flow: User uploads PDF → becomes seeder
app.post('/api/torrent/create-from-file', async (req, res) => {
  const file = req.file;
  
  // 1. Create .torrent file
  const { torrentBuffer, infoHash, magnetURI } = createTorrent(file.buffer, {
    name: file.originalname,
    pieceSize: 256 * 1024
  });
  
  // 2. Save source file
  const sourcePath = `/downloads/seeds/${infoHash}-${file.originalname}`;
  await fs.writeFile(sourcePath, file.buffer);
  
  // 3. Start seeding
  await engine.seedFromFile({ torrentBuffer, sourcePath });
  
  // 4. Save to DB
  await Torrent.create({
    name: file.originalname,
    infoHash,
    magnetURI,
    sourcePath,
    createdFromUpload: true,
    uploadedBy: req.user.id
  });
  
  res.json({ infoHash, magnetURI });
});
```

### 8.3 Queue Management

```javascript
class QueueManager extends EventEmitter {
  constructor(options) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.queue = [];        // Waiting
    this.active = new Set(); // Downloading
    this.paused = new Set();
    this.completed = new Set();
  }
  
  add(torrent, options) {
    if (this.active.size < this.maxConcurrent) {
      this.active.add(torrent);
      torrent.start();
    } else {
      this.queue.push(torrent);  // Wait for slot
    }
  }
  
  onComplete(torrent) {
    this.active.delete(torrent);
    this.completed.add(torrent);
    this._processQueue();  // Start next
  }
}
```

### 8.4 State Persistence & Resume

```javascript
// On server restart
const savedStates = await StateManager.loadAll();

for (const state of savedStates) {
  const torrent = await engine.addTorrent({
    magnetURI: state.magnetURI,
    autoStart: false
  });
  
  // Restore completed pieces (skip re-download)
  torrent.setCompletedPieces(state.completedPieces);
  
  // Resume from previous state
  if (state.state === 'downloading') {
    torrent.start();
  }
}
```

---

## 9. System Design Decisions & Trade-offs

### 9.1 Why Custom Engine vs WebTorrent?

| WebTorrent | Custom Engine |
|------------|---------------|
| Quick to start | Deep learning experience |
| Browser-compatible | Full protocol control |
| Limited to WebRTC | Native TCP connections |
| Abstracted away | Interview talking points |

**Decision:** Built custom for learning and full control.

### 9.2 Why MongoDB vs PostgreSQL?

| MongoDB | PostgreSQL |
|---------|------------|
| Flexible schema | Strict schema |
| JSON-native | Better for relations |
| Horizontal scaling | Vertical scaling |
| Nested documents | JOINs needed |

**Decision:** MongoDB because torrent metadata is JSON-like and varies by torrent.

### 9.3 Why Socket.IO vs WebSocket?

| Socket.IO | Raw WebSocket |
|-----------|---------------|
| Room abstraction | Manual routing |
| Auto-reconnect | Manual handling |
| Fallback to polling | WebSocket only |
| Heavier | Lighter |

**Decision:** Socket.IO for rooms (subscribe to specific torrent) and reliability.

### 9.4 Why Express vs Fastify?

| Express | Fastify |
|---------|---------|
| Huge ecosystem | Faster |
| More middleware | Less mature |
| Well documented | Better TypeScript |

**Decision:** Express for middleware ecosystem (multer, cors, morgan).

---

## 10. Scalability & Performance

### 10.1 Current Architecture (Single Server)

```
Handles: ~100 concurrent torrents, ~1000 peer connections
Bottlenecks:
- Single Node.js event loop
- Single MongoDB instance
- All torrents in memory
```

### 10.2 Scaling Strategies

**Horizontal Scaling:**
```
                    Load Balancer
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
    │Server 1 │    │Server 2 │    │Server 3 │
    │         │    │         │    │         │
    │Torrents │    │Torrents │    │Torrents │
    │ A-H     │    │  I-P    │    │  Q-Z    │
    └────┬────┘    └────┬────┘    └────┬────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                    MongoDB Replica Set
```

**Shard by infoHash:** Consistent hashing to route torrents.

**Redis for Socket.IO:**
```javascript
const { createAdapter } = require('@socket.io/redis-adapter');
io.adapter(createAdapter(pubClient, subClient));
// Now events propagate across servers
```

### 10.3 Performance Optimizations

1. **Throttled progress updates** — Max 2/sec per torrent
2. **Piece batching** — Request multiple blocks per peer
3. **Connection pooling** — Reuse peer connections
4. **Speed tracking EMA** — Smooth speed calculations
5. **Lazy piece initialization** — Only create Piece objects when needed

---

## 11. Security Considerations

### 11.1 Authentication

```javascript
// JWT middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
```

### 11.2 Input Validation

```javascript
// Magnet link validation
const magnetInfo = parseMagnet(magnetURI);
if (!magnetInfo.infoHash || magnetInfo.infoHash.length !== 40) {
  return res.status(400).json({ error: 'Invalid magnet link' });
}

// File size limits
const MAX_SEED_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const upload = multer({ limits: { fileSize: MAX_SEED_FILE_BYTES } });
```

### 11.3 Access Control

```javascript
// Only owner or leecher can view torrent
const isOwner = torrent.uploadedBy.toString() === userId;
const isLeecher = torrent.downloadedBy.includes(userId);

if (!isOwner && !isLeecher) {
  return res.status(403).json({ error: 'Not authorized' });
}
```

### 11.4 Peer Connection Security

```javascript
// Validate handshake
if (!receivedInfoHash.equals(this.infoHash)) {
  this.socket.destroy();  // Wrong torrent
  return;
}

// Ban misbehaving peers
if (peer.failures > 5) {
  this.banManager.ban(peer.key, 'Too many failures');
}
```

---

## 12. Interview Questions & Answers

### Q1: "Walk me through what happens when a user adds a magnet link."

**Answer:**
1. Frontend sends `POST /api/torrent/create` with magnetURI
2. Controller parses magnet to extract infoHash and trackers
3. Checks if torrent exists in DB:
   - If yes: Add user to `downloadedBy` array (they become a leecher)
   - If no: Create new Torrent document
4. Engine creates Torrent instance:
   - Connects to trackers to announce and get peer list
   - Starts DHT lookup for more peers
   - Since it's a magnet (no metadata yet), requests metadata from peers using extension protocol
5. Once metadata received, initializes DownloadManager and FileWriter
6. PeerManager connects to peers, sends interested message
7. When unchoked, requests rarest pieces first
8. Each piece verified with SHA1 after download
9. Socket.IO emits progress events in real-time
10. On completion, announces to tracker with event=completed

### Q2: "How do you handle concurrent downloads efficiently?"

**Answer:**
- QueueManager limits concurrent active downloads (default 3)
- Each torrent has its own event loop via EventEmitter
- PeerManager limits connections per torrent (50) and per IP (3)
- DownloadManager uses "rarest first" for better swarm health
- Progress events are throttled to 2/sec to reduce network overhead
- Pieces downloaded in parallel from multiple peers
- EndGame mode when >95% complete (request remaining pieces from all peers)

### Q3: "How does the real-time UI work?"

**Answer:**
- Socket.IO server initialized with HTTP server
- Frontend connects and joins rooms (e.g., `torrent:${infoHash}` or `all`)
- Engine emits events through socket module:
  - `torrent:progress` — download/upload progress (throttled)
  - `stats:speed` — global speed every 1 second
  - `torrent:completed`, `peer:connected`, etc.
- Frontend React hooks listen to these events and update state
- Room-based architecture means users only receive events for their torrents

### Q4: "What's your database schema for multi-user support?"

**Answer:**
- `uploadedBy`: Original creator of the torrent (ObjectId)
- `downloadedBy`: Array of users who added this torrent as leechers
- Query for "my torrents": `{ $or: [{ uploadedBy: userId }, { downloadedBy: userId }] }`
- Delete behavior differs:
  - Owner deletes: Remove from engine and DB entirely
  - Leecher deletes: Just remove from `downloadedBy` array
- Compound index on `[uploadedBy, downloadedBy]` for efficient queries

### Q5: "How do you verify downloaded data isn't corrupted?"

**Answer:**
- Each piece has a SHA1 hash in the .torrent file
- After downloading a piece, compute SHA1 and compare:
  ```javascript
  const actual = crypto.createHash('sha1').update(pieceData).digest();
  const expected = this.torrent.pieces[pieceIndex];
  if (!actual.equals(expected)) {
    // Discard piece, re-request, possibly ban peer
  }
  ```
- This is BEP-3 mandated — all BitTorrent clients do this
- If hash fails repeatedly from same peer, that peer gets banned

### Q6: "How would you scale this to handle 10,000 concurrent users?"

**Answer:**
1. **Horizontal scaling**: Multiple Node.js instances behind load balancer
2. **Torrent sharding**: Consistent hashing by infoHash to route to specific servers
3. **Redis adapter for Socket.IO**: Events propagate across servers
4. **MongoDB replica set**: Read scaling, high availability
5. **Separate tracker service**: Offload announce handling
6. **CDN for .torrent files**: Reduce download latency
7. **Kubernetes**: Auto-scaling based on CPU/memory
8. **Rate limiting**: Prevent abuse at API gateway level

---

## 13. Technical Deep Dives (Talking Points)

### 13.1 The Piece Selection Problem

**Problem:** You have 100 pieces to download and 10 peers. How do you decide which peer downloads which piece?

**Naive approach:** Round-robin or random
- Risk: Popular pieces get duplicated, rare pieces die

**TorrentEdge approach: Rarest First**
```javascript
// Track availability: how many peers have each piece
this.pieceAvailability[pieceIndex]++;  // On receive bitfield/have

// Select rarest
selectNextPiece() {
  return pieces
    .filter(p => !completed.has(p) && !active.has(p))
    .sort((a, b) => availability[a] - availability[b])
    [0];
}
```

**EndGame mode:** When >95% complete, request remaining pieces from ALL peers simultaneously to finish faster.

### 13.2 The Choke/Unchoke Algorithm

**Problem:** If you send data to everyone, freeloaders abuse you.

**Solution:** Optimistic unchoking + tit-for-tat
```javascript
// Every 10 seconds, recalculate who to unchoke
recalculateUnchokes() {
  // Sort peers by upload speed to us (reward good uploaders)
  const sorted = peers.sort((a, b) => b.uploadSpeed - a.uploadSpeed);
  
  // Unchoke top 4
  const unchoked = sorted.slice(0, 4);
  
  // Optimistic unchoke: random 5th peer (discover new fast peers)
  const optimistic = randomPeer(sorted.slice(4));
  unchoked.push(optimistic);
  
  // Choke everyone else
  peers.forEach(p => {
    if (unchoked.includes(p)) p.unchoke();
    else p.choke();
  });
}
```

### 13.3 The Metadata Download Problem (Magnet Links)

**Problem:** Magnet links only have infoHash. How do you get the actual .torrent metadata?

**Solution:** BEP-9 Extension Protocol
```javascript
// 1. Connect to peer
// 2. Check if they support ut_metadata extension
// 3. Request metadata pieces
sendMetadataRequest(pieceIndex) {
  const msg = bencode({
    msg_type: 0,  // request
    piece: pieceIndex
  });
  this.sendExtensionMessage(UT_METADATA_ID, msg);
}

// 4. Receive and verify
onMetadataReceive(pieces) {
  const fullMetadata = Buffer.concat(pieces);
  const hash = sha1(fullMetadata);
  if (hash.equals(this.infoHash)) {
    this.metadata = bdecode(fullMetadata);
  }
}
```

### 13.4 The Resume Problem

**Problem:** Server restarts. How do you continue downloads from where they left off?

**Solution:** State persistence
```javascript
// Every 30 seconds, save state
saveState(torrent) {
  return {
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    completedPieces: Array.from(torrent.completedPieces),
    downloadedBytes: torrent.downloadedBytes,
    state: torrent.state
  };
}

// On startup, restore
async restore() {
  for (const state of await loadAllStates()) {
    const torrent = await engine.addTorrent({ magnetURI: state.magnetURI });
    torrent.setCompletedPieces(state.completedPieces);  // Skip re-download
    if (state.state === 'downloading') torrent.start();
  }
}
```

---

## Quick Reference Card

### Files to Know
```
src/server/
├── server.js                 # Entry point, Express setup
├── socket.js                 # Socket.IO initialization & events
├── controllers/
│   └── torrentController.js  # All torrent CRUD logic
├── routes/
│   └── torrentRoutes.js      # API endpoint definitions
├── models/
│   └── torrent.js            # Mongoose schema
└── torrentEngine/
    ├── engine.js             # Central orchestrator
    ├── torrent.js            # Individual torrent
    ├── tracker.js            # Tracker announces
    ├── peerManager.js        # Peer connections
    ├── peerConnection.js     # Single peer TCP
    ├── downloadManager.js    # Piece orchestration
    ├── uploadManager.js      # Seeding pieces
    ├── fileWriter.js         # Disk I/O
    ├── torrentCreator.js     # .torrent generation
    ├── bencode.js            # Encoding
    └── dht/                   # DHT implementation
```

### Key Numbers
- Piece size: 256 KB (default)
- Max connections: 50 per torrent
- Max concurrent downloads: 3
- Progress throttle: 500ms
- Speed history: 60 samples
- Handshake size: 68 bytes

### Key Protocols
- **BEP-3**: BitTorrent Protocol
- **BEP-5**: DHT
- **BEP-9**: Metadata Extension
- **BEP-10**: Extension Protocol

---

*Last updated: March 2026*
*Project: TorrentEdge*
*Author: techmedaddy*
