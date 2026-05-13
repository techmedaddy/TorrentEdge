# TorrentEdge — Reliability-First Execution Plan (Meaningful, Not Overengineered)

## 0) Product Compass (Non-Negotiable)

**One-line definition**

> TorrentEdge is self-hosted distributed transfer infrastructure for large files over unreliable networks.

Every decision must improve at least one:

1. Reliability
2. Scalability
3. Transfer efficiency
4. Operational visibility

If not, we do not build it.

---

## 1) Architecture Strategy (Pragmatic)

Keep the current repo shape but enforce control-plane/data-plane boundaries logically first (process boundaries later only if required by scale).

### Control Plane (authoritative state + orchestration)
- Auth/access control
- Transfer scheduling
- Metadata/state store
- Node registry + heartbeats
- Orchestration and health policies

### Data Plane (actual transfer execution)
- Chunk transfer workers
- Peer communication
- Replication fan-out
- Retry/recovery handlers
- Stream/chunk I/O

### Current repo mapping
- `services/orchestrator` -> Control Plane brain
- `services/api-gateway` -> Control Plane API + realtime state projection
- `services/metadata-service` -> Control Plane metadata/query
- `services/worker-pool` -> Data Plane executors
- `services/notifications` -> async events/alerts

---

## 2) Implementation Phases With Exit Criteria

## Phase 1 — Stable Core Transfer Engine

**Goal:** resumable, verifiable large transfer pipeline.

### Build
- Chunk splitter + deterministic chunk index
- Resumable upload/download session model
- Transfer checkpointing (every N chunks/time interval)
- Integrity verification:
  - per-chunk hash
  - final file hash gate before complete
- Retry with bounded backoff + jitter

### Data model (minimum)
- `transfers` (id, state, priority, source, target, size, hash, createdAt)
- `transfer_chunks` (transferId, chunkNo, hash, status, ownerWorker, retries)
- `transfer_checkpoints` (transferId, committedChunkNo, timestamp)
- `worker_leases` (transferId/chunkNo, workerId, leaseUntil)

### Exit criteria
- 100GB test transfer survives process crash and resumes automatically
- Final output hash must match expected hash (100% accuracy)
- Recovery after restart for 100 active transfers < 60s

---

## Phase 2 — Distributed Worker System

**Goal:** node failure does not stall transfer completion.

### Build
- Worker registration + heartbeat TTL
- Lease-based chunk ownership (not locks)
- Lease expiry -> automatic reassignment
- Idempotent chunk commit semantics
- Retry reassignment policy (different worker after repeated failures)

### Exit criteria
- Kill active worker node during transfer -> transfer continues via reassignment
- No duplicate-corrupt commits under concurrent retry conditions
- Queue lag under normal load stays < 60s

---

## Phase 3 — Observability Layer

**Goal:** production truth visible in minutes.

### Build
- Structured logs (JSON + correlation IDs)
- Metrics + alerts:
  - throughput
  - queue lag
  - retries/chunk failures
  - transfer duration
  - worker health
  - p95/p99 API latency
- Basic tracing for transfer lifecycle

### Stack
- OpenTelemetry SDK/instrumentation
- Prometheus + Grafana

### Exit criteria
- Incident triage (<10 minutes to identify failure domain)
- Dashboards cover all CUJs and SLOs
- Alert rules map directly to error budget burn

---

## Phase 4 — Smart Scheduling

**Goal:** predictable behavior under contention.

### Build
- Priority queues (high/normal/background)
- Adaptive concurrency per worker/node bandwidth
- Bandwidth-aware chunk dispatch
- Rate limiting and fairness controls
- Dead-letter queue for poisoned tasks

### Exit criteria
- High-priority transfer receives faster completion under load
- No starvation for normal jobs
- DLQ captures non-recoverable tasks with operator actions

---

## Phase 5 — Peer-Assisted Distribution

**Goal:** reduce origin bandwidth and improve distribution speed.

### Build
- Seed subset nodes from origin
- Peer fan-out from seeded nodes
- Replica policy (min replica count / placement)
- Peer health + swarm quality scoring

### Exit criteria
- Origin bandwidth reduced meaningfully during multi-receiver distribution
- Completion time improves over pure origin-client mode
- Recovery still deterministic when peer leaves swarm

