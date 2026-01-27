const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Torrent } = require('../src/server/torrentEngine/torrent');
const { TorrentEngine } = require('../src/server/torrentEngine/engine');
const { parseTorrent } = require('../src/server/torrentEngine/torrentParser');
const bencode = require('../src/server/torrentEngine/bencode');

// Mock tracker module
jest.mock('../src/server/torrentEngine/tracker', () => ({
  announce: jest.fn()
}));

const { announce } = require('../src/server/torrentEngine/tracker');

// Helper to create a test .torrent file
async function createTestTorrentFile(tmpDir, name = 'test-file.txt', content = 'Hello World!') {
  // Create the file to be shared
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content);

  const fileBuffer = Buffer.from(content, 'utf8');
  const pieceLength = 16384; // 16KB pieces
  const pieces = [];

  // Calculate pieces
  for (let i = 0; i < fileBuffer.length; i += pieceLength) {
    const piece = fileBuffer.slice(i, Math.min(i + pieceLength, fileBuffer.length));
    const hash = crypto.createHash('sha1').update(piece).digest();
    pieces.push(hash);
  }

  const piecesBuffer = Buffer.concat(pieces);

  // Create torrent metadata
  const info = {
    name: name,
    length: fileBuffer.length,
    'piece length': pieceLength,
    pieces: piecesBuffer
  };

  const torrentData = {
    announce: 'http://tracker.example.com:8080/announce',
    'announce-list': [
      ['http://tracker.example.com:8080/announce'],
      ['udp://tracker.example.com:8080/announce']
    ],
    info: info,
    'creation date': Math.floor(Date.now() / 1000),
    comment: 'Test torrent'
  };

  const torrentBuffer = bencode.encode(torrentData);
  const torrentPath = path.join(tmpDir, `${name}.torrent`);
  await fs.writeFile(torrentPath, torrentBuffer);

  return { torrentPath, filePath, torrentBuffer, content };
}

