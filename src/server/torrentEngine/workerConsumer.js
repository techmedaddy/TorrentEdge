'use strict';

/**
 * Phase 2.1 — Worker Node Consumer
 *
 * In the target distributed architecture, this runs as a standalone
 * process on each worker node. It:
 *
 *   1. Subscribes to `torrent.jobs.dispatch` Kafka topic.
 *   2. Validates incoming Job Directives.
 *   3. Executes them against a local TorrentEngine instance.
 *   4. Publishes lifecycle events back to `torrent.events.lifecycle`.
 *   5. Publishes stats updates to `torrent.telemetry.stats`.
 *
 * In LOCAL mode (Phase 2 migration), the worker is embedded within
 * the same process as the API server and the Dispatcher calls it
 * directly via the `_executeLocal` shim.
 */

const EventEmitter = require('events');
let SpanStatusCode;
try { SpanStatusCode = require('@opentelemetry/api').SpanStatusCode; } catch { SpanStatusCode = { ERROR: 2 }; }
const { DIRECTIVE_TYPES, TOPICS, buildDirective, validateDirective } = require('./jobDirective');
const LeaseManager = require('./leaseManager');
const InternalPeerDiscovery = require('./internalPeerDiscovery');
const PeerRegistry = require('./peerRegistry');
const DeduplicationService = require('./deduplicationService');
const S3ColdStartStreamer = require('./s3Streamer');
let metrics, tracing;
try { metrics = require('../observability/metrics'); } catch { metrics = { recordWorkerDirective: () => {}, recordWorkerHeartbeat: () => {} }; }
try { tracing = require('../observability/tracing'); } catch { tracing = { withSpan: (n, a, fn) => fn({ setStatus: () => {}, recordException: () => {}, setAttribute: () => {} }) }; }

