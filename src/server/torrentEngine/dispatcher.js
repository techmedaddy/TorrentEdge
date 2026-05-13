'use strict';

/**
 * Phase 2.1 — Control Plane Dispatcher
 *
 * This module replaces direct `defaultEngine.addTorrent()` calls from
 * the API layer. Instead, the controller:
 *
 *   1. Writes the Transfer record to PostgreSQL.
 *   2. Calls Dispatcher.dispatch(directive) which publishes a
 *      JOB_ASSIGNED message to Kafka topic `torrent.jobs.dispatch`.
 *
 * In LOCAL mode (no Kafka), the dispatcher falls back to executing
 * the directive in-process against the local TorrentEngine singleton.
 * This ensures backward compatibility during the migration.
 */

const { DIRECTIVE_TYPES, TOPICS, buildDirective, validateDirective } = require('./jobDirective');
const { getProducer, hasProducer } = require('./kafkaProducer');

class Dispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.engine - The local TorrentEngine instance (fallback)
   * @param {boolean} opts.kafkaEnabled - Whether Kafka dispatch is active
   */
  constructor(opts = {}) {
    this._engine = opts.engine || null;
    this._kafkaEnabled = opts.kafkaEnabled || false;
    this._dispatchLog = []; // Last 100 dispatches for observability
    this._maxLog = 100;
  }

  /**
   * Dispatch a job directive to the Data Plane.
   *
   * @param {string} type - DIRECTIVE_TYPES.*
   * @param {object} payload - Transfer-specific data
   * @param {object} [meta] - Correlation metadata (requestId, userId, etc.)
   * @returns {Promise<{ dispatched: boolean, mode: 'kafka'|'local', directiveId: string }>}
   */
  async dispatch(type, payload, meta = {}) {
    const directive = buildDirective(type, payload, meta);
    const validation = validateDirective(directive);

    if (!validation.valid) {
      throw new Error(`Invalid directive: ${validation.error}`);
    }

    const directiveId = `${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    // Log for observability
    this._logDispatch(directiveId, directive);

    // ── Strategy: Kafka-first, local fallback ────────────────────────────
    if (this._kafkaEnabled && hasProducer()) {
      try {
        const producer = await getProducer();
        await producer.sendEvent({
          type,
          infoHash: payload.infoHash || payload.info_hash || 'system',
          timestamp: directive.timestamp,
          data: {
            ...payload,
            _directiveId: directiveId,
            _meta: directive.meta,
          },
        });

        console.log(`[Dispatcher] [Kafka] Dispatched ${type} → ${TOPICS.JOB_DISPATCH} (${directiveId})`);
        return { dispatched: true, mode: 'kafka', directiveId };

      } catch (kafkaErr) {
        console.warn(`[Dispatcher] Kafka dispatch failed, falling back to local: ${kafkaErr.message}`);
        // Fall through to local execution
      }
    }

    // ── Local execution (in-process) ─────────────────────────────────────
    if (this._engine) {
      await this._executeLocal(type, payload, meta);
      console.log(`[Dispatcher] [Local] Executed ${type} in-process (${directiveId})`);
      return { dispatched: true, mode: 'local', directiveId };
    }

    throw new Error(`[Dispatcher] Cannot dispatch ${type}: no Kafka and no local engine available`);
  }

  /**
   * Execute a directive against the local TorrentEngine instance.
   * This is the "shim" that bridges old direct-call patterns with
   * the new directive-based architecture.
   *
   * @private
   */
  async _executeLocal(type, payload, meta) {
    const engine = this._engine;

    switch (type) {
      case DIRECTIVE_TYPES.JOB_ASSIGNED: {
        const opts = {};
        if (payload.magnetUri)     opts.magnetURI     = payload.magnetUri;
        if (payload.torrentBuffer) opts.torrentBuffer  = payload.torrentBuffer;
        if (payload.torrentPath)   opts.torrentPath    = payload.torrentPath;
        if (payload.downloadPath)  opts.downloadPath   = payload.downloadPath;
        opts.autoStart  = payload.autoStart !== false;
        opts.priority   = payload.priority || 'normal';

        await engine.addTorrent(opts);
        break;
      }

      case DIRECTIVE_TYPES.JOB_PAUSED: {
        const torrent = engine.getTorrent(payload.infoHash);
        if (torrent && typeof torrent.pause === 'function') {
          torrent.pause();
        }
        break;
      }

      case DIRECTIVE_TYPES.JOB_RESUMED: {
        const torrent = engine.getTorrent(payload.infoHash);
        if (torrent && typeof torrent.resume === 'function') {
          torrent.resume();
        }
        break;
      }

      case DIRECTIVE_TYPES.JOB_CANCELLED: {
        await engine.removeTorrent(payload.infoHash, {
          deleteFiles: payload.deleteFiles || false,
        });
        break;
      }

      default:
        console.warn(`[Dispatcher] Unknown local directive type: ${type}`);
    }
  }

  /**
   * @private
   */
  _logDispatch(id, directive) {
    this._dispatchLog.push({
      id,
      type: directive.type,
      timestamp: directive.timestamp,
      meta: directive.meta,
    });
    if (this._dispatchLog.length > this._maxLog) {
      this._dispatchLog.shift();
    }
  }

  /**
   * Returns the last N dispatched directives for debugging.
   */
  getRecentDispatches(limit = 20) {
    return this._dispatchLog.slice(-limit);
  }
}

module.exports = Dispatcher;