describe('Torrent', () => {
  let tmpDir;
  let testTorrent;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-test-'));
    
    // Reset mocks
    announce.mockReset();
    announce.mockResolvedValue({
      interval: 1800,
      peers: [
        { ip: '127.0.0.1', port: 6881 },
        { ip: '127.0.0.1', port: 6882 }
      ],
      seeders: 2,
      leechers: 0
    });

    testTorrent = await createTestTorrentFile(tmpDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Constructor and Initialization', () => {
    it('should create Torrent from .torrent file', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      // Wait for initialization
      await new Promise((resolve) => torrent.once('ready', resolve));

      expect(torrent.name).toBe('test-file.txt');
      expect(torrent.size).toBe(testTorrent.content.length);
      expect(torrent.state).toBe('idle');
      expect(torrent.infoHash).toBeTruthy();
      expect(torrent.infoHash).toMatch(/^[a-f0-9]{40}$/);
      expect(torrent.pieceCount).toBeGreaterThan(0);
    });

    it('should create Torrent from buffer', async () => {
      const torrent = new Torrent({
        torrentBuffer: testTorrent.torrentBuffer,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      expect(torrent.name).toBe('test-file.txt');
      expect(torrent.state).toBe('idle');
    });

    it('should parse metadata correctly', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      expect(torrent.files).toHaveLength(1);
      expect(torrent.files[0].path).toBe('test-file.txt');
      expect(torrent.files[0].length).toBe(testTorrent.content.length);
    });

    it('should throw error without torrent source', () => {
      expect(() => {
        new Torrent({ downloadPath: tmpDir });
      }).toThrow('Must provide torrentPath, torrentBuffer, or magnetURI');
    });

    it('should generate peer ID automatically', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      expect(torrent._peerId).toBeTruthy();
      expect(torrent._peerId.length).toBe(20);
      expect(torrent._peerId.toString('utf8').startsWith('-TE0001-')).toBe(true);
    });
  });

  describe('Start and Download', () => {
    it('should initialize all components on start', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: path.join(tmpDir, 'downloads')
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      // Start torrent
      await torrent.start();

      expect(torrent.state).toBe('downloading');
      expect(torrent._peerManager).toBeTruthy();
      expect(torrent._downloadManager).toBeTruthy();
      expect(torrent._fileWriter).toBeTruthy();
      
      // Verify tracker was announced to
      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({
          announceUrl: 'http://tracker.example.com:8080/announce',
          event: 'started',
          port: 6881
        })
      );

      // Verify directories were created
      const downloadDir = path.join(tmpDir, 'downloads');
      const stats = await fs.stat(downloadDir);
      expect(stats.isDirectory()).toBe(true);

      await torrent.stop();
    });

    it('should emit started event', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      const startedPromise = new Promise((resolve) => {
        torrent.once('started', resolve);
      });

      await torrent.start();
      await startedPromise;

      expect(torrent.state).toBe('downloading');

      await torrent.stop();
    });

    it('should not start twice', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      // Try to start again
      await torrent.start();

      // Should still be downloading (not errored)
      expect(torrent.state).toBe('downloading');

      await torrent.stop();
    });
  });

  describe('Pause and Resume', () => {
    it('should pause torrent', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      torrent.pause();

      expect(torrent.state).toBe('paused');

      await torrent.stop();
    });

    it('should resume torrent', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      torrent.pause();
      expect(torrent.state).toBe('paused');

      torrent.resume();
      expect(torrent.state).toBe('downloading');

      await torrent.stop();
    });

    it('should emit pause and resume events', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      const pausedPromise = new Promise((resolve) => {
        torrent.once('paused', resolve);
      });
      torrent.pause();
      await pausedPromise;

      const resumedPromise = new Promise((resolve) => {
        torrent.once('resumed', resolve);
      });
      torrent.resume();
      await resumedPromise;

      await torrent.stop();
    });
  });

  describe('Stop and Cleanup', () => {
    it('should stop torrent and clean up', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      // Reset mock to track 'stopped' event
      announce.mockResolvedValue({ peers: [] });

      await torrent.stop();

      expect(torrent.state).toBe('idle');
      
      // Verify 'stopped' event was sent to tracker
      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'stopped'
        })
      );
    });

    it('should clear intervals on stop', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      expect(torrent._announceInterval).toBeTruthy();
      expect(torrent._statsInterval).toBeTruthy();

      await torrent.stop();

      expect(torrent._announceInterval).toBeNull();
      expect(torrent._statsInterval).toBeNull();
    });

    it('should not error when stopping idle torrent', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      await expect(torrent.stop()).resolves.not.toThrow();
      expect(torrent.state).toBe('idle');
    });
  });

  describe('Progress and Events', () => {
    it('should calculate progress correctly', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      // Initially 0%
      expect(torrent.progress).toBe(0);

      // Simulate piece completion
      if (torrent._downloadManager) {
        const totalSize = torrent.size;
        torrent._downloadManager.downloadedBytes = totalSize / 2;
        
        expect(torrent.progress).toBeCloseTo(50, 0);
      }

      await torrent.stop();
    });

    it('should emit piece event on piece completion', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      const piecePromise = new Promise((resolve) => {
        torrent.once('piece', resolve);
      });

      await torrent.start();

      // Simulate piece completion
      if (torrent._downloadManager) {
        torrent._downloadManager.emit('piece:complete', { index: 0 });
      }

      const pieceEvent = await piecePromise;
      expect(pieceEvent.index).toBe(0);

      await torrent.stop();
    });

    it('should emit progress event', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));

      const progressPromise = new Promise((resolve) => {
        torrent.once('progress', resolve);
      });

      await torrent.start();

      // Simulate progress update
      if (torrent._downloadManager) {
        torrent._downloadManager.emit('progress', {
          downloaded: 100,
          total: 1000,
          percentage: 10
        });
      }

      const progress = await progressPromise;
      expect(progress.percentage).toBe(10);

      await torrent.stop();
    });
  });

  describe('Stats', () => {
    it('should return accurate stats', async () => {
      const torrent = new Torrent({
        torrentPath: testTorrent.torrentPath,
        downloadPath: tmpDir
      });

      await new Promise((resolve) => torrent.once('ready', resolve));
      await torrent.start();

      const stats = torrent.getStats();

      expect(stats).toHaveProperty('infoHash');
      expect(stats).toHaveProperty('name');
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('downloaded');
      expect(stats).toHaveProperty('percentage');
      expect(stats).toHaveProperty('downloadSpeed');
      expect(stats).toHaveProperty('uploadSpeed');
      expect(stats).toHaveProperty('state');
      expect(stats).toHaveProperty('peers');
      expect(stats.state).toBe('downloading');

      await torrent.stop();
    });
  });
});

