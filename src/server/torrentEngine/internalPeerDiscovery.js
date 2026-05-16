'use strict';

/**
 * Phase 4.1 — Internal Peer Discovery
 *
 * Bridges the PeerRegistry (Redis) with the PeerManager (BitTorrent wire).
 *
 * When a torrent starts or resumes, this module:
 *   1. Queries the PeerRegistry for other nodes holding the same infoHash.
 *   2. Converts registry entries into { ip, port } pairs.
 *   3. Injects them into the PeerManager's pool with HIGH PRIORITY
 *      (before external tracker peers).
 *
 * This ensures that internal VPC/LAN peers are always preferred over
 * external internet peers, reducing egress costs and latency.
 */

const PeerRegistry = require('./peerRegistry');

class InternalPeerDiscovery {
  /**
   * @param {object} opts
   * @param {string} opts.nodeId - This worker's unique ID
   * @param {string} opts.nodeIp - This worker's reachable IP
   * @param {number} opts.bittorrentPort - This worker's BT wire port
   * @param {number} [opts.pollIntervalMs] - How often to re-check for new internal peers (default 15s)
   */
  constructor(opts = {}) {
    this._nodeId = opts.nodeId || `worker-${process.pid}`;
    this._nodeIp = opts.nodeIp || '127.0.0.1';
    this._btPort = opts.bittorrentPort || 6881;
    this._pollIntervalMs = opts.pollIntervalMs || 15_000;

    // infoHash -> intervalTimer
    this._activePolls = new Map();

    // Track which internal peers we already injected to avoid duplicates
    // infoHash -> Set<nodeId>
    this._knownInternalPeers = new Map();
  }

  /**
   * Registers this node as a peer for a transfer and starts
   * polling for other internal peers.
   *
   * @param {string} infoHash
   * @param {object} peerManager - The PeerManager instance for this torrent
   * @param {object} [meta] - Optional metadata (completedPieces, totalPieces)
   */
  async startDiscovery(infoHash, peerManager, meta = {}) {
    // Register ourselves
    await PeerRegistry.register(infoHash, this._nodeId, {
      ip: this._nodeIp,
      port: parseInt(process.env.PORT) || 3029,
      bittorrentPort: this._btPort,
      completedPieces: meta.completedPieces || 0,
      totalPieces: meta.totalPieces || 0,
    });

    console.log(`[InternalDiscovery] Registered ${this._nodeId} for ${infoHash.substring(0, 8)}...`);

    // Initialize tracking
    if (!this._knownInternalPeers.has(infoHash)) {
      this._knownInternalPeers.set(infoHash, new Set());
    }

    // Do an immediate discovery pass
    await this._discoverAndInject(infoHash, peerManager);

    // Start periodic polling
    if (!this._activePolls.has(infoHash)) {
      const timer = setInterval(async () => {
        try {
          await this._discoverAndInject(infoHash, peerManager);
        } catch (err) {
          console.warn(`[InternalDiscovery] Poll error for ${infoHash.substring(0, 8)}: ${err.message}`);
        }
      }, this._pollIntervalMs);

      if (timer.unref) timer.unref();
      this._activePolls.set(infoHash, timer);
    }
  }

  /**
   * Stops discovery and deregisters this node for a transfer.
   *
   * @param {string} infoHash
   */
  async stopDiscovery(infoHash) {
    // Stop polling
    const timer = this._activePolls.get(infoHash);
    if (timer) {
      clearInterval(timer);
      this._activePolls.delete(infoHash);
    }

    // Clean up tracking
    this._knownInternalPeers.delete(infoHash);

    // Deregister from Redis
    await PeerRegistry.deregister(infoHash, this._nodeId);
    console.log(`[InternalDiscovery] Deregistered ${this._nodeId} for ${infoHash.substring(0, 8)}...`);
  }

  /**
   * Updates our registration metadata (e.g., after verifying more pieces).
   *
   * @param {string} infoHash
   * @param {object} meta
   */
  async updateRegistration(infoHash, meta) {
    await PeerRegistry.register(infoHash, this._nodeId, {
      ip: this._nodeIp,
      port: parseInt(process.env.PORT) || 3029,
      bittorrentPort: this._btPort,
      completedPieces: meta.completedPieces || 0,
      totalPieces: meta.totalPieces || 0,
    });
  }

  /**
   * Queries the PeerRegistry and injects any NEW internal peers
   * into the PeerManager's pool.
   *
   * @private
   */
  async _discoverAndInject(infoHash, peerManager) {
    const peers = await PeerRegistry.getPeers(infoHash, this._nodeId);
    if (peers.length === 0) return;

    const known = this._knownInternalPeers.get(infoHash);
    const newPeers = [];

    for (const peer of peers) {
      if (!known.has(peer.nodeId)) {
        known.add(peer.nodeId);
        newPeers.push({
          ip: peer.ip,
          port: peer.bittorrentPort,
          _source: 'internal',
          _nodeId: peer.nodeId,
          _isSeeder: peer.isSeeder,
        });
      }
    }

    if (newPeers.length > 0) {
      console.log(`[InternalDiscovery] Injecting ${newPeers.length} internal peer(s) for ${infoHash.substring(0, 8)}...`);

      // Prepend to the peer pool so internal peers connect first.
      // PeerManager.addPeers() appends, so we add them first.
      peerManager.peerPool.unshift(...newPeers);

      // Also trigger a connection attempt if the manager isn't busy
      if (!peerManager.connecting && peerManager.activeConnections.size < peerManager.maxConnections) {
        peerManager.connectToPeers(newPeers.length).catch(() => {});
      }
    }
  }

  /**
   * Stops all active discovery polls and deregisters everything.
   */
  async shutdown() {
    for (const [infoHash, timer] of this._activePolls.entries()) {
      clearInterval(timer);
      await PeerRegistry.deregister(infoHash, this._nodeId).catch(() => {});
    }
    this._activePolls.clear();
    this._knownInternalPeers.clear();
    console.log(`[InternalDiscovery] Shutdown complete`);
  }

  /**
   * Returns stats for observability.
   */
  getStats() {
    const stats = {};
    for (const [infoHash, known] of this._knownInternalPeers.entries()) {
      stats[infoHash.substring(0, 8)] = {
        knownInternalPeers: known.size,
        isPolling: this._activePolls.has(infoHash),
      };
    }
    return stats;
  }
}

module.exports = InternalPeerDiscovery;
