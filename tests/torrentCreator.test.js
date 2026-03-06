'use strict';

/**
 * Unit tests for torrentCreator.js — Phase 1.3
 *
 * Coverage:
 *  - createTorrent()            : core creation, output shape, determinism
 *  - torrentToMagnet()          : extract magnet from existing .torrent buffer
 *  - createTorrentWithMagnet()  : round-trip consistency
 *  - _internal helpers          : hashPieces, resolvePieceSize, sanitizeName, etc.
 *  - Edge cases & error handling
 */

const crypto = require('crypto');
const {
  createTorrent,
  torrentToMagnet,
  createTorrentWithMagnet,
  _internal,
} = require('../src/server/torrentEngine/torrentCreator');

const { decode } = require('../src/server/torrentEngine/bencode');

const {
  hashPieces,
  buildInfoDict,
  buildTorrentDict,
  buildMagnetURI,
  resolvePieceSize,
  sanitizeName,
  extractTrackersFromDict,
} = _internal;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Small deterministic buffers for test repeatability
const SMALL_FILE   = Buffer.from('Hello TorrentEdge! This is a small test file.');        // 45 bytes
const MEDIUM_FILE  = Buffer.from('A'.repeat(512 * 1024));                                  // 512 KB
const PDF_LIKE     = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('x'.repeat(10000))]); // fake pdf

const DEFAULT_NAME     = 'test-file.txt';
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
];

// ─── createTorrent() ──────────────────────────────────────────────────────────

