'use strict';

/**
 * TorrentEdge — Torrent Creator Service
 *
 * Given a file buffer + metadata, produces:
 *  - A valid .torrent file buffer (bencoded)
 *  - An infoHash (hex string)
 *  - A magnet URI
 *
 * Conforms to BitTorrent spec (BEP-3):
 *   https://www.bittorrent.org/beps/bep_0003.html
 */

const crypto = require('crypto');
const { encode } = require('./bencode');

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PIECE_SIZE = 256 * 1024; // 256 KB — good default for most files

/**
 * Default public trackers to announce to.
 * These are well-known open trackers — can be overridden by caller.
 */
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
];

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Creates a .torrent file from a file buffer.
 *
 * @param {Buffer} fileBuffer       - The raw file content
 * @param {Object} options
 * @param {string} options.name     - Torrent/file name (e.g. "mydoc.pdf")
 * @param {number} [options.pieceSize=262144] - Piece length in bytes (default 256KB)
 * @param {string[]} [options.trackers]       - Tracker announce URLs
 * @param {boolean} [options.private=false]   - Mark as private (disables DHT/PEX)
 * @param {string} [options.createdBy='TorrentEdge'] - Creator string
 *
 * @returns {{
 *   torrentBuffer: Buffer,   // The .torrent file bytes — save as filename.torrent
 *   infoHash: string,        // Hex info hash (40 chars)
 *   magnetURI: string,       // Ready-to-use magnet link
 *   name: string,            // Torrent name used
 *   pieceLength: number,     // Piece size used
 *   pieceCount: number,      // How many pieces
 *   fileSize: number,        // Original file size in bytes
 * }}
 */
