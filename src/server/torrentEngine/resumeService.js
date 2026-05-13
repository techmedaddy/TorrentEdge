'use strict';
// Import from index to ensure all Sequelize associations are registered
const { Chunk, Transfer } = require('../models/sql');

/**
 * Phase 1.3 — CAS-Aware Resume Service
 *
 * Queries the PostgreSQL `chunks` table to determine exactly where a
 * transfer left off after an interruption, without re-verifying data
 * that was already confirmed with SHA-256 integrity.
 *
 * Used by the /resume endpoint to give the engine a precise "skip list"
 * of already-verified pieces — so the download resumes from the *first
 * unverified chunk*, not from the beginning.
 */
class ResumeService {

  /**
   * Builds the resume context for a transfer identified by its infoHash.
   *
   * @param {string} infoHash - 40-char hex SHA-1 info hash
   * @returns {Promise<{
   *   verifiedIndices: number[],   // Chunk indices already confirmed in DB
   *   pendingIndices:  number[],   // Chunks not yet verified (should be re-requested)
   *   failedIndices:   number[],   // Chunks that explicitly failed hash check
   *   totalTracked:    number,     // Total chunks recorded in DB for this transfer
   *   resumeFromIndex: number,     // First non-verified index (0 if nothing done)
   *   isFullyVerified: boolean,    // True if every chunk is verified
   * } | null>}  null if no DB record exists
   */
  static async getResumeContext(infoHash) {
    const transfer = await Transfer.findOne({
      where: { info_hash: infoHash },
      include: [{ 
        association: 'chunks',
        attributes: ['chunk_index', 'status']
      }]
    });

    if (!transfer) return null;

    const chunks = transfer.chunks || [];
    if (chunks.length === 0) {
      return {
        verifiedIndices: [],
        pendingIndices:  [],
        failedIndices:   [],
        totalTracked:    0,
        resumeFromIndex: 0,
        isFullyVerified: false
      };
    }

    const verified = [];
    const pending  = [];
    const failed   = [];

    for (const chunk of chunks) {
      switch (chunk.status) {
        case 'verified':    verified.push(chunk.chunk_index); break;
        case 'failed':      failed.push(chunk.chunk_index);   break;
        case 'pending':
        case 'downloading':
        default:            pending.push(chunk.chunk_index);  break;
      }
    }

    // Sort for binary search / ordered processing
    verified.sort((a, b) => a - b);
    pending.sort((a, b) => a - b);
    failed.sort((a, b) => a - b);

    // First index the engine must actually work on (pending or failed)
    const needsWork = [...pending, ...failed].sort((a, b) => a - b);
    const resumeFromIndex = needsWork.length > 0 ? needsWork[0] : chunks.length;
    const isFullyVerified = pending.length === 0 && failed.length === 0;

    return {
      verifiedIndices: verified,
      pendingIndices:  pending,
      failedIndices:   failed,
      totalTracked:    chunks.length,
      resumeFromIndex,
      isFullyVerified,
    };
  }

  /**
   * Resets all 'failed' chunks back to 'pending' so they are retried.
   * Called before re-starting a failed transfer.
   *
   * @param {string} infoHash
   * @returns {Promise<number>} Number of chunks reset
   */
  static async resetFailedChunks(infoHash) {
    const transfer = await Transfer.findOne({ where: { info_hash: infoHash } });
    if (!transfer) return 0;

    const [affectedRows] = await Chunk.update(
      { status: 'pending' },
      { where: { transfer_id: transfer.id, status: 'failed' } }
    );

    if (affectedRows > 0) {
      console.log(`[ResumeService] Reset ${affectedRows} failed chunks to pending for ${infoHash}`);
    }

    return affectedRows;
  }
}

module.exports = ResumeService;
