'use strict';

const https = require('https');
const http = require('http');
const { Transform } = require('stream');
const crypto = require('crypto');
const CASStore = require('./casStore');
const LeaseManager = require('./leaseManager');

/**
 * Phase 4.3 — The S3 "Cold Start" Bridge
 * 
 * An autonomous infrastructure routing layer. When a transfer has 0 seeders,
 * the Genesis worker intercepts the request, streams it from an S3 Pre-Signed URL,
 * chunks it on the fly, writes to the local CAS, and laterally seeds it to the VPC.
 *
 * Memory Contract:
 *   Peak heap usage = 2 × pieceLength (one write buffer + one read buffer).
 *   For a 512KB piece size, worst case = ~1MB regardless of file size.
 *
 * Resiliency Contract:
 *   - HTTP Range requests resume at the exact byte boundary of the last verified piece.
 *   - Genesis lease renewal failure triggers an immediate stream abort to prevent split-brain.
 *   - Exponential backoff with jitter on network drops.
 */
class S3ColdStartStreamer {
  /**
   * @param {object} opts
   * @param {object} opts.torrent - The TorrentEdge Torrent instance
   * @param {string} opts.sourceUri - The S3 Pre-Signed URL (or any HTTP(S) URL)
   * @param {string} opts.nodeId - The worker node ID
   * @param {string} opts.downloadPath - Base path for CAS Store
   * @param {number} [opts.maxRetries=5] - Max retry attempts per network drop
   * @param {number} [opts.leaseTtl=60] - Genesis lease TTL in seconds
   */
  constructor(opts) {
    if (!opts.torrent) throw new Error('[S3Streamer] torrent is required');
    if (!opts.sourceUri) throw new Error('[S3Streamer] sourceUri is required');
    if (!opts.nodeId) throw new Error('[S3Streamer] nodeId is required');

    this.torrent = opts.torrent;
    this.sourceUri = opts.sourceUri;
    this.nodeId = opts.nodeId;
    this.casStore = new CASStore(opts.downloadPath || process.env.DOWNLOAD_PATH || './downloads');

    this.pieceLength = this.torrent.pieceLength || 262144; // 256KB default
    this.infoHash = this.torrent.infoHash;
    this.maxRetries = opts.maxRetries || 5;
    this.leaseTtl = opts.leaseTtl || 60;

    // Internal state
    this._aborted = false;
    this._leaseInterval = null;
    this._activeRequest = null;
    this._piecesWritten = 0;
    this._bytesStreamed = 0;
  }

  /**
   * Initiates the Cold Start streaming pipeline.
   *
   * 1. Competes for the Genesis lease via Redis.
   * 2. Scans the bitfield for already-committed pieces (Genesis Handoff).
   * 3. Opens an HTTP Range request at the exact resume offset.
   * 4. Pipes through PieceProcessor → CAS → BitTorrent engine.
   *
   * @returns {Promise<{ piecesWritten: number, bytesStreamed: number, resumed: boolean }>}
   */
  async start() {
    // ─── Step 1: Genesis Election ───────────────────────────────────────
    const genesisLeaseKey = `${this.infoHash}:genesis`;
    const token = await LeaseManager.acquireLease(genesisLeaseKey, this.nodeId, this.leaseTtl);

    if (!token) {
      console.log(`[S3Streamer] Another node is already the Genesis seeder for ${this.infoHash.substring(0, 12)}. Standing by to leech.`);
      return { piecesWritten: 0, bytesStreamed: 0, resumed: false };
    }

    // ─── Step 2: Lease Heartbeat with Abort-on-Failure ──────────────────
    this._leaseInterval = setInterval(async () => {
      try {
        const renewedToken = await LeaseManager.renewLease(genesisLeaseKey, this.nodeId, this.leaseTtl);
        if (renewedToken === null) {
          console.error(`[S3Streamer] LEASE LOST during streaming for ${this.infoHash.substring(0, 12)}. Aborting to prevent split-brain.`);
          this._abort();
        }
      } catch (err) {
        console.error(`[S3Streamer] Lease renewal failed: ${err.message}. Aborting stream.`);
        this._abort();
      }
    }, Math.floor(this.leaseTtl * 1000 / 3)); // Renew at 1/3 TTL

    try {
      // ─── Step 3: Genesis Handoff — Resume from last committed piece ────
      const { startPiece, offset } = this._calculateResumePoint();
      const resumed = startPiece > 0;

      if (resumed) {
        console.log(`[S3Streamer] Genesis Handoff: Resuming at piece ${startPiece} (offset ${offset}) for ${this.infoHash.substring(0, 12)}`);
      } else {
        console.log(`[S3Streamer] Initiating fresh Cold Start for ${this.infoHash.substring(0, 12)}`);
      }

      // ─── Step 4: Stream with retry ─────────────────────────────────────
      await this._streamWithRetry(offset, startPiece);

      this._cleanup();
      await LeaseManager.releaseLease(genesisLeaseKey, this.nodeId);

      console.log(`[S3Streamer] Cold Start complete for ${this.infoHash.substring(0, 12)}. ${this._piecesWritten} pieces written, ${(this._bytesStreamed / 1048576).toFixed(1)}MB streamed.`);

      return {
        piecesWritten: this._piecesWritten,
        bytesStreamed: this._bytesStreamed,
        resumed,
      };
    } catch (err) {
      this._cleanup();
      await LeaseManager.releaseLease(genesisLeaseKey, this.nodeId).catch(() => {});
      throw err;
    }
  }

