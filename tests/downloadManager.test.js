const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { Piece } = require('../src/server/torrentEngine/piece');
const { FileWriter } = require('../src/server/torrentEngine/fileWriter');
const { DownloadManager } = require('../src/server/torrentEngine/downloadManager');

describe('Piece', () => {
  describe('Constructor and Block Creation', () => {
    it('should create correct number of blocks for evenly divisible piece', () => {
      const piece = new Piece({
        index: 0,
        length: 32768,
        hash: Buffer.alloc(20, 0),
        blockSize: 16384
      });

      expect(piece.getBlockCount()).toBe(2);
      expect(piece.blocks[0].length).toBe(16384);
      expect(piece.blocks[1].length).toBe(16384);
    });

    it('should create correct number of blocks with smaller last block', () => {
      const piece = new Piece({
        index: 0,
        length: 40000,
        hash: Buffer.alloc(20, 0),
        blockSize: 16384
      });

      expect(piece.getBlockCount()).toBe(3);
      expect(piece.blocks[0].length).toBe(16384);
      expect(piece.blocks[1].length).toBe(16384);
      expect(piece.blocks[2].length).toBe(7232);
    });

    it('should throw on invalid hash', () => {
      expect(() => {
        new Piece({
          index: 0,
          length: 1000,
          hash: Buffer.alloc(10),
          blockSize: 16384
        });
      }).toThrow('hash must be a 20-byte Buffer');
    });
  });

  describe('Block Management', () => {
    it('should return blocks in order with getNextMissingBlock', () => {
      const piece = new Piece({
        index: 0,
        length: 32768,
        hash: Buffer.alloc(20, 0),
        blockSize: 16384
      });

      const block1 = piece.getNextMissingBlock();
      expect(block1.offset).toBe(0);
      expect(block1.length).toBe(16384);

      piece.addBlock(0, Buffer.alloc(16384));

      const block2 = piece.getNextMissingBlock();
      expect(block2.offset).toBe(16384);
      expect(block2.length).toBe(16384);
    });

    it('should return null when all blocks received', () => {
      const piece = new Piece({
        index: 0,
        length: 16384,
        hash: crypto.createHash('sha1').update(Buffer.alloc(16384)).digest(),
        blockSize: 16384
      });

      piece.addBlock(0, Buffer.alloc(16384));
      
      expect(piece.getNextMissingBlock()).toBe(null);
    });

    it('should track completion correctly', () => {
      const data = Buffer.alloc(32768, 0xFF);
      const hash = crypto.createHash('sha1').update(data).digest();
      
      const piece = new Piece({
        index: 0,
        length: 32768,
        hash,
        blockSize: 16384
      });

      expect(piece.isComplete).toBe(false);

      piece.addBlock(0, data.slice(0, 16384));
      expect(piece.isComplete).toBe(false);

      piece.addBlock(16384, data.slice(16384, 32768));
      expect(piece.isComplete).toBe(true);
    });
  });

  describe('Verification', () => {
    it('should verify correct data', () => {
      const data = Buffer.from('test data for verification');
      const hash = crypto.createHash('sha1').update(data).digest();

      const piece = new Piece({
        index: 0,
        length: data.length,
        hash,
        blockSize: 16384
      });

      piece.addBlock(0, data);
      
      expect(piece.verify()).toBe(true);
      expect(piece.isVerified).toBe(true);
    });

    it('should reject corrupt data', () => {
      const correctData = Buffer.from('correct data');
      const wrongData = Buffer.from('wrong data!!');
      const hash = crypto.createHash('sha1').update(correctData).digest();

      const piece = new Piece({
        index: 0,
        length: wrongData.length,
        hash,
        blockSize: 16384
      });

      piece.addBlock(0, wrongData);
      
      expect(piece.verify()).toBe(false);
      expect(piece.isVerified).toBe(false);
    });

    it('should throw when verifying incomplete piece', () => {
      const piece = new Piece({
        index: 0,
        length: 32768,
        hash: Buffer.alloc(20, 0),
        blockSize: 16384
      });

      expect(() => piece.verify()).toThrow('Cannot verify incomplete piece');
    });
  });

  describe('Reset', () => {
    it('should clear all block data', () => {
      const data = Buffer.alloc(16384, 0xFF);
      const hash = crypto.createHash('sha1').update(data).digest();
      
      const piece = new Piece({
        index: 0,
        length: 16384,
        hash,
        blockSize: 16384
      });

      piece.addBlock(0, data);
      expect(piece.isComplete).toBe(true);

      piece.reset();
      
      expect(piece.isComplete).toBe(false);
      expect(piece.isVerified).toBe(false);
      expect(piece.data).toBe(null);
      expect(piece.blocks[0].received).toBe(false);
      expect(piece.blocks[0].data).toBe(null);
    });
  });

  describe('Progress Tracking', () => {
    it('should calculate progress correctly', () => {
      const piece = new Piece({
        index: 0,
        length: 32768,
        hash: Buffer.alloc(20, 0),
        blockSize: 16384
      });

      expect(piece.getProgress()).toBe(0);

      piece.addBlock(0, Buffer.alloc(16384));
      expect(piece.getProgress()).toBe(50);

      piece.addBlock(16384, Buffer.alloc(16384));
      expect(piece.getProgress()).toBe(100);
    });
  });
});

