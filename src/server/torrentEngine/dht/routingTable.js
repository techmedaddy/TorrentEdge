const crypto = require('crypto');

/**
 * Kademlia Routing Table
 * 
 * Organizes DHT nodes into k-buckets based on XOR distance.
 * Implements the routing table structure from BEP-0005.
 */
class RoutingTable {
  /**
   * @param {Object} options
   * @param {Buffer} options.nodeId - Our 20-byte node ID
   * @param {number} [options.k=8] - Bucket size (nodes per bucket)
   */
  constructor(options) {
    if (!options || !options.nodeId) {
      throw new Error('nodeId is required');
    }
    
    if (!Buffer.isBuffer(options.nodeId) || options.nodeId.length !== 20) {
      throw new Error('nodeId must be a 20-byte Buffer');
    }
    
    this.nodeId = options.nodeId;
    this.k = options.k || 8;
    
    // Initialize 160 k-buckets (one for each bit of the 160-bit node ID)
    this.buckets = Array.from({ length: 160 }, () => ({
      nodes: [],
      lastRefresh: Date.now()
    }));
    
    console.log(`[RoutingTable] Created with node ID: ${this.nodeId.toString('hex').substring(0, 8)}...`);
  }
  
  /**
   * Get total number of nodes in routing table
   */
  get size() {
    return this.buckets.reduce((sum, bucket) => sum + bucket.nodes.length, 0);
  }
  
  /**
   * Add a node to the routing table
   * @param {Object} node
   * @param {Buffer} node.id - 20-byte node ID
   * @param {string} node.host - IP address
   * @param {number} node.port - Port number
   * @returns {boolean} True if added, false if bucket is full
   */
  addNode(node) {
    if (!node || !Buffer.isBuffer(node.id) || node.id.length !== 20) {
      throw new Error('Invalid node: id must be a 20-byte Buffer');
    }
    
    if (!node.host || !node.port) {
      throw new Error('Invalid node: host and port required');
    }
    
    // Don't add ourselves
    if (node.id.equals(this.nodeId)) {
      return false;
    }
    
    const bucketIndex = this.getBucket(node.id);
    const bucket = this.buckets[bucketIndex];
    const nodeKey = node.id.toString('hex');
    
    // Check if node already exists in bucket
    const existingIndex = bucket.nodes.findIndex(n => n.id.toString('hex') === nodeKey);
    
    if (existingIndex !== -1) {
      // Node exists, update and move to end (most recently seen)
      const existingNode = bucket.nodes[existingIndex];
      existingNode.host = node.host;
      existingNode.port = node.port;
      existingNode.lastSeen = Date.now();
      
      // Move to end of array (most recently seen)
      bucket.nodes.splice(existingIndex, 1);
      bucket.nodes.push(existingNode);
      
      return true;
    }
    
    // Node doesn't exist, check if bucket has room
    if (bucket.nodes.length < this.k) {
      // Bucket has room, add node
      bucket.nodes.push({
        id: node.id,
        host: node.host,
        port: node.port,
        lastSeen: Date.now()
      });
      
      bucket.lastRefresh = Date.now();
      return true;
    }
    
    // Bucket is full - caller should ping oldest node
    return false;
  }
  
  /**
   * Remove a node from the routing table
   * @param {Buffer} nodeId - 20-byte node ID
   * @returns {boolean} True if node was found and removed
   */
  removeNode(nodeId) {
    if (!Buffer.isBuffer(nodeId) || nodeId.length !== 20) {
      throw new Error('nodeId must be a 20-byte Buffer');
    }
    
    const bucketIndex = this.getBucket(nodeId);
    const bucket = this.buckets[bucketIndex];
    const nodeKey = nodeId.toString('hex');
    
    const index = bucket.nodes.findIndex(n => n.id.toString('hex') === nodeKey);
    
    if (index !== -1) {
      bucket.nodes.splice(index, 1);
      return true;
    }
    
    return false;
  }
  
