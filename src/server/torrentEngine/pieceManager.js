const crypto = require('crypto');
const EventEmitter = require('events');

/**
 * Manages piece verification and restoration for torrent downloads
 */
class PieceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.torrentInfo = options.torrentInfo; // Torrent metadata
    this.fileWriter = options.fileWriter; // FileWriter instance
    this.completedPieces = new Set(); // Set of completed piece indices
    
    this._verificationInProgress = false;
    this._verificationAborted = false;
  }
  
  /**
   * Verifies saved completed pieces against their hashes
   * @param {number[]} completedPieces - Array of piece indices to verify
   * @returns {Promise<Object>} Verification results
   */
  async verifyPieces(completedPieces) {
    console.log(`[PieceManager] Verifying ${completedPieces.length} pieces...`);
    
    this._verificationInProgress = true;
    this._verificationAborted = false;
    
    const result = {
      valid: [],
      invalid: [],
      missing: [],
      verified: 0,
      failed: 0
    };
    
    this.emit('verify:start', { total: completedPieces.length });
    
    for (let i = 0; i < completedPieces.length; i++) {
      if (this._verificationAborted) {
        console.log('[PieceManager] Verification aborted');
        break;
      }
      
      const pieceIndex = completedPieces[i];
      
      try {
        const isValid = await this._verifyPiece(pieceIndex);
        
        if (isValid) {
          result.valid.push(pieceIndex);
          result.verified++;
          this.completedPieces.add(pieceIndex);
        } else {
          result.invalid.push(pieceIndex);
          result.failed++;
          console.warn(`[PieceManager] Piece ${pieceIndex} failed verification`);
        }
      } catch (error) {
        // Piece is missing or unreadable
        result.missing.push(pieceIndex);
        result.failed++;
        console.warn(`[PieceManager] Piece ${pieceIndex} missing or unreadable: ${error.message}`);
      }
      
      // Emit progress
      const percent = ((i + 1) / completedPieces.length) * 100;
      this.emit('verify:progress', {
        verified: result.verified,
        failed: result.failed,
        total: completedPieces.length,
        percent,
        currentPiece: pieceIndex
      });
    }
    
    this._verificationInProgress = false;
    
    console.log(`[PieceManager] Verification complete: ${result.valid.length} valid, ${result.invalid.length} invalid, ${result.missing.length} missing`);
    
    this.emit('verify:complete', {
      valid: result.valid.length,
      invalid: result.invalid.length,
      missing: result.missing.length,
      total: completedPieces.length
    });
    
    return result;
  }
  
  /**
   * Verifies pieces in background without blocking downloads
   * @param {number[]} completedPieces - Array of piece indices to verify
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<Object>} Verification results
   */
  async verifyInBackground(completedPieces, onProgress) {
    console.log(`[PieceManager] Starting background verification of ${completedPieces.length} pieces...`);
    
    this._verificationInProgress = true;
    this._verificationAborted = false;
    
    const result = {
      valid: [],
      invalid: [],
      missing: [],
      verified: 0,
      failed: 0
    };
    
    this.emit('verify:start', { total: completedPieces.length });
    
    // Verify pieces with delays to avoid blocking
    for (let i = 0; i < completedPieces.length; i++) {
      if (this._verificationAborted) {
        console.log('[PieceManager] Background verification aborted');
        break;
      }
      
      const pieceIndex = completedPieces[i];
      
      try {
        const isValid = await this._verifyPiece(pieceIndex);
        
        if (isValid) {
          result.valid.push(pieceIndex);
          result.verified++;
          this.completedPieces.add(pieceIndex);
        } else {
          result.invalid.push(pieceIndex);
          result.failed++;
          console.warn(`[PieceManager] Piece ${pieceIndex} failed background verification`);
        }
      } catch (error) {
        result.missing.push(pieceIndex);
        result.failed++;
        console.warn(`[PieceManager] Piece ${pieceIndex} missing in background check: ${error.message}`);
      }
      
      // Progress callback
      const percent = ((i + 1) / completedPieces.length) * 100;
      const progressData = {
        verified: result.verified,
        failed: result.failed,
        total: completedPieces.length,
        percent,
        currentPiece: pieceIndex
      };
      
      this.emit('verify:progress', progressData);
      
      if (onProgress) {
        onProgress(progressData);
      }
      
      // Small delay to avoid blocking (every 10 pieces)
      if (i % 10 === 0 && i > 0) {
        await this._delay(100);
      }
    }
    
    this._verificationInProgress = false;
    
    console.log(`[PieceManager] Background verification complete: ${result.valid.length} valid, ${result.invalid.length} invalid, ${result.missing.length} missing`);
    
    this.emit('verify:complete', {
      valid: result.valid.length,
      invalid: result.invalid.length,
      missing: result.missing.length,
      total: completedPieces.length
    });
    
    return result;
  }
  
  /**
   * Restores completed pieces without verification (trust saved state)
   * @param {number[]} pieces - Array of piece indices
   */
  restoreCompletedPieces(pieces) {
    console.log(`[PieceManager] Restoring ${pieces.length} completed pieces without verification`);
    
    for (const pieceIndex of pieces) {
      this.completedPieces.add(pieceIndex);
    }
    
    console.log(`[PieceManager] Restored ${this.completedPieces.size} pieces`);
  }
  
  /**
   * Verifies a single piece
   * @param {number} pieceIndex
   * @returns {Promise<boolean>} True if piece is valid
   * @private
   */
  async _verifyPiece(pieceIndex) {
    if (!this.fileWriter || !this.torrentInfo) {
      throw new Error('FileWriter and torrentInfo required for verification');
    }
    
    try {
      // Read piece data from disk
      const pieceData = await this.fileWriter.readPiece(pieceIndex);
      
      if (!pieceData || pieceData.length === 0) {
        return false;
      }
      
      // Calculate SHA1 hash
      const calculatedHash = crypto.createHash('sha1').update(pieceData).digest();
      
      // Get expected hash from torrent info
      const expectedHash = this.torrentInfo.pieces[pieceIndex];
      
      if (!expectedHash) {
        throw new Error(`No expected hash for piece ${pieceIndex}`);
      }
      
      // Compare hashes
      return calculatedHash.equals(expectedHash);
      
    } catch (error) {
      console.error(`[PieceManager] Error verifying piece ${pieceIndex}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Marks a piece as completed
   * @param {number} pieceIndex
   */
  markPieceComplete(pieceIndex) {
    this.completedPieces.add(pieceIndex);
  }
  
  /**
   * Marks a piece as incomplete
   * @param {number} pieceIndex
   */
  markPieceIncomplete(pieceIndex) {
    this.completedPieces.delete(pieceIndex);
  }
  
  /**
   * Checks if a piece is completed
   * @param {number} pieceIndex
   * @returns {boolean}
   */
  isPieceComplete(pieceIndex) {
    return this.completedPieces.has(pieceIndex);
  }
  
  /**
   * Gets array of completed piece indices
   * @returns {number[]}
   */
  getCompletedPieces() {
    return Array.from(this.completedPieces);
  }
  
  /**
   * Gets total count of completed pieces
   * @returns {number}
   */
  getCompletedCount() {
    return this.completedPieces.size;
  }
  
  /**
   * Calculates completion percentage
   * @returns {number}
   */
  getCompletionPercentage() {
    if (!this.torrentInfo || !this.torrentInfo.pieces) {
      return 0;
    }
    
    const total = this.torrentInfo.pieces.length;
    return (this.completedPieces.size / total) * 100;
  }
  
  /**
   * Gets pieces that need to be downloaded
   * @returns {number[]}
   */
  getRemainingPieces() {
    if (!this.torrentInfo || !this.torrentInfo.pieces) {
      return [];
    }
    
    const remaining = [];
    const total = this.torrentInfo.pieces.length;
    
    for (let i = 0; i < total; i++) {
      if (!this.completedPieces.has(i)) {
        remaining.push(i);
      }
    }
    
    return remaining;
  }
  
  /**
   * Aborts ongoing verification
   */
  abortVerification() {
    if (this._verificationInProgress) {
      console.log('[PieceManager] Aborting verification...');
      this._verificationAborted = true;
    }
  }
  
  /**
   * Checks if verification is in progress
   * @returns {boolean}
   */
  isVerifying() {
    return this._verificationInProgress;
  }
  
  /**
   * Resets piece manager state
   */
  reset() {
    this.completedPieces.clear();
    this._verificationAborted = false;
    this._verificationInProgress = false;
  }
  
  /**
   * Delay helper for background verification
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Gets statistics about pieces
   * @returns {Object}
   */
  getStats() {
    const total = this.torrentInfo?.pieces?.length || 0;
    const completed = this.completedPieces.size;
    const remaining = total - completed;
    const percent = total > 0 ? (completed / total) * 100 : 0;
    
    return {
      total,
      completed,
      remaining,
      percent,
      isVerifying: this._verificationInProgress
    };
  }
}

// Legacy export for backward compatibility
const pieceManager = {
  downloadPiece: (pieceIndex) => {
    console.log('Downloading piece:', pieceIndex);
    // Logic to download a specific piece
  },

  verifyPiece: (piece) => {
    console.log('Verifying piece:', piece);
    // Logic to verify piece integrity
  }
};

module.exports = { PieceManager, pieceManager };
