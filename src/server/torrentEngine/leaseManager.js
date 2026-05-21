'use strict';

const redis = require('../db/redis');

/**
 * Phase 2.2 — Distributed Lease Manager (with Fencing Tokens)
 *
 * Implements a distributed lock in Redis for Torrent Ownership.
 * Ensures that only one worker node can execute a specific transfer at any given time.
 *
 * Fencing Token (Fix #6):
 *   Every lease acquisition/renewal increments a monotonic fencing token.
 *   Workers must pass their token when writing to disk. If the token doesn't
 *   match the current value in Redis, the write is rejected — preventing
 *   stale workers from corrupting data after their lease expired.
 */
class LeaseManager {
  /**
   * Tries to acquire a lease for a transfer.
   * Returns the fencing token on success, or null on failure.
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {string} nodeId - The worker node claiming the transfer.
   * @param {number} ttlSeconds - Lease duration in seconds (default: 30s).
   * @returns {Promise<number|null>} Fencing token if acquired, null otherwise.
   */
  static async acquireLease(infoHash, nodeId, ttlSeconds = 30) {
    const leaseKey = `lease:transfer:${infoHash}`;
    const tokenKey = `lease:token:${infoHash}`;

    // Atomic Lua: set lease only if not exists, then increment fencing token
    const luaScript = `
      local current = redis.call("get", KEYS[1])
      if current == false then
        redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2])
        local token = redis.call("incr", KEYS[2])
        redis.call("expire", KEYS[2], ARGV[2])
        return token
      elseif current == ARGV[1] then
        -- We already own it, refresh TTL and return current token
        redis.call("expire", KEYS[1], ARGV[2])
        redis.call("expire", KEYS[2], ARGV[2])
        local token = redis.call("get", KEYS[2])
        return tonumber(token)
      else
        return -1
      end
    `;

    const result = await redis.eval(luaScript, 2, leaseKey, tokenKey, nodeId, ttlSeconds);

    if (result === -1) {
      return null; // Another node holds the lease
    }

    return Number(result);
  }

  /**
   * Renews an existing lease and returns the current fencing token.
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {string} nodeId - The worker node renewing the lease.
   * @param {number} ttlSeconds - Lease duration in seconds.
   * @returns {Promise<number|null>} Fencing token if renewed, null if lease was lost.
   */
  static async renewLease(infoHash, nodeId, ttlSeconds = 30) {
    const leaseKey = `lease:transfer:${infoHash}`;
    const tokenKey = `lease:token:${infoHash}`;

    // Atomic Lua: renew only if the node is still the owner
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("expire", KEYS[1], ARGV[2])
        redis.call("expire", KEYS[2], ARGV[2])
        local token = redis.call("get", KEYS[2])
        return tonumber(token)
      else
        return -1
      end
    `;

    const result = await redis.eval(luaScript, 2, leaseKey, tokenKey, nodeId, ttlSeconds);

    if (result === -1) {
      return null; // Lease lost
    }

    return Number(result);
  }

  /**
   * Validates that a worker's fencing token is still current.
   * Call this before any critical disk/CAS write.
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {number} token - The worker's fencing token.
   * @returns {Promise<boolean>} True if the token is still valid.
   */
  static async validateToken(infoHash, token) {
    const tokenKey = `lease:token:${infoHash}`;
    const currentToken = await redis.get(tokenKey);
    return currentToken !== null && Number(currentToken) === token;
  }

  /**
   * Releases a lease voluntarily (e.g., when transfer is paused, completed, or cancelled).
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {string} nodeId - The worker node releasing the lease.
   * @returns {Promise<boolean>} True if successfully released.
   */
  static async releaseLease(infoHash, nodeId) {
    const leaseKey = `lease:transfer:${infoHash}`;
    const tokenKey = `lease:token:${infoHash}`;

    // Atomic Lua: delete both keys only if the node is still the owner
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("del", KEYS[1])
        redis.call("del", KEYS[2])
        return 1
      else
        return 0
      end
    `;

    const result = await redis.eval(luaScript, 2, leaseKey, tokenKey, nodeId);
    return result === 1;
  }

  /**
   * Bulk renews leases for multiple infoHashes in a single Redis pipeline.
   * Returns an array of fencing tokens (or null if the lease was lost).
   *
   * @param {string[]} infoHashes - Array of transfer identifiers.
   * @param {string} nodeId - The worker node ID.
   * @param {number} ttlSeconds - Lease duration in seconds.
   * @returns {Promise<(number|null)[]>}
   */
  static async renewLeasesBulk(infoHashes, nodeId, ttlSeconds = 30) {
    if (infoHashes.length === 0) return [];

    const pipeline = redis.pipeline();

    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("expire", KEYS[1], ARGV[2])
        redis.call("expire", KEYS[2], ARGV[2])
        local token = redis.call("get", KEYS[2])
        return tonumber(token)
      else
        return -1
      end
    `;

    for (const infoHash of infoHashes) {
      const leaseKey = `lease:transfer:${infoHash}`;
      const tokenKey = `lease:token:${infoHash}`;
      pipeline.eval(luaScript, 2, leaseKey, tokenKey, nodeId, ttlSeconds);
    }

    const results = await pipeline.exec();

    return results.map(([err, result]) => {
      if (err || result === -1) return null;
      return Number(result);
    });
  }
}

module.exports = LeaseManager;
