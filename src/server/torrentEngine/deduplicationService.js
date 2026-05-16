'use strict';

/**
 * Phase 4.2 — Deduplication Service
 *
 * Orchestrates chunk-level deduplication across transfers.
 *
 * When a new transfer starts or resumes, this service:
 *   1. Queries the PostgreSQL `chunks` table for chunk hashes.
 *   2. Checks the local CAS Store for existing data matching those hashes.
 *   3. For each CAS hit, writes the data directly to the FileWriter
 *      and marks the piece as complete — skipping the download entirely.
 *
 * When a piece is verified (any transfer), the Checkpointer calls
 * `onChunkVerified()` to store the chunk data in the CAS for
 * future deduplication.
 *
 * Dedup Flow:
 *   Transfer A downloads piece 7 → SHA-256 = abc123
 *     → CAS stores abc123.bin
 *
 *   Transfer B starts, piece 3 has SHA-256 = abc123
 *     → DeduplicationService.prePopulate() finds it in CAS
 *     → Writes data to FileWriter, marks piece 3 complete
 *     → Engine skips downloading piece 3
 */

const { Chunk } = require('../models/sql');
const CASStore = require('./casStore');

class DeduplicationService {
  /**
   * @param {object} opts
   * @param {string} opts.downloadPath - Root download directory
   */
  constructor(opts = {}) {
    this._cas = new CASStore(opts.downloadPath || process.env.DOWNLOAD_PATH || './downloads');
    this._dedupCount = 0;
    this._dedupBytes = 0;
    this._scanCount = 0;
  }

  /**
   * Stores a verified chunk in the CAS for future deduplication.
   * Called by the Checkpointer after successful verification.
   *
   * @param {Buffer} data - Raw chunk data
   * @param {string} sha256 - The SHA-256 hash of the chunk
   */
  async onChunkVerified(data, sha256) {
    try {
      await this._cas.store(data, sha256);
    } catch (err) {
      // Non-fatal: CAS storage failure shouldn't block the engine
      console.warn(`[Dedup] Failed to store chunk ${sha256?.substring(0, 12)}: ${err.message}`);
    }
  }

  /**
   * Scans the chunks table for a transfer and attempts to pre-populate
   * pieces from the CAS, skipping downloads for already-known data.
   *
   * @param {string} infoHash - Transfer identifier
   * @param {object} fileWriter - The FileWriter instance for this torrent
   * @param {number} pieceLength - Size of each piece in bytes
   * @returns {Promise<{ deduped: number[], scanned: number, casHits: number }>}
   */
  async prePopulate(infoHash, fileWriter, pieceLength) {
    this._scanCount++;
    const result = { deduped: [], scanned: 0, casHits: 0 };

    try {
      // Query all chunks for this transfer that have a hash but aren't verified yet
      const chunks = await Chunk.findAll({
        attributes: ['chunk_index', 'chunk_hash', 'status'],
        include: [{
          association: 'transfer',
          where: { info_hash: infoHash },
          attributes: [],
        }],
        where: { status: ['pending', 'failed'] },
        order: [['chunk_index', 'ASC']],
        raw: true,
      });

      if (!chunks || chunks.length === 0) {
        console.log(`[Dedup] No pending chunks found for ${infoHash.substring(0, 8)}`);
        return result;
      }

      result.scanned = chunks.length;
      console.log(`[Dedup] Scanning ${chunks.length} pending chunks for ${infoHash.substring(0, 8)}...`);

      for (const chunk of chunks) {
        if (!chunk.chunk_hash) continue;

        const data = await this._cas.get(chunk.chunk_hash);
        if (!data) continue;

        // CAS hit! Write the data to disk
        result.casHits++;

        try {
          await fileWriter.writePiece(chunk.chunk_index, data);
          result.deduped.push(chunk.chunk_index);

          this._dedupCount++;
          this._dedupBytes += data.length;
        } catch (writeErr) {
          console.warn(`[Dedup] Failed to write deduped chunk ${chunk.chunk_index}: ${writeErr.message}`);
        }
      }

      if (result.deduped.length > 0) {
        console.log(`[Dedup] Pre-populated ${result.deduped.length}/${result.scanned} chunks from CAS for ${infoHash.substring(0, 8)}`);
      }

    } catch (err) {
      // Non-fatal: dedup failure should not block the transfer
      console.warn(`[Dedup] Pre-populate scan failed for ${infoHash.substring(0, 8)}: ${err.message}`);
    }

    return result;
  }

  /**
   * Checks if a single chunk hash exists in the CAS.
   * Useful for the engine to check before requesting from peers.
   *
   * @param {string} sha256 - The SHA-256 hash to check
   * @returns {Promise<Buffer|null>} The chunk data if found, null otherwise
   */
  async lookupChunk(sha256) {
    return this._cas.get(sha256);
  }

  /**
   * Returns deduplication statistics.
   */
  getStats() {
    return {
      dedupCount: this._dedupCount,
      dedupBytes: this._dedupBytes,
      dedupMB: (this._dedupBytes / (1024 * 1024)).toFixed(2),
      scanCount: this._scanCount,
      cas: this._cas.getStats(),
    };
  }
}

module.exports = DeduplicationService;
