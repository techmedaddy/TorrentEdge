# The TorrentEdge Bible

Welcome to the comprehensive guide for **TorrentEdge**. Whether you are a product manager, a new engineering hire, or a system architect, this document is designed to give you a complete, top-to-bottom understanding of the TorrentEdge ecosystem.

---

## Part I: Product Vision & Overview

### What is TorrentEdge?
TorrentEdge is a modern, decentralized file-sharing and distribution platform. It bridges the gap between traditional BitTorrent peer-to-peer (P2P) protocols and modern, edge-computing infrastructure. By utilizing an edge network and cloud-native services, it provides highly resilient, scalable, and fast file transfers.

### Key Value Propositions
1. **Decentralized Edge Network:** Instead of relying entirely on fragile individual peer seeds, TorrentEdge utilizes specialized Edge Nodes that securely store and serve torrent chunks.
2. **S3 Cold Start Bridge (Phase 4):** Ensures long-term durability. If a torrent loses active seeders in the P2P swarm, TorrentEdge gracefully falls back to Amazon S3 storage, resurrecting the file and injecting it back into the swarm.
3. **Resiliency & Resume Capabilities:** Deeply integrated state tracking allows downloads to pause, resume, and survive network interruptions seamlessly.
4. **Rich Observability:** Unlike traditional black-box torrent clients, TorrentEdge features an enterprise-grade observability stack, making it ready for production environments.

---

## Part II: System Architecture

The TorrentEdge system follows a modular, microservice-inspired monolithic design built primarily in Node.js. 

### High-Level Components
1. **The API Server (Backend):** A Node.js/Express REST API handling user authentication, transfer management, and node health checks.
2. **The Torrent Engine:** The heart of the system. It handles BitTorrent protocols, DHT (Distributed Hash Table) operations, magnet link resolution, and chunk downloading/seeding.
3. **Event Bus (Kafka):** Used to decouple the high-throughput torrent status updates (progress, chunk verification, errors) from the main API. The `kafkaConsumer` processes these events asynchronously.
4. **Data Persistence (SQL DB):** Managed via Sequelize ORM, storing the state of all transfers, users, nodes, and chunks.
5. **Cold Storage (S3):** AWS S3 integration for the "Cold Start" fallback mechanism.
6. **Real-time Comms (WebSockets):** Using `socket.io` to push real-time transfer progress to connected frontend clients.

---

## Part III: Database Design

The relational database is the source of truth for the platform's state. 

- **`users`**: Manages authentication (Local/Google OAuth) and roles (admin/user).
- **`nodes`**: Tracks the physical or virtual edge nodes, their IP addresses, total capacity, and heartbeat status.
- **`transfers`**: The core entity. Tracks torrents via `info_hash`, current `status` (downloading, seeding, paused), size, and S3 backup keys.
- **`chunks`**: Granular tracking. Each transfer is split into chunks, stored here with a `chunk_index` and `status` (downloading, verified). Enables piecemeal downloading and verification.
- **`transfer_leechers`**: A many-to-many join table mapping users to the transfers they are actively consuming.

*(For detailed schemas, see the Database Design document).*

---

## Part IV: Core Engineering Components

### 1. The Torrent Engine (`src/server/torrentEngine/`)
This module handles the heavy lifting of the BitTorrent protocol.
- **DHT Integration:** Allows TorrentEdge to find peers without relying on centralized trackers.
- **Resume Service:** Tracks exactly which pieces have been downloaded to disk and cross-references them with the database, allowing lightning-fast resumes after a crash.
- **State Machine:** Transfers move through strict states: `created` -> `fetching_metadata` -> `downloading` -> `checking` -> `seeding` -> `completed`.

### 2. S3 Service (`src/server/services/s3Service.js`)
Handles the dual-write logic. When a file is completed on the edge network, a copy can be synced to S3. If the file is requested later and no edge nodes have it, the S3 service pulls it back to an edge node to seed it.

### 3. Kafka Consumer (`src/server/torrentEngine/kafkaConsumer.js`)
As torrents download, they generate thousands of tiny state changes (e.g., "chunk 45 downloaded", "progress 42.1%"). Instead of hammering the SQL database directly, the Torrent Engine fires these to a Kafka topic. The consumer batches and writes them to the DB efficiently.

---

## Part V: Observability and Monitoring

TorrentEdge is built to be run in production.
- **Structured Logging:** All logs are output in structured JSON formats.
- **Request Tracing:** The `requestId` middleware ensures every incoming API request is tagged with a UUID. This UUID is passed down to the Torrent Engine, S3 Service, and DB logs, allowing you to trace an entire workflow through the system.
- **Log Files:** `combined.log` (all info/debug logs) and `error.log` (for stack traces and fatal errors).

---

## Part VI: Infrastructure & Deployment

The repository includes a robust DevOps and Platform setup:
1. **Containerization:** The `Dockerfile` and `Dockerfile.frontend` containerize the respective applications.
2. **Docker Compose:** 
   - `docker-compose.yml`: Local development environment (spins up Postgres, Kafka, Zookeeper, Redis, etc.).
   - `docker-compose.prod.yml`: Productionized setup.
   - `docker-compose.aws-micro.yml`: Lightweight footprint optimized for deployment on small AWS EC2 instances.
3. **CI/CD:** Governed by `Jenkinsfile` and `sonar-project.properties` (for SonarQube code quality analysis).
4. **Kubernetes / Helm:** The `charts/` directory contains Helm charts for deploying TorrentEdge into a highly scalable K8s cluster.
5. **Nginx:** Reverse proxy configurations in `nginx/` handle SSL termination and WebSocket routing.

---

## Part VII: Developer Guide

### Getting Started Locally
1. Clone the repository and run `npm install` inside `src/server`.
2. Copy `.env.example` to `.env` and configure your local Postgres and Kafka credentials.
3. Start the backing services: `docker-compose up -d db kafka zookeeper`
4. Run the database seeders/migrations: `node src/server/seed.js`
5. Start the backend: `npm run dev` (from inside `src/server`).

### Folder Structure
```
/src
  /server
    /controllers    # Express route controllers
    /data           # Local SQLite fallback/storage (if applicable)
    /db             # Database connection and config
    /downloads      # Temporary storage for active downloads
    /middleware     # Express middlewares (Auth, RequestId)
    /models         # Sequelize Models (sql/index.js)
    /observability  # Logging and metrics config
    /routes         # API endpoint definitions
    /services       # Business logic (S3, Auth)
    /torrentEngine  # Core P2P, DHT, Resume logic
/tests              # Unit and Integration tests
/infra              # Infrastructure as Code (Terraform/CloudFormation)
```

### Best Practices
- **Never mutate state directly in controllers.** Route everything through the `TorrentEngine` or dedicated services.
- **Always use the Logger.** Avoid `console.log`. Use the structured logger attached to the request object (`req.log.info()`).
- **Handle Edge Cases:** P2P networks are chaotic. Always anticipate timeouts, corrupted chunks, and disconnected peers. Use the Chunk `status` field to handle retries gracefully.