---

## Phase 6 — Content Addressable Storage

**Goal:** storage efficiency + stronger integrity.

### Build
- `chunk_hash -> blob` addressing
- Dedup across transfers
- Immutable chunk store semantics
- Garbage collection for orphaned chunks

### Exit criteria
- Duplicate content consumes reduced incremental storage
- Re-verification and replication use hash index safely

---

## Phase 7 — Production Deployment

**Goal:** reproducible and safe production operation.

### Build
- Docker images + Compose baseline (required)
- Helm chart (optional milestone once stable)
- Rolling update strategy
- Horizontal scale hooks for worker pools

### Exit criteria
- Clean staging -> prod promotion path with rollback
- Upgrade runbook tested
- Zero data-loss across rolling restarts

---

## Phase 8 — Failure Engineering

**Goal:** prove reliability claims.

### Simulations
- Worker/node death
- Packet loss/latency spikes
- Corrupted chunk injection
- Queue outage/recovery
- DB failover scenario
- Network partitions

### Exit criteria
- Recovery playbooks documented and validated
- SLO compliance maintained or graceful degradation observed/documented
- Postmortem template used for each induced failure test

---

## 3) SLO and Error Budget Operating Policy

## SLOs (initial)
- API availability >= 99.9% successful non-5xx responses
- P95 metadata/read < 300ms
- P99 transfer-init/write < 1.0s
- Job success > 99.5% for admitted transfers (healthy swarm assumption)
- Verification accuracy = 100%
- Recovery time for 100 active transfers < 30s target (60s temporary acceptable for early phase)

## Error budget policy
- Burn < 20%: feature work continues
- Burn > 20% in 24h: incident investigation mandatory
- Budget exhausted: feature freeze, reliability-only work until restored

---

## 4) Product Interfaces (Open-Source Friendly)

## CLI (priority #1)
- `torrentedge send <path>`
- `torrentedge resume <transfer-id>`
- `torrentedge status <transfer-id>`
- `torrentedge workers list`

## API
- REST first; gRPC optional when needed for throughput/streaming ergonomics

## Dashboard (minimal)
- Transfer states
- Worker/node health
- Key metrics/log pointers

No heavy UI investment before operator-grade CLI/API is excellent.

---

## 5) Anti-Overengineering Rules

1. No microservice split until measurable bottleneck or team-scale pressure.
2. No Kafka requirement on day 1 if Redis streams/queue meets SLO.
3. No Kubernetes requirement for MVP; Compose deployment must remain first-class.
4. Every new subsystem must include: runbook + metrics + failure mode notes.
5. Reliability claims without chaos evidence are not accepted.

---

## 6) 90-Day Practical Plan

## Month 1
- Phase 1 core engine complete
- Checkpoint/retry/hash verification complete
- Crash-resume demo with large file

## Month 2
- Phase 2 distributed workers + leasing complete
- Node death recovery demo
- Queue lag and reassignment metrics live

## Month 3
- Phase 3 observability complete
- SLO dashboard + alerts + burn policy active
- First reliability report published

(Phase 4+ can start after 90-day baseline is stable.)

---

## 7) Definition of “Meaningful Open Source”

Project is considered meaningful when all are true:
- Fresh clone -> running stack in <= 30 minutes
- Large transfer crash-resume demo reproducible
- SLO dashboard and alerts available by default
- At least 5 operational runbooks exist
- Benchmark + tradeoff docs are published and honest

---

## 8) Immediate Next Actions (This Week)

1. Add this doc as canonical reliability plan.
2. Create `docs/reliability.md` with CUJ/SLO/error-budget tables.
3. Add issue labels: `reliability`, `slo`, `observability`, `failure-test`, `runbook`.
4. Open 10 tracked tasks for Phase 1 with measurable acceptance criteria.
5. Implement first chaos test: process kill during 20GB transfer and auto-resume proof.

---

## 9) Decision Log (Initial)

- Chosen priority: reliability-first over feature-first.
- Chosen architecture style: modular service boundaries with pragmatic deployment.
- Chosen delivery philosophy: prove claims with tests + chaos + metrics.
- Chosen OSS philosophy: operator usability (CLI/runbooks/docs) over UI polish.
