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
 */
class S3ColdStartStreamer {
  /**
   * @param {object} opts
   * @param {object} opts.torrent - The TorrentEdge Torrent instance
   * @param {string} opts.sourceUri - The S3 Pre-Signed URL
   * @param {string} opts.nodeId - The worker node ID
   * @param {string} opts.downloadPath - Base path for CAS Store
   */
  constructor(opts) {
    this.torrent = opts.torrent;
    this.sourceUri = opts.sourceUri;
    this.nodeId = opts.nodeId;
    this.casStore = new CASStore(opts.downloadPath || process.env.DOWNLOAD_PATH || './downloads');
    
    // Fallback to standard 256KB if pieceLength is undefined
    this.pieceLength = this.torrent.pieceLength || 262144; 
    this.infoHash = this.torrent.infoHash;
  }

  async start() {
    // 1. Genesis Election
    // Use Redis Lease Manager to ensure exactly one node assumes the role of Genesis Seeder
    const genesisLeaseKey = `${this.infoHash}:genesis`;
    const token = await LeaseManager.acquireLease(genesisLeaseKey, this.nodeId, 60);
    
    if (!token) {
      console.log(`[S3Streamer] Another node is already the Genesis seeder for ${this.infoHash}. Standing by to leech.`);
      return;
    }

    // Keep genesis lease alive while streaming the large file
    const leaseInterval = setInterval(() => {
      LeaseManager.renewLease(genesisLeaseKey, this.nodeId, 60).catch(() => {});
    }, 20000);

    try {
      // 2. Genesis Handoff: Determine offset from already verified pieces
      // If preempted by K8s, the next worker maps what was already committed.
      let startPiece = 0;
      if (this.torrent.pieceManager && this.torrent.pieceManager.bitfield) {
        const numPieces = this.torrent.numPieces || Math.ceil(this.torrent.size / this.pieceLength);
        for (let i = 0; i < numPieces; i++) {
          if (!this.torrent.pieceManager.bitfield.get(i)) {
            startPiece = i;
            break;
          }
        }
      }
      
      let currentOffset = startPiece * this.pieceLength;
      
      console.log(`[S3Streamer] Initiating Cold Start for ${this.infoHash} at offset ${currentOffset} (Piece ${startPiece})`);
      
      await this._streamWithRetry(currentOffset, startPiece);
      
      clearInterval(leaseInterval);
      await LeaseManager.releaseLease(genesisLeaseKey, this.nodeId);
      console.log(`[S3Streamer] Cold Start complete for ${this.infoHash}. Transfer is now seeded to the Swarm.`);
    } catch (err) {
      console.error(`[S3Streamer] Cold Start failed: ${err.message}`);
      clearInterval(leaseInterval);
      await LeaseManager.releaseLease(genesisLeaseKey, this.nodeId);
      throw err;
    }
  }

  async _streamWithRetry(initialOffset, startPieceIndex, retries = 5) {
    let offset = initialOffset;
    let pieceIndex = startPieceIndex;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          const client = this.sourceUri.startsWith('https') ? https : http;
          
          // 3. HTTP Range Requests (Resiliency)
          const req = client.get(this.sourceUri, {
            headers: {
              'Range': `bytes=${offset}-`
            }
          }, (res) => {
            if (res.statusCode >= 400 && res.statusCode !== 416) {
              return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
            if (res.statusCode === 416) {
              return resolve(); // 416 Range Not Satisfiable means we are already at the end of the file
            }

            // 4. Strict Streaming with Backpressure
            const processor = new PieceProcessor({
              pieceLength: this.pieceLength,
              initialPieceIndex: pieceIndex,
              onPieceReady: async ({ pieceData, index }) => {
                // 5. On-the-Fly Hashing & CAS commitment
                const sha256 = crypto.createHash('sha256').update(pieceData).digest('hex');
                await this.casStore.store(pieceData, sha256);
                
                // Write to BitTorrent file structure and mark piece as instantly seedable
                if (this.torrent.fileWriter) {
                  await this.torrent.fileWriter.writePiece(index, pieceData);
                }
                if (this.torrent.pieceManager) {
                  this.torrent.pieceManager.markComplete(index);
                }
                
                offset += pieceData.length;
                pieceIndex = index + 1;
              }
            });

            processor.on('finish', resolve);
            processor.on('error', reject);

            res.pipe(processor);
          });

          req.on('error', reject);
        });
        
        return; // Success, break out of retry loop
      } catch (err) {
        console.warn(`[S3Streamer] Network drop at offset ${offset} (Attempt ${attempt}/${retries}): ${err.message}`);
        if (attempt === retries) throw err;
        // Exponential backoff
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
}

/**
 * A Custom Transform Stream that strictly buffers exactly 1 pieceLength of data,
 * pauses the HTTP socket, awaits the async IO (Hashing & CAS writing), and resumes.
 * This guarantees V8 heap usage never exceeds 1 pieceLength (~256KB - 1MB).
 */
class PieceProcessor extends Transform {
  constructor(opts) {
    // Set highWaterMark to pieceLength to enforce strict backpressure
    super({ writableHighWaterMark: opts.pieceLength, readableHighWaterMark: opts.pieceLength });
    this.pieceLength = opts.pieceLength;
    this.pieceIndex = opts.initialPieceIndex || 0;
    this.buffer = Buffer.alloc(0);
    this.onPieceReady = opts.onPieceReady; // async function
  }

  async _transform(chunk, encoding, callback) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      
      while (this.buffer.length >= this.pieceLength) {
        const pieceData = this.buffer.subarray(0, this.pieceLength);
        this.buffer = this.buffer.subarray(this.pieceLength);
        
        // This await applies strict backpressure to the incoming HTTP stream!
        await this.onPieceReady({ pieceData, index: this.pieceIndex++ });
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  async _flush(callback) {
    try {
      if (this.buffer.length > 0) {
        await this.onPieceReady({ pieceData: this.buffer, index: this.pieceIndex++ });
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = S3ColdStartStreamer;
