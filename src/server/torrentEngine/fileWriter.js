const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Handles writing piece data to correct files on disk
 * 
 * File mapping logic:
 * - Each file has a byte offset in the torrent's total data
 * - Pieces may span multiple files
 * - For piece at offset P with length L, find files overlapping [P, P+L)
 * - For each file, calculate position and length to write
 */
class FileWriter {
  constructor(options) {
    this.torrent = options.torrent;
    this.downloadPath = options.downloadPath;
    
    this.basePath = path.join(this.downloadPath, this.torrent.name);
    this.files = [];
    this.totalLength = this.torrent.length;
    this.fileHandles = new Map();
    this.isInitialized = false;

    this._buildFileMap();
  }

  /**
   * Builds file mapping with byte offsets
   */
  _buildFileMap() {
    let offset = 0;

    if (this.torrent.isMultiFile) {
      for (const file of this.torrent.files) {
        this.files.push({
          path: file.path,
          length: file.length,
          offset
        });
        offset += file.length;
      }
    } else {
      // Single file torrent
      this.files.push({
        path: this.torrent.name,
        length: this.torrent.length,
        offset: 0
      });
    }
  }

  /**
   * Initializes file structure on disk
   */
  async initialize() {
    if (this.isInitialized) {
      return;
    }

    // Create base directory
    await fs.mkdir(this.basePath, { recursive: true });

    // Create and pre-allocate files
    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i];
      const filePath = this.getFilePath(i);

