# TorrentEdge

**Cloud-Native, Peer-Assisted Artifact Distribution for Infrastructure Teams**

A chunk-based, VPC-aware P2P delivery system that eliminates the "Thundering Herd" network bottleneck when distributing large binary artifacts (model checkpoints, container images, dataset shards) across compute fleets. Built for MLOps and Platform Engineering teams operating at the scale where centralized object storage becomes the failure domain.

---

## The Problem

When a training run completes and a new 70GB Llama-3 checkpoint is pushed to S3, the rollout begins. Fifty GPU nodes simultaneously issue `aws s3 cp` to pull the artifact. The result is predictable:

- **Top-of-Rack switch saturation.** The NAT Gateway or VPC endpoint becomes a single point of contention. Nodes that start pulling 2 seconds late may wait 40 minutes longer than the first.
- **Egress cost amplification.** 50 nodes × 70GB = 3.5TB of S3 egress per deployment. At $0.09/GB, that is **$315 per rollout** — and teams deploying multiple times per day burn thousands monthly on redundant byte transfers.
- **Non-deterministic completion.** There is no orchestration layer. Nodes complete at different times based on network jitter, and the fleet cannot begin inference until the slowest node finishes.

TorrentEdge eliminates this by downloading the artifact from S3 **once**, then laterally distributing it across the internal VPC using chunk-verified P2P protocols. The first node to pull a piece immediately begins seeding it to its neighbors over East-West traffic, which is free and unrestricted.

---

## Architecture

TorrentEdge follows a strict Control Plane / Data Plane separation. The orchestration layer never touches raw bytes; it only manages metadata, leases, and job state. The execution layer never makes scheduling decisions; it only processes directives.

```
                    ┌──────────────────────────────────────────────────┐
                    │              CONTROL PLANE                       │
                    │                                                  │
  MLOps Pipeline ──▶│  REST API (Express.js)                          │
  (CI/CD, Airflow)  │    │                                            │
                    │    ├── POST /api/torrent/create                  │
                    │    ├── GET  /api/torrent/:id/stats               │
                    │    └── GET  /api/health                          │
                    │    │                                             │
                    │    ▼                                             │
                    │  Dispatcher ──▶ Kafka (torrent.jobs.dispatch)    │
                    │                                                  │
                    │  LeaseSweeper (Zombie Recovery Cron)             │
                    │    └── Polls PostgreSQL + Redis every 30s        │
                    └──────────────┬───────────────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────────────┐
                    │              DATA PLANE (Worker Nodes)           │
                    │                                                  │
                    │  WorkerConsumer                                  │
                    │    ├── Kafka Consumer (torrent.jobs.dispatch)    │
                    │    ├── LeaseManager (Redis SETNX + Fencing)      │
                    │    ├── S3 Cold Start Bridge (HTTP Range Stream)  │
                    │    ├── BitTorrent Engine (Piece Protocol)        │
                    │    ├── CAS Store (SHA-256 Deduplication)         │
                    │    └── Peer Registry (VPC-aware discovery)       │
                    │                                                  │
                    └──────────────────────────────────────────────────┘

  Persistence Layer:
    PostgreSQL ──── ACID metadata, transfer state, chunk verification
    Redis ───────── Distributed leases, fencing tokens, peer TTLs
    Kafka ───────── Asynchronous job dispatch, lifecycle events, telemetry
```

### Core Subsystems

| Subsystem | Responsibility | Key Guarantee |
|-----------|---------------|---------------|
| **Dispatcher** | Publishes `JOB_ASSIGNED` directives to Kafka. Falls back to in-process execution when Kafka is unavailable. | Exactly-once dispatch via `X-Request-ID` idempotency. |
| **LeaseManager** | Redis-backed distributed lock with monotonic fencing tokens. Workers must validate their token before every CAS write. | Prevents split-brain disk corruption on shared volumes. |
| **LeaseSweeper** | Control Plane cron that detects zombie transfers (active DB status, expired Redis lease) and re-queues them. | Autonomous recovery from OOMKilled or preempted workers. |
| **S3 Cold Start Bridge** | When a transfer has 0 seeders, the first worker acquires a genesis lease, streams the artifact from a Pre-Signed URL, and seeds it to the VPC — all without the AWS SDK on the data plane. | Peak heap usage capped at ~1MB regardless of artifact size. |
| **CAS Store** | Content-Addressable Storage. Chunks are stored by SHA-256 hash in a sharded directory structure. Identical chunks across transfers are deduplicated. | Eliminates redundant disk I/O for overlapping artifacts. |
| **PeerRegistry** | Redis-backed registry of active workers per `infoHash`. Enables VPC-aware peer discovery so nodes preferentially pull from local neighbors. | East-West traffic prioritization over North-South egress. |

---

## Deployment Topology

### Evaluation Mode (Single Node)

Boot the full stack locally with a single command. This runs the Control Plane, a single embedded Worker, PostgreSQL, Redis, Kafka, and the observability pipeline.

```bash
git clone https://github.com/yourusername/TorrentEdge.git
cd TorrentEdge
cp .env.example .env
docker compose up -d
```

