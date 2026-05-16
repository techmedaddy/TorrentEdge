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
const { SpanStatusCode } = require('@opentelemetry/api');
const { DIRECTIVE_TYPES, TOPICS, buildDirective, validateDirective } = require('./jobDirective');
const LeaseManager = require('./leaseManager');
const metrics = require('../observability/metrics');
const tracing = require('../observability/tracing');

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
        switch (type) {
          case DIRECTIVE_TYPES.JOB_ASSIGNED:
            await this._handleJobAssigned(payload, meta);
            break;

          case DIRECTIVE_TYPES.JOB_PAUSED:
            await this._handleJobPaused(payload, meta);
            break;

          case DIRECTIVE_TYPES.JOB_RESUMED:
            await this._handleJobResumed(payload, meta);
            break;

          case DIRECTIVE_TYPES.JOB_CANCELLED:
            await this._handleJobCancelled(payload, meta);
            break;

          default:
            console.warn(`[Worker:${this._nodeId}] Unhandled directive type: ${type}`);
        }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Directive Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  async _handleJobAssigned(payload, meta) {
    const opts = {};
    if (payload.magnetUri)     opts.magnetURI     = payload.magnetUri;
    if (payload.torrentBuffer) opts.torrentBuffer  = Buffer.isBuffer(payload.torrentBuffer) 
                                                       ? payload.torrentBuffer 
                                                       : Buffer.from(payload.torrentBuffer, 'base64');
    if (payload.torrentPath)   opts.torrentPath    = payload.torrentPath;
    if (payload.downloadPath)  opts.downloadPath   = payload.downloadPath;
    opts.autoStart = payload.autoStart !== false;
    opts.priority  = payload.priority || 'normal';

    const torrent = await this._engine.addTorrent(opts);

    // Phase 2.2: Acquire lease
    const acquired = await LeaseManager.acquireLease(torrent.infoHash, this._nodeId);
    if (!acquired) {
      console.warn(`[Worker:${this._nodeId}] Failed to acquire lease for new job ${torrent.infoHash}. Removing...`);
      await this._engine.removeTorrent(torrent.infoHash);
      throw new Error(`Lease denied for ${torrent.infoHash}`);
    }

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

  async _handleJobPaused(payload, meta) {
    const torrent = this._engine.getTorrent(payload.infoHash);
    if (!torrent) {
      throw new Error(`Torrent not found: ${payload.infoHash}`);
    }
    torrent.pause();

    // Phase 2.2: Release lease
    await LeaseManager.releaseLease(payload.infoHash, this._nodeId);

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

      // Phase 2.2: Renew leases for all active torrents
      if (this._engine) {
        for (const [infoHash, torrent] of this._engine.torrents.entries()) {
          // Only renew if not paused/stopped
          if (torrent.state !== 'paused' && torrent.state !== 'stopped' && torrent.state !== 'error') {
            const renewed = await LeaseManager.renewLease(infoHash, this._nodeId);
            if (!renewed) {
              console.warn(`[Worker:${this._nodeId}] Lost lease for ${infoHash}! Pausing torrent to prevent split-brain.`);
              torrent.pause();
            }
          }
        }
      }

      this.emit('heartbeat', buildDirective(
        DIRECTIVE_TYPES.WORKER_HEARTBEAT,
        {
          nodeId:          this._nodeId,
          processedCount:  this._processedCount,
          failedCount:     this._failedCount,
          activeTorrents:  stats.activeTorrents || 0,
          downloadSpeed:   stats.totalDownloadSpeed || 0,
          uploadSpeed:     stats.totalUploadSpeed || 0,
          uptime:          process.uptime(),
        },
        { nodeId: this._nodeId }
      ));

      metrics.recordWorkerHeartbeat(this._nodeId);
    }, this._heartbeatIntervalMs);

    if (this._heartbeatTimer.unref) {
      this._heartbeatTimer.unref();
    }
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
    };
  }
}

module.exports = WorkerConsumer;
