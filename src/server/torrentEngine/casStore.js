'use strict';

/**
 * Phase 4.2 — Content Addressable Store (CAS)
 *
 * A filesystem-backed store that organizes verified chunk data
 * by SHA-256 hash. Structure:
 *
 *   <basePath>/.torrentedge/cas/
 *     ab/
 *       ab3f...64chars.bin      ← chunk data stored by hash
 *     cd/
 *       cd91...64chars.bin
 *
 * The first 2 hex characters of the hash form a "shard" directory
 * to avoid placing millions of files in a single folder.
 *
 * This store is shared across ALL transfers on this node.
 * When a new transfer needs a chunk that already exists in the CAS,
 * the DeduplicationService reads it from here instead of downloading.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class CASStore {
  /**
   * @param {string} basePath - Root download path (e.g., ./downloads)
   */
  constructor(basePath) {
    this._root = path.join(basePath, '.torrentedge', 'cas');
    this._initialized = false;
    this._stats = { hits: 0, misses: 0, stores: 0, totalBytes: 0 };
  }

  /**
   * Ensures the CAS root directory exists.
   */
  async initialize() {
    if (this._initialized) return;
    await fs.mkdir(this._root, { recursive: true });
    this._initialized = true;
  }

  /**
   * Returns the filesystem path for a given SHA-256 hash.
   * @param {string} sha256 - 64-char hex hash
   * @returns {string}
   */
  _pathForHash(sha256) {
    const shard = sha256.substring(0, 2);
    return path.join(this._root, shard, `${sha256}.bin`);
  }

  /**
   * Checks if a chunk with the given hash exists in the store.
   *
   * @param {string} sha256 - 64-char hex hash
   * @returns {Promise<boolean>}
   */
  async has(sha256) {
    if (!sha256 || sha256.length !== 64) return false;
    try {
      await fs.access(this._pathForHash(sha256));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves chunk data from the CAS by its hash.
   * Returns null if the chunk doesn't exist.
   *
   * @param {string} sha256 - 64-char hex hash
   * @returns {Promise<Buffer|null>}
   */
  async get(sha256) {
    if (!sha256 || sha256.length !== 64) return null;
    try {
      const data = await fs.readFile(this._pathForHash(sha256));

      // Integrity check: verify the hash matches
      const computed = crypto.createHash('sha256').update(data).digest('hex');
      if (computed !== sha256) {
        console.warn(`[CAS] Integrity mismatch for ${sha256.substring(0, 12)}... — removing corrupted entry`);
        await this.remove(sha256);
        this._stats.misses++;
        return null;
      }

      this._stats.hits++;
      return data;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[CAS] Read error for ${sha256.substring(0, 12)}...: ${err.message}`);
      }
      this._stats.misses++;
      return null;
    }
  }

  /**
   * Stores chunk data in the CAS.
   * The hash is computed from the data if not provided.
   *
   * @param {Buffer} data - Raw chunk data
   * @param {string} [sha256] - Pre-computed SHA-256 hash (saves re-hashing)
   * @returns {Promise<string>} The SHA-256 hash of the stored data
   */
  async store(data, sha256 = null) {
    await this.initialize();

    if (!sha256) {
      sha256 = crypto.createHash('sha256').update(data).digest('hex');
    }

    const filePath = this._pathForHash(sha256);

    // Check if already stored (idempotent)
    try {
      await fs.access(filePath);
      return sha256; // Already exists
    } catch {
      // Doesn't exist — write it
    }

    // Ensure shard directory exists
    const shardDir = path.dirname(filePath);
    await fs.mkdir(shardDir, { recursive: true });

    // Atomic write: write to temp, then rename
    // Use UUID instead of process.pid — in Kubernetes, all containers run as PID 1
    const uniqueSuffix = crypto.randomUUID().replace(/-/g, '').substring(0, 12);
    const tmpPath = `${filePath}.${uniqueSuffix}.tmp`;
    try {
      await fs.writeFile(tmpPath, data);
      await fs.rename(tmpPath, filePath);
      this._stats.stores++;
      this._stats.totalBytes += data.length;
    } catch (err) {
      // Clean up temp file on error
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }

    return sha256;
  }

  /**
   * Removes a chunk from the CAS.
   *
   * @param {string} sha256
   */
  async remove(sha256) {
    try {
      await fs.unlink(this._pathForHash(sha256));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[CAS] Remove error for ${sha256.substring(0, 12)}...: ${err.message}`);
      }
    }
  }

  /**
   * Returns CAS store statistics.
   */
  getStats() {
    return {
      ...this._stats,
      hitRate: this._stats.hits + this._stats.misses > 0
        ? (this._stats.hits / (this._stats.hits + this._stats.misses) * 100).toFixed(1) + '%'
        : '0%',
    };
  }
}

module.exports = CASStore;
