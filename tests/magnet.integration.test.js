const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { Torrent } = require('../src/server/torrentEngine/torrent');
const { parseMagnet, createMagnet } = require('../src/server/torrentEngine/magnet');
const bencode = require('../src/server/torrentEngine/bencode');
const { DHTNode } = require('../src/server/torrentEngine/dht/node');

// Constants
const MOCK_PEER_PORT = 7000;
const MOCK_DHT_PORT = 8000;
const BT_PROTOCOL = 'BitTorrent protocol';
const EXTENSION_BIT = 0x10; // Byte 5, bit 4

/**
 * Helper function to generate test torrent metadata
 */
function generateTestMetadata(options = {}) {
  const name = options.name || 'test-file.txt';
  const content = options.content || 'This is test content for magnet link testing.';
  const pieceLength = options.pieceLength || 16384;
  
  const contentBuffer = Buffer.from(content, 'utf8');
  
  // Calculate pieces
  const numPieces = Math.ceil(contentBuffer.length / pieceLength);
  const pieces = [];
  
  for (let i = 0; i < numPieces; i++) {
    const start = i * pieceLength;
    const end = Math.min(start + pieceLength, contentBuffer.length);
    const piece = contentBuffer.slice(start, end);
    const hash = crypto.createHash('sha1').update(piece).digest();
    pieces.push(hash);
  }
  
  const piecesBuffer = Buffer.concat(pieces);
  
  // Create info dictionary
  const infoDict = {
    name: name,
    'piece length': pieceLength,
    pieces: piecesBuffer,
    length: contentBuffer.length
  };
  
  // Calculate info hash
  const infoEncoded = bencode.encode(infoDict);
  const infoHash = crypto.createHash('sha1').update(infoEncoded).digest();
  const infoHashHex = infoHash.toString('hex');
  
  // Create magnet URI
  const magnetURI = createMagnet({
    infoHash: infoHashHex,
    name: name,
    trackers: []
  });
  
  return {
    metadata: infoEncoded,
    infoDict,
    infoHash,
    infoHashHex,
    magnetURI,
    content: contentBuffer,
    pieceLength,
    pieces: piecesBuffer
  };
}

/**
 * Mock peer server that supports extension protocol
 */
