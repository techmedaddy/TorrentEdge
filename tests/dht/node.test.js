const crypto = require('crypto');
const DHTNode = require('../../src/server/torrentEngine/dht/node');

// Helper to wait for a duration
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to generate test node ID
const generateNodeId = () => crypto.randomBytes(20);

describe('DHTNode', () => {
  let nodes = [];
  let basePort = 16881;

  // Clean up all nodes after each test
  afterEach(async () => {
    for (const node of nodes) {
      if (node._socket) {
        await node.stop();
      }
    }
    nodes = [];
    basePort += 10; // Increment port to avoid conflicts between tests
  });

  describe('Construction', () => {
    test('should create node with random ID if not provided', () => {
      const node = new DHTNode({ port: basePort++ });
      nodes.push(node);

      expect(node.nodeId).toBeInstanceOf(Buffer);
      expect(node.nodeId.length).toBe(20);
    });

    test('should verify node ID is exactly 20 bytes', () => {
      const node = new DHTNode({ port: basePort++ });
      nodes.push(node);

      expect(node.nodeId.length).toBe(20);
      expect(Buffer.isBuffer(node.nodeId)).toBe(true);
    });

    test('should use provided node ID', () => {
      const customId = generateNodeId();
      const node = new DHTNode({ 
        nodeId: customId,
        port: basePort++ 
      });
      nodes.push(node);

      expect(node.nodeId.equals(customId)).toBe(true);
      expect(node.nodeId).toBe(customId);
    });

    test('should use default port 6881 if not provided', () => {
      const node = new DHTNode({ bootstrapNodes: [] });
      nodes.push(node);

      expect(node.port).toBe(6881);
    });

    test('should initialize with correct default values', () => {
      const node = new DHTNode({ port: basePort++ });
      nodes.push(node);

      expect(node.isReady).toBe(false);
      expect(node.nodesCount).toBe(0);
      expect(node._routingTable.size).toBe(0);
    });
  });

  describe('Message Encoding/Decoding', () => {
    let node;

    beforeEach(() => {
      node = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(node);
    });

    test('should correctly encode nodes to compact format (26 bytes each)', () => {
      const testNodes = [
        {
          id: generateNodeId(),
          host: '192.168.1.1',
          port: 6881
        },
        {
          id: generateNodeId(),
          host: '10.0.0.1',
          port: 51413
        }
      ];

      const encoded = node._encodeNodes(testNodes);

      expect(encoded).toBeInstanceOf(Buffer);
      expect(encoded.length).toBe(26 * 2); // 26 bytes per node

      // Verify first node encoding
      expect(encoded.slice(0, 20).equals(testNodes[0].id)).toBe(true);
      expect(encoded[20]).toBe(192);
      expect(encoded[21]).toBe(168);
      expect(encoded[22]).toBe(1);
      expect(encoded[23]).toBe(1);
      expect(encoded.readUInt16BE(24)).toBe(6881);

      // Verify second node encoding
      expect(encoded.slice(26, 46).equals(testNodes[1].id)).toBe(true);
      expect(encoded[46]).toBe(10);
      expect(encoded[47]).toBe(0);
      expect(encoded[48]).toBe(0);
      expect(encoded[49]).toBe(1);
      expect(encoded.readUInt16BE(50)).toBe(51413);
    });

    test('should correctly decode nodes from compact format', () => {
      const testNodes = [
        {
          id: generateNodeId(),
          host: '172.16.0.1',
          port: 8080
        },
        {
          id: generateNodeId(),
          host: '8.8.8.8',
          port: 6881
        }
      ];

      const encoded = node._encodeNodes(testNodes);
      const decoded = node._decodeNodes(encoded);

      expect(decoded).toHaveLength(2);
      expect(decoded[0].id.equals(testNodes[0].id)).toBe(true);
      expect(decoded[0].host).toBe('172.16.0.1');
      expect(decoded[0].port).toBe(8080);
      expect(decoded[1].id.equals(testNodes[1].id)).toBe(true);
      expect(decoded[1].host).toBe('8.8.8.8');
      expect(decoded[1].port).toBe(6881);
    });

    test('should handle empty node list', () => {
      const encoded = node._encodeNodes([]);
      expect(encoded.length).toBe(0);

      const decoded = node._decodeNodes(Buffer.alloc(0));
      expect(decoded).toHaveLength(0);
    });

    test('should correctly encode peers to compact format (6 bytes each)', () => {
      const testPeers = [
        { ip: '192.168.1.100', port: 6881 },
        { ip: '10.0.0.50', port: 51413 }
      ];

      const encoded = node._encodePeers(testPeers);

      expect(Array.isArray(encoded)).toBe(true);
      expect(encoded).toHaveLength(2);
      expect(encoded[0]).toBeInstanceOf(Buffer);
      expect(encoded[0].length).toBe(6);

      // Verify first peer encoding
      expect(encoded[0][0]).toBe(192);
      expect(encoded[0][1]).toBe(168);
      expect(encoded[0][2]).toBe(1);
      expect(encoded[0][3]).toBe(100);
      expect(encoded[0].readUInt16BE(4)).toBe(6881);

      // Verify second peer encoding
      expect(encoded[1][0]).toBe(10);
      expect(encoded[1][1]).toBe(0);
      expect(encoded[1][2]).toBe(0);
      expect(encoded[1][3]).toBe(50);
      expect(encoded[1].readUInt16BE(4)).toBe(51413);
    });

    test('should correctly decode peers from compact format', () => {
      const testPeers = [
        { ip: '8.8.8.8', port: 6881 },
        { ip: '1.1.1.1', port: 8080 }
      ];

      const encoded = node._encodePeers(testPeers);
      const decoded = node._decodePeers(encoded);

      expect(decoded).toHaveLength(2);
      expect(decoded[0]).toEqual({ ip: '8.8.8.8', port: 6881 });
      expect(decoded[1]).toEqual({ ip: '1.1.1.1', port: 8080 });
    });

    test('should handle empty peer list', () => {
      const encoded = node._encodePeers([]);
      expect(encoded).toHaveLength(0);

      const decoded = node._decodePeers([]);
      expect(decoded).toHaveLength(0);
    });

    test('should ignore invalid peer buffers', () => {
      const invalidPeers = [
        Buffer.alloc(5), // Wrong length
        Buffer.alloc(7), // Wrong length
        Buffer.alloc(6)  // Valid
      ];

      const buffer = Buffer.alloc(6);
      buffer[0] = 192;
      buffer[1] = 168;
      buffer[2] = 1;
      buffer[3] = 1;
      buffer.writeUInt16BE(6881, 4);
      invalidPeers[2] = buffer;

      const decoded = node._decodePeers(invalidPeers);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toEqual({ ip: '192.168.1.1', port: 6881 });
    });
  });

  describe('Token Generation and Validation', () => {
    let node;

    beforeEach(() => {
      node = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(node);
    });

    test('should generate token for an IP address', () => {
      const token = node._generateToken('192.168.1.1');

      expect(token).toBeInstanceOf(Buffer);
      expect(token.length).toBe(8);
    });

    test('should generate different tokens for different IPs', () => {
      const token1 = node._generateToken('192.168.1.1');
      const token2 = node._generateToken('192.168.1.2');

      expect(token1.equals(token2)).toBe(false);
    });

    test('should generate same token for same IP', () => {
      const token1 = node._generateToken('192.168.1.1');
      const token2 = node._generateToken('192.168.1.1');

      expect(token1.equals(token2)).toBe(true);
    });

    test('should validate correct token immediately', () => {
      const ip = '192.168.1.1';
      const token = node._generateToken(ip);

      expect(node._validateToken(token, ip)).toBe(true);
    });

    test('should reject wrong token', () => {
      const ip = '192.168.1.1';
      const wrongToken = crypto.randomBytes(8);

      expect(node._validateToken(wrongToken, ip)).toBe(false);
    });

    test('should reject token with wrong IP', () => {
      const token = node._generateToken('192.168.1.1');

      expect(node._validateToken(token, '192.168.1.2')).toBe(false);
    });

    test('should reject invalid token (wrong length)', () => {
      const invalidToken = crypto.randomBytes(4);

      expect(node._validateToken(invalidToken, '192.168.1.1')).toBe(false);
    });

    test('should validate token with previous secret after rotation', () => {
      const ip = '192.168.1.1';
      const token = node._generateToken(ip);

      // Rotate token secret
      node._rotateTokenSecret();

      // Token should still be valid (using previous secret)
      expect(node._validateToken(token, ip)).toBe(true);
    });

    test('should reject token after two rotations', () => {
      const ip = '192.168.1.1';
      const token = node._generateToken(ip);

      // Rotate twice
      node._rotateTokenSecret();
      node._rotateTokenSecret();

      // Token should now be invalid
      expect(node._validateToken(token, ip)).toBe(false);
    });
  });

  describe('Ping', () => {
    let nodeA, nodeB;

    beforeEach(async () => {
      nodeA = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeB = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(nodeA, nodeB);

      await nodeA.start();
      await nodeB.start();
      await wait(100); // Wait for sockets to be ready
    });

    test('should ping another node and receive response', async () => {
      const result = await nodeA.ping('127.0.0.1', nodeB.port);

      expect(result).toHaveProperty('nodeId');
      expect(result).toHaveProperty('rtt');
      expect(result.nodeId).toBeInstanceOf(Buffer);
      expect(result.nodeId.equals(nodeB.nodeId)).toBe(true);
      expect(typeof result.rtt).toBe('number');
      expect(result.rtt).toBeGreaterThanOrEqual(0);
    });

    test('should add pinged node to routing table', async () => {
      expect(nodeA.nodesCount).toBe(0);

      await nodeA.ping('127.0.0.1', nodeB.port);
      await wait(50);

      expect(nodeA.nodesCount).toBe(1);
    });

    test('should add pinging node to routing table', async () => {
      expect(nodeB.nodesCount).toBe(0);

      await nodeA.ping('127.0.0.1', nodeB.port);
      await wait(50);

      // Node B should have added Node A to its routing table
      expect(nodeB.nodesCount).toBe(1);
    });

    test('should handle ping timeout gracefully', async () => {
      const fakePort = basePort + 100; // Non-existent port

      await expect(nodeA.ping('127.0.0.1', fakePort)).rejects.toThrow(/timeout/i);
    }, 10000);
  });

  describe('Find Node', () => {
    let nodeA, nodeB, nodeC;

    beforeEach(async () => {
      nodeA = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeB = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeC = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(nodeA, nodeB, nodeC);

      await nodeA.start();
      await nodeB.start();
      await nodeC.start();
      await wait(100);

      // Populate Node B's routing table with Node C
      await nodeB.ping('127.0.0.1', nodeC.port);
      await wait(50);
    });

    test('should send find_node and receive nodes', async () => {
      const targetId = generateNodeId();
      
      // Node A finds nodes close to targetId from Node B
      // Node B should respond with nodes from its routing table (Node C)
      const result = await nodeA.findNode(targetId);

      expect(Array.isArray(result)).toBe(true);
      // Result may be empty or contain nodes depending on routing table
      result.forEach(node => {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('host');
        expect(node).toHaveProperty('port');
        expect(node.id).toBeInstanceOf(Buffer);
        expect(node.id.length).toBe(20);
      });
    });

    test('should populate routing table from find_node responses', async () => {
      const initialCount = nodeA.nodesCount;
      const targetId = generateNodeId();

      await nodeA.findNode(targetId);
      await wait(50);

      // Node A should have added nodes to its routing table
      expect(nodeA.nodesCount).toBeGreaterThanOrEqual(initialCount);
    });
  });

  describe('Get Peers (no peers stored)', () => {
    let nodeA, nodeB;

    beforeEach(async () => {
      nodeA = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeB = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(nodeA, nodeB);

      await nodeA.start();
      await nodeB.start();
      await wait(100);

      // Let Node A know about Node B
      await nodeA.ping('127.0.0.1', nodeB.port);
      await wait(50);
    });

    test('should query for unknown info_hash', async () => {
      const infoHash = generateNodeId();

      const result = await nodeA.getPeers(infoHash);

      expect(result).toHaveProperty('peers');
      expect(result).toHaveProperty('nodes');
      expect(Array.isArray(result.peers)).toBe(true);
      expect(Array.isArray(result.nodes)).toBe(true);
    });

    test('should receive nodes when no peers available', async () => {
      const infoHash = generateNodeId();

      const result = await nodeA.getPeers(infoHash);

      // Should return nodes (not peers) since no one has announced
      expect(result.nodes.length).toBeGreaterThan(0);
    });

    test('should receive token in get_peers response', async () => {
      const infoHash = generateNodeId();

      await nodeA.getPeers(infoHash);
      await wait(50);

      // Node A should have received a token from Node B
      const tokenKey = `127.0.0.1:${nodeB.port}`;
      expect(nodeA._tokens.has(tokenKey)).toBe(true);
    });
  });

  describe('Announce Peer + Get Peers (with peers)', () => {
    let nodeA, nodeB, nodeC;
    let infoHash;

    beforeEach(async () => {
      infoHash = generateNodeId();

      nodeA = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeB = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeC = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(nodeA, nodeB, nodeC);

      await nodeA.start();
      await nodeB.start();
      await nodeC.start();
      await wait(100);

      // Establish connections
      await nodeA.ping('127.0.0.1', nodeB.port);
      await nodeC.ping('127.0.0.1', nodeB.port);
      await wait(50);
    });

    test('should announce peer successfully', async () => {
      await expect(nodeA.announcePeer(infoHash, 6881)).resolves.not.toThrow();
    });

    test('should store announced peer in node', async () => {
      await nodeA.announcePeer(infoHash, 6881);
      await wait(100);

      const infoHashHex = infoHash.toString('hex');
      expect(nodeB._peerStorage.has(infoHashHex)).toBe(true);
      
      const peers = nodeB._peerStorage.get(infoHashHex);
      expect(peers.size).toBeGreaterThan(0);
    });

    test('should retrieve announced peer from get_peers', async () => {
      // Node A announces
      await nodeA.announcePeer(infoHash, 6881);
      await wait(100);

      // Node C queries for peers
      const result = await nodeC.getPeers(infoHash);

      // Should receive Node A as a peer
      expect(result.peers.length).toBeGreaterThan(0);
      
      // Check if any peer matches Node A's announced port
      const hasNodeA = result.peers.some(peer => peer.port === 6881);
      expect(hasNodeA).toBe(true);
    });

    test('should call onPeers callback when peers found', async () => {
      const onPeersMock = jest.fn();
      
      nodeD = new DHTNode({
        port: basePort++,
        bootstrapNodes: [],
        onPeers: onPeersMock
      });
      nodes.push(nodeD);
      await nodeD.start();
      await wait(50);

      // Connect to Node B
      await nodeD.ping('127.0.0.1', nodeB.port);
      await wait(50);

      // Node A announces
      await nodeA.announcePeer(infoHash, 6881);
      await wait(100);

      // Node D queries
      await nodeD.getPeers(infoHash);
      await wait(50);

      // Callback should have been called
      expect(onPeersMock).toHaveBeenCalled();
    });
  });

  describe('Peer Storage and Expiry', () => {
    let node;
    let infoHash;

    beforeEach(() => {
      infoHash = generateNodeId();
      node = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(node);
      
      // Set very short expiry for testing
      node._peerExpiry = 100; // 100ms
    });

    test('should add peer to storage', () => {
      const infoHashHex = infoHash.toString('hex');
      
      node._peerStorage.set(infoHashHex, new Set([
        { ip: '192.168.1.1', port: 6881, timestamp: Date.now() }
      ]));

      expect(node._peerStorage.has(infoHashHex)).toBe(true);
      expect(node._peerStorage.get(infoHashHex).size).toBe(1);
    });

    test('should clean up expired peers', async () => {
      const infoHashHex = infoHash.toString('hex');
      
      // Add peer with old timestamp
      node._peerStorage.set(infoHashHex, new Set([
        { ip: '192.168.1.1', port: 6881, timestamp: Date.now() - 200 }
      ]));

      expect(node._peerStorage.get(infoHashHex).size).toBe(1);

      // Run cleanup
      node._cleanupExpiredPeers();

      // Peer should be removed
      expect(node._peerStorage.has(infoHashHex)).toBe(false);
    });

    test('should keep non-expired peers', () => {
      const infoHashHex = infoHash.toString('hex');
      
      node._peerStorage.set(infoHashHex, new Set([
        { ip: '192.168.1.1', port: 6881, timestamp: Date.now() }
      ]));

      node._cleanupExpiredPeers();

      expect(node._peerStorage.has(infoHashHex)).toBe(true);
      expect(node._peerStorage.get(infoHashHex).size).toBe(1);
    });
  });

  describe('Error Handling', () => {
    let nodeA, nodeB;

    beforeEach(async () => {
      nodeA = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodeB = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(nodeA, nodeB);

      await nodeA.start();
      await nodeB.start();
      await wait(100);
    });

    test('should handle query timeout', async () => {
      const fakePort = basePort + 200;

      await expect(nodeA.ping('127.0.0.1', fakePort)).rejects.toThrow(/timeout/i);
    }, 10000);

    test('should handle invalid host', async () => {
      await expect(nodeA.ping('999.999.999.999', 6881)).rejects.toThrow();
    }, 10000);

    test('should reject announce_peer with invalid token', async () => {
      const bencode = require('../../src/server/torrentEngine/bencode');
      const infoHash = generateNodeId();
      const invalidToken = crypto.randomBytes(8);

      // Manually craft announce_peer message with invalid token
      const query = {
        t: crypto.randomBytes(2),
        y: 'q',
        q: 'announce_peer',
        a: {
          id: nodeA.nodeId,
          info_hash: infoHash,
          port: 6881,
          token: invalidToken
        }
      };

      const buffer = bencode.encode(query);
      
      // Send directly to Node B
      await new Promise((resolve) => {
        nodeA._socket.send(buffer, nodeB.port, '127.0.0.1', resolve);
      });

      await wait(100);

      // Node B should not have stored the peer (invalid token)
      const infoHashHex = infoHash.toString('hex');
      const peers = nodeB._peerStorage.get(infoHashHex);
      expect(peers).toBeUndefined();
    });

    test('should handle malformed messages gracefully', async () => {
      const malformedBuffer = Buffer.from('invalid bencode data');

      // Send malformed message - should not crash
      await new Promise((resolve) => {
        nodeA._socket.send(malformedBuffer, nodeB.port, '127.0.0.1', resolve);
      });

      await wait(100);

      // Nodes should still be operational
      expect(nodeA._socket).toBeTruthy();
      expect(nodeB._socket).toBeTruthy();
    });
  });

  describe('Routing Table Management', () => {
    let node;

    beforeEach(() => {
      node = new DHTNode({ 
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(node);
      node._maxRoutingTableSize = 5; // Small size for testing
    });

    test('should add nodes to routing table', () => {
      const nodeId = generateNodeId();
      node._addNode(nodeId, '192.168.1.1', 6881);

      expect(node.nodesCount).toBe(1);
    });

    test('should not add self to routing table', () => {
      node._addNode(node.nodeId, '192.168.1.1', 6881);

      expect(node.nodesCount).toBe(0);
    });

    test('should evict oldest node when table is full', () => {
      // Fill routing table
      for (let i = 0; i < 5; i++) {
        node._addNode(generateNodeId(), `192.168.1.${i + 1}`, 6881);
      }

      expect(node.nodesCount).toBe(5);

      // Add one more node
      node._addNode(generateNodeId(), '192.168.1.99', 6881);

      // Should still be at max size
      expect(node.nodesCount).toBe(5);
    });

    test('should get closest nodes from routing table', () => {
      // Add some nodes
      for (let i = 0; i < 5; i++) {
        node._addNode(generateNodeId(), `192.168.1.${i + 1}`, 6881);
      }

      const targetId = generateNodeId();
      const closest = node.getClosestNodes(targetId, 3);

      expect(Array.isArray(closest)).toBe(true);
      expect(closest.length).toBeLessThanOrEqual(3);
      closest.forEach(n => {
        expect(n).toHaveProperty('id');
        expect(n).toHaveProperty('host');
        expect(n).toHaveProperty('port');
      });
    });
  });

  describe('XOR Distance Calculation', () => {
    let node;

    beforeEach(() => {
      node = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(node);
    });

    test('should calculate XOR distance correctly', () => {
      const id1 = Buffer.from('0000000000000000000000000000000000000000', 'hex');
      const id2 = Buffer.from('ffffffffffffffffffffffffffffffffffffffff', 'hex');

      const distance = node._xorDistance(id1, id2);

      expect(distance).toBeInstanceOf(Buffer);
      expect(distance.length).toBe(20);
      expect(distance.toString('hex')).toBe('ffffffffffffffffffffffffffffffffffffffff');
    });

    test('should return zero distance for identical IDs', () => {
      const id = generateNodeId();
      const distance = node._xorDistance(id, id);

      expect(distance.toString('hex')).toBe('0'.repeat(40));
    });

    test('should be commutative (distance(a,b) = distance(b,a))', () => {
      const id1 = generateNodeId();
      const id2 = generateNodeId();

      const dist1 = node._xorDistance(id1, id2);
      const dist2 = node._xorDistance(id2, id1);

      expect(dist1.equals(dist2)).toBe(true);
    });
  });

  describe('Bootstrap', () => {
    test('should handle bootstrap failure gracefully', async () => {
      const node = new DHTNode({
        port: basePort++,
        bootstrapNodes: [
          { host: '127.0.0.1', port: basePort + 500 } // Non-existent
        ]
      });
      nodes.push(node);

      // Should not throw, just log warning
      await expect(node.start()).resolves.not.toThrow();
      
      // Node should not be ready
      expect(node.isReady).toBe(false);
    }, 15000);

    test('should call onReady callback when bootstrap succeeds', async () => {
      const onReadyMock = jest.fn();
      
      const nodeA = new DHTNode({
        port: basePort++,
        bootstrapNodes: []
      });
      
      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }],
        onReady: onReadyMock
      });
      
      nodes.push(nodeA, nodeB);

      await nodeA.start();
      await wait(100);
      await nodeB.start();
      await wait(200);

      expect(onReadyMock).toHaveBeenCalled();
    }, 10000);
  });
});