describe('FileWriter', () => {
  let tmpDir;
  let fileWriter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-test-'));
  });

  afterEach(async () => {
    if (fileWriter) {
      await fileWriter.close();
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Single File Torrent', () => {
    it('should create directory and file on initialize', async () => {
      const torrent = {
        name: 'test.txt',
        length: 1000,
        pieces: [Buffer.alloc(20, 0)],
        pieceLength: 1000,
        isMultiFile: false
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();

      const filePath = path.join(tmpDir, 'test.txt');
      const stats = await fs.stat(filePath);
      expect(stats.size).toBe(1000);
    });

    it('should write and read piece at index 0', async () => {
      const data = Buffer.from('Hello World!');
      const hash = crypto.createHash('sha1').update(data).digest();
      
      const torrent = {
        name: 'test.txt',
        length: data.length,
        pieces: [hash],
        pieceLength: data.length,
        isMultiFile: false
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();
      await fileWriter.writePiece(0, data);
      
      const readData = await fileWriter.readPiece(0);
      expect(readData.equals(data)).toBe(true);
    });

    it('should write piece at correct offset', async () => {
      const pieceLength = 100;
      const numPieces = 5;
      const totalLength = pieceLength * numPieces;
      
      const pieces = [];
      for (let i = 0; i < numPieces; i++) {
        pieces.push(Buffer.alloc(20, i));
      }

      const torrent = {
        name: 'test.txt',
        length: totalLength,
        pieces,
        pieceLength,
        isMultiFile: false
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();

      // Write piece at index 2
      const testData = Buffer.alloc(pieceLength, 0xAA);
      await fileWriter.writePiece(2, testData);

      // Read entire file
      const filePath = path.join(tmpDir, 'test.txt');
      const fileData = await fs.readFile(filePath);

      // Check that data is at correct offset (2 * 100 = 200)
      const pieceData = fileData.slice(200, 300);
      expect(pieceData.every(byte => byte === 0xAA)).toBe(true);
      
      // Check that other areas are still zeros
      const beforePiece = fileData.slice(0, 200);
      expect(beforePiece.every(byte => byte === 0)).toBe(true);
    });
  });

  describe('Multi-File Torrent', () => {
    it('should create subdirectories and files', async () => {
      const torrent = {
        name: 'test-folder',
        length: 2000,
        pieces: [Buffer.alloc(20, 0), Buffer.alloc(20, 1)],
        pieceLength: 1000,
        isMultiFile: true,
        files: [
          { path: 'subdir/file1.txt', length: 1000 },
          { path: 'file2.txt', length: 1000 }
        ]
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();

      const file1Path = path.join(tmpDir, 'test-folder', 'subdir', 'file1.txt');
      const file2Path = path.join(tmpDir, 'test-folder', 'file2.txt');

      const stats1 = await fs.stat(file1Path);
      const stats2 = await fs.stat(file2Path);

      expect(stats1.size).toBe(1000);
      expect(stats2.size).toBe(1000);
    });

    it('should handle piece spanning multiple files', async () => {
      // Create torrent with two 600-byte files and 1000-byte pieces
      // Piece 0: bytes 0-999 (all of file1 + 400 bytes of file2)
      const file1Size = 600;
      const file2Size = 600;
      const pieceLength = 1000;
      
      const torrent = {
        name: 'test-folder',
        length: file1Size + file2Size,
        pieces: [Buffer.alloc(20, 0), Buffer.alloc(20, 1)],
        pieceLength,
        isMultiFile: true,
        files: [
          { path: 'file1.txt', length: file1Size },
          { path: 'file2.txt', length: file2Size }
        ]
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();

      // Create piece data that will span both files
      const pieceData = Buffer.alloc(pieceLength);
      for (let i = 0; i < pieceLength; i++) {
        pieceData[i] = i % 256;
      }

      await fileWriter.writePiece(0, pieceData);

      // Read both files and verify
      const file1Path = path.join(tmpDir, 'test-folder', 'file1.txt');
      const file2Path = path.join(tmpDir, 'test-folder', 'file2.txt');

      const file1Data = await fs.readFile(file1Path);
      const file2Data = await fs.readFile(file2Path);

      // File1 should have first 600 bytes of piece
      expect(file1Data.equals(pieceData.slice(0, file1Size))).toBe(true);

      // File2 should have bytes 600-999 at its start
      const file2Expected = pieceData.slice(file1Size, pieceLength);
      expect(file2Data.slice(0, file2Expected.length).equals(file2Expected)).toBe(true);
    });
  });

  describe('Verification', () => {
    it('should verify existing pieces on disk', async () => {
      const piece1Data = Buffer.from('piece 1 data');
      const piece2Data = Buffer.from('piece 2 data');
      
      const hash1 = crypto.createHash('sha1').update(piece1Data).digest();
      const hash2 = crypto.createHash('sha1').update(piece2Data).digest();

      const torrent = {
        name: 'test.txt',
        length: piece1Data.length + piece2Data.length,
        pieces: [hash1, hash2],
        pieceLength: Math.max(piece1Data.length, piece2Data.length),
        isMultiFile: false
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();
      await fileWriter.writePiece(0, piece1Data);
      await fileWriter.writePiece(1, piece2Data);

      const result = await fileWriter.verify();

      expect(result.valid).toContain(0);
      expect(result.valid).toContain(1);
      expect(result.invalid.length).toBe(0);
    });

    it('should detect corrupt pieces', async () => {
      const correctData = Buffer.from('correct data');
      const wrongData = Buffer.from('wrong data!!');
      
      const hash = crypto.createHash('sha1').update(correctData).digest();

      const torrent = {
        name: 'test.txt',
        length: wrongData.length,
        pieces: [hash],
        pieceLength: wrongData.length,
        isMultiFile: false
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      await fileWriter.initialize();
      await fileWriter.writePiece(0, wrongData);

      const result = await fileWriter.verify();

      expect(result.valid.length).toBe(0);
      expect(result.invalid).toContain(0);
    });
  });

  describe('File Mapping', () => {
    it('should calculate pieces for file range correctly', () => {
      const torrent = {
        name: 'test-folder',
        length: 3000,
        pieces: [Buffer.alloc(20, 0), Buffer.alloc(20, 1), Buffer.alloc(20, 2)],
        pieceLength: 1000,
        isMultiFile: true,
        files: [
          { path: 'file1.txt', length: 1500 },
          { path: 'file2.txt', length: 1500 }
        ]
      };

      fileWriter = new FileWriter({
        torrent,
        downloadPath: tmpDir
      });

      // File 0 (0-1499) overlaps pieces 0 (0-999) and 1 (1000-1999)
      const pieces = fileWriter.getPiecesForFileRange(0, 0, 1500);
      expect(pieces).toEqual([0, 1]);

      // File 1 (1500-2999) overlaps pieces 1 (1000-1999) and 2 (2000-2999)
      const pieces2 = fileWriter.getPiecesForFileRange(1, 0, 1500);
      expect(pieces2).toEqual([1, 2]);
    });
  });
});

describe('DownloadManager', () => {
  describe('Piece Selection', () => {
    it('should select rarest piece first', () => {
      const mockPeerManager = {
        pieceAvailability: [3, 1, 5, 2, 1], // Pieces 1 and 4 are rarest (count=1)
        on: jest.fn(),
        getConnectedPeers: jest.fn(() => []),
        hasPiece: jest.fn(),
        broadcast: jest.fn()
      };

      const torrent = {
        name: 'test',
        length: 50000,
        pieces: [
          Buffer.alloc(20, 0),
          Buffer.alloc(20, 1),
          Buffer.alloc(20, 2),
          Buffer.alloc(20, 3),
          Buffer.alloc(20, 4)
        ],
        pieceLength: 10000,
        isMultiFile: false
      };

      const manager = new DownloadManager({
        torrent,
        peerManager: mockPeerManager,
        downloadPath: '/tmp/test',
        maxActiveRequests: 5
      });

      const selected = manager.selectNextPiece();
      
      // Should select piece 1 (rarest, comes first)
      expect(selected).toBe(1);
    });

    it('should skip completed pieces', () => {
      const mockPeerManager = {
        pieceAvailability: [2, 2, 2],
        on: jest.fn(),
        getConnectedPeers: jest.fn(() => []),
        hasPiece: jest.fn(),
        broadcast: jest.fn()
      };

      const torrent = {
        name: 'test',
        length: 30000,
        pieces: [
          Buffer.alloc(20, 0),
          Buffer.alloc(20, 1),
          Buffer.alloc(20, 2)
        ],
        pieceLength: 10000,
        isMultiFile: false
      };

      const manager = new DownloadManager({
        torrent,
        peerManager: mockPeerManager,
        downloadPath: '/tmp/test',
        maxActiveRequests: 5
      });

      // Mark piece 0 as completed
      manager.completedPieces.add(0);

      const selected = manager.selectNextPiece();
      
      // Should select piece 1 or 2, not 0
      expect(selected).not.toBe(0);
      expect([1, 2]).toContain(selected);
    });

    it('should skip active pieces', () => {
      const mockPeerManager = {
        pieceAvailability: [2, 2, 2],
        on: jest.fn(),
        getConnectedPeers: jest.fn(() => []),
        hasPiece: jest.fn(),
        broadcast: jest.fn()
      };

      const torrent = {
        name: 'test',
        length: 30000,
        pieces: [
          Buffer.alloc(20, 0),
          Buffer.alloc(20, 1),
          Buffer.alloc(20, 2)
        ],
        pieceLength: 10000,
        isMultiFile: false
      };

      const manager = new DownloadManager({
        torrent,
        peerManager: mockPeerManager,
        downloadPath: '/tmp/test',
        maxActiveRequests: 5
      });

      // Mark piece 0 as active
      const mockPiece = { index: 0 };
      manager.activePieces.set(0, mockPiece);

      const selected = manager.selectNextPiece();
      
      // Should select piece 1 or 2, not 0
      expect(selected).not.toBe(0);
      expect([1, 2]).toContain(selected);
    });

    it('should return null when no pieces available', () => {
      const mockPeerManager = {
        pieceAvailability: [0, 0, 0], // No peers have any pieces
        on: jest.fn(),
        getConnectedPeers: jest.fn(() => []),
        hasPiece: jest.fn(),
        broadcast: jest.fn()
      };

      const torrent = {
        name: 'test',
        length: 30000,
        pieces: [
          Buffer.alloc(20, 0),
          Buffer.alloc(20, 1),
          Buffer.alloc(20, 2)
        ],
        pieceLength: 10000,
        isMultiFile: false
      };

      const manager = new DownloadManager({
        torrent,
        peerManager: mockPeerManager,
        downloadPath: '/tmp/test',
        maxActiveRequests: 5
      });

      const selected = manager.selectNextPiece();
      expect(selected).toBe(null);
    });
  });

  describe('Bitfield Generation', () => {
    it('should generate correct bitfield', () => {
      const mockPeerManager = {
        pieceAvailability: [1, 1, 1, 1, 1, 1, 1, 1],
        on: jest.fn(),
        getConnectedPeers: jest.fn(() => []),
        hasPiece: jest.fn(),
        broadcast: jest.fn()
      };

      const torrent = {
        name: 'test',
        length: 80000,
        pieces: Array(8).fill(Buffer.alloc(20, 0)),
        pieceLength: 10000,
        isMultiFile: false
      };

      const manager = new DownloadManager({
        torrent,
        peerManager: mockPeerManager,
        downloadPath: '/tmp/test',
        maxActiveRequests: 5
      });

      // Mark pieces 0, 2, 5 as complete
      manager.completedPieces.add(0);
      manager.completedPieces.add(2);
      manager.completedPieces.add(5);

      const bitfield = manager.getBitfield();
      
      // Bitfield for 8 pieces: 10100100 = 0xA4
      expect(bitfield[0]).toBe(0xA4);
    });
  });
});
