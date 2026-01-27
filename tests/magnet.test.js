const { parseMagnet, createMagnet } = require('../src/server/torrentEngine/magnet');

describe('Magnet Link Parser', () => {
  describe('parseMagnet with hex info hash', () => {
    test('should parse basic magnet link with hex info hash', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
      const result = parseMagnet(magnetURI);

      expect(result.infoHash).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.infoHashBuffer).toBeInstanceOf(Buffer);
      expect(result.infoHashBuffer.length).toBe(20);
      expect(result.infoHashBuffer.toString('hex')).toBe('0123456789abcdef0123456789abcdef01234567');
    });

    test('should handle uppercase hex and convert to lowercase', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567';
      const result = parseMagnet(magnetURI);

      expect(result.infoHash).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.infoHashBuffer.toString('hex')).toBe('0123456789abcdef0123456789abcdef01234567');
    });

    test('should parse magnet link with display name', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Ubuntu%2022.04';
      const result = parseMagnet(magnetURI);

      expect(result.infoHash).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.displayName).toBe('Ubuntu 22.04');
    });

    test('should parse magnet link with multiple trackers', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' +
        '&tr=http://tracker1.com/announce&tr=udp://tracker2.com:6969';
      const result = parseMagnet(magnetURI);

      expect(result.trackers).toHaveLength(2);
      expect(result.trackers).toContain('http://tracker1.com/announce');
      expect(result.trackers).toContain('udp://tracker2.com:6969');
    });

    test('should parse magnet link with peers', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' +
        '&x.pe=192.168.1.1:6881&x.pe=10.0.0.1:51413';
      const result = parseMagnet(magnetURI);

      expect(result.peers).toHaveLength(2);
      expect(result.peers[0]).toEqual({ ip: '192.168.1.1', port: 6881 });
      expect(result.peers[1]).toEqual({ ip: '10.0.0.1', port: 51413 });
    });

    test('should parse magnet link with all parameters', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' +
        '&dn=Test%20Torrent&tr=http://tracker.com/announce&x.pe=192.168.1.1:6881';
      const result = parseMagnet(magnetURI);

      expect(result.infoHash).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.displayName).toBe('Test Torrent');
      expect(result.trackers).toHaveLength(1);
      expect(result.peers).toHaveLength(1);
    });
  });

  describe('parseMagnet with base32 info hash', () => {
    test('should parse magnet link with base32 info hash (uppercase)', () => {
      // Base32 "CBTGQFQGQ5FE2YJXGQ3DCMBSGQ3DGMJQ" decodes to specific 20-byte hash
      const magnetURI = 'magnet:?xt=urn:btih:CBTGQFQGQ5FE2YJXGQ3DCMBSGQ3DGMJQ';
      const result = parseMagnet(magnetURI);

      expect(result.infoHashBuffer).toBeInstanceOf(Buffer);
      expect(result.infoHashBuffer.length).toBe(20);
      expect(result.infoHash).toBe(result.infoHashBuffer.toString('hex'));
      expect(result.infoHash).toMatch(/^[0-9a-f]{40}$/);
    });

    test('should parse magnet link with base32 info hash (lowercase)', () => {
      const magnetURI = 'magnet:?xt=urn:btih:cbtgqfqgq5fe2yjxgq3dcmbsgq3dgmjq';
      const result = parseMagnet(magnetURI);

      expect(result.infoHashBuffer).toBeInstanceOf(Buffer);
      expect(result.infoHashBuffer.length).toBe(20);
      expect(result.infoHash).toMatch(/^[0-9a-f]{40}$/);
    });

    test('should parse magnet link with base32 info hash (mixed case)', () => {
      const magnetURI = 'magnet:?xt=urn:btih:CbTgQfQgQ5Fe2YjXgQ3DcMbSgQ3DgMjQ';
      const result = parseMagnet(magnetURI);

      expect(result.infoHashBuffer).toBeInstanceOf(Buffer);
      expect(result.infoHashBuffer.length).toBe(20);
      expect(result.infoHash).toMatch(/^[0-9a-f]{40}$/);
    });

    test('should produce same result for hex and base32 of same hash', () => {
      const testHash = '0123456789abcdef0123456789abcdef01234567';
      const buffer = Buffer.from(testHash, 'hex');
      
      // Convert to base32
      const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let base32 = '';
      let bits = 0;
      let value = 0;
      
      for (let i = 0; i < buffer.length; i++) {
        value = (value << 8) | buffer[i];
        bits += 8;
        while (bits >= 5) {
          base32 += base32Chars[(value >>> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) {
        base32 += base32Chars[(value << (5 - bits)) & 31];
      }

      const hexResult = parseMagnet(`magnet:?xt=urn:btih:${testHash}`);
      const base32Result = parseMagnet(`magnet:?xt=urn:btih:${base32}`);

      expect(hexResult.infoHash).toBe(base32Result.infoHash);
      expect(hexResult.infoHashBuffer.equals(base32Result.infoHashBuffer)).toBe(true);
    });
  });

  describe('parseMagnet error cases', () => {
    test('should throw error for empty string', () => {
      expect(() => parseMagnet('')).toThrow();
    });

    test('should throw error for missing xt parameter', () => {
      const magnetURI = 'magnet:?dn=Test';
      expect(() => parseMagnet(magnetURI)).toThrow(/xt parameter.*required/i);
    });

    test('should throw error for invalid xt format', () => {
      const magnetURI = 'magnet:?xt=invalid:0123456789abcdef0123456789abcdef01234567';
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid.*format/i);
    });

    test('should throw error for wrong length hex (39 chars)', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef0123456';
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid.*length/i);
    });

    test('should throw error for wrong length hex (41 chars)', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef012345678';
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid.*length/i);
    });

    test('should throw error for wrong length base32 (31 chars)', () => {
      const magnetURI = 'magnet:?xt=urn:btih:CBTGQFQGQ5FE2YJXGQ3DCMBSGQ3DGMJ';
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid.*length/i);
    });

    test('should throw error for wrong length base32 (33 chars)', () => {
      const magnetURI = 'magnet:?xt=urn:btih:CBTGQFQGQ5FE2YJXGQ3DCMBSGQ3DGMJQAA';
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid.*length/i);
    });

    test('should throw error for invalid base32 characters', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0189QFQGQ5FE2YJXGQ3DCMBSGQ3DGMJQ'; // 0, 1, 8, 9 are invalid
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid.*base32/i);
    });

    test('should throw error for invalid hex characters', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdefghij456789abcdef01234567'; // g, h, i, j are invalid
      expect(() => parseMagnet(magnetURI)).toThrow(/invalid/i);
    });

    test('should throw error for non-magnet URI', () => {
      expect(() => parseMagnet('http://example.com')).toThrow();
    });

    test('should handle malformed peer addresses gracefully', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&x.pe=invalid';
      const result = parseMagnet(magnetURI);
      
      expect(result.peers).toHaveLength(0);
    });
  });

  describe('createMagnet', () => {
    test('should create magnet URI with just info hash', () => {
      const infoHash = '0123456789abcdef0123456789abcdef01234567';
      const magnetURI = createMagnet({ infoHash });

      expect(magnetURI).toContain('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
    });

    test('should create magnet URI with display name', () => {
      const infoHash = '0123456789abcdef0123456789abcdef01234567';
      const displayName = 'Ubuntu 22.04';
      const magnetURI = createMagnet({ infoHash, displayName });

      expect(magnetURI).toContain('xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
      expect(magnetURI).toContain('dn=Ubuntu%2022.04');
    });

    test('should create magnet URI with single tracker', () => {
      const infoHash = '0123456789abcdef0123456789abcdef01234567';
      const trackers = ['http://tracker.com/announce'];
      const magnetURI = createMagnet({ infoHash, trackers });

      expect(magnetURI).toContain('tr=http%3A%2F%2Ftracker.com%2Fannounce');
    });

    test('should create magnet URI with multiple trackers', () => {
      const infoHash = '0123456789abcdef0123456789abcdef01234567';
      const trackers = ['http://tracker1.com/announce', 'udp://tracker2.com:6969'];
      const magnetURI = createMagnet({ infoHash, trackers });

      expect(magnetURI).toContain('tr=http%3A%2F%2Ftracker1.com%2Fannounce');
      expect(magnetURI).toContain('tr=udp%3A%2F%2Ftracker2.com%3A6969');
    });

    test('should create magnet URI with all options', () => {
      const infoHash = '0123456789abcdef0123456789abcdef01234567';
      const displayName = 'Test Torrent';
      const trackers = ['http://tracker.com/announce'];
      const magnetURI = createMagnet({ infoHash, displayName, trackers });

      expect(magnetURI).toContain('xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
      expect(magnetURI).toContain('dn=Test%20Torrent');
      expect(magnetURI).toContain('tr=http%3A%2F%2Ftracker.com%2Fannounce');
    });

    test('should handle special characters in display name', () => {
      const infoHash = '0123456789abcdef0123456789abcdef01234567';
      const displayName = 'Test & Special: Characters!';
      const magnetURI = createMagnet({ infoHash, displayName });

      expect(magnetURI).toContain('dn=Test%20%26%20Special%3A%20Characters!');
    });

    test('should throw error if infoHash is missing', () => {
      expect(() => createMagnet({})).toThrow(/infoHash.*required/i);
    });

    test('should throw error if infoHash is invalid length', () => {
      expect(() => createMagnet({ infoHash: '0123456789abcdef' })).toThrow(/invalid.*length/i);
    });

    test('should throw error if infoHash contains invalid characters', () => {
      expect(() => createMagnet({ infoHash: '0123456789abcdefghij456789abcdef01234567' })).toThrow(/invalid/i);
    });
  });

  describe('round-trip conversion', () => {
    test('should parse back a created magnet URI', () => {
      const original = {
        infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
        displayName: 'Test Torrent',
        trackers: ['http://tracker1.com/announce', 'udp://tracker2.com:6969']
      };

      const magnetURI = createMagnet(original);
      const parsed = parseMagnet(magnetURI);

      expect(parsed.infoHash).toBe(original.infoHash);
      expect(parsed.displayName).toBe(original.displayName);
      expect(parsed.trackers).toEqual(original.trackers);
    });

    test('should handle round-trip with minimal options', () => {
      const original = {
        infoHash: '0123456789abcdef0123456789abcdef01234567'
      };

      const magnetURI = createMagnet(original);
      const parsed = parseMagnet(magnetURI);

      expect(parsed.infoHash).toBe(original.infoHash);
      expect(parsed.displayName).toBeUndefined();
      expect(parsed.trackers).toEqual([]);
    });

    test('should maintain info hash integrity through multiple conversions', () => {
      const infoHash = 'fedcba9876543210fedcba9876543210fedcba98';
      
      const magnet1 = createMagnet({ infoHash });
      const parsed1 = parseMagnet(magnet1);
      const magnet2 = createMagnet({ infoHash: parsed1.infoHash });
      const parsed2 = parseMagnet(magnet2);

      expect(parsed1.infoHash).toBe(infoHash);
      expect(parsed2.infoHash).toBe(infoHash);
      expect(parsed1.infoHashBuffer.equals(parsed2.infoHashBuffer)).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('should handle empty trackers array', () => {
      const magnetURI = createMagnet({
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        trackers: []
      });
      const parsed = parseMagnet(magnetURI);

      expect(parsed.trackers).toEqual([]);
    });

    test('should handle empty display name', () => {
      const magnetURI = createMagnet({
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        displayName: ''
      });

      // Empty display name should not add dn parameter
      expect(magnetURI).not.toContain('dn=');
    });

    test('should parse magnet URI with duplicate trackers', () => {
      const magnetURI = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' +
        '&tr=http://tracker.com/announce&tr=http://tracker.com/announce';
      const result = parseMagnet(magnetURI);

      // Should include both (no deduplication in parser)
      expect(result.trackers).toHaveLength(2);
    });

    test('should handle very long display names', () => {
      const longName = 'A'.repeat(500);
      const magnetURI = createMagnet({
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        displayName: longName
      });
      const parsed = parseMagnet(magnetURI);

      expect(parsed.displayName).toBe(longName);
    });

    test('should handle unicode characters in display name', () => {
      const unicodeName = 'Test 测试 🎉';
      const magnetURI = createMagnet({
        infoHash: '0123456789abcdef0123456789abcdef01234567',
        displayName: unicodeName
      });
      const parsed = parseMagnet(magnetURI);

      expect(parsed.displayName).toBe(unicodeName);
    });
  });
});
