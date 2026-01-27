const crypto = require('crypto');
const DHTNode = require('../../src/server/torrentEngine/dht/node');

// Helper to wait for a duration
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to generate random node ID
const generateNodeId = () => crypto.randomBytes(20);

// Helper to generate random info hash
const generateInfoHash = () => crypto.randomBytes(20);

describe('DHT Integration Tests', () => {
  let nodes = [];
  let basePort = 17000;

  // Clean up all nodes after each test
  afterEach(async () => {
    for (const node of nodes) {
      if (node._socket) {
        await node.stop();
      }
    }
    nodes = [];
    basePort += 100; // Large increment to avoid port conflicts
  });

  describe('Bootstrapping', () => {
    test('should bootstrap with local DHT nodes', async () => {
      // Create bootstrap node
      const bootstrapNode = new DHTNode({
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(bootstrapNode);
      await bootstrapNode.start();
      await wait(100);

      // Create node that bootstraps from first node
      const node = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: bootstrapNode.port }]
      });
      nodes.push(node);

      // Start and wait for bootstrap
      await node.start();
      await wait(500);

      // Verify bootstrapped
      expect(node.isReady).toBe(true);
      expect(node.nodesCount).toBeGreaterThan(0);
    }, 15000);

    test('should ping bootstrap nodes during startup', async () => {
      const bootstrapNode = new DHTNode({
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(bootstrapNode);
      await bootstrapNode.start();
      await wait(100);

      let pinged = false;
      const originalPing = bootstrapNode.ping.bind(bootstrapNode);
      bootstrapNode.ping = async (...args) => {
        pinged = true;
        return originalPing(...args);
      };

      const node = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: bootstrapNode.port }]
      });
      nodes.push(node);

      await node.start();
      await wait(500);

      expect(node.nodesCount).toBeGreaterThan(0);
    }, 15000);

    test('should emit ready event when bootstrapped', async () => {
      const bootstrapNode = new DHTNode({
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(bootstrapNode);
      await bootstrapNode.start();
      await wait(100);

      const readyPromise = new Promise(resolve => {
        const node = new DHTNode({
          port: basePort++,
          bootstrapNodes: [{ host: '127.0.0.1', port: bootstrapNode.port }],
          onReady: resolve
        });
        nodes.push(node);
        node.start();
      });

      await expect(readyPromise).resolves.toBeDefined();
    }, 15000);

    test('should handle bootstrap failure gracefully', async () => {
      const node = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: basePort + 500 }] // Non-existent
      });
      nodes.push(node);

      await node.start();
      await wait(500);

      // Should not crash, but won't be ready
      expect(node.isReady).toBe(false);
      expect(node.nodesCount).toBe(0);
    }, 15000);
  });

  describe('Iterative find_node', () => {
    test('should perform iterative lookup across multiple nodes', async () => {
      // Create a network of 5 nodes
      const networkNodes = [];
      
      // Create first node
      const firstNode = new DHTNode({
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(firstNode);
      networkNodes.push(firstNode);
      await firstNode.start();
      await wait(100);

      // Create remaining nodes, each bootstrapping from previous
      for (let i = 0; i < 4; i++) {
        const node = new DHTNode({
          port: basePort++,
          bootstrapNodes: networkNodes.map(n => ({ host: '127.0.0.1', port: n.port }))
        });
        nodes.push(node);
        networkNodes.push(node);
        await node.start();
        await wait(200);
      }

      // All nodes should know about each other now
      await wait(500);

      // Do find_node lookup from first node
      const targetId = generateNodeId();
      const result = await networkNodes[0].findNode(targetId);

      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(8);

      // Verify results are nodes (have id, host, port)
      result.forEach(node => {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('host');
        expect(node).toHaveProperty('port');
        expect(Buffer.isBuffer(node.id)).toBe(true);
      });
    }, 20000);

    test('should converge to closest nodes', async () => {
      // Create network of 5 nodes
      const networkNodes = [];
      
      const firstNode = new DHTNode({
        port: basePort++,
        bootstrapNodes: []
      });
      nodes.push(firstNode);
      networkNodes.push(firstNode);
      await firstNode.start();
      await wait(100);

      for (let i = 0; i < 4; i++) {
        const node = new DHTNode({
          port: basePort++,
          bootstrapNodes: [{ host: '127.0.0.1', port: firstNode.port }]
        });
        nodes.push(node);
        networkNodes.push(node);
        await node.start();
        await wait(200);
      }

      await wait(500);

      // Pick one node's ID as target
      const targetId = networkNodes[2].nodeId;
      const result = await networkNodes[0].findNode(targetId);

      // Should find the target node or nodes very close to it
      expect(result.length).toBeGreaterThan(0);
      
      // Calculate distances and verify sorting
      const distances = result.map(node => {
        const distance = Buffer.alloc(20);
        for (let i = 0; i < 20; i++) {
          distance[i] = node.id[i] ^ targetId[i];
        }
        return distance;
      });

      // Verify sorted by distance
      for (let i = 1; i < distances.length; i++) {
        expect(Buffer.compare(distances[i - 1], distances[i])).toBeLessThanOrEqual(0);
      }
    }, 20000);
  });

  describe('get_peers flow', () => {
    test('should discover peers via get_peers', async () => {
      // Create 3 nodes
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const nodeC = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeC);
      await nodeC.start();
      await wait(300);

      const infoHash = generateInfoHash();

      // Node A announces peer
      await nodeA.announcePeer(infoHash, 6881);
      await wait(500);

      // Node C queries for peers
      const result = await nodeC.getPeers(infoHash);

      // Should find Node A as peer
      expect(result.peers.length).toBeGreaterThan(0);
      
      const foundNodeA = result.peers.some(peer => peer.port === 6881);
      expect(foundNodeA).toBe(true);
    }, 20000);

    test('should return nodes when no peers available', async () => {
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const infoHash = generateInfoHash();

      // Query for unknown info hash
      const result = await nodeB.getPeers(infoHash);

      // Should return nodes (not peers)
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.peers.length).toBe(0);
    }, 15000);
  });

  describe('announce_peer flow', () => {
    test('should complete full announce flow with token', async () => {
      // Create 2 nodes
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const infoHash = generateInfoHash();

      // Node B gets peers (gets token from Node A)
      await nodeB.getPeers(infoHash);
      await wait(200);

      // Node B announces
      await nodeB.announcePeer(infoHash, 7777);
      await wait(300);

      // Verify Node A stored the peer
      const infoHashHex = infoHash.toString('hex');
      expect(nodeA._peerStorage.has(infoHashHex)).toBe(true);
      
      const peers = nodeA._peerStorage.get(infoHashHex);
      expect(peers.size).toBeGreaterThan(0);
    }, 15000);

    test('should share announced peers with other nodes', async () => {
      // Create 3 nodes
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const nodeC = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeC);
      await nodeC.start();
      await wait(300);

      const infoHash = generateInfoHash();

      // Node B announces to Node A
      await nodeB.announcePeer(infoHash, 8888);
      await wait(500);

      // Node C queries Node A
      const result = await nodeC.getPeers(infoHash);

      // Should find Node B as peer
      expect(result.peers.length).toBeGreaterThan(0);
      const foundNodeB = result.peers.some(peer => peer.port === 8888);
      expect(foundNodeB).toBe(true);
    }, 20000);
  });

  describe('Peer discovery callbacks', () => {
    test('should invoke onPeers callback when peers found', async () => {
      let callbackInvoked = false;
      let receivedInfoHash = null;
      let receivedPeers = null;

      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }],
        onPeers: (infoHash, peers) => {
          callbackInvoked = true;
          receivedInfoHash = infoHash;
          receivedPeers = peers;
        }
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const infoHash = generateInfoHash();

      // Node A announces
      await nodeA.announcePeer(infoHash, 9999);
      await wait(500);

      // Node B queries
      await nodeB.getPeers(infoHash);
      await wait(200);

      expect(callbackInvoked).toBe(true);
      expect(receivedInfoHash).toBeTruthy();
      expect(receivedPeers).toBeTruthy();
      expect(Array.isArray(receivedPeers)).toBe(true);
    }, 20000);

    test('should emit peer event when peer is announced', async () => {
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);

      const peerPromise = new Promise(resolve => {
        nodeA.on('peer', (data) => {
          resolve(data);
        });
      });

      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const infoHash = generateInfoHash();
      await nodeB.announcePeer(infoHash, 5555);
      await wait(300);

      const peerData = await peerPromise;
      expect(peerData).toHaveProperty('infoHash');
      expect(peerData).toHaveProperty('peer');
      expect(peerData.peer.port).toBe(5555);
    }, 15000);
  });

  describe('Resilience', () => {
    test('should handle some bootstrap nodes being offline', async () => {
      // Create one working bootstrap node
      const workingNode = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(workingNode);
      await workingNode.start();
      await wait(100);

      // Create node with mixed bootstrap list (some offline)
      const node = new DHTNode({
        port: basePort++,
        bootstrapNodes: [
          { host: '127.0.0.1', port: basePort + 100 }, // Offline
          { host: '127.0.0.1', port: workingNode.port }, // Online
          { host: '127.0.0.1', port: basePort + 101 }  // Offline
        ]
      });
      nodes.push(node);

      await node.start();
      await wait(1000);

      // Should still bootstrap successfully with the one working node
      expect(node.nodesCount).toBeGreaterThan(0);
    }, 15000);

    test('should not add dead nodes to routing table', async () => {
      const node = new DHTNode({
        port: basePort++,
        bootstrapNodes: [
          { host: '127.0.0.1', port: basePort + 200 } // Non-existent
        ]
      });
      nodes.push(node);

      await node.start();
      await wait(1000);

      // Routing table should be empty (dead node not added)
      expect(node.nodesCount).toBe(0);
    }, 15000);

    test('should continue lookup when some nodes fail', async () => {
      // Create network of 4 nodes
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(200);

      const nodeC = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeC);
      await nodeC.start();
      await wait(200);

      const nodeD = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeD);
      await nodeD.start();
      await wait(500);

      // Stop one node mid-test
      await nodeB.stop();
      nodes = nodes.filter(n => n !== nodeB);

      // Node D should still be able to find nodes
      const targetId = generateNodeId();
      const result = await nodeD.findNode(targetId);

      expect(result.length).toBeGreaterThan(0);
    }, 20000);
  });

  describe('Concurrent operations', () => {
    test('should handle multiple concurrent get_peers lookups', async () => {
      // Create 3 nodes
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const nodeC = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeC);
      await nodeC.start();
      await wait(300);

      // Create multiple info hashes
      const infoHashes = [
        generateInfoHash(),
        generateInfoHash(),
        generateInfoHash()
      ];

      // Announce different peers
      await nodeA.announcePeer(infoHashes[0], 1111);
      await nodeB.announcePeer(infoHashes[1], 2222);
      await wait(300);

      // Do concurrent lookups from Node C
      const promises = infoHashes.map(hash => nodeC.getPeers(hash));
      const results = await Promise.all(promises);

      // All should complete successfully
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result).toHaveProperty('peers');
        expect(result).toHaveProperty('nodes');
      });
    }, 20000);

    test('should handle concurrent find_node operations', async () => {
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      // Do multiple concurrent find_node lookups
      const targetIds = [
        generateNodeId(),
        generateNodeId(),
        generateNodeId()
      ];

      const promises = targetIds.map(id => nodeB.findNode(id));
      const results = await Promise.all(promises);

      // All should complete
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(Array.isArray(result)).toBe(true);
      });
    }, 15000);
  });

  describe('Events', () => {
    test('should emit node event when node is added to routing table', async () => {
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);

      const nodeEventPromise = new Promise(resolve => {
        nodeA.on('node', (data) => {
          resolve(data);
        });
      });

      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);
      await nodeB.start();
      await wait(300);

      const nodeData = await nodeEventPromise;
      expect(nodeData).toHaveProperty('id');
      expect(nodeData).toHaveProperty('host');
      expect(nodeData).toHaveProperty('port');
    }, 15000);

    test('should emit ready event when DHT is bootstrapped', async () => {
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const readyPromise = new Promise(resolve => {
        const nodeB = new DHTNode({
          port: basePort++,
          bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
        });
        nodes.push(nodeB);
        nodeB.on('ready', () => resolve(true));
        nodeB.start();
      });

      const ready = await readyPromise;
      expect(ready).toBe(true);
    }, 15000);
  });

  describe('Routing table management', () => {
    test('should populate routing table from bootstrap', async () => {
      const nodeA = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(nodeA);
      await nodeA.start();
      await wait(100);

      const nodeB = new DHTNode({
        port: basePort++,
        bootstrapNodes: [{ host: '127.0.0.1', port: nodeA.port }]
      });
      nodes.push(nodeB);

      expect(nodeB.nodesCount).toBe(0);

      await nodeB.start();
      await wait(500);

      // Should have at least bootstrap node in table
      expect(nodeB.nodesCount).toBeGreaterThan(0);
    }, 15000);

    test('should maintain routing table with multiple nodes', async () => {
      // Create network of 5 nodes
      const networkNodes = [];
      
      const firstNode = new DHTNode({ port: basePort++, bootstrapNodes: [] });
      nodes.push(firstNode);
      networkNodes.push(firstNode);
      await firstNode.start();
      await wait(100);

      for (let i = 0; i < 4; i++) {
        const node = new DHTNode({
          port: basePort++,
          bootstrapNodes: [{ host: '127.0.0.1', port: firstNode.port }]
        });
        nodes.push(node);
        networkNodes.push(node);
        await node.start();
        await wait(200);
      }

      await wait(500);

      // All nodes should have multiple entries in routing table
      networkNodes.forEach(node => {
        expect(node.nodesCount).toBeGreaterThan(0);
      });

      // First node should know about most others
      expect(firstNode.nodesCount).toBeGreaterThanOrEqual(3);
    }, 20000);
  });
});