describe('createTorrent()', () => {

  describe('Output shape', () => {
    let result;

    beforeAll(() => {
      result = createTorrent(SMALL_FILE, {
        name: DEFAULT_NAME,
        trackers: DEFAULT_TRACKERS,
      });
    });

    it('returns a torrentBuffer that is a Buffer', () => {
      expect(Buffer.isBuffer(result.torrentBuffer)).toBe(true);
    });

    it('torrentBuffer is non-empty', () => {
      expect(result.torrentBuffer.length).toBeGreaterThan(0);
    });

    it('returns a 40-char hex infoHash', () => {
      expect(typeof result.infoHash).toBe('string');
      expect(result.infoHash).toHaveLength(40);
      expect(/^[a-f0-9]{40}$/.test(result.infoHash)).toBe(true);
    });

    it('returns a valid magnet URI', () => {
      expect(result.magnetURI).toMatch(/^magnet:\?xt=urn:btih:[a-f0-9]{40}/);
    });

    it('magnet URI contains dn (display name)', () => {
      expect(result.magnetURI).toContain('dn=');
    });

    it('magnet URI contains tracker params', () => {
      expect(result.magnetURI).toContain('tr=');
    });

    it('returns correct name', () => {
      expect(result.name).toBe(DEFAULT_NAME);
    });

    it('returns correct fileSize', () => {
      expect(result.fileSize).toBe(SMALL_FILE.length);
    });

    it('returns pieceLength as a positive number', () => {
      expect(typeof result.pieceLength).toBe('number');
      expect(result.pieceLength).toBeGreaterThan(0);
    });

    it('returns pieceCount >= 1', () => {
      expect(result.pieceCount).toBeGreaterThanOrEqual(1);
    });

    it('pieceCount matches Math.ceil(fileSize / pieceLength)', () => {
      const expected = Math.ceil(result.fileSize / result.pieceLength);
      expect(result.pieceCount).toBe(expected);
    });
  });

  describe('Torrent buffer is valid bencode', () => {
    let parsed;
    let result;

    beforeAll(() => {
      result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      parsed = decode(result.torrentBuffer);
    });

    it('torrent buffer decodes without error', () => {
      expect(parsed).toBeDefined();
    });

    it('has announce field', () => {
      expect(parsed.announce).toBeDefined();
      expect(parsed.announce.toString()).toBe(DEFAULT_TRACKERS[0]);
    });

    it('has announce-list field', () => {
      expect(Array.isArray(parsed['announce-list'])).toBe(true);
      expect(parsed['announce-list'].length).toBe(DEFAULT_TRACKERS.length);
    });

    it('has info dictionary', () => {
      expect(parsed.info).toBeDefined();
      expect(typeof parsed.info).toBe('object');
    });

    it('info.name matches input name', () => {
      expect(parsed.info.name.toString('utf8')).toBe(DEFAULT_NAME);
    });

    it('info.length matches file size', () => {
      expect(parsed.info.length).toBe(SMALL_FILE.length);
    });

    it('info["piece length"] is a positive integer', () => {
      expect(typeof parsed.info['piece length']).toBe('number');
      expect(parsed.info['piece length']).toBeGreaterThan(0);
    });

    it('info.pieces is a Buffer', () => {
      expect(Buffer.isBuffer(parsed.info.pieces)).toBe(true);
    });

    it('info.pieces length = pieceCount × 20 bytes', () => {
      expect(parsed.info.pieces.length).toBe(result.pieceCount * 20);
    });

    it('has created by field', () => {
      expect(parsed['created by']).toBeDefined();
      expect(parsed['created by'].toString()).toBe('TorrentEdge');
    });

    it('has creation date as unix timestamp', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(parsed['creation date']).toBeGreaterThan(now - 10);
      expect(parsed['creation date']).toBeLessThanOrEqual(now + 1);
    });
  });

  describe('Determinism', () => {
    it('same file + same options → same infoHash', () => {
      const r1 = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      const r2 = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      expect(r1.infoHash).toBe(r2.infoHash);
    });

    it('same file + same options → identical torrent buffers', () => {
      const r1 = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      const r2 = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      expect(r1.torrentBuffer.equals(r2.torrentBuffer)).toBe(true);
    });

    it('different files → different infoHashes', () => {
      const r1 = createTorrent(SMALL_FILE,  { name: 'a.txt' });
      const r2 = createTorrent(MEDIUM_FILE, { name: 'b.txt' });
      expect(r1.infoHash).not.toBe(r2.infoHash);
    });

    it('same file + different name → different infoHash (name is part of info)', () => {
      const r1 = createTorrent(SMALL_FILE, { name: 'name-a.txt' });
      const r2 = createTorrent(SMALL_FILE, { name: 'name-b.txt' });
      expect(r1.infoHash).not.toBe(r2.infoHash);
    });
  });

  describe('infoHash correctness', () => {
    it('infoHash = SHA1 of bencoded info dict', () => {
      const result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME });
      const parsed = decode(result.torrentBuffer);

      // Re-encode info dict and hash it manually
      const { encode } = require('../src/server/torrentEngine/bencode');
      const encodedInfo  = encode(parsed.info);
      const expectedHash = crypto.createHash('sha1').update(encodedInfo).digest('hex');

      expect(result.infoHash).toBe(expectedHash);
    });

    it('infoHash in magnet URI matches infoHash field', () => {
      const result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME });
      expect(result.magnetURI).toContain(result.infoHash);
    });
  });

  describe('Private torrent', () => {
    it('sets info.private = 1 when private: true', () => {
      const result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, private: true });
      const parsed = decode(result.torrentBuffer);
      expect(parsed.info.private).toBe(1);
    });

    it('does NOT set info.private when private: false', () => {
      const result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, private: false });
      const parsed = decode(result.torrentBuffer);
      expect(parsed.info.private).toBeUndefined();
    });

    it('does NOT set info.private by default', () => {
      const result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME });
      const parsed = decode(result.torrentBuffer);
      expect(parsed.info.private).toBeUndefined();
    });
  });

  describe('Default trackers', () => {
    it('uses default trackers when none provided', () => {
      const result = createTorrent(SMALL_FILE, { name: DEFAULT_NAME });
      const parsed = decode(result.torrentBuffer);
      expect(parsed.announce).toBeDefined();
      expect(Array.isArray(parsed['announce-list'])).toBe(true);
      expect(parsed['announce-list'].length).toBeGreaterThan(0);
    });
  });

  describe('Input validation', () => {
    it('throws if fileBuffer is not a Buffer', () => {
      expect(() => createTorrent('not a buffer', { name: 'x' })).toThrow('fileBuffer must be a Buffer');
    });

    it('throws if fileBuffer is empty', () => {
      expect(() => createTorrent(Buffer.alloc(0), { name: 'x' })).toThrow('empty');
    });

    it('throws if pieceSize is out of range', () => {
      expect(() => createTorrent(SMALL_FILE, { name: 'x', pieceSize: 100 })).toThrow('pieceSize');
    });
  });

  describe('Various file types', () => {
    it('creates valid torrent from PDF-like content', () => {
      const result = createTorrent(PDF_LIKE, { name: 'document.pdf' });
      expect(/^[a-f0-9]{40}$/.test(result.infoHash)).toBe(true);
      expect(result.fileSize).toBe(PDF_LIKE.length);
    });

    it('creates valid torrent from binary-like content', () => {
      const binary = crypto.randomBytes(1024); // random binary
      const result = createTorrent(binary, { name: 'file.bin' });
      expect(/^[a-f0-9]{40}$/.test(result.infoHash)).toBe(true);
    });

    it('creates valid torrent from multi-piece file', () => {
      const result = createTorrent(MEDIUM_FILE, { name: 'medium.bin', pieceSize: 256 * 1024 });
      expect(result.pieceCount).toBe(2); // 512KB / 256KB = 2 pieces
      const parsed = decode(result.torrentBuffer);
      expect(parsed.info.pieces.length).toBe(2 * 20); // 2 × 20 bytes
    });
  });
});