  /**
   * Get a node by ID
   * @param {Buffer} nodeId - 20-byte node ID
   * @returns {{id: Buffer, host: string, port: number} | null}
   */
  getNode(nodeId) {
    if (!Buffer.isBuffer(nodeId) || nodeId.length !== 20) {
      throw new Error('nodeId must be a 20-byte Buffer');
    }
    
    const bucketIndex = this.getBucket(nodeId);
    const bucket = this.buckets[bucketIndex];
    const nodeKey = nodeId.toString('hex');
    
    const node = bucket.nodes.find(n => n.id.toString('hex') === nodeKey);
    
    if (node) {
      return {
        id: node.id,
        host: node.host,
        port: node.port
      };
    }
    
    return null;
  }
  
  /**
   * Get the closest nodes to a target ID
   * @param {Buffer} targetId - 20-byte target ID
   * @param {number} count - Maximum number of nodes to return
   * @returns {Array<{id: Buffer, host: string, port: number}>}
   */
  getClosest(targetId, count = 8) {
    if (!Buffer.isBuffer(targetId) || targetId.length !== 20) {
      throw new Error('targetId must be a 20-byte Buffer');
    }
    
    // Get all nodes from all buckets
    const allNodes = this.getAllNodes();
    
    if (allNodes.length === 0) {
      return [];
    }
    
    // Sort by distance to target
    const sortedNodes = allNodes
      .map(node => ({
        ...node,
        distance: RoutingTable.distance(node.id, targetId)
      }))
      .sort((a, b) => Buffer.compare(a.distance, b.distance))
      .slice(0, count)
      .map(({ id, host, port }) => ({ id, host, port }));
    
    return sortedNodes;
  }
  
  /**
   * Calculate which bucket a node ID belongs to
   * @param {Buffer} nodeId - 20-byte node ID
   * @returns {number} Bucket index (0-159)
   */
  getBucket(nodeId) {
    if (!Buffer.isBuffer(nodeId) || nodeId.length !== 20) {
      throw new Error('nodeId must be a 20-byte Buffer');
    }
    
    const distance = RoutingTable.distance(this.nodeId, nodeId);
    
    // Find the index of the first differing bit (most significant bit set)
    for (let i = 0; i < 160; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      const bit = (distance[byteIndex] >> bitIndex) & 1;
      
      if (bit === 1) {
        // This is the first bit that differs
        return 159 - i;
      }
    }
    
    // All bits are zero (same ID) - shouldn't happen as we filter our own ID
    return 0;
  }
  
  /**
   * Get all nodes from the routing table
   * @returns {Array<{id: Buffer, host: string, port: number}>}
   */
  getAllNodes() {
    const nodes = [];
    
    for (const bucket of this.buckets) {
      for (const node of bucket.nodes) {
        nodes.push({
          id: node.id,
          host: node.host,
          port: node.port
        });
      }
    }
    
    return nodes;
  }
  
  /**
   * Get the oldest (least recently seen) node in a bucket
   * @param {number} bucketIndex - Bucket index (0-159)
   * @returns {{id: Buffer, host: string, port: number} | null}
   */
  getOldestInBucket(bucketIndex) {
    if (bucketIndex < 0 || bucketIndex >= 160) {
      throw new Error('bucketIndex must be between 0 and 159');
    }
    
    const bucket = this.buckets[bucketIndex];
    
    if (bucket.nodes.length === 0) {
      return null;
    }
    
    // Nodes are ordered by lastSeen (oldest first)
    const oldest = bucket.nodes[0];
    
    return {
      id: oldest.id,
      host: oldest.host,
      port: oldest.port
    };
  }
  
  /**
   * Mark a bucket as recently refreshed
   * @param {number} bucketIndex - Bucket index (0-159)
   */
  refreshBucket(bucketIndex) {
    if (bucketIndex < 0 || bucketIndex >= 160) {
      throw new Error('bucketIndex must be between 0 and 159');
    }
    
    this.buckets[bucketIndex].lastRefresh = Date.now();
  }
  