The API is available at `http://localhost:3029`. Grafana dashboards are at `http://localhost:3033` (credentials: `admin` / `admin`).

### Production Mode (AWS Free Tier — 1GB t3.micro)

For resource-constrained deployments, a dedicated `docker-compose.aws-micro.yml` is provided. It runs Kafka in KRaft mode (eliminating Zookeeper), hard-limits the JVM to 256MB (`-Xmx256m`), and caps Node.js V8 heap at 256MB (`--max-old-space-size=256`). PostgreSQL and Redis are offloaded to managed AWS services (RDS, ElastiCache).

```bash
docker compose -f docker-compose.aws-micro.yml up -d
```

See [docs/aws_free_tier_playbook.md](docs/aws_free_tier_playbook.md) for the full operational runbook, including swap file provisioning and memory budgets.

### Kubernetes (Helm)

A versioned Helm chart is provided in `charts/torrentedge/`. It includes Liveness and Readiness probes mapped to `/api/health`, PersistentVolumeClaims for the download directory, and configurable replica counts for horizontal worker scaling.

```bash
helm install torrentedge ./charts/torrentedge \
  --set replicaCount.backend=3 \
  --set kafka.brokers=kafka.svc.cluster.local:9092
```

---

## API Usage

### Dispatch a Transfer

```bash
curl -X POST http://localhost:3029/api/torrent/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Request-ID: deploy-llama3-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{
    "magnetURI": "magnet:?xt=urn:btih:INFOHASH&dn=llama3-70b-checkpoint.safetensors"
  }'
```

The `X-Request-ID` header enables idempotent request handling. If the same request is retried due to a network timeout, the Control Plane returns the cached `200 OK` response without generating duplicate Kafka events or database records.

### Upload and Seed a Local Artifact

```bash
curl -X POST http://localhost:3029/api/torrent/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Request-ID: seed-model-v2.1" \
  -F "file=@./checkpoints/model-v2.1.safetensors"
```

### Query Transfer Status

```bash
curl http://localhost:3029/api/torrent/$TRANSFER_ID/stats \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "infoHash": "a1b2c3d4e5...",
  "status": "downloading",
  "progress": 67.4,
  "downloadSpeed": 52428800,
  "peers": { "connected": 12, "total": 48 },
  "pieces": { "completed": 174, "total": 258 }
}
```

### Health Check

```bash
curl http://localhost:3029/api/health
```

Returns dependency status for PostgreSQL, Redis, and Kafka. Kubernetes Liveness and Readiness probes are mapped to this endpoint.

---

## Observability

TorrentEdge exports telemetry through three channels:

### Prometheus Metrics

Scraped from `GET /metrics`. Key gauges and counters:

| Metric | Type | Description |
|--------|------|-------------|
| `torrentedge_cas_hit_rate` | Gauge | CAS deduplication hit ratio (0–1). |
| `torrentedge_dedup_bytes_total` | Counter | Total bytes saved by chunk deduplication. |
| `torrentedge_http_request_duration_seconds` | Histogram | API latency distribution with route labels. |
| `torrentedge_kafka_messages_total` | Counter | Kafka produce/consume throughput by topic. |
| `torrentedge_lease_acquisitions_total` | Counter | Distributed lock acquisition attempts by result. |
| `torrentedge_queue_depth` | Gauge | Transfer queue depth by state. |
| `torrentedge_worker_heartbeats_total` | Counter | Worker liveness heartbeat events. |

A pre-built Grafana dashboard is provisioned automatically in Docker Compose at `observability/grafana/dashboards/torrentedge-overview.json`.

### OpenTelemetry Distributed Tracing

Traces are exported via OTLP/HTTP to a configurable collector. Every Kafka message carries W3C Trace Context headers, enabling end-to-end trace correlation from API request → Kafka dispatch → Worker execution → CAS write.

```bash
# Enable tracing
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
```

Traces are viewable in Grafana Tempo at `http://localhost:3200`.

### Real-Time WebSocket Telemetry

Socket.IO provides low-latency push updates for operational dashboards:

```javascript
const socket = io('http://localhost:3029');
socket.emit('authenticate', { token: 'YOUR_TOKEN' });
socket.emit('subscribe:torrent', { infoHash: 'HASH' });

socket.on('torrent:progress', (data) => {
  // { percentage, downloadSpeed, peers, pieces }
});
```

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3029` |
| `POSTGRES_HOST` | PostgreSQL host | `localhost` |
| `POSTGRES_PORT` | PostgreSQL port | `5432` |
| `POSTGRES_DB` | Database name | `torrentedge` |
| `REDIS_HOST` | Redis host | `localhost` |
| `KAFKA_ENABLED` | Enable Kafka event bus | `false` |
| `KAFKA_BROKERS` | Kafka broker addresses | `localhost:9092` |
| `DOWNLOAD_PATH` | Artifact storage directory | `./downloads` |
| `MAX_ACTIVE_TORRENTS` | Concurrent transfer limit | `5` |
| `MAX_CONCURRENT` | Worker concurrency limit | `3` |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing | `false` |
| `WORKER_NODE_ID` | Unique identifier for this worker | `local-<PID>` |

---

## Project Structure

```
TorrentEdge/
├── src/server/
│   ├── server.js                    # Process entrypoint, middleware, graceful shutdown
│   ├── controllers/
│   │   └── torrentController.js     # Transfer lifecycle, file serving, merge logic
│   ├── models/sql/
│   │   ├── Transfer.js              # Core transfer metadata (PostgreSQL)
│   │   ├── Chunk.js                 # Piece verification state
│   │   ├── User.js                  # Authentication & ownership
│   │   └── index.js                 # Sequelize associations
│   ├── routes/
│   │   ├── torrentRoutes.js         # Transfer CRUD endpoints
│   │   ├── healthRoutes.js          # Liveness / Readiness probes
│   │   └── statisticsRoutes.js      # Operational metrics API
│   ├── torrentEngine/
│   │   ├── engine.js                # BitTorrent engine orchestrator
│   │   ├── dispatcher.js            # Control Plane → Kafka job publisher
│   │   ├── workerConsumer.js        # Data Plane Kafka consumer + directive executor
│   │   ├── leaseManager.js          # Redis distributed locks + fencing tokens
│   │   ├── leaseSweeper.js          # Zombie transfer recovery cron
│   │   ├── s3Streamer.js            # S3 Cold Start Bridge (HTTP Range streaming)
│   │   ├── casStore.js              # Content-Addressable Storage (SHA-256)
│   │   ├── peerRegistry.js          # VPC-aware peer discovery (Redis)
│   │   ├── queueManager.js          # Bounded concurrency admission control
│   │   ├── pieceManager.js          # Piece verification & bitfield tracking
│   │   └── fileWriter.js            # Atomic disk I/O (temp → rename)
│   ├── observability/
│   │   ├── metrics.js               # Prometheus metric definitions
│   │   └── tracing.js               # OpenTelemetry SDK initialization
│   └── middleware/
│       └── requestId.js             # X-Request-ID correlation
├── charts/torrentedge/              # Helm chart (K8s deployment)
├── observability/                   # Grafana dashboards, Prometheus, Tempo, OTel Collector
├── nginx/                           # Reverse proxy configuration
├── docs/
│   ├── aws_free_tier_playbook.md    # 1GB EC2 deployment runbook
│   ├── constitution.txt             # Engineering principles
│   └── execution.txt                # 12-week execution roadmap
├── docker-compose.yml               # Full local stack
├── docker-compose.prod.yml          # Production layout (Nginx + backend + frontend)
├── docker-compose.aws-micro.yml     # Memory-starved free tier layout
└── TROUBLESHOOTING.md               # Known bugs & resolution log
```

---

## Design Decisions

### Why PostgreSQL, Not a Document Store

Transfer metadata is inherently relational: Users own Transfers, Transfers have Leechers (junction table), Transfers are subdivided into Chunks. The system relies on row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`) for concurrent job dequeuing across horizontally scaled workers. A document store cannot provide these ACID guarantees without application-level compensation logic.

### Why Pre-Signed URLs, Not IAM Roles on Workers

The S3 Cold Start Bridge does not use the AWS SDK on the data plane. The Control Plane generates a time-limited Pre-Signed URL and passes it through the Kafka directive. Workers stream from a standard HTTP GET endpoint. This ensures the data plane is zero-trust, storage-agnostic, and immediately portable to GCS or Azure Blob without code changes.

### Why Fencing Tokens, Not Simple Locks

A `SETNX` lock alone is insufficient for distributed storage. If Worker A's lease expires while it is still writing a chunk (due to a slow disk), Worker B acquires the lock and begins writing the same chunk. Both workers now corrupt the file. TorrentEdge uses monotonic fencing tokens: every lease acquisition increments a counter, and the CAS store rejects writes from stale tokens.

### Why Fire-and-Forget Cold Start

The S3 streamer runs as a background task after `JOB_ASSIGNED` completes. The BitTorrent engine starts accepting peer connections immediately — it does not wait for the full S3 download to finish. As each piece is committed to the CAS, it becomes instantly available for lateral seeding. This means nodes 2–50 can begin pulling pieces from node 1 while node 1 is still streaming from S3.

---

## Failure Handling

| Failure Scenario | Detection | Recovery |
|-----------------|-----------|----------|
| Worker OOMKilled mid-transfer | Redis lease expires (30s TTL) | LeaseSweeper detects zombie, re-queues via Kafka |
| Network drop during S3 stream | HTTP socket error | Exponential backoff + Range header resume at last verified piece |
| Genesis lease stolen during stream | `renewLease()` returns null | Immediate `_abort()` — destroys HTTP socket to prevent split-brain |
| Kafka broker crash | KafkaJS `consumer.crash` event | Worker calls `process.exit(1)`, K8s restarts the pod |
| Stale worker writes after lease loss | Fencing token mismatch | CAS store rejects the write operation |
| Container restart wipes engine memory | Empty file list from API | Multi-tier fallback: `.torrent` file → PostgreSQL synthesis |

---

## License

MIT