// ─── torrentToMagnet() ────────────────────────────────────────────────────────

describe('torrentToMagnet()', () => {

  describe('Output shape', () => {
    let result;
    let original;

    beforeAll(() => {
      original = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      result   = torrentToMagnet(original.torrentBuffer);
    });

    it('returns a valid magnet URI', () => {
      expect(result.magnetURI).toMatch(/^magnet:\?xt=urn:btih:[a-f0-9]{40}/);
    });

    it('returns a 40-char hex infoHash', () => {
      expect(result.infoHash).toHaveLength(40);
      expect(/^[a-f0-9]{40}$/.test(result.infoHash)).toBe(true);
    });

    it('returns correct name', () => {
      expect(result.name).toBe(DEFAULT_NAME);
    });

    it('returns trackers array', () => {
      expect(Array.isArray(result.trackers)).toBe(true);
      expect(result.trackers.length).toBeGreaterThan(0);
    });

    it('returns fileSize', () => {
      expect(result.fileSize).toBe(SMALL_FILE.length);
    });

    it('returns pieceLength', () => {
      expect(result.pieceLength).toBeGreaterThan(0);
    });
  });

  describe('Consistency with createTorrent()', () => {
    it('infoHash matches createTorrent infoHash', () => {
      const created   = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      const extracted = torrentToMagnet(created.torrentBuffer);
      expect(extracted.infoHash).toBe(created.infoHash);
    });

    it('magnetURI matches createTorrent magnetURI', () => {
      const created   = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      const extracted = torrentToMagnet(created.torrentBuffer);
      expect(extracted.magnetURI).toBe(created.magnetURI);
    });

    it('all trackers are preserved', () => {
      const created   = createTorrent(SMALL_FILE, { name: DEFAULT_NAME, trackers: DEFAULT_TRACKERS });
      const extracted = torrentToMagnet(created.torrentBuffer);
      for (const tracker of DEFAULT_TRACKERS) {
        expect(extracted.trackers).toContain(tracker);
      }
    });
  });

  describe('Input validation', () => {
    it('throws if input is not a Buffer', () => {
      expect(() => torrentToMagnet('string')).toThrow('torrentBuffer must be a Buffer');
    });

    it('throws if buffer is invalid bencode', () => {
      expect(() => torrentToMagnet(Buffer.from('not valid!!!'))).toThrow();
    });

    it('throws if torrent has no info dict', () => {
      const { encode } = require('../src/server/torrentEngine/bencode');
      const noInfo = encode({ announce: 'http://tracker.example.com' });
      expect(() => torrentToMagnet(noInfo)).toThrow('missing info dictionary');
    });
  });
});

// ─── createTorrentWithMagnet() ────────────────────────────────────────────────

describe('createTorrentWithMagnet()', () => {

  describe('Output shape', () => {
    let result;

    beforeAll(() => {
      result = createTorrentWithMagnet(SMALL_FILE, {
        name: DEFAULT_NAME,
        trackers: DEFAULT_TRACKERS,
      });
    });

    it('returns torrentBuffer', () => {
      expect(Buffer.isBuffer(result.torrentBuffer)).toBe(true);
    });

    it('returns infoHash', () => {
      expect(/^[a-f0-9]{40}$/.test(result.infoHash)).toBe(true);
    });

    it('returns magnetURI', () => {
      expect(result.magnetURI).toMatch(/^magnet:\?xt=urn:btih:/);
    });

    it('returns trackers array', () => {
      expect(Array.isArray(result.trackers)).toBe(true);
    });

    it('returns pieceCount', () => {
      expect(result.pieceCount).toBeGreaterThanOrEqual(1);
    });

    it('returns fileSize', () => {
      expect(result.fileSize).toBe(SMALL_FILE.length);
    });
  });

  describe('Round-trip consistency', () => {
    it('infoHash matches when re-parsed from torrentBuffer', () => {
      const result    = createTorrentWithMagnet(SMALL_FILE, { name: DEFAULT_NAME });
      const extracted = torrentToMagnet(result.torrentBuffer);
      expect(result.infoHash).toBe(extracted.infoHash);
    });

    it('magnetURI matches when re-parsed from torrentBuffer', () => {
      const result    = createTorrentWithMagnet(SMALL_FILE, { name: DEFAULT_NAME });
      const extracted = torrentToMagnet(result.torrentBuffer);
      expect(result.magnetURI).toBe(extracted.magnetURI);
    });
  });
});