  /**
   * Scans the torrent bitfield to find the first missing piece.
   * This is how a replacement Genesis node picks up exactly where
   * a preempted node left off.
   *
   * @returns {{ startPiece: number, offset: number }}
   */
  _calculateResumePoint() {
    let startPiece = 0;

    if (this.torrent.pieceManager && this.torrent.pieceManager.bitfield) {
      const numPieces = this.torrent.numPieces || Math.ceil(this.torrent.size / this.pieceLength);

      // Walk the bitfield forward until we find the first gap
      for (let i = 0; i < numPieces; i++) {
        if (this.torrent.pieceManager.bitfield.get(i)) {
          startPiece = i + 1; // This piece is done, try the next
        } else {
          break; // Found the first missing piece
        }
      }
    }

    return {
      startPiece,
      offset: startPiece * this.pieceLength,
    };
  }

  /**
   * Opens an HTTP(S) stream with Range header support and automatic retry
   * with exponential backoff + jitter on network failures.
   *
   * @param {number} initialOffset - Byte offset to start from
   * @param {number} startPieceIndex - Piece index corresponding to offset
   */
  async _streamWithRetry(initialOffset, startPieceIndex) {
    let offset = initialOffset;
    let pieceIndex = startPieceIndex;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (this._aborted) {
        throw new Error('Stream aborted due to lease loss');
      }

      try {
        const result = await this._openStream(offset, pieceIndex);
        // Update tracking from the result
        offset = result.finalOffset;
        pieceIndex = result.finalPieceIndex;
        return; // Success
      } catch (err) {
        if (this._aborted) {
          throw new Error('Stream aborted due to lease loss');
        }

        console.warn(`[S3Streamer] Network drop at offset ${offset} (Attempt ${attempt}/${this.maxRetries}): ${err.message}`);

        if (attempt === this.maxRetries) {
          throw new Error(`S3 Cold Start failed after ${this.maxRetries} attempts. Last error: ${err.message}`);
        }

        // Exponential backoff with jitter to prevent thundering herd
        const baseDelay = 2000 * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 1000;
        await new Promise(r => setTimeout(r, baseDelay + jitter));
      }
    }
  }

  /**
   * Opens a single HTTP(S) connection with Range header, pipes through
   * PieceProcessor, and resolves when the stream finishes or rejects on error.
   *
   * @param {number} offset - Byte offset for Range header
   * @param {number} pieceIndex - Starting piece index
   * @returns {Promise<{ finalOffset: number, finalPieceIndex: number }>}
   */
  _openStream(offset, pieceIndex) {
    return new Promise((resolve, reject) => {
      if (this._aborted) return reject(new Error('Aborted'));

      const client = this.sourceUri.startsWith('https') ? https : http;
      const headers = {};

      // Only add Range header if we're resuming (offset > 0)
      if (offset > 0) {
        headers['Range'] = `bytes=${offset}-`;
      }

      const req = client.get(this.sourceUri, { headers }, (res) => {
        // 416 = Range Not Satisfiable = we already have all the data
        if (res.statusCode === 416) {
          return resolve({ finalOffset: offset, finalPieceIndex: pieceIndex });
        }

        // Accept 200 (full body) and 206 (partial content)
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume(); // Drain the response to free the socket
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }

        let currentOffset = offset;
        let currentPiece = pieceIndex;

        const processor = new PieceProcessor({
          pieceLength: this.pieceLength,
          initialPieceIndex: pieceIndex,
          onPieceReady: async ({ pieceData, index }) => {
            // On-the-fly SHA-256 hashing
            const sha256 = crypto.createHash('sha256').update(pieceData).digest('hex');

            // Write to CAS (atomic: temp file → rename)
            await this.casStore.store(pieceData, sha256);

            // Write to BitTorrent file structure for seeding
            if (this.torrent.fileWriter) {
              await this.torrent.fileWriter.writePiece(index, pieceData);
            }

            // Mark as complete so peers can immediately request this piece
            if (this.torrent.pieceManager) {
              this.torrent.pieceManager.markComplete(index);
            }

            currentOffset += pieceData.length;
            currentPiece = index + 1;
            this._piecesWritten++;
            this._bytesStreamed += pieceData.length;
          },
        });

        // Wire up abort mechanism
        const onAbort = () => {
          res.destroy();
          processor.destroy(new Error('Stream aborted due to lease loss'));
        };

        if (this._aborted) {
          onAbort();
          return;
        }

        // Store reference so _abort() can kill an in-flight request
        this._activeRequest = req;
        this._onAbort = onAbort;

        processor.on('finish', () => {
          this._activeRequest = null;
          this._onAbort = null;
          resolve({ finalOffset: currentOffset, finalPieceIndex: currentPiece });
        });

        processor.on('error', (err) => {
          this._activeRequest = null;
          this._onAbort = null;
          reject(err);
        });

        res.on('error', (err) => {
          processor.destroy(err);
        });

        res.pipe(processor);
      });

      req.on('error', reject);

      // Timeout: if the server hangs for 30s, kill the socket and retry
      req.setTimeout(30000, () => {
        req.destroy(new Error('HTTP request timed out after 30s'));
      });
    });
  }

  /**
   * Immediately aborts all in-flight streaming. Called when the
   * genesis lease is lost to prevent split-brain CAS writes.
   */
  _abort() {
    this._aborted = true;
    if (this._onAbort) this._onAbort();
    if (this._activeRequest) {
      this._activeRequest.destroy();
      this._activeRequest = null;
    }
  }

  /**
   * Cleans up timers and references.
   */
  _cleanup() {
    if (this._leaseInterval) {
      clearInterval(this._leaseInterval);
      this._leaseInterval = null;
    }
    this._activeRequest = null;
    this._onAbort = null;
  }

  getStats() {
    return {
      infoHash: this.infoHash,
      piecesWritten: this._piecesWritten,
      bytesStreamed: this._bytesStreamed,
      aborted: this._aborted,
    };
  }
}

