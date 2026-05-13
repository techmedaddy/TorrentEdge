'use strict';

/**
 * Phase 2.1 — Job Directive Protocol
 *
 * Defines the canonical message types that flow between the
 * Control Plane (API Gateway) and Data Plane (Worker Nodes)
 * over the Kafka event bus.
 *
 * The Control Plane NEVER touches the BitTorrent engine directly.
 * It publishes Job Directives. Workers consume and execute them.
 */

const DIRECTIVE_TYPES = Object.freeze({
  // ═══════════════════════════════════════════════════════════
  // Control Plane → Worker (torrent.jobs.dispatch)
  // ═══════════════════════════════════════════════════════════
  JOB_ASSIGNED:   'JOB_ASSIGNED',   // Start a new transfer
  JOB_PAUSED:     'JOB_PAUSED',     // Pause an active transfer
  JOB_RESUMED:    'JOB_RESUMED',    // Resume a paused transfer
  JOB_CANCELLED:  'JOB_CANCELLED',  // Cancel and clean up a transfer

  // ═══════════════════════════════════════════════════════════
  // Worker → Control Plane (torrent.events.lifecycle)
  // ═══════════════════════════════════════════════════════════
  TRANSFER_STARTED:    'TRANSFER_STARTED',
  TRANSFER_PROGRESS:   'TRANSFER_PROGRESS',
  TRANSFER_COMPLETED:  'TRANSFER_COMPLETED',
  TRANSFER_FAILED:     'TRANSFER_FAILED',
  TRANSFER_PAUSED:     'TRANSFER_PAUSED',
  TRANSFER_RESUMED:    'TRANSFER_RESUMED',
  CHUNK_VERIFIED:      'CHUNK_VERIFIED',
  CHUNK_FAILED:        'CHUNK_FAILED',

  // ═══════════════════════════════════════════════════════════
  // Worker → Observability (torrent.telemetry.stats)
  // ═══════════════════════════════════════════════════════════
  STATS_UPDATE:        'STATS_UPDATE',
  WORKER_HEARTBEAT:    'WORKER_HEARTBEAT',
});

const TOPICS = Object.freeze({
  JOB_DISPATCH:  'torrent.jobs.dispatch',
  LIFECYCLE:     'torrent.events.lifecycle',
  TELEMETRY:     'torrent.telemetry.stats',
});

/**
 * Builds a Job Directive message envelope.
 *
 * @param {string} type - One of DIRECTIVE_TYPES
 * @param {object} payload - Event-specific data
 * @param {object} [meta] - Optional metadata (requestId, nodeId, etc.)
 * @returns {{ type, payload, meta, timestamp }}
 */
function buildDirective(type, payload, meta = {}) {
  if (!DIRECTIVE_TYPES[type]) {
    throw new Error(`Unknown directive type: ${type}`);
  }

  return {
    type,
    payload,
    meta: {
      requestId: meta.requestId || null,
      nodeId:    meta.nodeId    || null,
      version:   '1.0',
      ...meta,
    },
    timestamp: Date.now(),
  };
}

/**
 * Validates an incoming directive envelope.
 * @param {object} msg
 * @returns {{ valid: boolean, error?: string }}
 */
function validateDirective(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, error: 'Directive must be an object' };
  }
  if (!msg.type || !DIRECTIVE_TYPES[msg.type]) {
    return { valid: false, error: `Unknown or missing directive type: ${msg.type}` };
  }
  if (!msg.payload || typeof msg.payload !== 'object') {
    return { valid: false, error: 'Directive must have a payload object' };
  }
  if (!msg.timestamp || typeof msg.timestamp !== 'number') {
    return { valid: false, error: 'Directive must have a numeric timestamp' };
  }
  return { valid: true };
}

module.exports = { DIRECTIVE_TYPES, TOPICS, buildDirective, validateDirective };
