'use strict';

const { Transfer } = require('../models/sql');
const { Op } = require('sequelize');
const redis = require('../db/redis');
const { DIRECTIVE_TYPES } = require('./jobDirective');
const metrics = require('../observability/metrics');

/**
 * Phase 2.3 — The Sweeper (Zombie State Recovery)
 * 
 * Periodically scans PostgreSQL for transfers stuck in an active state
 * ('downloading', 'fetching_metadata', etc.). It cross-references these
 * with the Redis distributed locks (leases). If the lease is expired (null),
 * it assumes the worker node was OOMKilled or disconnected.
 * 
 * The Sweeper then safely resets the transfer to 'queued' and blasts the
 * JOB_ASSIGNED directive back into the Kafka topic for a surviving node to pick up.
 */
class LeaseSweeper {
  /**
   * @param {object} opts
   * @param {object} opts.dispatcher - Control Plane dispatcher to re-queue jobs
   * @param {number} opts.intervalMs - How often to run the sweep (default 30s)
   */
  constructor(opts = {}) {
    this._dispatcher = opts.dispatcher;
    if (!this._dispatcher) throw new Error('[LeaseSweeper] Dispatcher is required');
    
    this._intervalMs = opts.intervalMs || 30_000;
    this._timer = null;
    this._isRunning = false;
  }

  start() {
    if (this._isRunning) return;
    this._isRunning = true;
    console.log(`[LeaseSweeper] Started heartbeat monitor. Sweeping for zombies every ${this._intervalMs}ms`);
    
    this._timer = setInterval(() => this.sweep(), this._intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (!this._isRunning) return;
    this._isRunning = false;
    if (this._timer) clearInterval(this._timer);
    console.log('[LeaseSweeper] Stopped heartbeat monitor');
  }

  async sweep() {
    try {
      // 1. Find all transfers that *should* be active and heartbeating
      const activeTransfers = await Transfer.findAll({
        where: {
          status: {
            [Op.in]: ['downloading', 'fetching_metadata', 'checking', 'in_progress']
          }
        }
      });

      if (activeTransfers.length === 0) return;

      // 2. Fetch all corresponding leases from Redis in a single pipeline
      const pipeline = redis.pipeline();
      activeTransfers.forEach(t => {
        pipeline.get(`lease:transfer:${t.info_hash}`);
      });

      const results = await pipeline.exec();

      // 3. Detect anomalies (Active DB status but no Redis Lease)
      for (let i = 0; i < activeTransfers.length; i++) {
        const transfer = activeTransfers[i];
        const [err, ownerId] = results[i];

        if (err) {
          console.error(`[LeaseSweeper] Redis error checking lease for ${transfer.info_hash}:`, err);
          continue;
        }

        if (!ownerId) {
          // ZOMBIE DETECTED
          console.warn(`[LeaseSweeper] ZOMBIE DETECTED: Transfer ${transfer.info_hash} has active status '${transfer.status}' but the Redis lease has expired.`);
          await this.requeueZombie(transfer);
        }
      }
    } catch (err) {
      console.error('[LeaseSweeper] Sweep cycle failed:', err);
    }
  }

  async requeueZombie(transfer) {
    console.log(`[LeaseSweeper] Initiating rescue protocol... Re-queuing ${transfer.info_hash} to Kafka.`);
    
    // Safety check: Mark as queued so it doesn't get swept again before dispatch completes
    await transfer.update({ status: 'queued' });

    // Blast the job back into the execution queue
    try {
      await this._dispatcher.dispatch(DIRECTIVE_TYPES.JOB_ASSIGNED, {
        transferId: transfer.id,
        infoHash: transfer.info_hash,
        magnetUri: transfer.magnet_uri,
        torrentPath: transfer.torrent_file_path,
        autoStart: true,
        priority: 'high' // Bump priority for recovery jobs
      }, {
        requestId: `recovery-${Date.now()}`
      });
      
      console.log(`[LeaseSweeper] Successfully re-queued zombie job ${transfer.info_hash}.`);
    } catch (err) {
      console.error(`[LeaseSweeper] Failed to dispatch recovery job for ${transfer.info_hash}:`, err);
    }
  }
}

module.exports = LeaseSweeper;
