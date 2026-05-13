'use strict';

const redis = require('../db/redis');

/**
 * Phase 2.2 — Distributed Lease Manager
 *
 * Implements a distributed lock in Redis for Torrent Ownership.
 * Ensures that only one worker node can execute a specific transfer at any given time.
 */
class LeaseManager {
  /**
   * Tries to acquire a lease for a transfer.
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {string} nodeId - The worker node claiming the transfer.
   * @param {number} ttlSeconds - Lease duration in seconds (default: 30s).
   * @returns {Promise<boolean>} True if the lease was acquired, false otherwise.
   */
  static async acquireLease(infoHash, nodeId, ttlSeconds = 30) {
    const key = `lease:transfer:${infoHash}`;
    
    // NX: Set only if it does not exist. EX: Expire after TTL seconds.
    const result = await redis.set(key, nodeId, 'NX', 'EX', ttlSeconds);
    
    // Check if we just acquired it OR if we already own it
    if (result === 'OK') {
      return true;
    }

    const currentOwner = await redis.get(key);
    return currentOwner === nodeId;
  }

  /**
   * Renews an existing lease.
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {string} nodeId - The worker node renewing the lease.
   * @param {number} ttlSeconds - Lease duration in seconds.
   * @returns {Promise<boolean>} True if successful, false if the lease was lost or belongs to another node.
   */
  static async renewLease(infoHash, nodeId, ttlSeconds = 30) {
    const key = `lease:transfer:${infoHash}`;
    
    // Atomic Lua script to renew only if the node is still the owner.
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await redis.eval(luaScript, 1, key, nodeId, ttlSeconds);
    return result === 1;
  }

  /**
   * Releases a lease voluntarily (e.g., when transfer is paused, completed, or cancelled).
   *
   * @param {string} infoHash - The transfer identifier.
   * @param {string} nodeId - The worker node releasing the lease.
   * @returns {Promise<boolean>} True if successfully released.
   */
  static async releaseLease(infoHash, nodeId) {
    const key = `lease:transfer:${infoHash}`;

    // Atomic Lua script to delete only if the node is still the owner.
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(luaScript, 1, key, nodeId);
    return result === 1;
  }
}

module.exports = LeaseManager;