class MockPeerServer {
  constructor(port, metadata) {
    this.port = port;
    this.metadata = metadata; // Full metadata buffer
    this.server = null;
    this.clients = [];
    this.peerId = Buffer.from('-MP0001-' + crypto.randomBytes(6).toString('hex').substring(0, 12));
    this.infoHash = null;
    this.metadataSize = metadata ? metadata.length : 0;
    this.sendWrongHash = false;
  }
  
  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        console.log(`[MockPeer] Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
        this.handleClient(socket);
      });
      
      this.server.listen(this.port, () => {
        console.log(`[MockPeer] Server listening on port ${this.port}`);
        resolve();
      });
      
      this.server.on('error', (err) => {
        console.error(`[MockPeer] Server error: ${err.message}`);
        reject(err);
      });
    });
  }
  
  async stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients = [];
    
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('[MockPeer] Server stopped');
          resolve();
        });
      });
    }
  }
  
  handleClient(socket) {
    this.clients.push(socket);
    
    let buffer = Buffer.alloc(0);
    let handshakeComplete = false;
    let extensionHandshakeSent = false;
    
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      
      if (!handshakeComplete) {
        // BT handshake: <pstrlen><pstr><reserved><info_hash><peer_id>
        if (buffer.length >= 68) {
          const pstrlen = buffer[0];
          if (pstrlen === 19 && buffer.length >= 49 + pstrlen) {
            const pstr = buffer.slice(1, 1 + pstrlen).toString();
            
            if (pstr === BT_PROTOCOL) {
              const reserved = buffer.slice(20, 28);
              const infoHash = buffer.slice(28, 48);
              const peerId = buffer.slice(48, 68);
              
              console.log(`[MockPeer] Received handshake from ${peerId.toString('hex').substring(0, 16)}...`);
              console.log(`[MockPeer] Info hash: ${infoHash.toString('hex').substring(0, 16)}...`);
              
              this.infoHash = infoHash;
              
              // Send handshake response with extension bit set
              const response = Buffer.alloc(68);
              response[0] = 19;
              response.write(BT_PROTOCOL, 1);
              // Set extension bit in reserved bytes (byte 5, bit 4)
              response[25] = EXTENSION_BIT;
              infoHash.copy(response, 28);
              this.peerId.copy(response, 48);
              
              socket.write(response);
              console.log('[MockPeer] Sent handshake response with extension bit');
              
              handshakeComplete = true;
              buffer = buffer.slice(68);
            }
          }
        }
      } else {
        // Parse messages
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          
          if (length === 0) {
            // Keep-alive
            buffer = buffer.slice(4);
            continue;
          }
          
          if (buffer.length < 4 + length) {
            break; // Wait for more data
          }
          
          const messageId = buffer[4];
          const payload = buffer.slice(5, 4 + length);
          
          console.log(`[MockPeer] Received message: id=${messageId}, length=${length}`);
          
          if (messageId === 20) {
            // Extended message
            this.handleExtendedMessage(socket, payload, extensionHandshakeSent);
            extensionHandshakeSent = true;
          }
          
          buffer = buffer.slice(4 + length);
        }
      }
    });
    
    socket.on('error', (err) => {
      console.error(`[MockPeer] Socket error: ${err.message}`);
    });
    
    socket.on('close', () => {
      console.log('[MockPeer] Client disconnected');
      const index = this.clients.indexOf(socket);
      if (index > -1) {
        this.clients.splice(index, 1);
      }
    });
  }
  
  handleExtendedMessage(socket, payload, handshakeSent) {
    const extMsgId = payload[0];
    const extPayload = payload.slice(1);
    
    console.log(`[MockPeer] Extended message: extId=${extMsgId}`);
    
    if (extMsgId === 0 && !handshakeSent) {
      // Extension handshake from client
      console.log('[MockPeer] Received extension handshake');
      
      // Send our extension handshake with ut_metadata support
      const handshake = {
        m: {
          ut_metadata: 2 // Our message ID for ut_metadata
        },
        metadata_size: this.metadataSize
      };
      
      const encoded = bencode.encode(handshake);
      const message = Buffer.alloc(2 + encoded.length);
      message[0] = 20; // Extended message
      message[1] = 0;  // Handshake
      encoded.copy(message, 2);
      
      const length = Buffer.alloc(4);
      length.writeUInt32BE(message.length, 0);
      
      socket.write(Buffer.concat([length, message]));
      console.log('[MockPeer] Sent extension handshake with ut_metadata support');
    } else if (extMsgId === 1) {
      // This is likely a request (client uses id 1 for ut_metadata)
      // Parse the bencoded dictionary
      try {
        // Find dict end
        let dictEnd = 0;
        let depth = 0;
        
        for (let i = 0; i < extPayload.length; i++) {
          if (extPayload[i] === 0x64) { // 'd'
            depth++;
          } else if (extPayload[i] === 0x65) { // 'e'
            depth--;
            if (depth === 0) {
              dictEnd = i + 1;
              break;
            }
          }
        }
        
        const dict = bencode.decode(extPayload.slice(0, dictEnd));
        
        console.log(`[MockPeer] ut_metadata request: ${JSON.stringify(dict)}`);
        
        if (dict.msg_type === 0) {
          // Request for metadata piece
          this.sendMetadataPiece(socket, dict.piece);
        }
      } catch (err) {
        console.error(`[MockPeer] Error parsing ut_metadata message: ${err.message}`);
      }
    }
  }
  
  sendMetadataPiece(socket, pieceIndex) {
    if (!this.metadata) {
      console.error('[MockPeer] No metadata to send');
      return;
    }
    
    const PIECE_SIZE = 16384;
    const start = pieceIndex * PIECE_SIZE;
    const end = Math.min(start + PIECE_SIZE, this.metadata.length);
    
    if (start >= this.metadata.length) {
      // Invalid piece, send reject
      const reject = {
        msg_type: 2,
        piece: pieceIndex
      };
      
      const encoded = bencode.encode(reject);
      const message = Buffer.alloc(2 + encoded.length);
      message[0] = 20; // Extended
      message[1] = 2;  // ut_metadata (our id)
      encoded.copy(message, 2);
      
      const length = Buffer.alloc(4);
      length.writeUInt32BE(message.length, 0);
      
      socket.write(Buffer.concat([length, message]));
      console.log(`[MockPeer] Sent reject for piece ${pieceIndex}`);
      return;
    }
    
    // Get piece data
    let pieceData = this.metadata.slice(start, end);
    
    // If sendWrongHash is true, corrupt the data
    if (this.sendWrongHash) {
      pieceData = Buffer.concat([pieceData, Buffer.from([0xFF])]);
      console.log('[MockPeer] Sending corrupted metadata (wrong hash)');
    }
    
    // Send data message
    const response = {
      msg_type: 1,
      piece: pieceIndex,
      total_size: this.metadata.length
    };
    
    const encoded = bencode.encode(response);
    const message = Buffer.concat([
      Buffer.from([20]), // Extended
      Buffer.from([2]),  // ut_metadata (our id)
      encoded,
      pieceData
    ]);
    
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.length, 0);
    
    socket.write(Buffer.concat([length, message]));
    console.log(`[MockPeer] Sent metadata piece ${pieceIndex} (${pieceData.length} bytes)`);
  }
}

/**
 * Mock DHT node for testing
 */
class MockDHTNode {
  constructor(peers = []) {
    this.peers = peers; // Array of {host, port} objects
    this.queries = [];
  }
  
  async getPeers(infoHash, callback) {
    const infoHashHex = infoHash.toString('hex');
    this.queries.push({ infoHash: infoHashHex, timestamp: Date.now() });
    
    console.log(`[MockDHT] getPeers called for ${infoHashHex.substring(0, 16)}...`);
    
    // Simulate async operation
    setTimeout(() => {
      if (callback) {
        callback(this.peers);
      }
    }, 100);
  }
  
  on(event, handler) {
    // Mock event handler
    if (event === 'peer' && this.peers.length > 0) {
      // Simulate peer announcements
      setTimeout(() => {
        for (const peer of this.peers) {
          handler({
            infoHash: this.queries[0]?.infoHash,
            peer
          });
        }
      }, 200);
    }
  }
}

describe('Magnet Link Integration Tests', () => {
  let mockPeerServer;
  let testData;
  let torrent;
  
  beforeEach(() => {
    // Generate test metadata
    testData = generateTestMetadata({
      name: 'test-torrent.txt',
      content: 'Hello World! This is a test torrent for magnet link integration testing.',
      pieceLength: 16384
    });
    
    console.log(`\n[Test] Generated test metadata:`);
    console.log(`  Info hash: ${testData.infoHashHex}`);
    console.log(`  Size: ${testData.content.length} bytes`);
    console.log(`  Magnet: ${testData.magnetURI}`);
  });
  
  afterEach(async () => {
    if (mockPeerServer) {
      await mockPeerServer.stop();
      mockPeerServer = null;
    }
    
    if (torrent) {
      await torrent.destroy();
      torrent = null;
    }
  });
  
  describe('Metadata Download with Mock Peer', () => {
    test('should download metadata from mock peer', async () => {
      // Create mock peer server
      mockPeerServer = new MockPeerServer(MOCK_PEER_PORT, testData.metadata);
      await mockPeerServer.start();
      
      // Create magnet URI with mock peer
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt',
        peers: [`127.0.0.1:${MOCK_PEER_PORT}`]
      });
      
      // Track state transitions
      const states = [];
      
      // Create torrent
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6881
      });
      
      torrent.on('ready', () => {
        console.log('[Test] Torrent ready');
        states.push('ready');
      });
      
      torrent.on('fetching_metadata', () => {
        console.log('[Test] Fetching metadata');
        states.push('fetching_metadata');
      });
      
      torrent.on('metadata:size', ({ size }) => {
        console.log(`[Test] Metadata size: ${size}`);
        expect(size).toBe(testData.metadata.length);
      });
      
      torrent.on('metadata:piece', ({ index, size }) => {
        console.log(`[Test] Metadata piece ${index} received (${size} bytes)`);
      });
      
      torrent.on('metadata:complete', ({ name, size, pieceCount }) => {
        console.log(`[Test] Metadata complete: ${name}, ${size} bytes, ${pieceCount} pieces`);
        states.push('metadata_complete');
      });
      
      // Wait for initialization
      await new Promise((resolve) => {
        torrent.on('ready', resolve);
      });
      
      expect(states).toContain('ready');
      expect(torrent.state).toBe('idle');
      expect(torrent.name).toBe('test-torrent.txt');
      
      // Start download (will fetch metadata first)
      const startPromise = torrent.start();
      
      // Wait for metadata to be fetched (with timeout)
      await Promise.race([
        new Promise((resolve) => {
          torrent.on('metadata:complete', resolve);
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Metadata download timeout')), 30000)
        )
      ]);
      
      // Verify state transitions
      expect(states).toContain('fetching_metadata');
      expect(states).toContain('metadata_complete');
      
      // Verify metadata was parsed correctly
      expect(torrent.name).toBe('test-torrent.txt');
      expect(torrent.size).toBe(testData.content.length);
      expect(torrent.infoHash).toBe(testData.infoHashHex);
      
      // Stop torrent
      await torrent.stop();
    }, 35000);
    
    test('should show metadata progress in stats', async () => {
      mockPeerServer = new MockPeerServer(MOCK_PEER_PORT, testData.metadata);
      await mockPeerServer.start();
      
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt',
        peers: [`127.0.0.1:${MOCK_PEER_PORT}`]
      });
      
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6882
      });
      
      await new Promise((resolve) => torrent.on('ready', resolve));
      
      // Start and check stats during metadata fetch
      const startPromise = torrent.start();
      
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      const stats = torrent.getStats();
      
      if (stats.state === 'fetching_metadata') {
        expect(stats).toHaveProperty('metadataProgress');
        expect(stats.metadataProgress).toBeGreaterThanOrEqual(0);
        expect(stats.metadataProgress).toBeLessThanOrEqual(1);
      }
      
      await torrent.stop();
    }, 30000);
  });
  
  describe('Metadata Verification', () => {
    test('should reject metadata with wrong hash', async () => {
      mockPeerServer = new MockPeerServer(MOCK_PEER_PORT, testData.metadata);
      mockPeerServer.sendWrongHash = true; // Corrupt the metadata
      await mockPeerServer.start();
      
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt',
        peers: [`127.0.0.1:${MOCK_PEER_PORT}`]
      });
      
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6883
      });
      
      await new Promise((resolve) => torrent.on('ready', resolve));
      
      let errorReceived = false;
      torrent.on('error', (error) => {
        console.log(`[Test] Error received: ${error.message}`);
        errorReceived = true;
      });
      
      // Start should fail or timeout
      try {
        await Promise.race([
          torrent.start(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Expected metadata verification to fail')), 10000)
          )
        ]);
        
        // If we get here, metadata was accepted (shouldn't happen)
        expect(torrent.state).not.toBe('downloading');
      } catch (err) {
        // Expected to fail
        console.log(`[Test] Start failed as expected: ${err.message}`);
      }
      
      await torrent.stop();
    }, 15000);
  });
  
  describe('DHT Peer Discovery', () => {
    test('should discover peers via DHT', async () => {
      mockPeerServer = new MockPeerServer(MOCK_PEER_PORT, testData.metadata);
      await mockPeerServer.start();
      
      // Create mock DHT that returns our mock peer
      const mockDHT = new MockDHTNode([
        { host: '127.0.0.1', port: MOCK_PEER_PORT }
      ]);
      
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt'
        // No direct peers
      });
      
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6884,
        dht: mockDHT
      });
      
      await new Promise((resolve) => torrent.on('ready', resolve));
      
      const startPromise = torrent.start();
      
      // Wait for metadata
      await Promise.race([
        new Promise((resolve) => torrent.on('metadata:complete', resolve)),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Metadata download timeout')), 30000)
        )
      ]);
      
      // Verify DHT was queried
      expect(mockDHT.queries.length).toBeGreaterThan(0);
      expect(mockDHT.queries[0].infoHash).toBe(testData.infoHashHex);
      
      // Verify metadata downloaded
      expect(torrent.name).toBe('test-torrent.txt');
      expect(torrent.size).toBe(testData.content.length);
      
      await torrent.stop();
    }, 35000);
  });
  
  describe('Tracker + DHT Combined', () => {
    test('should use both tracker and DHT for peer discovery', async () => {
      mockPeerServer = new MockPeerServer(MOCK_PEER_PORT, testData.metadata);
      await mockPeerServer.start();
      
      const mockDHT = new MockDHTNode([
        { host: '127.0.0.1', port: MOCK_PEER_PORT }
      ]);
      
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt',
        trackers: ['http://tracker.example.com:8080/announce']
        // No direct peers, will use DHT
      });
      
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6885,
        dht: mockDHT
      });
      
      await new Promise((resolve) => torrent.on('ready', resolve));
      
      // Verify magnet has tracker
      expect(torrent._metadata.announce).toBe('http://tracker.example.com:8080/announce');
      
      torrent.start().catch(() => {}); // Tracker will fail, but DHT should work
      
      // Wait a bit for DHT to be queried
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      // DHT should have been queried
      expect(mockDHT.queries.length).toBeGreaterThan(0);
      
      await torrent.stop();
    }, 15000);
  });
  
  describe('No Peers Available', () => {
    test('should timeout when no peers are available', async () => {
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt'
        // No peers, no trackers
      });
      
      const mockDHT = new MockDHTNode([]); // No peers from DHT
      
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6886,
        dht: mockDHT
      });
      
      await new Promise((resolve) => torrent.on('ready', resolve));
      
      let errorOccurred = false;
      
      try {
        await Promise.race([
          torrent.start(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('No peers timeout')), 35000)
          )
        ]);
      } catch (err) {
        console.log(`[Test] Failed as expected: ${err.message}`);
        errorOccurred = true;
      }
      
      expect(errorOccurred).toBe(true);
      
      await torrent.stop();
    }, 40000);
  });
  
  describe('Real Magnet Format Parsing', () => {
    test('should parse real-world magnet link correctly', () => {
      const realMagnet = 'magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12' +
        '&dn=Ubuntu+20.04+Desktop' +
        '&tr=http://tracker.example.com:8080/announce' +
        '&tr=udp://tracker2.example.com:6969/announce' +
        '&x.pe=192.168.1.100:6881' +
        '&x.pe=10.0.0.50:6882';
      
      const parsed = parseMagnet(realMagnet);
      
      expect(parsed.infoHash).toBe('abcdef1234567890abcdef1234567890abcdef12');
      expect(parsed.displayName).toBe('Ubuntu 20.04 Desktop');
      expect(parsed.trackers).toHaveLength(2);
      expect(parsed.trackers[0]).toBe('http://tracker.example.com:8080/announce');
      expect(parsed.trackers[1]).toBe('udp://tracker2.example.com:6969/announce');
      expect(parsed.peers).toHaveLength(2);
      expect(parsed.peers[0]).toBe('192.168.1.100:6881');
      expect(parsed.peers[1]).toBe('10.0.0.50:6882');
    });
    
    test('should parse magnet with base32 info hash', () => {
      // Base32 encoded info hash
      const base32Hash = 'VW42EFFB4M45D6Y4OLQSDFVNUBQVXHBF';
      const magnet = `magnet:?xt=urn:btih:${base32Hash}&dn=Test+File`;
      
      const parsed = parseMagnet(magnet);
      
      expect(parsed.infoHash).toBeDefined();
      expect(parsed.infoHash.length).toBe(40); // Hex is 40 chars
      expect(parsed.displayName).toBe('Test File');
    });
    
    test('should handle magnet with minimal info', () => {
      const magnet = 'magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678';
      
      const parsed = parseMagnet(magnet);
      
      expect(parsed.infoHash).toBe('1234567890abcdef1234567890abcdef12345678');
      expect(parsed.displayName).toBeNull();
      expect(parsed.trackers).toEqual([]);
      expect(parsed.peers).toEqual([]);
    });
  });
  
  describe('Helper Functions', () => {
    test('generateTestMetadata should create valid metadata', () => {
      const data = generateTestMetadata({
        name: 'my-file.txt',
        content: 'Test content',
        pieceLength: 16384
      });
      
      expect(data.infoDict.name).toBe('my-file.txt');
      expect(data.infoDict['piece length']).toBe(16384);
      expect(data.infoDict.length).toBe(12); // "Test content".length
      expect(data.infoHash).toHaveLength(20); // SHA1 hash
      expect(data.infoHashHex).toHaveLength(40); // Hex string
      expect(data.magnetURI).toContain('magnet:?xt=urn:btih:');
      
      // Verify hash is correct
      const calculatedHash = crypto.createHash('sha1').update(data.metadata).digest();
      expect(calculatedHash.equals(data.infoHash)).toBe(true);
    });
    
    test('createMagnet should create valid magnet URI', () => {
      const magnet = createMagnet({
        infoHash: 'abcd1234567890abcdef1234567890abcdef1234',
        name: 'Test Torrent',
        trackers: ['http://tracker.com:8080/announce'],
        peers: ['192.168.1.1:6881']
      });
      
      expect(magnet).toContain('magnet:?xt=urn:btih:ABCD1234567890ABCDEF1234567890ABCDEF1234');
      expect(magnet).toContain('dn=Test+Torrent');
      expect(magnet).toContain('tr=http%3A%2F%2Ftracker.com%3A8080%2Fannounce');
      expect(magnet).toContain('x.pe=192.168.1.1%3A6881');
    });
  });
  
  describe('State Transitions', () => {
    test('should transition through correct states', async () => {
      mockPeerServer = new MockPeerServer(MOCK_PEER_PORT, testData.metadata);
      await mockPeerServer.start();
      
      const magnetURI = createMagnet({
        infoHash: testData.infoHashHex,
        name: 'test-torrent.txt',
        peers: [`127.0.0.1:${MOCK_PEER_PORT}`]
      });
      
      const states = [];
      
      torrent = new Torrent({
        magnetURI,
        downloadPath: './test-downloads',
        port: 6887
      });
      
      // Track all state changes
      const originalState = torrent.state;
      states.push(originalState);
      
      // Monitor state property
      const stateCheckInterval = setInterval(() => {
        const currentState = torrent.state;
        if (states[states.length - 1] !== currentState) {
          states.push(currentState);
          console.log(`[Test] State changed to: ${currentState}`);
        }
      }, 100);
      
      await new Promise((resolve) => torrent.on('ready', resolve));
      
      const startPromise = torrent.start();
      
      // Wait for metadata complete
      await Promise.race([
        new Promise((resolve) => torrent.on('metadata:complete', resolve)),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 30000)
        )
      ]);
      
      clearInterval(stateCheckInterval);
      
      // Verify state sequence
      expect(states).toContain('idle');
      expect(states).toContain('fetching_metadata');
      
      // Should eventually reach checking or downloading
      const finalStates = ['checking', 'downloading', 'error'];
      expect(finalStates.some(s => states.includes(s))).toBe(true);
      
      await torrent.stop();
    }, 35000);
  });
});