function createTorrent(fileBuffer, options = {}) {
  // ── Input validation ──────────────────────────────────────────────────────
  if (!Buffer.isBuffer(fileBuffer)) {
    throw new Error('fileBuffer must be a Buffer');
  }
  if (fileBuffer.length === 0) {
    throw new Error('fileBuffer is empty — nothing to create a torrent from');
  }

  const name       = sanitizeName(options.name || 'untitled');
  const pieceSize  = resolvePieceSize(options.pieceSize, fileBuffer.length);
  const trackers   = options.trackers && options.trackers.length > 0
    ? options.trackers
    : DEFAULT_TRACKERS;
  const isPrivate  = options.private === true ? 1 : undefined;
  const createdBy  = options.createdBy || 'TorrentEdge';
  const createdAt  = Math.floor(Date.now() / 1000); // Unix timestamp

  // ── Step 1: Hash pieces ───────────────────────────────────────────────────
  const piecesBuffer = hashPieces(fileBuffer, pieceSize, options.onProgress);
  const pieceCount   = Math.ceil(fileBuffer.length / pieceSize);

  // ── Step 2: Build info dict (BEP-3 single-file mode) ─────────────────────
  const info = buildInfoDict({
    name,
    length: fileBuffer.length,
    pieceLength: pieceSize,
    pieces: piecesBuffer,
    isPrivate,
  });

  // ── Step 3: Calculate infoHash ────────────────────────────────────────────
  const encodedInfo = encode(info);
  const infoHash    = crypto.createHash('sha1').update(encodedInfo).digest('hex');

  // ── Step 4: Build full torrent dict ───────────────────────────────────────
  const torrentDict = buildTorrentDict({
    info,
    announce: trackers[0],
    announceList: trackers,
    createdBy,
    createdAt,
  });

  // ── Step 5: Bencode the whole thing ───────────────────────────────────────
  const torrentBuffer = encode(torrentDict);

  // ── Step 6: Build magnet URI ──────────────────────────────────────────────
  const magnetURI = buildMagnetURI({ infoHash, name, trackers });

  return {
    torrentBuffer,
    infoHash,
    magnetURI,
    name,
    pieceLength: pieceSize,
    pieceCount,
    fileSize: fileBuffer.length,
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Hashes each piece of the file using SHA1.
 * BitTorrent spec: pieces = concatenation of 20-byte SHA1 hashes, one per piece.
 *
 * @param {Buffer}   fileBuffer
 * @param {number}   pieceSize
 * @param {Function} [onProgress]  Called with (piecesHashed, totalPieces) after each piece.
 *                                 Use for progress reporting on large files.
 * @returns {Buffer} Concatenated raw SHA1 digests (20 bytes × pieceCount)
 */
function hashPieces(fileBuffer, pieceSize, onProgress) {
  const pieceCount  = Math.ceil(fileBuffer.length / pieceSize);
  const hashBuffers = [];

  for (let i = 0; i < pieceCount; i++) {
    const start  = i * pieceSize;
    const end    = Math.min(start + pieceSize, fileBuffer.length);
    const piece  = fileBuffer.slice(start, end);
    const hash   = crypto.createHash('sha1').update(piece).digest();
    hashBuffers.push(hash);

    if (onProgress) {
      onProgress(i + 1, pieceCount);
    }
  }

  return Buffer.concat(hashBuffers); // 20 bytes × N pieces
}

/**
 * Builds the `info` dictionary (the core of a .torrent file).
 * Keys MUST be sorted alphabetically (bencode spec).
 * Our bencode encoder already handles sorting — but we build cleanly anyway.
 *
 * Single-file mode (BEP-3):
 * {
 *   length:       <file size in bytes>,
 *   name:         <filename>,
 *   piece length: <bytes per piece>,
 *   pieces:       <concatenated SHA1 hashes>,
 *   private:      <1 if private> (optional)
 * }
 */
function buildInfoDict({ name, length, pieceLength, pieces, isPrivate }) {
  const info = {
    length,
    name:            Buffer.from(name, 'utf8'),
    'piece length':  pieceLength,
    pieces,          // Raw Buffer of concatenated SHA1s
  };

  // Only include `private` key if explicitly set (absence = public)
  if (isPrivate === 1) {
    info.private = 1;
  }

  return info;
}

/**
 * Builds the outer torrent dictionary.
 * {
 *   announce:       <primary tracker URL>,
 *   announce-list:  [[tracker1], [tracker2], ...],
 *   created by:     <client string>,
 *   creation date:  <unix timestamp>,
 *   info:           <info dict>
 * }
 */
function buildTorrentDict({ info, announce, announceList, createdBy, createdAt }) {
  const dict = {
    announce:        Buffer.from(announce, 'utf8'),
    'announce-list': announceList.map(url => [Buffer.from(url, 'utf8')]),
    'created by':    Buffer.from(createdBy, 'utf8'),
    'creation date': createdAt,
    info,
  };

  return dict;
}

/**
 * Builds a magnet URI from infoHash, name, and tracker list.
 *
 * Format:
 *   magnet:?xt=urn:btih:<INFOHASH>&dn=<NAME>&tr=<TRACKER1>&tr=<TRACKER2>...
 */
function buildMagnetURI({ infoHash, name, trackers }) {
  const params = [
    `xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(name)}`,
    ...trackers.map(t => `tr=${encodeURIComponent(t)}`),
  ];

  return `magnet:?${params.join('&')}`;
}

/**
 * Picks an appropriate piece size.
 * - Respects caller's choice if provided and valid
 * - Falls back to DEFAULT_PIECE_SIZE (256KB)
 * - Clamps to valid range: 16KB – 8MB
 * - Must be a power of 2 (BitTorrent convention — warn but don't block)
 *
 * @param {number|undefined} requested
 * @param {number} fileSize
 * @returns {number}
 */
function resolvePieceSize(requested, fileSize) {
  const MIN = 16 * 1024;       // 16 KB
  const MAX = 8 * 1024 * 1024; // 8 MB

  if (requested !== undefined) {
    if (typeof requested !== 'number' || requested < MIN || requested > MAX) {
      throw new Error(`pieceSize must be between ${MIN} and ${MAX} bytes`);
    }
    return requested;
  }

  // Auto-select based on file size for reasonable piece counts (200–2000 pieces)
  if (fileSize < 64 * 1024 * 1024)        return 256 * 1024;  // < 64 MB  → 256 KB
  if (fileSize < 512 * 1024 * 1024)       return 512 * 1024;  // < 512 MB → 512 KB
  if (fileSize < 2 * 1024 * 1024 * 1024)  return 1024 * 1024; // < 2 GB   → 1 MB
  return 2 * 1024 * 1024;                                       // ≥ 2 GB   → 2 MB
}

/**
 * Sanitizes a torrent/file name.
 * Removes path separators and control characters that would break things.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('name must be a non-empty string');
  }
  return name
    .trim()
    .replace(/[/\\:*?"<>|]/g, '_')  // Replace invalid filesystem chars
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .substring(0, 255);              // Max filename length
}

// ─── Phase 1.2 ────────────────────────────────────────────────────────────────

/**
 * Extracts magnet URI from an existing .torrent buffer.
 *
 * Useful when:
 *  - User uploads a .torrent file and you want to give them a magnet link
 *  - You have a stored .torrent and need its magnet URI on demand
 *
 * @param {Buffer} torrentBuffer  - Raw .torrent file bytes
 * @returns {{
 *   magnetURI:   string,    // Full magnet link
 *   infoHash:    string,    // 40-char hex
 *   name:        string,    // Torrent name
 *   trackers:    string[],  // All tracker URLs found
 *   fileSize:    number,    // Total file size in bytes
 *   pieceLength: number,    // Piece size used
 * }}
 */
function torrentToMagnet(torrentBuffer) {
  if (!Buffer.isBuffer(torrentBuffer)) {
    throw new Error('torrentBuffer must be a Buffer');
  }

  // ── Decode the .torrent ──────────────────────────────────────────────────
  const { decode } = require('./bencode');
  let torrent;
  try {
    torrent = decode(torrentBuffer);
  } catch (err) {
    throw new Error(`Failed to decode torrent: ${err.message}`);
  }

  if (!torrent || !torrent.info) {
    throw new Error('Invalid torrent: missing info dictionary');
  }

  const info = torrent.info;

  // ── Re-encode info dict → SHA1 → infoHash ───────────────────────────────
  // We MUST re-encode the info dict (not use raw torrentBuffer) because the
  // infoHash is specifically the SHA1 of the bencoded info dictionary only,
  // not the whole .torrent file.
  const encodedInfo = encode(info);
  const infoHash    = crypto.createHash('sha1').update(encodedInfo).digest('hex');

  // ── Extract name ─────────────────────────────────────────────────────────
  const name = info.name
    ? (Buffer.isBuffer(info.name) ? info.name.toString('utf8') : String(info.name))
    : 'unknown';

  // ── Extract trackers ─────────────────────────────────────────────────────
  const trackers = extractTrackersFromDict(torrent);

  // ── Extract file size ────────────────────────────────────────────────────
  let fileSize = 0;
  if (typeof info.length === 'number') {
    // Single-file mode
    fileSize = info.length;
  } else if (Array.isArray(info.files)) {
    // Multi-file mode — sum all file lengths
    fileSize = info.files.reduce((sum, f) => sum + (f.length || 0), 0);
  }

  // ── Extract piece length ─────────────────────────────────────────────────
  const pieceLength = typeof info['piece length'] === 'number'
    ? info['piece length']
    : 0;

  // ── Build magnet URI ─────────────────────────────────────────────────────
  const magnetURI = buildMagnetURI({ infoHash, name, trackers });

  return {
    magnetURI,
    infoHash,
    name,
    trackers,
    fileSize,
    pieceLength,
  };
}

/**
 * All-in-one: create torrent from file → return everything.
 *
 * This is the combined output of Phase 1.1 + 1.2:
 *  - .torrent buffer (save/download as file)
 *  - infoHash (store in DB, use as ID)
 *  - magnet URI (share with others)
 *
 * Identical to `createTorrent` but with the magnet explicitly
 * confirmed via round-trip through `torrentToMagnet` to guarantee
 * consistency between the two paths.
 *
 * @param {Buffer} fileBuffer
 * @param {Object} options  — same as createTorrent()
 * @returns {{
 *   torrentBuffer: Buffer,
 *   infoHash:      string,
 *   magnetURI:     string,
 *   name:          string,
 *   pieceLength:   number,
 *   pieceCount:    number,
 *   fileSize:      number,
 *   trackers:      string[],
 * }}
 */
function createTorrentWithMagnet(fileBuffer, options = {}) {
  // Create the torrent
  const created = createTorrent(fileBuffer, options);

  // Round-trip: extract magnet from the buffer we just made
  // This guarantees the magnet matches exactly what's in the .torrent file
  const extracted = torrentToMagnet(created.torrentBuffer);

  // Both paths should produce the same infoHash — throw if not (sanity check)
  if (created.infoHash !== extracted.infoHash) {
    throw new Error(
      `infoHash mismatch — created: ${created.infoHash}, extracted: ${extracted.infoHash}`
    );
  }

  return {
    torrentBuffer: created.torrentBuffer,
    infoHash:      created.infoHash,
    magnetURI:     extracted.magnetURI,  // from round-trip (canonical)
    name:          created.name,
    pieceLength:   created.pieceLength,
    pieceCount:    created.pieceCount,
    fileSize:      created.fileSize,
    trackers:      extracted.trackers,
  };
}

// ─── Tracker Extraction Helper ────────────────────────────────────────────────

/**
 * Extracts all unique tracker URLs from a decoded torrent dictionary.
 * Handles both `announce` (single) and `announce-list` (multi-tier).
 *
 * @param {Object} torrentDict  - Decoded torrent dictionary
 * @returns {string[]}          - Deduplicated array of tracker URLs
 */
function extractTrackersFromDict(torrentDict) {
  const seen    = new Set();
  const result  = [];

  const addTracker = (url) => {
    if (!url) return;
    const str = Buffer.isBuffer(url) ? url.toString('utf8') : String(url);
    const trimmed = str.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  };

  // Primary announce
  addTracker(torrentDict.announce);

  // announce-list: [[tier1tracker1, tier1tracker2], [tier2tracker1], ...]
  if (Array.isArray(torrentDict['announce-list'])) {
    for (const tier of torrentDict['announce-list']) {
      if (Array.isArray(tier)) {
        for (const url of tier) addTracker(url);
      } else {
        addTracker(tier);
      }
    }
  }

  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createTorrent,
  torrentToMagnet,
  createTorrentWithMagnet,
  // Expose internals for unit testing (Phase 1.3)
  _internal: {
    hashPieces,
    buildInfoDict,
    buildTorrentDict,
    buildMagnetURI,
    resolvePieceSize,
    sanitizeName,
    extractTrackersFromDict,
  },
};
