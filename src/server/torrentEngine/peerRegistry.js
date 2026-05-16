'use strict';

/**
 * Phase 4.1 — Peer Registry (Redis)
 *
 * A shared, Redis-backed registry that maps infoHashes to
 * the set of worker nodes that currently hold (or are downloading)
 * each transfer.
 *
 * Data structure in Redis:
 *   Key:   peers:<infoHash>
 *   Type:  Hash
 *   Field: <nodeId>
 *   Value: JSON { ip, port, bittorrentPort, pieces, updatedAt }
 *
 * Each entry has a TTL that is renewed by the worker heartbeat.
 * If a worker crashes, its entries expire automatically.
 */

const redis = require('../db/redis');

const PEER_KEY_PREFIX = 'peers:';
const DEFAULT_TTL = 60; // seconds — must be > heartbeat interval (10s)

class PeerRegistry {
  /**
   * Registers this node as a peer for a given infoHash.
   *
   * @param {string} infoHash - The transfer identifier
   * @param {string} nodeId - This worker's unique ID
   * @param {object} meta - Peer metadata
   * @param {string} meta.ip - Reachable IP address
   * @param {number} meta.port - HTTP/API port (for control plane)
   * @param {number} meta.bittorrentPort - BitTorrent wire protocol port
   * @param {number} [meta.completedPieces] - Number of verified pieces
   * @param {number} [meta.totalPieces] - Total pieces in the transfer
   * @param {number} [ttl] - TTL in seconds (default 60)
   */
  static async register(infoHash, nodeId, meta, ttl = DEFAULT_TTL) {
    const key = `${PEER_KEY_PREFIX}${infoHash}`;
    const value = JSON.stringify({
      ip: meta.ip,
      port: meta.port,
      bittorrentPort: meta.bittorrentPort || 6881,
      completedPieces: meta.completedPieces || 0,
      totalPieces: meta.totalPieces || 0,
      updatedAt: Date.now(),
    });

    try {
      await redis.hset(key, nodeId, value);
      await redis.expire(key, ttl);
      return true;
    } catch (err) {
      console.warn(`[PeerRegistry] Failed to register ${nodeId} for ${infoHash}: ${err.message}`);
      return false;
    }
  }

  /**
   * Deregisters this node as a peer for a given infoHash.
   *
   * @param {string} infoHash
   * @param {string} nodeId
   */
  static async deregister(infoHash, nodeId) {
    const key = `${PEER_KEY_PREFIX}${infoHash}`;
    try {
      await redis.hdel(key, nodeId);
      return true;
    } catch (err) {
      console.warn(`[PeerRegistry] Failed to deregister ${nodeId} for ${infoHash}: ${err.message}`);
      return false;
    }
  }

  /**
   * Returns all registered peers for a given infoHash,
   * excluding the requesting node itself.
   *
   * @param {string} infoHash
   * @param {string} [excludeNodeId] - Exclude this node from results
   * @returns {Promise<Array<{ nodeId, ip, port, bittorrentPort, completedPieces, totalPieces }>>}
   */
  static async getPeers(infoHash, excludeNodeId = null) {
    const key = `${PEER_KEY_PREFIX}${infoHash}`;
    try {
      const entries = await redis.hgetall(key);
      if (!entries || Object.keys(entries).length === 0) {
        return [];
      }

      const peers = [];
      const now = Date.now();

      for (const [nodeId, raw] of Object.entries(entries)) {
        if (nodeId === excludeNodeId) continue;

        try {
          const data = JSON.parse(raw);
          // Skip stale entries (> 2 * TTL old)
          if (now - data.updatedAt > DEFAULT_TTL * 2 * 1000) {
            // Lazy cleanup
            await redis.hdel(key, nodeId);
            continue;
          }

          peers.push({
            nodeId,
            ip: data.ip,
            port: data.port,
            bittorrentPort: data.bittorrentPort,
            completedPieces: data.completedPieces,
            totalPieces: data.totalPieces,
            isSeeder: data.totalPieces > 0 && data.completedPieces === data.totalPieces,
          });
        } catch (parseErr) {
          // Corrupted entry — remove it
          await redis.hdel(key, nodeId);
        }
      }

      // Sort: seeders first, then by completedPieces descending
      peers.sort((a, b) => {
        if (a.isSeeder !== b.isSeeder) return b.isSeeder ? 1 : -1;
        return b.completedPieces - a.completedPieces;
      });

      return peers;
    } catch (err) {
      console.warn(`[PeerRegistry] Failed to get peers for ${infoHash}: ${err.message}`);
      return [];
    }
  }

  /**
   * Refreshes the TTL for all of a node's registrations.
   * Called during the worker heartbeat.
   *
   * @param {string} nodeId
   * @param {string[]} infoHashes - List of active infoHashes on this node
   * @param {number} [ttl]
   */
  static async refreshAll(nodeId, infoHashes, ttl = DEFAULT_TTL) {
    const pipeline = redis.pipeline();
    for (const infoHash of infoHashes) {
      const key = `${PEER_KEY_PREFIX}${infoHash}`;
      pipeline.expire(key, ttl);
    }
    try {
      await pipeline.exec();
    } catch (err) {
      console.warn(`[PeerRegistry] Bulk refresh failed for ${nodeId}: ${err.message}`);
    }
  }

  /**
   * Returns the total number of registered peers across
   * all infoHashes (for observability).
   */
  static async getGlobalPeerCount() {
    try {
      let cursor = '0';
      let total = 0;
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${PEER_KEY_PREFIX}*`, 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) {
          total += await redis.hlen(key);
        }
      } while (cursor !== '0');
      return total;
    } catch (err) {
      console.warn(`[PeerRegistry] getGlobalPeerCount failed: ${err.message}`);
      return 0;
    }
  }
}

module.exports = PeerRegistry;
