const { Chunk, Transfer } = require('../models/sql');

/**
 * Persists chunk completion status to PostgreSQL.
 * Part of Phase 1.2: Chunking & Integrity (CAS).
 */
class Checkpointer {
  static transferIdCache = new Map();

  /**
   * Helper to get transfer ID with caching to prevent race conditions and excessive queries.
   */
  static async _getTransferId(infoHash) {
    if (!infoHash || typeof infoHash !== 'string') {
      throw new Error('Invalid infoHash parameter');
    }
    if (this.transferIdCache.has(infoHash)) {
      return this.transferIdCache.get(infoHash);
    }
    const transfer = await Transfer.findOne({ where: { info_hash: infoHash } });
    if (transfer) {
      this.transferIdCache.set(infoHash, transfer.id);
      return transfer.id;
    }
    return null;
  }

  /**
   * Initializes chunks for a new transfer.
   * @param {string} infoHash - The info hash of the transfer
   * @param {Array<string>} chunkHashes - Array of SHA-256 chunk hashes
   * @param {string} transferId - The UUID of the transfer
   */
  static async initializeChunks(infoHash, chunkHashes, transferId) {
    if (!transferId || !chunkHashes || chunkHashes.length === 0) return;

    try {
      const chunksData = chunkHashes.map((hash, index) => ({
        transfer_id: transferId,
        chunk_index: index,
        chunk_hash: hash,
        status: 'pending'
      }));

      // Insert all chunks. Use ignoreDuplicates in case they already exist from a resume attempt
      await Chunk.bulkCreate(chunksData, { ignoreDuplicates: true });
      this.transferIdCache.set(infoHash, transferId);
      console.log(`[Checkpointer] Initialized ${chunkHashes.length} chunks for transfer ${infoHash}`);
    } catch (err) {
      console.error(`[Checkpointer] Failed to initialize chunks for ${infoHash}:`, err.message);
    }
  }

  /**
   * Marks a chunk as verified and completed.
   * @param {string} infoHash - The info hash of the transfer
   * @param {number} chunkIndex - The index of the completed chunk
   * @param {string} [chunkHash] - The computed SHA-256 CAS hash of the chunk
   */
  static async markChunkVerified(infoHash, chunkIndex, chunkHash = null) {
    try {
      const transferId = await this._getTransferId(infoHash);
      if (!transferId) {
        console.warn(`[Checkpointer] Transfer not found for infoHash: ${infoHash}`);
        return;
      }

      const updateData = { 
        status: 'verified', 
        verified_at: new Date() 
      };
      if (chunkHash) {
        updateData.chunk_hash = chunkHash;
      }

      const [affectedRows] = await Chunk.update(
        updateData,
        { 
          where: { 
            transfer_id: transferId, 
            chunk_index: chunkIndex 
          } 
        }
      );
      
      if (affectedRows === 0) {
        console.warn(`[Checkpointer] Chunk ${chunkIndex} not found or already verified for ${infoHash}`);
      }
    } catch (err) {
      console.error(`[Checkpointer] Failed to mark chunk verified for ${infoHash}:`, err.message);
    }
  }

  /**
   * Marks multiple chunks as verified (useful for seed initialization).
   * @param {string} infoHash - The info hash of the transfer
   * @param {Array<string>} chunkHashes - Array of SHA-256 chunk hashes
   */
  static async markChunksVerifiedBulk(infoHash, chunkHashes) {
    try {
      const transferId = await this._getTransferId(infoHash);
      if (!transferId) {
        console.warn(`[Checkpointer] Transfer not found for infoHash: ${infoHash}`);
        return;
      }

      const [affectedRows] = await Chunk.update(
        { status: 'verified', verified_at: new Date() },
        { where: { transfer_id: transferId } }
      );
      console.log(`[Checkpointer] Bulk verified ${affectedRows} chunks for ${infoHash}`);
    } catch (err) {
      console.error(`[Checkpointer] Bulk verification failed for ${infoHash}:`, err.message);
    }
  }

  /**
   * Marks a chunk as failed (e.g. failed hash check).
   * @param {string} infoHash - The info hash of the transfer
   * @param {number} chunkIndex - The index of the failed chunk
   */
  static async markChunkFailed(infoHash, chunkIndex) {
    try {
      const transferId = await this._getTransferId(infoHash);
      if (!transferId) {
        console.warn(`[Checkpointer] Transfer not found for failed chunk in ${infoHash}`);
        return;
      }

      const [affectedRows] = await Chunk.update(
        { status: 'failed' },
        { 
          where: { 
            transfer_id: transferId, 
            chunk_index: chunkIndex 
          } 
        }
      );

      if (affectedRows === 0) {
        console.warn(`[Checkpointer] Failed to mark chunk ${chunkIndex} as failed for ${infoHash} (not found)`);
      }
    } catch (err) {
      console.error(`[Checkpointer] Failed to mark chunk failed for ${infoHash}:`, err.message);
    }
  }
}

module.exports = Checkpointer;
