const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bencode = require('../src/server/torrentEngine/bencode');
const { TorrentEngine } = require('../src/server/torrentEngine/engine');
const S3ColdStartStreamer = require('../src/server/torrentEngine/s3Streamer');
const CASStore = require('../src/server/torrentEngine/casStore');

async function runTest() {
  console.log('--- Setting up S3 Mock Server ---');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-test-'));
  
  // 1. Create a mock S3 file
  const testData = crypto.randomBytes(1024 * 1024); // 1MB test file
  const testDataHash = crypto.createHash('sha256').update(testData).digest('hex');
  const s3FilePath = path.join(tmpDir, 'mock-s3-file.dat');
  await fs.writeFile(s3FilePath, testData);

  // 2. Start mock HTTP server
  const s3Server = http.createServer((req, res) => {
    console.log(`[Mock S3] Received request: ${req.url} (Range: ${req.headers.range || 'none'})`);
    if (req.headers.range) {
      const parts = req.headers.range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : testData.length - 1;
      const chunksize = (end - start) + 1;
      const file = testData.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${testData.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'application/octet-stream',
      });
      res.end(file);
    } else {
      res.writeHead(200, {
        'Content-Length': testData.length,
        'Content-Type': 'application/octet-stream',
      });
      res.end(testData);
    }
  });

  await new Promise(r => s3Server.listen(0, r));
  const s3Port = s3Server.address().port;
  const s3Url = `http://localhost:${s3Port}/mock-file`;
  console.log(`[Mock S3] Listening on ${s3Url}`);

  // 2b. Start mock Tracker Server
  const trackerServer = http.createServer((req, res) => {
    // Return empty peers list for the tracker announce
    const responseData = bencode.encode({
      interval: 1800,
      peers: []
    });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(responseData);
  });
  await new Promise(r => trackerServer.listen(0, r));
  const trackerUrl = `http://127.0.0.1:${trackerServer.address().port}/announce`;
  console.log(`[Mock Tracker] Listening on ${trackerUrl}`);

  // 3. Create Torrent Metadata for the mock file
  const pieceLength = 262144; // 256KB
  const pieces = [];
  for (let i = 0; i < testData.length; i += pieceLength) {
    pieces.push(crypto.createHash('sha1').update(testData.slice(i, Math.min(i + pieceLength, testData.length))).digest());
  }
  const piecesBuffer = Buffer.concat(pieces);

  const infoDict = {
    name: 'mock-file.dat',
    'piece length': pieceLength,
    pieces: piecesBuffer,
    length: testData.length
  };
  
  const infoEncoded = bencode.encode(infoDict);
  const infoHash = crypto.createHash('sha1').update(infoEncoded).digest();
  
  const torrentData = {
    announce: trackerUrl,
    info: infoDict,
    'creation date': Math.floor(Date.now() / 1000)
  };
  const torrentBuffer = bencode.encode(torrentData);

  console.log(`[Test] Torrent InfoHash: ${infoHash.toString('hex')}`);

  // 4. Setup Genesis Node (Seeder using S3ColdStartStreamer)
  const genesisDir = path.join(tmpDir, 'genesis');
  await fs.mkdir(genesisDir);
  
  console.log('--- Starting Genesis Node ---');
  const genesisEngine = new TorrentEngine({
    downloadPath: genesisDir,
    port: 6881
  });
  
  await genesisEngine.startPeerListener();
  const genesisListenPort = genesisEngine._peerListenPort;
  
  const genesisTorrent = await genesisEngine.addTorrent({
    torrentBuffer,
    downloadPath: genesisDir,
    autoStart: true
  });
  
  genesisTorrent.on('error', err => console.error('[Genesis] Error:', err.message));
  genesisTorrent.on('warning', err => console.warn('[Genesis] Warning:', err.message));
  
  // Wait for the torrent to finish starting (QueueManager starts it via autoStart)
  await new Promise(r => setTimeout(r, 500));
  
  console.log('--- Starting S3 Cold Start Streamer ---');
  const streamer = new S3ColdStartStreamer({
    torrent: genesisTorrent,
    sourceUri: s3Url,
    nodeId: 'genesis-node-1',
    downloadPath: genesisDir
  });

  const streamResult = await streamer.start();
  console.log(`[S3Streamer] Completed: ${JSON.stringify(streamResult)}`);
  
  // Force Genesis to seed and initialize UploadManager
  if (typeof genesisTorrent._transitionToSeeding === 'function') {
    await genesisTorrent._transitionToSeeding();
  } else {
    genesisTorrent._state = 'seeding';
  }
  
  // 5. Setup Leecher Node
  console.log('--- Starting Leecher Node ---');
  const leecherDir = path.join(tmpDir, 'leecher');
  await fs.mkdir(leecherDir);
  
  const leecherEngine = new TorrentEngine({
    downloadPath: leecherDir,
    port: 6882
  });
  
  await leecherEngine.startPeerListener();
  
  const leecherTorrent = await leecherEngine.addTorrent({
    torrentBuffer,
    downloadPath: leecherDir,
    autoStart: true
  });
  
  leecherTorrent.on('error', err => console.error('[Leecher] Error:', err.message));
  
  // Wait for leecher to complete
  const leecherDone = new Promise((resolve, reject) => {
    // Listen on the downloadManager for the 'complete' event
    const checkComplete = () => {
      if (leecherTorrent._downloadManager) {
        leecherTorrent._downloadManager.on('complete', () => resolve());
      } else {
        setTimeout(checkComplete, 100);
      }
    };
    checkComplete();
    leecherTorrent.on('completed', () => resolve());
  });

  // Wait for the torrent to finish starting (QueueManager starts it via autoStart)
  await new Promise(r => setTimeout(r, 500));
  
  // Manually connect Leecher to Genesis
  console.log('[Test] Connecting Leecher directly to Genesis (bypassing Tracker/DHT for speed)');
  leecherTorrent._peerManager.connectToPeer({ ip: '127.0.0.1', port: genesisListenPort });

  console.log('[Test] Waiting for Leecher to finish downloading...');
  
  // Timeout for safety
  const timeoutId = setTimeout(() => {
    console.error('[Test] TIMEOUT: Leecher did not complete in 30 seconds.');
    // Debug: print state
    if (leecherTorrent._downloadManager) {
      const dm = leecherTorrent._downloadManager;
      console.error(`[Debug] completedPieces: ${dm.completedPieces.size}/${dm.pieces.length}`);
      console.error(`[Debug] activePieces: ${dm.activePieces.size}`);
      console.error(`[Debug] pendingRequests: ${dm.pendingRequests.size}`);
      console.error(`[Debug] isRunning: ${dm.isRunning}, isPaused: ${dm.isPaused}`);
      const peers = leecherTorrent._peerManager?.getConnectedPeers() || [];
      console.error(`[Debug] connectedPeers: ${peers.length}`);
      for (const p of peers) {
        console.error(`[Debug]   peer ${p.ip}:${p.port} choking=${p.peerChoking} handshake=${p.isHandshakeComplete}`);
      }
    }
    process.exit(1);
  }, 30000);

  await leecherDone;
  clearTimeout(timeoutId);
  
  console.log('[Test] Leecher Completed!');

  // Verify file integrity
  const leecherFilePath = path.join(leecherDir, 'mock-file.dat');
  const downloadedData = await fs.readFile(leecherFilePath);
  const downloadedHash = crypto.createHash('sha256').update(downloadedData).digest('hex');
  
  if (downloadedHash === testDataHash) {
    console.log('✅ End-to-End Swarm Test PASSED (Hashes match)');
  } else {
    console.error('❌ End-to-End Swarm Test FAILED (Hashes mismatch)');
  }

  // Cleanup
  await genesisTorrent.stop();
  await leecherTorrent.stop();
  if (genesisEngine._peerServer) genesisEngine._peerServer.close();
  if (leecherEngine._peerServer) leecherEngine._peerServer.close();
  s3Server.close();
  trackerServer.close();
  console.log('--- Test Finished ---');
  process.exit(0);
}

runTest().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
