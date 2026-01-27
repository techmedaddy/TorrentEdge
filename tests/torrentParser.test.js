const { encode } = require('../src/server/torrentEngine/bencode');
const { parseTorrent } = require('../src/server/torrentEngine/torrentParser');

describe('Torrent Parser', () => {
  describe('Single-File Torrent', () => {
    let torrentBuffer;
    let parsed;

    beforeEach(() => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };
      torrentBuffer = encode(torrent);
      parsed = parseTorrent(torrentBuffer);
    });

    it('should return infoHash as 40-character hex string', () => {
      expect(typeof parsed.infoHash).toBe('string');
      expect(parsed.infoHash.length).toBe(40);
      expect(/^[0-9a-f]{40}$/.test(parsed.infoHash)).toBe(true);
    });

    it('should return infoHashBuffer as 20-byte Buffer', () => {
      expect(Buffer.isBuffer(parsed.infoHashBuffer)).toBe(true);
      expect(parsed.infoHashBuffer.length).toBe(20);
    });

    it('should return correct name', () => {
      expect(parsed.name).toBe('test.txt');
    });

    it('should return correct pieceLength', () => {
      expect(parsed.pieceLength).toBe(16384);
    });

    it('should return pieces as array of 20-byte Buffers', () => {
      expect(Array.isArray(parsed.pieces)).toBe(true);
      expect(parsed.pieces.length).toBe(1);
      expect(Buffer.isBuffer(parsed.pieces[0])).toBe(true);
      expect(parsed.pieces[0].length).toBe(20);
    });

    it('should return correct length', () => {
      expect(parsed.length).toBe(100);
    });

    it('should have isMultiFile as false', () => {
      expect(parsed.isMultiFile).toBe(false);
    });

    it('should have files as null', () => {
      expect(parsed.files).toBe(null);
    });

    it('should return correct announce URL', () => {
      expect(parsed.announce).toBe('http://tracker.example.com/announce');
    });

    it('should have empty announceList if not present', () => {
      expect(Array.isArray(parsed.announceList)).toBe(true);
      expect(parsed.announceList.length).toBe(0);
    });

    it('should have private as false if not set', () => {
      expect(parsed.private).toBe(false);
    });
  });

  describe('Multi-File Torrent', () => {
    let torrentBuffer;
    let parsed;

    beforeEach(() => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test-folder',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          files: [
            { length: 50, path: ['folder', 'file1.txt'] },
            { length: 50, path: ['file2.txt'] }
          ]
        }
      };
      torrentBuffer = encode(torrent);
      parsed = parseTorrent(torrentBuffer);
    });

    it('should have isMultiFile as true', () => {
      expect(parsed.isMultiFile).toBe(true);
    });

    it('should return files array with correct structure', () => {
      expect(Array.isArray(parsed.files)).toBe(true);
      expect(parsed.files.length).toBe(2);
    });

    it('should join path components with /', () => {
      expect(parsed.files[0].path).toBe('folder/file1.txt');
      expect(parsed.files[1].path).toBe('file2.txt');
    });

    it('should have correct file lengths', () => {
      expect(parsed.files[0].length).toBe(50);
      expect(parsed.files[1].length).toBe(50);
    });

    it('should calculate total length from files', () => {
      expect(parsed.length).toBe(100);
    });
  });

  describe('Pieces Splitting', () => {
    it('should split pieces into array of 20-byte chunks', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(60, 0), // 3 pieces
          length: 40000
        }
      };
      const torrentBuffer = encode(torrent);
      const parsed = parseTorrent(torrentBuffer);

      expect(parsed.pieces.length).toBe(3);
      expect(parsed.pieces[0].length).toBe(20);
      expect(parsed.pieces[1].length).toBe(20);
      expect(parsed.pieces[2].length).toBe(20);
    });

    it('should handle large number of pieces', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(200, 0), // 10 pieces
          length: 163840
        }
      };
      const torrentBuffer = encode(torrent);
      const parsed = parseTorrent(torrentBuffer);

      expect(parsed.pieces.length).toBe(10);
    });
  });

  describe('Announce-List Parsing', () => {
    it('should parse announce-list correctly', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        'announce-list': [
          ['http://t1.com'],
          ['http://t2.com', 'http://t3.com']
        ],
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      const parsed = parseTorrent(torrentBuffer);

      expect(Array.isArray(parsed.announceList)).toBe(true);
      expect(parsed.announceList.length).toBe(2);
      expect(parsed.announceList[0]).toEqual(['http://t1.com']);
      expect(parsed.announceList[1]).toEqual(['http://t2.com', 'http://t3.com']);
    });

    it('should handle Buffer URLs in announce-list', () => {
      const torrent = {
        announce: Buffer.from('http://tracker.example.com/announce'),
        'announce-list': [
          [Buffer.from('http://t1.com')]
        ],
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      const parsed = parseTorrent(torrentBuffer);

      expect(parsed.announce).toBe('http://tracker.example.com/announce');
      expect(parsed.announceList[0][0]).toBe('http://t1.com');
    });
  });

  describe('Private Torrent', () => {
    it('should set private to true when info.private is 1', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100,
          private: 1
        }
      };
      const torrentBuffer = encode(torrent);
      const parsed = parseTorrent(torrentBuffer);

      expect(parsed.private).toBe(true);
    });

    it('should set private to false when info.private is 0', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100,
          private: 0
        }
      };
      const torrentBuffer = encode(torrent);
      const parsed = parseTorrent(torrentBuffer);

      expect(parsed.private).toBe(false);
    });
  });

  describe('Info Hash Consistency', () => {
    it('should produce same infoHash for identical info dicts', () => {
      const info = {
        name: 'test.txt',
        'piece length': 16384,
        pieces: Buffer.alloc(20, 0),
        length: 100
      };

      const torrent1 = {
        announce: 'http://tracker1.com/announce',
        info
      };

      const torrent2 = {
        announce: 'http://tracker2.com/announce',
        info
      };

      const parsed1 = parseTorrent(encode(torrent1));
      const parsed2 = parseTorrent(encode(torrent2));

      expect(parsed1.infoHash).toBe(parsed2.infoHash);
    });

    it('should produce different infoHash for different info dicts', () => {
      const torrent1 = {
        announce: 'http://tracker.com/announce',
        info: {
          name: 'test1.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };

      const torrent2 = {
        announce: 'http://tracker.com/announce',
        info: {
          name: 'test2.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };

      const parsed1 = parseTorrent(encode(torrent1));
      const parsed2 = parseTorrent(encode(torrent2));

      expect(parsed1.infoHash).not.toBe(parsed2.infoHash);
    });
  });

  describe('Error Handling', () => {
    it('should throw on non-Buffer input', () => {
      expect(() => parseTorrent('not a buffer')).toThrow('Input must be a Buffer');
    });

    it('should throw on missing info dict', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce'
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('missing info dictionary');
    });

    it('should throw on missing announce', () => {
      const torrent = {
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('announce');
    });

    it('should throw on missing info.name', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('info.name');
    });

    it('should throw on missing info.piece length', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          pieces: Buffer.alloc(20, 0),
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('piece length');
    });

    it('should throw on missing info.pieces', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('info.pieces');
    });

    it('should throw on invalid pieces length (not multiple of 20)', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(25, 0), // Invalid: not multiple of 20
          length: 100
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('multiple of 20');
    });

    it('should throw on missing length or files in info', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0)
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('info.length');
    });

    it('should throw on empty files array', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          files: []
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('cannot be empty');
    });

    it('should throw on invalid file structure', () => {
      const torrent = {
        announce: 'http://tracker.example.com/announce',
        info: {
          name: 'test.txt',
          'piece length': 16384,
          pieces: Buffer.alloc(20, 0),
          files: [
            { path: ['test.txt'] } // Missing length
          ]
        }
      };
      const torrentBuffer = encode(torrent);
      expect(() => parseTorrent(torrentBuffer)).toThrow('length');
    });

    it('should throw on invalid torrent bencode', () => {
      const invalidBuffer = Buffer.from('invalid bencode data');
      expect(() => parseTorrent(invalidBuffer)).toThrow('Failed to decode');
    });
  });
});
