const crypto = require('crypto');

/**
 * Represents a single piece in a torrent
 * 
 * BitTorrent piece/block relationship:
 * - Torrents are divided into pieces (e.g., 256KB, 512KB, etc.)
 * - Each piece has a SHA1 hash for verification
 * - Pieces are downloaded as blocks (typically 16KB)
 * - We request blocks from peers, assemble into pieces, then verify
 */
class Piece {
  /**
   * @param {Object} options
   * @param {number} options.index - Piece index
   * @param {number} options.length - Piece length in bytes
   * @param {Buffer} options.hash - Expected 20-byte SHA1 hash
   * @param {number} options.blockSize - Block size, default 16384 (16KB)
   */
  constructor(options) {
    this.index = options.index;
    this.length = options.length;
    this.hash = options.hash;
    this.blockSize = options.blockSize || 16384;

    if (!Buffer.isBuffer(this.hash) || this.hash.length !== 20) {
      throw new Error('hash must be a 20-byte Buffer');
    }

    if (this.length <= 0) {
      throw new Error('length must be positive');
    }

    this.blocks = [];
    this.isComplete = false;
    this.isVerified = false;
    this.data = null;

    this._initializeBlocks();
  }

  /**
   * Initializes block structure
   */
  _initializeBlocks() {
    let offset = 0;
    
    while (offset < this.length) {
      const blockLength = Math.min(this.blockSize, this.length - offset);
      
      this.blocks.push({
        offset,
        length: blockLength,
        data: null,
        received: false
      });

      offset += blockLength;
    }
  }

  /**
   * Gets the total number of blocks in this piece
   * @returns {number}
   */
  getBlockCount() {
    return this.blocks.length;
  }

  /**
   * Gets the next block that hasn't been received
   * @returns {{offset: number, length: number} | null}
   */
  getNextMissingBlock() {
    for (const block of this.blocks) {
      if (!block.received) {
        return {
          offset: block.offset,
          length: block.length
        };
      }
    }
    return null;
  }

  /**
   * Gets a specific block by offset
   * @param {number} offset
   * @returns {Object | null}
   */
  getBlockByOffset(offset) {
    return this.blocks.find(block => block.offset === offset) || null;
  }

  /**
   * Adds received block data
   * @param {number} offset - Block offset within piece
   * @param {Buffer} data - Block data
   * @returns {boolean} True if piece is now complete
   */
  addBlock(offset, data) {
    const block = this.getBlockByOffset(offset);

    if (!block) {
      throw new Error(`Invalid block offset: ${offset}`);
    }

    if (block.received) {
      return this.isComplete;
    }

    if (!Buffer.isBuffer(data)) {
      throw new Error('Block data must be a Buffer');
    }

    if (data.length !== block.length) {
      throw new Error(`Block data length mismatch: expected ${block.length}, got ${data.length}`);
    }

    block.data = data;
    block.received = true;

    this.isComplete = this.blocks.every(b => b.received);

    if (this.isComplete) {
      this.data = this.assemble();
    }

    return this.isComplete;
  }

  /**
   * Assembles all blocks into complete piece data
   * @returns {Buffer}
   */
  assemble() {
    if (!this.isComplete) {
      throw new Error('Cannot assemble incomplete piece');
    }

    const buffers = this.blocks.map(block => block.data);
    return Buffer.concat(buffers, this.length);
  }

  /**
   * Verifies the piece by computing SHA1 hash
   * @returns {boolean} True if hash matches, false if corrupt
   */
  verify() {
    if (!this.isComplete) {
      throw new Error('Cannot verify incomplete piece');
    }

    if (!this.data) {
      this.data = this.assemble();
    }

    const computedHash = crypto.createHash('sha1').update(this.data).digest();
    this.isVerified = computedHash.equals(this.hash);

    return this.isVerified;
  }

  /**
   * Resets the piece, clearing all block data
   */
  reset() {
    for (const block of this.blocks) {
      block.data = null;
      block.received = false;
    }

    this.isComplete = false;
    this.isVerified = false;
    this.data = null;
  }

  /**
   * Gets download progress as percentage
   * @returns {number} Progress from 0 to 100
   */
  getProgress() {
    const receivedBlocks = this.blocks.filter(b => b.received).length;
    return (receivedBlocks / this.blocks.length) * 100;
  }

  /**
   * Gets received byte count
   * @returns {number}
   */
  getReceivedBytes() {
    return this.blocks
      .filter(b => b.received)
      .reduce((sum, b) => sum + b.length, 0);
  }

  /**
   * Gets missing blocks
   * @returns {Array<{offset: number, length: number}>}
   */
  getMissingBlocks() {
    return this.blocks
      .filter(b => !b.received)
      .map(b => ({ offset: b.offset, length: b.length }));
  }
}

module.exports = { Piece };