// ─── _internal: hashPieces() ──────────────────────────────────────────────────

describe('_internal.hashPieces()', () => {

  it('returns a Buffer', () => {
    expect(Buffer.isBuffer(hashPieces(SMALL_FILE, 256 * 1024))).toBe(true);
  });

  it('length = pieceCount × 20 bytes', () => {
    const pieceSize  = 256 * 1024;
    const pieceCount = Math.ceil(SMALL_FILE.length / pieceSize);
    const result     = hashPieces(SMALL_FILE, pieceSize);
    expect(result.length).toBe(pieceCount * 20);
  });

  it('single-piece file → 20 bytes', () => {
    const result = hashPieces(SMALL_FILE, 256 * 1024); // file < pieceSize → 1 piece
    expect(result.length).toBe(20);
  });

  it('two-piece file → 40 bytes', () => {
    const twoChunks = Buffer.alloc(300 * 1024, 'x'); // 300KB > 256KB → 2 pieces
    const result    = hashPieces(twoChunks, 256 * 1024);
    expect(result.length).toBe(40);
  });

  it('first 20 bytes = SHA1 of first piece', () => {
    const file      = Buffer.alloc(300 * 1024, 'a');
    const pieceSize = 256 * 1024;
    const result    = hashPieces(file, pieceSize);

    const firstPiece    = file.slice(0, pieceSize);
    const expectedHash  = crypto.createHash('sha1').update(firstPiece).digest();
    expect(result.slice(0, 20).equals(expectedHash)).toBe(true);
  });

  it('second 20 bytes = SHA1 of second piece', () => {
    const file      = Buffer.alloc(300 * 1024, 'b');
    const pieceSize = 256 * 1024;
    const result    = hashPieces(file, pieceSize);

    const secondPiece  = file.slice(pieceSize); // remainder
    const expectedHash = crypto.createHash('sha1').update(secondPiece).digest();
    expect(result.slice(20, 40).equals(expectedHash)).toBe(true);
  });

  it('is deterministic — same input → same hashes', () => {
    const r1 = hashPieces(SMALL_FILE, 256 * 1024);
    const r2 = hashPieces(SMALL_FILE, 256 * 1024);
    expect(r1.equals(r2)).toBe(true);
  });

  it('different content → different hashes', () => {
    const fileA = Buffer.from('AAAA'.repeat(100));
    const fileB = Buffer.from('BBBB'.repeat(100));
    const r1    = hashPieces(fileA, 256 * 1024);
    const r2    = hashPieces(fileB, 256 * 1024);
    expect(r1.equals(r2)).toBe(false);
  });
});

// ─── _internal: resolvePieceSize() ───────────────────────────────────────────

describe('_internal.resolvePieceSize()', () => {

  it('returns 256KB for files < 64MB', () => {
    expect(resolvePieceSize(undefined, 10 * 1024 * 1024)).toBe(256 * 1024);
  });

  it('returns 512KB for files between 64MB–512MB', () => {
    expect(resolvePieceSize(undefined, 200 * 1024 * 1024)).toBe(512 * 1024);
  });

  it('returns 1MB for files between 512MB–2GB', () => {
    expect(resolvePieceSize(undefined, 1 * 1024 * 1024 * 1024)).toBe(1024 * 1024);
  });

  it('returns 2MB for files >= 2GB', () => {
    expect(resolvePieceSize(undefined, 3 * 1024 * 1024 * 1024)).toBe(2 * 1024 * 1024);
  });

  it('respects explicitly provided pieceSize', () => {
    const custom = 512 * 1024;
    expect(resolvePieceSize(custom, 10 * 1024 * 1024)).toBe(custom);
  });

  it('throws if pieceSize is below 16KB', () => {
    expect(() => resolvePieceSize(8 * 1024, 1024)).toThrow('pieceSize');
  });

  it('throws if pieceSize is above 8MB', () => {
    expect(() => resolvePieceSize(16 * 1024 * 1024, 1024)).toThrow('pieceSize');
  });

  it('throws if pieceSize is not a number', () => {
    expect(() => resolvePieceSize('256kb', 1024)).toThrow();
  });
});

