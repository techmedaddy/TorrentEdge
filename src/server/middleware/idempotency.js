/**
 * Phase 1.3 — Idempotency Service
 *
 * Prevents duplicate processing of retried client requests.
 *
 * Strategy:
 *  - The service uses an in-process LRU-style Map (no Redis dependency yet).
 *  - Key   = `X-Request-ID` from the client.
 *  - Value = { status: 'in_flight' | 'completed', result, completedAt }
 *
 * Flow:
 *  1. On first request with ID-X → mark 'in_flight', process, store result.
 *  2. On retry with ID-X (before completion) → return 409 (still processing).
 *  3. On retry with ID-X (after completion) → return the cached 2xx result.
 *
 * Cache TTL: 24 hours (configurable via IDEMPOTENCY_TTL_MS env var).
 * Max cache size: 10,000 entries.
 */

'use strict';

const TTL_MS = parseInt(process.env.IDEMPOTENCY_TTL_MS, 10) || 24 * 60 * 60 * 1000;
const MAX_SIZE = 10_000;

class IdempotencyCache {
  constructor() {
    this._cache = new Map();
  }

  /**
   * Check if a request ID is already known.
   * @param {string} requestId
   * @returns {{ status: string, result?: object } | null}
   */
  get(requestId) {
    const entry = this._cache.get(requestId);
    if (!entry) return null;

    // Evict if expired
    if (Date.now() - entry.createdAt > TTL_MS) {
      this._cache.delete(requestId);
      return null;
    }

    return entry;
  }

  /**
   * Mark a request as in-flight.
   * @param {string} requestId
   */
  markInFlight(requestId) {
    this._evictOldest();
    this._cache.set(requestId, {
      status: 'in_flight',
      createdAt: Date.now()
    });
  }

  /**
   * Mark a request as completed and cache its result.
   * @param {string} requestId
   * @param {number} statusCode - HTTP status code
   * @param {object} body - Response body
   */
  markCompleted(requestId, statusCode, body) {
    const entry = this._cache.get(requestId);
    if (entry) {
      entry.status = 'completed';
      entry.statusCode = statusCode;
      entry.body = body;
      entry.completedAt = Date.now();
    }
  }

  /**
   * Clear a request ID from cache (e.g. on terminal failure).
   * @param {string} requestId
   */
  clear(requestId) {
    this._cache.delete(requestId);
  }

  /**
   * Evicts the oldest entry when cache is full.
   * @private
   */
  _evictOldest() {
    if (this._cache.size >= MAX_SIZE) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
  }

  get size() {
    return this._cache.size;
  }
}

// Singleton
const idempotencyCache = new IdempotencyCache();

/**
 * Express middleware factory.
 * Wrap specific routes that need idempotency protection.
 *
 * Usage:
 *   router.post('/create-from-file', idempotencyGuard(), controller.createTorrentFromFile);
 */
function idempotencyGuard() {
  return (req, res, next) => {
    const id = req.requestId;

    // Skip if no request ID is provided (non-idempotent call)
    if (!id) return next();

    const existing = idempotencyCache.get(id);

    if (existing) {
      if (existing.status === 'in_flight') {
        return res.status(409).json({
          error: 'Duplicate request',
          detail: 'A request with this X-Request-ID is already being processed.',
          requestId: id
        });
      }

      if (existing.status === 'completed') {
        res.setHeader('X-Idempotency-Replayed', 'true');
        return res.status(existing.statusCode).json(existing.body);
      }
    }

    // First time: mark in-flight and intercept the response
    idempotencyCache.markInFlight(id);

    // Intercept res.json to cache the result
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      idempotencyCache.markCompleted(id, res.statusCode, body);
      return originalJson(body);
    };

    // On error, clear the in-flight entry so retries are allowed
    res.on('finish', () => {
      if (res.statusCode >= 500) {
        idempotencyCache.clear(id);
      }
    });

    next();
  };
}

module.exports = { idempotencyGuard, idempotencyCache };