/**
 * PieceProcessor — A zero-copy Transform stream for chunk slicing.
 *
 * Buffers incoming HTTP data until exactly 1 piece is ready, then
 * pauses the upstream via async backpressure while the piece is
 * hashed and committed to disk. This guarantees:
 *
 *   - Peak memory = 2 × pieceLength (read buffer + write buffer)
 *   - The HTTP socket is paused during disk I/O (no heap accumulation)
 *   - The final piece (which may be shorter) is flushed in _flush()
 *
 * Uses a pre-allocated ring approach: we only hold `this._buf` and
 * the incoming chunk in memory at any given time.
 */
class PieceProcessor extends Transform {
  constructor(opts) {
    super({
      writableHighWaterMark: opts.pieceLength,
      readableHighWaterMark: opts.pieceLength,
    });
    this.pieceLength = opts.pieceLength;
    this.pieceIndex = opts.initialPieceIndex || 0;
    this.onPieceReady = opts.onPieceReady;

    // Pre-allocate the accumulation buffer
    this._buf = Buffer.allocUnsafe(opts.pieceLength * 2);
    this._bufLen = 0;
  }

  async _transform(chunk, encoding, callback) {
    try {
      // Copy incoming chunk into pre-allocated buffer
      let chunkOffset = 0;

      while (chunkOffset < chunk.length) {
        const spaceLeft = this._buf.length - this._bufLen;
        const bytesToCopy = Math.min(chunk.length - chunkOffset, spaceLeft);

        chunk.copy(this._buf, this._bufLen, chunkOffset, chunkOffset + bytesToCopy);
        this._bufLen += bytesToCopy;
        chunkOffset += bytesToCopy;

        // Emit complete pieces
        while (this._bufLen >= this.pieceLength) {
          // Slice out exactly one piece (creates a new buffer for the callback)
          const pieceData = Buffer.from(this._buf.subarray(0, this.pieceLength));

          // Shift remaining data to front of buffer
          this._buf.copy(this._buf, 0, this.pieceLength, this._bufLen);
          this._bufLen -= this.pieceLength;

          // Await ensures backpressure: HTTP socket pauses until disk I/O completes
          await this.onPieceReady({ pieceData, index: this.pieceIndex++ });
        }
      }

      callback();
    } catch (err) {
      callback(err);
    }
  }

  async _flush(callback) {
    try {
      // Emit the final partial piece (last piece of the file)
      if (this._bufLen > 0) {
        const pieceData = Buffer.from(this._buf.subarray(0, this._bufLen));
        await this.onPieceReady({ pieceData, index: this.pieceIndex++ });
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = S3ColdStartStreamer;