  /**
   * Get bucket indices that need refreshing
   * @param {number} maxAge - Maximum age in milliseconds
   * @returns {number[]} Array of bucket indices
   */
  getBucketsNeedingRefresh(maxAge = 15 * 60 * 1000) {
    const now = Date.now();
    const needingRefresh = [];
    
    for (let i = 0; i < this.buckets.length; i++) {
      const bucket = this.buckets[i];
      
      // Only refresh buckets that have nodes or are nearby
      if (bucket.nodes.length > 0 || i >= 155) {
        if (now - bucket.lastRefresh > maxAge) {
          needingRefresh.push(i);
        }
      }
    }
    
    return needingRefresh;
  }
  
  /**
   * Get statistics about the routing table
   * @returns {Object} Statistics
   */
  getStats() {
    const stats = {
      totalNodes: this.size,
      bucketsWithNodes: 0,
      fullBuckets: 0,
      averageNodesPerBucket: 0,
      oldestNode: null,
      newestNode: null
    };
    
    let oldest = null;
    let newest = null;
    
    for (const bucket of this.buckets) {
      if (bucket.nodes.length > 0) {
        stats.bucketsWithNodes++;
        
        if (bucket.nodes.length === this.k) {
          stats.fullBuckets++;
        }
        
        for (const node of bucket.nodes) {
          if (!oldest || node.lastSeen < oldest.lastSeen) {
            oldest = node;
          }
          if (!newest || node.lastSeen > newest.lastSeen) {
            newest = node;
          }
        }
      }
    }
    
    if (stats.bucketsWithNodes > 0) {
      stats.averageNodesPerBucket = stats.totalNodes / stats.bucketsWithNodes;
    }
    
    if (oldest) {
      stats.oldestNode = {
        id: oldest.id.toString('hex').substring(0, 8) + '...',
        lastSeen: new Date(oldest.lastSeen).toISOString(),
        age: Date.now() - oldest.lastSeen
      };
    }
    
    if (newest) {
      stats.newestNode = {
        id: newest.id.toString('hex').substring(0, 8) + '...',
        lastSeen: new Date(newest.lastSeen).toISOString(),
        age: Date.now() - newest.lastSeen
      };
    }
    
    return stats;
  }
  
  /**
   * Calculate XOR distance between two node IDs
   * @param {Buffer} id1 - First 20-byte node ID
   * @param {Buffer} id2 - Second 20-byte node ID
   * @returns {Buffer} 20-byte XOR distance
   */
  static distance(id1, id2) {
    if (!Buffer.isBuffer(id1) || id1.length !== 20) {
      throw new Error('id1 must be a 20-byte Buffer');
    }
    if (!Buffer.isBuffer(id2) || id2.length !== 20) {
      throw new Error('id2 must be a 20-byte Buffer');
    }
    
    const distance = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) {
      distance[i] = id1[i] ^ id2[i];
    }
    return distance;
  }
  
  /**
   * Compare which ID is closer to target
   * @param {Buffer} id1 - First node ID
   * @param {Buffer} id2 - Second node ID
   * @param {Buffer} target - Target ID
   * @returns {number} -1 if id1 closer, 1 if id2 closer, 0 if equal
   */
  static compareDistance(id1, id2, target) {
    if (!Buffer.isBuffer(id1) || id1.length !== 20) {
      throw new Error('id1 must be a 20-byte Buffer');
    }
    if (!Buffer.isBuffer(id2) || id2.length !== 20) {
      throw new Error('id2 must be a 20-byte Buffer');
    }
    if (!Buffer.isBuffer(target) || target.length !== 20) {
      throw new Error('target must be a 20-byte Buffer');
    }
    
    const dist1 = RoutingTable.distance(id1, target);
    const dist2 = RoutingTable.distance(id2, target);
    
    return Buffer.compare(dist1, dist2);
  }
}

module.exports = RoutingTable;