describe('TorrentEngine', () => {
  let tmpDir;
  let engine;
  let testTorrent;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-test-'));
    
    engine = new TorrentEngine({
      downloadPath: path.join(tmpDir, 'downloads'),
      maxActiveTorrents: 5,
      port: 6883
    });

    // Reset mocks
    announce.mockReset();
    announce.mockResolvedValue({
      interval: 1800,
      peers: [],
      seeders: 0,
      leechers: 0
    });

    testTorrent = await createTestTorrentFile(tmpDir);
  });

  afterEach(async () => {
    await engine.stopAll();
    
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Add and Remove Torrents', () => {
    it('should add torrent to engine', async () => {
      const torrent = await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      expect(torrent).toBeTruthy();
      expect(torrent.name).toBe('test-file.txt');
      expect(engine.torrents.size).toBe(1);
    });

    it('should retrieve torrent by infoHash', async () => {
      const torrent = await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      const retrieved = engine.getTorrent(torrent.infoHash);
      expect(retrieved).toBe(torrent);
    });

    it('should get all torrents', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      const allTorrents = engine.getAllTorrents();
      expect(allTorrents).toHaveLength(1);
      expect(allTorrents[0].name).toBe('test-file.txt');
    });

    it('should remove torrent from engine', async () => {
      const torrent = await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      const infoHash = torrent.infoHash;
      await engine.removeTorrent(infoHash, false);

      expect(engine.torrents.size).toBe(0);
      expect(engine.getTorrent(infoHash)).toBeNull();
    });

    it('should delete files when deleteFiles=true', async () => {
      const torrent = await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      // Create a dummy file
      const downloadDir = path.join(tmpDir, 'downloads', 'test-file.txt');
      await fs.mkdir(path.dirname(downloadDir), { recursive: true });
      await fs.writeFile(downloadDir, 'test content');

      // Verify file exists
      await expect(fs.access(downloadDir)).resolves.not.toThrow();

      // Remove with deleteFiles=true
      await engine.removeTorrent(torrent.infoHash, true);

      // File should be deleted
      await expect(fs.access(downloadDir)).rejects.toThrow();
    });

    it('should keep files when deleteFiles=false', async () => {
      const torrent = await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      // Create a dummy file
      const downloadDir = path.join(tmpDir, 'downloads', 'test-file.txt');
      await fs.mkdir(path.dirname(downloadDir), { recursive: true });
      await fs.writeFile(downloadDir, 'test content');

      // Remove with deleteFiles=false
      await engine.removeTorrent(torrent.infoHash, false);

      // File should still exist
      await expect(fs.access(downloadDir)).resolves.not.toThrow();
    });
  });

  describe('Duplicate Detection', () => {
    it('should reject duplicate torrents', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      // Try to add same torrent again
      await expect(
        engine.addTorrent({
          torrentPath: testTorrent.torrentPath,
          autoStart: false
        })
      ).rejects.toThrow('already exists');
    });
  });

  describe('Global Stats', () => {
    it('should return aggregated stats', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      const stats = engine.getGlobalStats();

      expect(stats).toHaveProperty('totalDownloadSpeed');
      expect(stats).toHaveProperty('totalUploadSpeed');
      expect(stats).toHaveProperty('activeTorrents');
      expect(stats).toHaveProperty('totalTorrents');
      expect(stats).toHaveProperty('totalDownloaded');
      expect(stats).toHaveProperty('totalUploaded');
      expect(stats.totalTorrents).toBe(1);
    });

    it('should sum stats from multiple torrents', async () => {
      // Create two test torrents
      const torrent1 = await createTestTorrentFile(tmpDir, 'file1.txt', 'content 1');
      const torrent2 = await createTestTorrentFile(tmpDir, 'file2.txt', 'content 2');

      await engine.addTorrent({
        torrentPath: torrent1.torrentPath,
        autoStart: false
      });

      await engine.addTorrent({
        torrentPath: torrent2.torrentPath,
        autoStart: false
      });

      const stats = engine.getGlobalStats();
      expect(stats.totalTorrents).toBe(2);
    });
  });

  describe('Start and Stop', () => {
    it('should start all torrents', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      await engine.startAll();

      const torrent = engine.getAllTorrents()[0];
      expect(torrent.state).toBe('downloading');

      await engine.stopAll();
    });

    it('should stop all torrents', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: true
      });

      await engine.stopAll();

      const torrent = engine.getAllTorrents()[0];
      expect(torrent.state).toBe('idle');
    });

    it('should respect maxActiveTorrents limit', async () => {
      engine.maxActiveTorrents = 1;

      const torrent1 = await createTestTorrentFile(tmpDir, 'file1.txt', 'content 1');
      const torrent2 = await createTestTorrentFile(tmpDir, 'file2.txt', 'content 2');

      await engine.addTorrent({
        torrentPath: torrent1.torrentPath,
        autoStart: false
      });

      await engine.addTorrent({
        torrentPath: torrent2.torrentPath,
        autoStart: false
      });

      await engine.startAll();

      const stats = engine.getGlobalStats();
      expect(stats.activeTorrents).toBeLessThanOrEqual(1);

      await engine.stopAll();
    });
  });

  describe('Events', () => {
    it('should emit torrent:added event', async () => {
      const addedPromise = new Promise((resolve) => {
        engine.once('torrent:added', resolve);
      });

      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      const event = await addedPromise;
      expect(event.infoHash).toBeTruthy();
      expect(event.name).toBe('test-file.txt');
    });

    it('should emit torrent:removed event', async () => {
      const torrent = await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      const removedPromise = new Promise((resolve) => {
        engine.once('torrent:removed', resolve);
      });

      await engine.removeTorrent(torrent.infoHash);

      const event = await removedPromise;
      expect(event.infoHash).toBe(torrent.infoHash);
    });
  });

  describe('State Persistence', () => {
    it('should save state to disk', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      await engine.saveState();

      const stateFile = path.join(tmpDir, 'downloads', '.torrentedge', 'state.json');
      const stateData = await fs.readFile(stateFile, 'utf8');
      const state = JSON.parse(stateData);

      expect(state.torrents).toHaveLength(1);
      expect(state.torrents[0].name).toBe('test-file.txt');
    });

    it('should load state from disk', async () => {
      await engine.addTorrent({
        torrentPath: testTorrent.torrentPath,
        autoStart: false
      });

      await engine.saveState();

      // Create new engine
      const engine2 = new TorrentEngine({
        downloadPath: path.join(tmpDir, 'downloads'),
        port: 6884
      });

      await engine2.loadState();

      expect(engine2.torrents.size).toBe(1);
      expect(engine2.getAllTorrents()[0].name).toBe('test-file.txt');

      await engine2.stopAll();
    });
  });
});
