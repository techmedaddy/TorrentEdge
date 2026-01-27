const crypto = require('crypto');
const RoutingTable = require('../../src/server/torrentEngine/dht/routingTable');

// Helper to generate random node ID
const generateNodeId = () => crypto.randomBytes(20);

// Helper to create node with specific ID
const createNode = (id, host = '192.168.1.1', port = 6881) => ({
  id,
  host,
  port
});

// Helper to create ID with specific byte pattern
const createIdWithBytes = (...bytes) => {
  const id = Buffer.alloc(20);
  bytes.forEach((byte, index) => {
    if (index < 20) id[index] = byte;
  });
  return id;
};

describe('RoutingTable', () => {
  let ourNodeId;
  let table;

  beforeEach(() => {
    ourNodeId = generateNodeId();
    table = new RoutingTable({ nodeId: ourNodeId, k: 8 });
  });

  describe('Construction', () => {
    test('should create routing table with node ID', () => {
      expect(table.nodeId).toEqual(ourNodeId);
      expect(table.k).toBe(8);
      expect(table.size).toBe(0);
      expect(table.buckets).toHaveLength(160);
    });

    test('should throw error if nodeId not provided', () => {
      expect(() => new RoutingTable({})).toThrow(/nodeId is required/);
    });

    test('should throw error if nodeId is not a Buffer', () => {
      expect(() => new RoutingTable({ nodeId: 'not-a-buffer' })).toThrow(/must be a 20-byte Buffer/);
    });

    test('should throw error if nodeId is wrong length', () => {
      expect(() => new RoutingTable({ nodeId: Buffer.alloc(19) })).toThrow(/must be a 20-byte Buffer/);
    });

    test('should use custom k value', () => {
      const customTable = new RoutingTable({ nodeId: generateNodeId(), k: 16 });
      expect(customTable.k).toBe(16);
    });
  });

  describe('Distance Calculation (static)', () => {
    test('should return all zeros for distance(A, A)', () => {
      const id = generateNodeId();
      const distance = RoutingTable.distance(id, id);

      expect(distance).toBeInstanceOf(Buffer);
      expect(distance.length).toBe(20);
      expect(distance.toString('hex')).toBe('0'.repeat(40));
    });

    test('should be commutative: distance(A, B) = distance(B, A)', () => {
      const id1 = generateNodeId();
      const id2 = generateNodeId();

      const dist1 = RoutingTable.distance(id1, id2);
      const dist2 = RoutingTable.distance(id2, id1);

      expect(dist1.equals(dist2)).toBe(true);
    });

    test('should return 20-byte Buffer', () => {
      const id1 = generateNodeId();
      const id2 = generateNodeId();

      const distance = RoutingTable.distance(id1, id2);

      expect(distance).toBeInstanceOf(Buffer);
      expect(distance.length).toBe(20);
    });

    test('should calculate known example correctly: 0x01 XOR 0x02 = 0x03', () => {
      const id1 = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
      const id2 = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2);
      const expected = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3);

      const distance = RoutingTable.distance(id1, id2);

      expect(distance.equals(expected)).toBe(true);
    });

    test('should calculate XOR correctly for all bits', () => {
      const id1 = Buffer.alloc(20, 0xFF); // All 1s
      const id2 = Buffer.alloc(20, 0x00); // All 0s
      const expected = Buffer.alloc(20, 0xFF); // All 1s

      const distance = RoutingTable.distance(id1, id2);

      expect(distance.equals(expected)).toBe(true);
    });

    test('should throw error for invalid id1', () => {
      const validId = generateNodeId();
      expect(() => RoutingTable.distance('invalid', validId)).toThrow(/must be a 20-byte Buffer/);
    });

    test('should throw error for invalid id2', () => {
      const validId = generateNodeId();
      expect(() => RoutingTable.distance(validId, Buffer.alloc(10))).toThrow(/must be a 20-byte Buffer/);
    });
  });

  describe('Bucket Index Calculation', () => {
    test('should not add node with same ID as us', () => {
      const result = table.addNode(createNode(ourNodeId));
      expect(result).toBe(false);
      expect(table.size).toBe(0);
    });

    test('should calculate bucket 159 for node differing in first bit', () => {
      // Create ID that differs in the first bit
      const nodeId = Buffer.from(ourNodeId);
      nodeId[0] ^= 0x80; // Flip first bit

      const bucketIndex = table.getBucket(nodeId);
      expect(bucketIndex).toBe(159);
    });

    test('should calculate bucket 0 for node differing only in last bit', () => {
      // Create ID that differs only in the last bit
      const nodeId = Buffer.from(ourNodeId);
      nodeId[19] ^= 0x01; // Flip last bit

      const bucketIndex = table.getBucket(nodeId);
      expect(bucketIndex).toBe(0);
    });

    test('should map various distances to correct buckets', () => {
      // Node differing in bit 158 (second bit)
      const nodeId1 = Buffer.from(ourNodeId);
      nodeId1[0] ^= 0x40;
      expect(table.getBucket(nodeId1)).toBe(158);

      // Node differing in bit 152 (8th bit)
      const nodeId2 = Buffer.from(ourNodeId);
      nodeId2[0] ^= 0x01;
      expect(table.getBucket(nodeId2)).toBe(152);

      // Node differing in bit 151 (9th bit, second byte)
      const nodeId3 = Buffer.from(ourNodeId);
      nodeId3[1] ^= 0x80;
      expect(table.getBucket(nodeId3)).toBe(151);
    });

    test('should handle node with multiple bit differences (uses most significant)', () => {
      const nodeId = Buffer.from(ourNodeId);
      nodeId[0] ^= 0xFF; // All bits different in first byte

      const bucketIndex = table.getBucket(nodeId);
      expect(bucketIndex).toBe(159); // Most significant bit wins
    });
  });

  describe('Add Node', () => {
    test('should add node to empty table', () => {
      const nodeId = generateNodeId();
      const node = createNode(nodeId, '192.168.1.1', 6881);

      const result = table.addNode(node);

      expect(result).toBe(true);
      expect(table.size).toBe(1);
    });

    test('should add same node twice - size stays 1, node moved to end', () => {
      const nodeId = generateNodeId();
      const node = createNode(nodeId, '192.168.1.1', 6881);

      table.addNode(node);
      const result = table.addNode(node);

      expect(result).toBe(true);
      expect(table.size).toBe(1);

      // Node should be retrievable
      const retrieved = table.getNode(nodeId);
      expect(retrieved).toBeTruthy();
      expect(retrieved.id.equals(nodeId)).toBe(true);
    });

    test('should update node info when adding same node again', () => {
      const nodeId = generateNodeId();
      const node1 = createNode(nodeId, '192.168.1.1', 6881);
      const node2 = createNode(nodeId, '192.168.1.2', 7777);

      table.addNode(node1);
      table.addNode(node2);

      const retrieved = table.getNode(nodeId);
      expect(retrieved.host).toBe('192.168.1.2');
      expect(retrieved.port).toBe(7777);
    });

    test('should add k nodes to same bucket', () => {
      const k = table.k;
      const baseId = Buffer.from(ourNodeId);
      baseId[19] ^= 0x01; // All nodes will be in bucket 0

      for (let i = 0; i < k; i++) {
        const nodeId = Buffer.from(baseId);
        nodeId[18] = i; // Make each ID unique
        const result = table.addNode(createNode(nodeId));
        expect(result).toBe(true);
      }

      expect(table.size).toBe(k);
    });

    test('should return false when adding k+1 nodes to same bucket (bucket full)', () => {
      const k = table.k;
      const baseId = Buffer.from(ourNodeId);
      baseId[19] ^= 0x01; // All nodes will be in bucket 0

      // Add k nodes
      for (let i = 0; i < k; i++) {
        const nodeId = Buffer.from(baseId);
        nodeId[18] = i;
        table.addNode(createNode(nodeId));
      }

      // Try to add k+1 node
      const extraNodeId = Buffer.from(baseId);
      extraNodeId[18] = k;
      const result = table.addNode(createNode(extraNodeId));

      expect(result).toBe(false);
      expect(table.size).toBe(k);
    });

    test('should add nodes to different buckets', () => {
      const node1Id = Buffer.from(ourNodeId);
      node1Id[0] ^= 0x80; // Bucket 159

      const node2Id = Buffer.from(ourNodeId);
      node2Id[19] ^= 0x01; // Bucket 0

      const node3Id = Buffer.from(ourNodeId);
      node3Id[10] ^= 0x40; // Different bucket

      table.addNode(createNode(node1Id));
      table.addNode(createNode(node2Id));
      table.addNode(createNode(node3Id));

      expect(table.size).toBe(3);
    });

    test('should throw error for invalid node', () => {
      expect(() => table.addNode({ id: 'invalid' })).toThrow(/Invalid node/);
      expect(() => table.addNode({ id: generateNodeId() })).toThrow(/host and port required/);
    });
  });

  describe('Remove Node', () => {
    test('should remove existing node', () => {
      const nodeId = generateNodeId();
      table.addNode(createNode(nodeId));

      expect(table.size).toBe(1);

      const result = table.removeNode(nodeId);

      expect(result).toBe(true);
      expect(table.size).toBe(0);
    });

    test('should return false when removing non-existent node', () => {
      const nodeId = generateNodeId();

      const result = table.removeNode(nodeId);

      expect(result).toBe(false);
      expect(table.size).toBe(0);
    });

    test('should remove correct node from bucket with multiple nodes', () => {
      const node1Id = generateNodeId();
      const node2Id = generateNodeId();

      table.addNode(createNode(node1Id));
      table.addNode(createNode(node2Id));

      expect(table.size).toBe(2);

      table.removeNode(node1Id);

      expect(table.size).toBe(1);
      expect(table.getNode(node1Id)).toBeNull();
      expect(table.getNode(node2Id)).toBeTruthy();
    });

    test('should throw error for invalid nodeId', () => {
      expect(() => table.removeNode('invalid')).toThrow(/must be a 20-byte Buffer/);
    });
  });

  describe('Get Node', () => {
    test('should return null for non-existent node', () => {
      const nodeId = generateNodeId();
      const result = table.getNode(nodeId);

      expect(result).toBeNull();
    });

    test('should retrieve existing node', () => {
      const nodeId = generateNodeId();
      const node = createNode(nodeId, '10.0.0.1', 8888);

      table.addNode(node);

      const retrieved = table.getNode(nodeId);

      expect(retrieved).toBeTruthy();
      expect(retrieved.id.equals(nodeId)).toBe(true);
      expect(retrieved.host).toBe('10.0.0.1');
      expect(retrieved.port).toBe(8888);
    });

    test('should throw error for invalid nodeId', () => {
      expect(() => table.getNode(Buffer.alloc(10))).toThrow(/must be a 20-byte Buffer/);
    });
  });

  describe('Get Closest Nodes', () => {
    test('should return empty array for empty table', () => {
      const targetId = generateNodeId();
      const closest = table.getClosest(targetId, 8);

      expect(closest).toEqual([]);
    });

    test('should return all nodes when requesting more than available', () => {
      const node1 = createNode(generateNodeId());
      const node2 = createNode(generateNodeId());

      table.addNode(node1);
      table.addNode(node2);

      const closest = table.getClosest(generateNodeId(), 10);

      expect(closest).toHaveLength(2);
    });

    test('should return nodes sorted by distance to target', () => {
      // Add 5 nodes
      const nodeIds = Array.from({ length: 5 }, () => generateNodeId());
      nodeIds.forEach(id => table.addNode(createNode(id)));

      const targetId = generateNodeId();
      const closest = table.getClosest(targetId, 5);

      // Verify sorted by distance
      for (let i = 1; i < closest.length; i++) {
        const dist1 = RoutingTable.distance(closest[i - 1].id, targetId);
        const dist2 = RoutingTable.distance(closest[i].id, targetId);
        expect(Buffer.compare(dist1, dist2)).toBeLessThanOrEqual(0);
      }
    });

    test('should find globally closest nodes across multiple buckets', () => {
      // Add nodes in different buckets
      for (let i = 0; i < 10; i++) {
        const nodeId = generateNodeId();
        table.addNode(createNode(nodeId));
      }

      const targetId = generateNodeId();
      const closest = table.getClosest(targetId, 3);

      expect(closest).toHaveLength(3);

      // Calculate distances to verify
      const distances = closest.map(node =>
        RoutingTable.distance(node.id, targetId)
      );

      // Verify sorted
      for (let i = 1; i < distances.length; i++) {
        expect(Buffer.compare(distances[i - 1], distances[i])).toBeLessThanOrEqual(0);
      }
    });

    test('should return requested count of nodes', () => {
      for (let i = 0; i < 10; i++) {
        table.addNode(createNode(generateNodeId()));
      }

      const closest = table.getClosest(generateNodeId(), 5);

      expect(closest).toHaveLength(5);
    });

    test('should throw error for invalid targetId', () => {
      expect(() => table.getClosest('invalid', 5)).toThrow(/must be a 20-byte Buffer/);
    });
  });

  describe('Get Oldest in Bucket', () => {
    test('should return null for empty bucket', () => {
      const oldest = table.getOldestInBucket(0);

      expect(oldest).toBeNull();
    });

    test('should return oldest node in bucket (added first)', async () => {
      const baseId = Buffer.from(ourNodeId);
      baseId[19] ^= 0x01; // Bucket 0

      // Add first node
      const oldNodeId = Buffer.from(baseId);
      oldNodeId[18] = 1;
      table.addNode(createNode(oldNodeId));

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Add second node
      const newNodeId = Buffer.from(baseId);
      newNodeId[18] = 2;
      table.addNode(createNode(newNodeId));

      const bucketIndex = table.getBucket(oldNodeId);
      const oldest = table.getOldestInBucket(bucketIndex);

      expect(oldest).toBeTruthy();
      expect(oldest.id.equals(oldNodeId)).toBe(true);
    });

    test('should throw error for invalid bucket index', () => {
      expect(() => table.getOldestInBucket(-1)).toThrow(/must be between 0 and 159/);
      expect(() => table.getOldestInBucket(160)).toThrow(/must be between 0 and 159/);
    });
  });

  describe('Compare Distance (static)', () => {
    test('should return -1 when id1 is closer to target', () => {
      const target = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      const closer = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
      const farther = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10);

      const result = RoutingTable.compareDistance(closer, farther, target);

      expect(result).toBe(-1);
    });

    test('should return 1 when id2 is closer to target', () => {
      const target = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      const farther = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10);
      const closer = createIdWithBytes(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);

      const result = RoutingTable.compareDistance(farther, closer, target);

      expect(result).toBe(1);
    });

    test('should return 0 when both IDs are equidistant from target', () => {
      const target = generateNodeId();
      const id1 = generateNodeId();
      const id2 = Buffer.from(id1); // Same ID

      const result = RoutingTable.compareDistance(id1, id2, target);

      expect(result).toBe(0);
    });

    test('should throw error for invalid parameters', () => {
      const validId = generateNodeId();

      expect(() => RoutingTable.compareDistance('invalid', validId, validId))
        .toThrow(/must be a 20-byte Buffer/);
      expect(() => RoutingTable.compareDistance(validId, 'invalid', validId))
        .toThrow(/must be a 20-byte Buffer/);
      expect(() => RoutingTable.compareDistance(validId, validId, 'invalid'))
        .toThrow(/must be a 20-byte Buffer/);
    });
  });

  describe('Bucket Refresh Tracking', () => {
    test('should initialize buckets with current timestamp', () => {
      const now = Date.now();

      for (const bucket of table.buckets) {
        expect(bucket.lastRefresh).toBeGreaterThanOrEqual(now - 100);
        expect(bucket.lastRefresh).toBeLessThanOrEqual(now + 100);
      }
    });

    test('should update lastRefresh when calling refreshBucket', async () => {
      const bucketIndex = 50;
      const initialRefresh = table.buckets[bucketIndex].lastRefresh;

      await new Promise(resolve => setTimeout(resolve, 10));

      table.refreshBucket(bucketIndex);

      const newRefresh = table.buckets[bucketIndex].lastRefresh;

      expect(newRefresh).toBeGreaterThan(initialRefresh);
    });

    test('should return stale buckets from getBucketsNeedingRefresh', () => {
      // Set some buckets to old timestamp
      const oldTimestamp = Date.now() - 20 * 60 * 1000; // 20 minutes ago

      table.buckets[155].lastRefresh = oldTimestamp;
      table.buckets[156].lastRefresh = oldTimestamp;

      // Add nodes to make buckets relevant
      const node1Id = Buffer.from(ourNodeId);
      node1Id[0] ^= 0x08; // Near bucket 155-159
      table.addNode(createNode(node1Id));

      const staleBuckets = table.getBucketsNeedingRefresh(15 * 60 * 1000);

      // Should include the stale nearby buckets
      expect(staleBuckets.length).toBeGreaterThan(0);
    });

    test('should not return recently refreshed buckets', () => {
      const staleBuckets = table.getBucketsNeedingRefresh(15 * 60 * 1000);

      // All buckets were just created, so most shouldn't need refresh
      // (except maybe nearby buckets which are always checked)
      expect(staleBuckets.length).toBeLessThan(160);
    });

    test('should throw error for invalid bucket index in refreshBucket', () => {
      expect(() => table.refreshBucket(-1)).toThrow(/must be between 0 and 159/);
      expect(() => table.refreshBucket(160)).toThrow(/must be between 0 and 159/);
    });
  });

  describe('Get All Nodes', () => {
    test('should return empty array for empty table', () => {
      const nodes = table.getAllNodes();

      expect(nodes).toEqual([]);
    });

    test('should return all nodes from all buckets', () => {
      const nodeIds = Array.from({ length: 10 }, () => generateNodeId());
      nodeIds.forEach(id => table.addNode(createNode(id)));

      const allNodes = table.getAllNodes();

      expect(allNodes).toHaveLength(10);
      allNodes.forEach((node, index) => {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('host');
        expect(node).toHaveProperty('port');
        expect(Buffer.isBuffer(node.id)).toBe(true);
      });
    });
  });

  describe('Statistics', () => {
    test('should return correct statistics', () => {
      // Add various nodes
      for (let i = 0; i < 15; i++) {
        table.addNode(createNode(generateNodeId()));
      }

      const stats = table.getStats();

      expect(stats.totalNodes).toBe(15);
      expect(stats.bucketsWithNodes).toBeGreaterThan(0);
      expect(stats.averageNodesPerBucket).toBeGreaterThan(0);
      expect(stats.oldestNode).toBeTruthy();
      expect(stats.newestNode).toBeTruthy();
    });

    test('should return empty stats for empty table', () => {
      const stats = table.getStats();

      expect(stats.totalNodes).toBe(0);
      expect(stats.bucketsWithNodes).toBe(0);
      expect(stats.fullBuckets).toBe(0);
      expect(stats.oldestNode).toBeNull();
      expect(stats.newestNode).toBeNull();
    });

    test('should track full buckets', () => {
      const k = table.k;
      const baseId = Buffer.from(ourNodeId);
      baseId[19] ^= 0x01;

      // Fill one bucket
      for (let i = 0; i < k; i++) {
        const nodeId = Buffer.from(baseId);
        nodeId[18] = i;
        table.addNode(createNode(nodeId));
      }

      const stats = table.getStats();

      expect(stats.fullBuckets).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    test('should handle rapid additions and removals', () => {
      const nodeIds = Array.from({ length: 20 }, () => generateNodeId());

      // Add all
      nodeIds.forEach(id => table.addNode(createNode(id)));
      expect(table.size).toBe(20);

      // Remove half
      for (let i = 0; i < 10; i++) {
        table.removeNode(nodeIds[i]);
      }
      expect(table.size).toBe(10);

      // Add back
      for (let i = 0; i < 10; i++) {
        table.addNode(createNode(nodeIds[i]));
      }
      expect(table.size).toBe(20);
    });

    test('should handle nodes at extreme distances', () => {
      // Add node with maximum distance (all bits flipped)
      const maxDistId = Buffer.from(ourNodeId).map(byte => ~byte & 0xFF);
      table.addNode(createNode(maxDistId));

      // Add node with minimum distance (only last bit flipped)
      const minDistId = Buffer.from(ourNodeId);
      minDistId[19] ^= 0x01;
      table.addNode(createNode(minDistId));

      expect(table.size).toBe(2);
    });

    test('should maintain consistency after many operations', () => {
      const operations = 100;
      const nodeIds = [];

      for (let i = 0; i < operations; i++) {
        const nodeId = generateNodeId();
        nodeIds.push(nodeId);

        if (Math.random() > 0.5) {
          table.addNode(createNode(nodeId));
        } else if (nodeIds.length > 0) {
          const removeId = nodeIds[Math.floor(Math.random() * nodeIds.length)];
          table.removeNode(removeId);
        }
      }

      // Table should still be consistent
      const stats = table.getStats();
      expect(stats.totalNodes).toBe(table.size);
      expect(stats.totalNodes).toBeLessThanOrEqual(160 * table.k);
    });
  });
});