// ─── _internal: sanitizeName() ────────────────────────────────────────────────

describe('_internal.sanitizeName()', () => {

  it('returns the name unchanged if clean', () => {
    expect(sanitizeName('my-file.pdf')).toBe('my-file.pdf');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeName('  file.txt  ')).toBe('file.txt');
  });

  it('replaces forward slash with underscore', () => {
    expect(sanitizeName('path/to/file.txt')).toBe('path_to_file.txt');
  });

  it('replaces backslash with underscore', () => {
    expect(sanitizeName('path\\file.txt')).toBe('path_file.txt');
  });

  it('replaces colon with underscore', () => {
    expect(sanitizeName('C:file.txt')).toBe('C_file.txt');
  });

  it('replaces multiple invalid chars', () => {
    expect(sanitizeName('file*name?.txt')).toBe('file_name_.txt');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeName('my   file.txt')).toBe('my file.txt');
  });

  it('truncates to 255 characters', () => {
    const long   = 'a'.repeat(300);
    const result = sanitizeName(long);
    expect(result.length).toBe(255);
  });

  it('throws on empty string', () => {
    expect(() => sanitizeName('')).toThrow();
  });

  it('throws on whitespace-only string', () => {
    expect(() => sanitizeName('   ')).toThrow();
  });

  it('throws on non-string', () => {
    expect(() => sanitizeName(123)).toThrow();
  });
});

// ─── _internal: buildMagnetURI() ──────────────────────────────────────────────

describe('_internal.buildMagnetURI()', () => {
  const FAKE_HASH = 'a'.repeat(40);

  it('starts with magnet:?xt=urn:btih:', () => {
    const uri = buildMagnetURI({ infoHash: FAKE_HASH, name: 'test.txt', trackers: [] });
    expect(uri.startsWith('magnet:?xt=urn:btih:')).toBe(true);
  });

  it('contains the infoHash', () => {
    const uri = buildMagnetURI({ infoHash: FAKE_HASH, name: 'test.txt', trackers: [] });
    expect(uri).toContain(FAKE_HASH);
  });

  it('contains dn= with encoded name', () => {
    const uri = buildMagnetURI({ infoHash: FAKE_HASH, name: 'my file.pdf', trackers: [] });
    expect(uri).toContain('dn=my%20file.pdf');
  });

  it('contains one &tr= per tracker', () => {
    const trackers = ['udp://tracker1.com', 'udp://tracker2.com', 'udp://tracker3.com'];
    const uri      = buildMagnetURI({ infoHash: FAKE_HASH, name: 'x', trackers });
    const count    = (uri.match(/&tr=/g) || []).length;
    expect(count).toBe(3);
  });

  it('works with no trackers', () => {
    const uri = buildMagnetURI({ infoHash: FAKE_HASH, name: 'x', trackers: [] });
    expect(uri).not.toContain('tr=');
  });
});

// ─── _internal: extractTrackersFromDict() ─────────────────────────────────────

describe('_internal.extractTrackersFromDict()', () => {

  it('extracts primary announce URL', () => {
    const dict   = { announce: Buffer.from('udp://tracker.example.com') };
    const result = extractTrackersFromDict(dict);
    expect(result).toContain('udp://tracker.example.com');
  });

  it('extracts all tiers from announce-list', () => {
    const dict = {
      announce: Buffer.from('udp://tracker1.com'),
      'announce-list': [
        [Buffer.from('udp://tracker1.com')],
        [Buffer.from('udp://tracker2.com'), Buffer.from('udp://tracker3.com')],
      ],
    };
    const result = extractTrackersFromDict(dict);
    expect(result).toContain('udp://tracker1.com');
    expect(result).toContain('udp://tracker2.com');
    expect(result).toContain('udp://tracker3.com');
  });

  it('deduplicates trackers', () => {
    const dict = {
      announce: Buffer.from('udp://tracker1.com'),
      'announce-list': [
        [Buffer.from('udp://tracker1.com')], // duplicate
        [Buffer.from('udp://tracker2.com')],
      ],
    };
    const result = extractTrackersFromDict(dict);
    expect(result.filter(t => t === 'udp://tracker1.com').length).toBe(1);
  });

  it('returns empty array if no trackers', () => {
    expect(extractTrackersFromDict({})).toEqual([]);
  });
});