      // Create directory structure for multi-file torrents
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      try {
        // Check if file already exists
        const stats = await fs.stat(filePath);
        
        if (stats.size !== file.length) {
          // Truncate or extend to correct size
          const fd = await fs.open(filePath, 'r+');
          await fd.truncate(file.length);
          await fd.close();
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, create it
          const fd = await fs.open(filePath, 'w');
          await fd.truncate(file.length);
          await fd.close();
        } else {
          throw error;
        }
      }
    }

    this.isInitialized = true;
  }

  /**
   * Writes piece data to the correct file(s)
   * @param {number} pieceIndex
   * @param {Buffer} data
   */
  async writePiece(pieceIndex, data) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const pieceLength = this.torrent.pieceLength;
    const pieceOffset = pieceIndex * pieceLength;
    const pieceEnd = pieceOffset + data.length;

    // Find files that overlap with this piece
    const overlappingFiles = this._getOverlappingFiles(pieceOffset, pieceEnd);

    let dataOffset = 0;

    for (const { fileIndex, fileOffset, length } of overlappingFiles) {
      const filePath = this.getFilePath(fileIndex);
      const chunk = data.slice(dataOffset, dataOffset + length);

      const fd = await fs.open(filePath, 'r+');
      await fd.write(chunk, 0, length, fileOffset);
      await fd.close();

      dataOffset += length;
    }
  }

  /**
   * Reads piece data from file(s)
   * @param {number} pieceIndex
   * @returns {Promise<Buffer>}
   */
  async readPiece(pieceIndex) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const pieceLength = this.torrent.pieceLength;
    const numPieces = this.torrent.pieces.length;
    const isLastPiece = pieceIndex === numPieces - 1;
    const actualLength = isLastPiece 
      ? this.totalLength - (pieceIndex * pieceLength)
      : pieceLength;

    const pieceOffset = pieceIndex * pieceLength;
    const pieceEnd = pieceOffset + actualLength;

    const overlappingFiles = this._getOverlappingFiles(pieceOffset, pieceEnd);
    const buffers = [];

    for (const { fileIndex, fileOffset, length } of overlappingFiles) {
      const filePath = this.getFilePath(fileIndex);
      const buffer = Buffer.allocUnsafe(length);

      const fd = await fs.open(filePath, 'r');
      await fd.read(buffer, 0, length, fileOffset);
      await fd.close();

      buffers.push(buffer);
    }

    return Buffer.concat(buffers, actualLength);
  }

  /**
   * Finds files that overlap with given byte range
   * @param {number} start - Start byte offset
   * @param {number} end - End byte offset
   * @returns {Array<{fileIndex, fileOffset, length}>}
   */
  _getOverlappingFiles(start, end) {
    const overlapping = [];

    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i];
      const fileStart = file.offset;
      const fileEnd = file.offset + file.length;

      // Check if ranges overlap
      if (start < fileEnd && end > fileStart) {
        const overlapStart = Math.max(start, fileStart);
        const overlapEnd = Math.min(end, fileEnd);
        
        overlapping.push({
          fileIndex: i,
          fileOffset: overlapStart - fileStart,
          length: overlapEnd - overlapStart
        });
      }
    }

    return overlapping;
  }

  /**
   * Verifies existing pieces on disk
   * @returns {Promise<{valid: number[], invalid: number[]}>}
   */
  async verify() {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const valid = [];
    const invalid = [];
    const numPieces = this.torrent.pieces.length;

    for (let i = 0; i < numPieces; i++) {
      try {
        const data = await this.readPiece(i);
        const computedHash = crypto.createHash('sha1').update(data).digest();
        const expectedHash = this.torrent.pieces[i];

        if (computedHash.equals(expectedHash)) {
          valid.push(i);
        } else {
          invalid.push(i);
        }
      } catch (error) {
        // If we can't read the piece, consider it invalid
        invalid.push(i);
      }
    }

    return { valid, invalid };
  }

  /**
   * Gets absolute file path for a file index
   * @param {number} fileIndex
   * @returns {string}
   */
  getFilePath(fileIndex) {
    if (fileIndex < 0 || fileIndex >= this.files.length) {
      throw new Error(`Invalid file index: ${fileIndex}`);
    }

    const file = this.files[fileIndex];
    
    if (this.torrent.isMultiFile) {
      return path.join(this.basePath, file.path);
    } else {
      return path.join(this.downloadPath, file.path);
    }
  }

  /**
   * Gets file information
   * @returns {Array<{path, length, offset}>}
   */
  getFileInfo() {
    return this.files.map(f => ({
      path: f.path,
      length: f.length,
      offset: f.offset
    }));
  }

  /**
   * Calculates which piece(s) a file byte range belongs to
   * @param {number} fileIndex
   * @param {number} offset - Offset within file
   * @param {number} length - Length to read
   * @returns {Array<number>} Piece indices
   */
  getPiecesForFileRange(fileIndex, offset, length) {
    const file = this.files[fileIndex];
    const absoluteStart = file.offset + offset;
    const absoluteEnd = absoluteStart + length;
    
    const pieceLength = this.torrent.pieceLength;
    const startPiece = Math.floor(absoluteStart / pieceLength);
    const endPiece = Math.floor((absoluteEnd - 1) / pieceLength);
    
    const pieces = [];
    for (let i = startPiece; i <= endPiece; i++) {
      pieces.push(i);
    }
    
    return pieces;
  }

  /**
   * Gets progress for individual files
   * @param {Set<number>} completedPieces - Set of completed piece indices
   * @returns {Array<{path, downloaded, total, percentage}>}
   */
  getFileProgress(completedPieces) {
    return this.files.map((file, index) => {
      const pieces = this.getPiecesForFileRange(index, 0, file.length);
      const completedCount = pieces.filter(p => completedPieces.has(p)).length;
      const percentage = (completedCount / pieces.length) * 100;
      
      return {
        path: file.path,
        downloaded: Math.floor((completedCount / pieces.length) * file.length),
        total: file.length,
        percentage
      };
    });
  }

  /**
   * Closes any open file handles
   */
  async close() {
    const handles = Array.from(this.fileHandles.values());
    this.fileHandles.clear();

    for (const fd of handles) {
      try {
        await fd.close();
      } catch (error) {
        // Ignore errors on close
      }
    }
  }

  /**
   * Removes all downloaded files
   */
  async cleanup() {
    await this.close();

    try {
      // Remove all files
      for (let i = 0; i < this.files.length; i++) {
        const filePath = this.getFilePath(i);
        try {
          await fs.unlink(filePath);
        } catch (error) {
          // File may not exist
        }
      }

      // Remove base directory if empty
      if (this.torrent.isMultiFile) {
        try {
          await fs.rmdir(this.basePath, { recursive: true });
        } catch (error) {
          // Directory may not be empty or not exist
        }
      }
    } catch (error) {
      throw new Error(`Cleanup failed: ${error.message}`);
    }
  }
}

module.exports = { FileWriter };