class WorkerConsumer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.engine - The TorrentEngine instance this worker controls
   * @param {string} opts.nodeId - Unique identifier for this worker node
   * @param {object} [opts.kafka] - Kafka consumer config (null = local-only mode)
   */
  constructor(opts = {}) {
    super();

    this._engine = opts.engine;
    this._nodeId = opts.nodeId || `worker-${process.pid}`;
    this._kafkaConfig = opts.kafka || null;
    this._consumer = null;
    this._isRunning = false;
    this._processedCount = 0;
    this._failedCount = 0;

    // Heartbeat interval (every 10s)
    this._heartbeatTimer = null;
    this._heartbeatIntervalMs = 10_000;

    // Phase 4.1: Internal peer discovery
    this._peerDiscovery = new InternalPeerDiscovery({
      nodeId: this._nodeId,
      nodeIp: process.env.WORKER_IP || '127.0.0.1',
      bittorrentPort: parseInt(process.env.BT_PORT) || 6881,
    });

    // Phase 4.2: Deduplication service
    this._dedup = new DeduplicationService({
      downloadPath: opts.engine?.downloadPath || process.env.DOWNLOAD_PATH || './downloads',
    });

    // Flow control backpressure
    this._isPaused = false;
  }

  /**
   * Starts the worker consumer.
   * In Kafka mode, subscribes to the dispatch topic.
   * In local mode, just registers the heartbeat.
   */
  async start() {
    if (this._isRunning) return;
    this._isRunning = true;

    console.log(`[Worker:${this._nodeId}] Starting worker consumer`);

    // Start heartbeat
    this._startHeartbeat();

    if (this._kafkaConfig) {
      await this._startKafkaConsumer();
    } else {
      console.log(`[Worker:${this._nodeId}] Running in LOCAL mode (no Kafka consumer)`);
    }

    this.emit('started', { nodeId: this._nodeId });
    console.log(`[Worker:${this._nodeId}] Worker consumer started`);
  }

  /**
   * Processes a single Job Directive. Called either by the Kafka
   * consumer loop or directly by the Dispatcher in local mode.
   *
   * @param {object} directive - A validated Job Directive envelope
   */
  async processDirective(directive) {
    return tracing.withSpan('worker.directive', {
      'torrentedge.worker.node_id': this._nodeId,
      'torrentedge.directive.type': directive?.type || 'unknown',
      'torrentedge.request_id': directive?.meta?.requestId || undefined,
    }, async (span) => {
      const validation = validateDirective(directive);
      if (!validation.valid) {
        console.error(`[Worker:${this._nodeId}] Invalid directive: ${validation.error}`);
        this._failedCount++;
        metrics.recordWorkerDirective({ type: directive?.type || 'unknown', result: 'invalid' });
        span.setStatus({ code: SpanStatusCode.ERROR, message: validation.error });
        return;
      }

      const { type, payload, meta } = directive;
      console.log(`[Worker:${this._nodeId}] Processing: ${type} (requestId: ${meta?.requestId || 'none'})`);

      try {
        await this._dispatchDirective(type, payload, meta);
        this._processedCount++;
        metrics.recordWorkerDirective({ type, result: 'success' });
      } catch (err) {
        console.error(`[Worker:${this._nodeId}] Directive ${type} failed: ${err.message}`);
        this._failedCount++;
        metrics.recordWorkerDirective({ type, result: 'error' });
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

        // Emit failure event back to Control Plane
        this.emit('directive:failed', {
          type,
          payload,
          error: err.message,
          nodeId: this._nodeId,
        });
      }
    });
  }

  async _dispatchDirective(type, payload, meta) {
    const handler = this._getDirectiveHandler(type);
    if (!handler) {
      console.warn(`[Worker:${this._nodeId}] Unhandled directive type: ${type}`);
      return;
    }

    await handler(payload, meta);
  }

  _getDirectiveHandler(type) {
    const handlers = {
      [DIRECTIVE_TYPES.JOB_ASSIGNED]: this._handleJobAssigned.bind(this),
      [DIRECTIVE_TYPES.JOB_PAUSED]: this._handleJobPaused.bind(this),
      [DIRECTIVE_TYPES.JOB_RESUMED]: this._handleJobResumed.bind(this),
      [DIRECTIVE_TYPES.JOB_CANCELLED]: this._handleJobCancelled.bind(this),
    };

    return handlers[type];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Directive Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  async _handleJobAssigned(payload, meta) {
    const opts = this._buildTorrentOptions(payload);
    const torrent = await this._engine.addTorrent(opts);

    await this._ensureLease(torrent);
    await this._startPeerDiscovery(torrent);
    await this._prePopulateDedup(torrent);
    await this._maybeStartColdStart(payload, torrent, opts.downloadPath);

    this.emit('lifecycle', buildDirective(
      DIRECTIVE_TYPES.TRANSFER_STARTED,
      {
        infoHash:    torrent.infoHash,
        name:        torrent.name,
        size:        torrent.size,
        transferId:  payload.transferId,
      },
      { nodeId: this._nodeId, requestId: meta?.requestId }
    ));
  }

  _buildTorrentOptions(payload) {
    const opts = {};
    if (payload.magnetUri) opts.magnetURI = payload.magnetUri;
    if (payload.torrentBuffer) {
      opts.torrentBuffer = Buffer.isBuffer(payload.torrentBuffer)
        ? payload.torrentBuffer
        : Buffer.from(payload.torrentBuffer, 'base64');
    }
    if (payload.torrentPath) opts.torrentPath = payload.torrentPath;
    if (payload.downloadPath) opts.downloadPath = payload.downloadPath;
    opts.autoStart = payload.autoStart !== false;
    opts.priority = payload.priority || 'normal';
    return opts;
  }

  async _ensureLease(torrent) {
    const fencingToken = await LeaseManager.acquireLease(torrent.infoHash, this._nodeId);
    if (fencingToken !== null) {
      return;
    }
    console.warn(`[Worker:${this._nodeId}] Failed to acquire lease for new job ${torrent.infoHash}. Removing...`);
    await this._engine.removeTorrent(torrent.infoHash);
    throw new Error(`Lease denied for ${torrent.infoHash}`);
  }

  async _startPeerDiscovery(torrent) {
    try {
      if (torrent.peerManager) {
        await this._peerDiscovery.startDiscovery(torrent.infoHash, torrent.peerManager, {
          completedPieces: 0,
          totalPieces: torrent.numPieces || 0,
        });
      }
    } catch (discoveryErr) {
      console.warn(`[Worker:${this._nodeId}] Internal peer discovery failed (non-fatal): ${discoveryErr.message}`);
    }
  }

  async _prePopulateDedup(torrent) {
    try {
      if (!torrent.fileWriter || !torrent.pieceLength) {
        return;
      }

      const dedupResult = await this._dedup.prePopulate(
        torrent.infoHash,
        torrent.fileWriter,
        torrent.pieceLength
      );
      if (dedupResult.deduped.length === 0) {
        return;
      }

      for (const pieceIndex of dedupResult.deduped) {
        if (torrent.pieceManager) {
          torrent.pieceManager.markComplete(pieceIndex);
        }
      }
      console.log(`[Worker:${this._nodeId}] Dedup saved ${dedupResult.deduped.length} pieces for ${torrent.infoHash.substring(0, 8)}`);
    } catch (dedupErr) {
      console.warn(`[Worker:${this._nodeId}] Dedup pre-populate failed (non-fatal): ${dedupErr.message}`);
    }
  }

  async _maybeStartColdStart(payload, torrent, downloadPathOverride) {
    if (!payload.sourceUri) {
      return;
    }

    try {
      const activePeers = torrent.peerManager ? torrent.peerManager.getConnectedCount() : 0;
      if (activePeers > 0) {
        console.log(`[Worker:${this._nodeId}] ${activePeers} active peers found. Skipping S3 Cold Start.`);
        return;
      }

      console.log(`[Worker:${this._nodeId}] Zero seeders detected for ${torrent.infoHash.substring(0, 8)}. Initiating S3 Cold Start Bridge.`);
      const streamer = new S3ColdStartStreamer({
        torrent,
        sourceUri: payload.sourceUri,
        nodeId: this._nodeId,
        downloadPath: downloadPathOverride || process.env.DOWNLOAD_PATH || './downloads',
      });

      this._clearMetadataTimeout(torrent);
      this._runColdStart(streamer, torrent);
    } catch (coldStartErr) {
      console.warn(`[Worker:${this._nodeId}] S3 Cold Start setup failed (non-fatal): ${coldStartErr.message}`);
    }
  }

  _clearMetadataTimeout(torrent) {
    const clearS3Timeout = setInterval(() => {
      if (torrent._metadataTimeout) {
        clearTimeout(torrent._metadataTimeout);
        torrent._metadataTimeout = null;
        clearInterval(clearS3Timeout);
      }
    }, 100);
    setTimeout(() => clearInterval(clearS3Timeout), 5000);
  }

  _runColdStart(streamer, torrent) {
    streamer.start()
      .then((result) => {
        if (result.piecesWritten > 0) {
          console.log(`[Worker:${this._nodeId}] S3 Cold Start finished: ${result.piecesWritten} pieces, ${(result.bytesStreamed / 1048576).toFixed(1)}MB`);
        }
        this._forceSeeding(torrent);
        this.emit('lifecycle', buildDirective(
          DIRECTIVE_TYPES.TRANSFER_COMPLETED,
          { infoHash: torrent.infoHash, name: torrent.name, size: result.bytesStreamed },
          { nodeId: this._nodeId }
        ));
      })
      .catch((err) => {
        console.error(`[Worker:${this._nodeId}] S3 Cold Start failed (non-fatal): ${err.message}`);
        torrent._state = 'error';
        torrent.emit('error', new Error(`S3 Stream Failed: ${err.message}`));

        this.emit('lifecycle', buildDirective(
          DIRECTIVE_TYPES.TRANSFER_FAILED,
          { infoHash: torrent.infoHash, name: torrent.name, error: err.message },
          { nodeId: this._nodeId }
        ));
      });
  }

  _forceSeeding(torrent) {
    if (torrent._state === 'seeding') {
      return;
    }

    if (typeof torrent._transitionToSeeding === 'function') {
      torrent._transitionToSeeding();
      return;
    }

    torrent._state = 'seeding';
    torrent.progress = 1;
  }

  async _handleJobPaused(payload, meta) {
    const torrent = this._engine.getTorrent(payload.infoHash);
    if (!torrent) {
      throw new Error(`Torrent not found: ${payload.infoHash}`);
    }
    torrent.pause();

    // Phase 2.2: Release lease
    await LeaseManager.releaseLease(payload.infoHash, this._nodeId);

    // Phase 4.1: Deregister from peer registry
    await this._peerDiscovery.stopDiscovery(payload.infoHash).catch(() => {});

    this.emit('lifecycle', buildDirective(
      DIRECTIVE_TYPES.TRANSFER_PAUSED,
      { infoHash: payload.infoHash },
      { nodeId: this._nodeId, requestId: meta?.requestId }
    ));
  }

  async _handleJobResumed(payload, meta) {
    const torrent = this._engine.getTorrent(payload.infoHash);
    if (!torrent) {
      throw new Error(`Torrent not found: ${payload.infoHash}`);
    }

    // Phase 2.2: Acquire lease
    const acquired = await LeaseManager.acquireLease(payload.infoHash, this._nodeId);
    if (!acquired) {
      throw new Error(`Failed to acquire lease for resume ${payload.infoHash}`);
    }

    torrent.resume();

    // Phase 4.1: Re-register in peer registry
    try {
      if (torrent.peerManager) {
        await this._peerDiscovery.startDiscovery(payload.infoHash, torrent.peerManager);
      }
    } catch (discoveryErr) {
      console.warn(`[Worker:${this._nodeId}] Internal peer discovery on resume failed (non-fatal): ${discoveryErr.message}`);
    }

    this.emit('lifecycle', buildDirective(
      DIRECTIVE_TYPES.TRANSFER_RESUMED,
      { infoHash: payload.infoHash },
      { nodeId: this._nodeId, requestId: meta?.requestId }
    ));
  }

  async _handleJobCancelled(payload, meta) {
    await this._engine.removeTorrent(payload.infoHash, {
      deleteFiles: payload.deleteFiles || false,
    });

    // Phase 2.2: Release lease
    await LeaseManager.releaseLease(payload.infoHash, this._nodeId);

    // Phase 4.1: Deregister from peer registry
    await this._peerDiscovery.stopDiscovery(payload.infoHash).catch(() => {});

    this.emit('lifecycle', buildDirective(
      DIRECTIVE_TYPES.TRANSFER_COMPLETED,
      { infoHash: payload.infoHash, reason: 'cancelled' },
      { nodeId: this._nodeId, requestId: meta?.requestId }
    ));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Kafka Integration
  // ═══════════════════════════════════════════════════════════════════════════

  async _startKafkaConsumer() {
    try {
      const { Kafka } = require('kafkajs');

      const kafka = new Kafka({
        clientId: `torrentedge-worker-${this._nodeId}`,
        brokers: this._kafkaConfig.brokers || ['localhost:9092'],
      });

      this._consumer = kafka.consumer({
        groupId: this._kafkaConfig.groupId || 'torrentedge-workers',
      });

      await this._consumer.connect();
      await this._consumer.subscribe({
        topic: TOPICS.JOB_DISPATCH,
        fromBeginning: false,
      });

      await this._consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const parentContext = tracing.extractKafkaContext(message.headers || {});
          const messageTypeHeader = message.headers?.directiveType || message.headers?.eventType;
          const messageType = Buffer.isBuffer(messageTypeHeader)
            ? messageTypeHeader.toString()
            : (messageTypeHeader ? String(messageTypeHeader) : 'unknown');
          const endTimer = metrics.startKafkaTimer('consumer', topic, messageType);

          await tracing.withSpan('kafka.consume', {
            'messaging.system': 'kafka',
            'messaging.destination.name': topic,
            'messaging.operation': 'process',
            'messaging.kafka.partition': partition,
            'torrentedge.kafka.message_type': messageType,
          }, async (span) => {
            try {
              const directive = JSON.parse(message.value.toString());
              span.setAttribute('torrentedge.directive.type', directive.type || messageType);
              await this.processDirective(directive);
              metrics.recordKafkaMessage({
                boundary: 'consumer',
                topic,
                type: directive.type || messageType,
                result: 'success',
              });
              endTimer('success');
            } catch (parseErr) {
              console.error(`[Worker:${this._nodeId}] Failed to parse Kafka message: ${parseErr.message}`);
              this._failedCount++;
              metrics.recordKafkaMessage({
                boundary: 'consumer',
                topic,
                type: messageType,
                result: 'error',
              });
              endTimer('error');
              span.recordException(parseErr);
              span.setStatus({ code: SpanStatusCode.ERROR, message: parseErr.message });
            }
          }, parentContext);
        },
      });

      console.log(`[Worker:${this._nodeId}] Kafka consumer subscribed to ${TOPICS.JOB_DISPATCH}`);

      // Listen for mid-flight Kafka crashes (e.g. broker goes down 3 hours later)
      // Without this, the worker becomes a zombie that K8s doesn't know is dead
      this._consumer.on('consumer.crash', async ({ payload }) => {
        console.error(`[Worker:${this._nodeId}] FATAL: Kafka consumer crashed: ${payload?.error?.message}`);
        console.error(`[Worker:${this._nodeId}] Exiting to allow K8s to restart the pod...`);
        process.exit(1);
      });

    } catch (err) {
      console.error(`[Worker:${this._nodeId}] Kafka consumer failed: ${err.message}`);
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Heartbeat & Stats
  // ═══════════════════════════════════════════════════════════════════════════

  _startHeartbeat() {
    if (this._heartbeatTimer) return;

    this._heartbeatTimer = setInterval(async () => {
      const stats = this._engine ? this._engine.getGlobalStats() : {};
      const activeTorrentsCount = stats.activeTorrents || 0;

      // --- Flow Control / Backpressure Implementation ---
      this._applyBackpressure(activeTorrentsCount);

      // Phase 2.2: Bulk renew leases for all active torrents in a single pipeline
      // Phase 4.1: Refresh peer registry TTLs
      const activeInfoHashes = this._collectActiveInfoHashes();
      await this._renewLeases(activeInfoHashes);
      await this._refreshPeerRegistry(activeInfoHashes);
      this._emitHeartbeat(stats);
      metrics.recordWorkerHeartbeat(this._nodeId);
    }, this._heartbeatIntervalMs);

    if (this._heartbeatTimer.unref) {
      this._heartbeatTimer.unref();
    }
  }

  _applyBackpressure(activeTorrentsCount) {
    if (!this._consumer) return;

    const maxCapacity = parseInt(process.env.WORKER_MAX_CAPACITY, 10) || 20;

    if (activeTorrentsCount >= maxCapacity && !this._isPaused) {
      console.warn(`[Worker:${this._nodeId}] BACKPRESSURE: Node at capacity (${activeTorrentsCount}/${maxCapacity}). Pausing Kafka consumption.`);
      this._consumer.pause([{ topic: TOPICS.JOB_DISPATCH }]);
      this._isPaused = true;
      return;
    }

    if (activeTorrentsCount < maxCapacity * 0.8 && this._isPaused) {
      console.log(`[Worker:${this._nodeId}] BACKPRESSURE: Capacity available (${activeTorrentsCount}/${maxCapacity}). Resuming Kafka consumption.`);
      this._consumer.resume([{ topic: TOPICS.JOB_DISPATCH }]);
      this._isPaused = false;
    }
  }

  _collectActiveInfoHashes() {
    const activeInfoHashes = [];
    if (!this._engine) return activeInfoHashes;

    for (const [infoHash, torrent] of this._engine.torrents.entries()) {
      if (torrent.state !== 'paused' && torrent.state !== 'stopped' && torrent.state !== 'error') {
        activeInfoHashes.push(infoHash);
      }
    }

    return activeInfoHashes;
  }

  async _renewLeases(activeInfoHashes) {
    if (!this._engine || activeInfoHashes.length === 0) return;

    const results = await LeaseManager.renewLeasesBulk(activeInfoHashes, this._nodeId);
    for (let i = 0; i < activeInfoHashes.length; i++) {
      if (results[i] === null) {
        const lostHash = activeInfoHashes[i];
        console.warn(`[Worker:${this._nodeId}] Lost lease for ${lostHash}! Pausing torrent to prevent split-brain.`);
        const torrent = this._engine.torrents.get(lostHash);
        if (torrent) torrent.pause();
        await this._peerDiscovery.stopDiscovery(lostHash).catch(() => {});
      }
    }
  }

  async _refreshPeerRegistry(activeInfoHashes) {
    if (!this._engine || activeInfoHashes.length === 0) return;
    await PeerRegistry.refreshAll(this._nodeId, activeInfoHashes).catch(() => {});
  }

  _emitHeartbeat(stats) {
    this.emit('heartbeat', buildDirective(
      DIRECTIVE_TYPES.WORKER_HEARTBEAT,
      {
        nodeId: this._nodeId,
        processedCount: this._processedCount,
        failedCount: this._failedCount,
        activeTorrents: stats.activeTorrents || 0,
        downloadSpeed: stats.totalDownloadSpeed || 0,
        uploadSpeed: stats.totalUploadSpeed || 0,
        uptime: process.uptime(),
      },
      { nodeId: this._nodeId }
    ));
  }

  /**
   * Graceful shutdown.
   */
  async stop() {
    if (!this._isRunning) return;
    this._isRunning = false;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this._consumer) {
      await this._consumer.disconnect();
      this._consumer = null;
    }

    // Phase 4.1: Shutdown peer discovery
    await this._peerDiscovery.shutdown().catch(() => {});

    console.log(`[Worker:${this._nodeId}] Worker consumer stopped (processed: ${this._processedCount}, failed: ${this._failedCount})`);
    this.emit('stopped', { nodeId: this._nodeId });
  }

  getStats() {
    return {
      nodeId:         this._nodeId,
      isRunning:      this._isRunning,
      processedCount: this._processedCount,
      failedCount:    this._failedCount,
      hasKafka:       !!this._consumer,
      peerDiscovery:  this._peerDiscovery.getStats(),
      deduplication:  this._dedup.getStats(),
    };
  }
}

module.exports = WorkerConsumer;
