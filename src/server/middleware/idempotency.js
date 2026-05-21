/**
 * Phase 1.3 — Distributed Idempotency Service
 *
 * Prevents duplicate processing of retried client requests across
 * multiple API pods behind a load balancer.
 *
 * Strategy:
 *  - Uses Redis SETNX for distributed idempotency state.
 *  - Key   = `idempotency:<X-Request-ID>` from the client.
 *  - Value = JSON { status: 'in_flight' | 'completed', statusCode, body, completedAt }
 *
 * Flow:
 *  1. On first request with ID-X → Redis SETNX marks 'in_flight', process, store result.
 *  2. On retry with ID-X (before completion) → return 409 (still processing).
 *  3. On retry with ID-X (after completion) → return the cached 2xx result.
 *
 * Cache TTL: 24 hours (configurable via IDEMPOTENCY_TTL_MS env var).
 */

'use strict';

const redis = require('../db/redis');

const TTL_SECONDS = Math.floor(
  (parseInt(process.env.IDEMPOTENCY_TTL_MS, 10) || 24 * 60 * 60 * 1000) / 1000
);

const KEY_PREFIX = 'idempotency:';

/**
 * Distributed Idempotency Cache backed by Redis.
 * Safe across multiple API pods behind a load balancer.
 */
class IdempotencyCache {
  /**
   * Check if a request ID is already known.
   * @param {string} requestId
   * @returns {Promise<{ status: string, statusCode?: number, body?: object } | null>}
   */
  async get(requestId) {
    try {
      const raw = await redis.get(`${KEY_PREFIX}${requestId}`);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[Idempotency] Redis GET failed (non-fatal): ${err.message}`);
      return null;
    }
  }

  /**
   * Atomically mark a request as in-flight using SETNX.
   * Returns true if this pod won the race, false if another pod already claimed it.
   * @param {string} requestId
   * @returns {Promise<boolean>}
   */
  async markInFlight(requestId) {
    try {
      const value = JSON.stringify({
        status: 'in_flight',
        createdAt: Date.now(),
      });

      // NX = only set if key does NOT exist. EX = expire after TTL.
      const result = await redis.set(
        `${KEY_PREFIX}${requestId}`,
        value,
        'NX',
        'EX',
        TTL_SECONDS
      );

      return result === 'OK';
    } catch (err) {
      console.warn(`[Idempotency] Redis SETNX failed (non-fatal): ${err.message}`);
      // Fail-open: allow the request to proceed rather than block it
      return true;
    }
  }

  /**
   * Mark a request as completed and cache its result.
   * @param {string} requestId
   * @param {number} statusCode - HTTP status code
   * @param {object} body - Response body
   */
  async markCompleted(requestId, statusCode, body) {
    try {
      const value = JSON.stringify({
        status: 'completed',
        statusCode,
        body,
        completedAt: Date.now(),
      });

      await redis.set(
        `${KEY_PREFIX}${requestId}`,
        value,
        'EX',
        TTL_SECONDS
      );
    } catch (err) {
      console.warn(`[Idempotency] Redis SET completed failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Clear a request ID from cache (e.g. on terminal failure).
   * @param {string} requestId
   */
  async clear(requestId) {
    try {
      await redis.del(`${KEY_PREFIX}${requestId}`);
    } catch (err) {
      console.warn(`[Idempotency] Redis DEL failed (non-fatal): ${err.message}`);
    }
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
  return async (req, res, next) => {
    const id = req.requestId;

    // Skip if no request ID is provided (non-idempotent call)
    if (!id) return next();

    const existing = await idempotencyCache.get(id);

    if (existing) {
      if (existing.status === 'in_flight') {
        return res.status(409).json({
          error: 'Duplicate request',
          detail: 'A request with this X-Request-ID is already being processed.',
          requestId: id,
        });
      }

      if (existing.status === 'completed') {
        res.setHeader('X-Idempotency-Replayed', 'true');
        return res.status(existing.statusCode).json(existing.body);
      }
    }

    // Atomically claim this request ID
    const acquired = await idempotencyCache.markInFlight(id);
    if (!acquired) {
      // Another pod claimed it between our GET and SETNX — treat as in-flight
      return res.status(409).json({
        error: 'Duplicate request',
        detail: 'A request with this X-Request-ID is already being processed.',
        requestId: id,
      });
    }

    // Intercept res.json to cache the result
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Fire-and-forget: cache the completed result in Redis
      idempotencyCache.markCompleted(id, res.statusCode, body);
      return originalJson(body);
    };

    // Also intercept res.send for non-JSON responses
    const originalSend = res.send.bind(res);
    res.send = (body) => {
      // Only cache if we haven't already (res.json calls res.send internally)
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          idempotencyCache.markCompleted(id, res.statusCode, parsed);
        } catch {
          // Non-JSON response — cache as-is
          idempotencyCache.markCompleted(id, res.statusCode, { raw: body });
        }
      }
      return originalSend(body);
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
