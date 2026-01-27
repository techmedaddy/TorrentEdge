const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const bencode = require('../bencode');

/**
 * Default DHT bootstrap nodes
 */
const DEFAULT_BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 }
];

/**
 * DHT Node implementing the Kademlia protocol (BEP-0005)
 * 
 * The DHT allows decentralized peer discovery without trackers.
 * Uses UDP for communication and bencode for message encoding.
 */
class DHTNode extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Buffer} [options.nodeId] - 20-byte node ID (auto-generated if not provided)
   * @param {number} [options.port=6881] - UDP port to listen on
   * @param {Array<{host: string, port: number}>} [options.bootstrapNodes=[]] - Bootstrap nodes
   * @param {Function} [options.onPeers] - Callback when peers found (infoHash, peers)
   * @param {Function} [options.onReady] - Callback when DHT is ready
   */
  constructor(options = {}) {
    super();
    
    this.nodeId = options.nodeId || crypto.randomBytes(20);
    this.port = options.port || 6881;
    this.bootstrapNodes = options.bootstrapNodes || DEFAULT_BOOTSTRAP_NODES;
    
    this._onPeersCallback = options.onPeers;
    this._onReadyCallback = options.onReady;
    
    // UDP socket
    this._socket = null;
    
    // Routing table: Map of nodeId (hex) -> {id, host, port, lastSeen}
    this._routingTable = new Map();
    
    // Pending queries: Map of transactionId (hex) -> {resolve, reject, timer, sentAt}
    this._pendingQueries = new Map();
    
    // Tokens received from nodes (needed for announce_peer)
    // Map of nodeKey (host:port) -> {token, receivedAt}
    this._tokens = new Map();
    
    // Peer storage: Map of infoHash (hex) -> Set of {ip, port, timestamp}
    this._peerStorage = new Map();
    
    // Token secrets for validating announce_peer (rotated every 5 minutes)
    this._tokenSecret = crypto.randomBytes(20);
    this._previousTokenSecret = null;
    this._lastTokenRotation = Date.now();
    
    // State
    this.isReady = false;
    
    // Constants
    this._queryTimeout = 5000; // 5 seconds
    this._maxRoutingTableSize = 200;
    this._tokenExpiry = 10 * 60 * 1000; // 10 minutes
    this._peerExpiry = 30 * 60 * 1000; // 30 minutes
    this._tokenRotationInterval = 5 * 60 * 1000; // 5 minutes
    this._alpha = 3; // Concurrency factor for iterative lookups
    this._k = 8; // Bucket size / number of nodes to return
    this._maxLookupIterations = 20; // Max iterations for iterative lookup
    
    // Maintenance intervals
    this._maintenanceIntervals = {
      bucketRefresh: null,
      nodeHealth: null,
      tokenRotation: null,
      peerCleanup: null
    };
    
    // Cleanup intervals
    this._cleanupInterval = null;
    this._tokenRotationTimer = null;
    
    console.log(`[DHT] Node created with ID: ${this.nodeId.toString('hex')}`);
  }
  
  /**
   * Get the number of nodes in routing table
   */
  get nodesCount() {
    return this._routingTable.size;
  }
  
  /**
   * Start the DHT node
   */
  async start() {
    if (this._socket) {
      throw new Error('[DHT] Node already started');
    }
    
    console.log(`[DHT] Starting node on port ${this.port}...`);
    
    // Create UDP socket
    this._socket = dgram.createSocket('udp4');
    
    // Set up message handler
    this._socket.on('message', (msg, rinfo) => {
      this._handleMessage(msg, rinfo);
    });
    
    this._socket.on('error', (err) => {
      console.error(`[DHT] Socket error:`, err);
    });
    
    // Bind to port
    await new Promise((resolve, reject) => {
      this._socket.bind(this.port, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log(`[DHT] Socket bound to port ${this.port}`);
    
    // Bootstrap the DHT
    await this.bootstrap();
    
    // Start maintenance tasks
    this._startMaintenance();
  }
  
  /**
   * Stop the DHT node
   */
  async stop() {
    console.log('[DHT] Stopping node...');
    
    // Stop maintenance
    this._stopMaintenance();
    
    // Cancel all pending queries
    for (const [tid, query] of this._pendingQueries.entries()) {
      clearTimeout(query.timer);
      query.reject(new Error('DHT node stopped'));
    }
    this._pendingQueries.clear();
    
    // Close socket
    if (this._socket) {
      await new Promise((resolve) => {
        this._socket.close(() => resolve());
      });
      this._socket = null;
    }
    
    this.isReady = false;
    console.log('[DHT] Node stopped');
  }
  
  /**
   * Bootstrap the DHT by contacting bootstrap nodes
   */
  async bootstrap() {
    console.log(`[DHT] Bootstrapping with ${this.bootstrapNodes.length} nodes...`);
    
    // Ping bootstrap nodes in parallel
    const pingPromises = this.bootstrapNodes.map(node =>
      this.ping(node.host, node.port).catch(err => {
        console.log(`[DHT] Bootstrap node ${node.host}:${node.port} failed:`, err.message);
        return null;
      })
    );
    
    const results = await Promise.all(pingPromises);
    const successCount = results.filter(r => r !== null).length;
    
    if (successCount === 0) {
      console.warn('[DHT] Bootstrap failed: no nodes responded');
      this.emit('warning', 'Bootstrap failed: no nodes responded');
      return;
    }
    
    console.log(`[DHT] Bootstrap: ${successCount}/${this.bootstrapNodes.length} nodes responded`);
    
    // Do a find_node lookup for our own ID to populate routing table
    try {
      console.log('[DHT] Finding nodes close to our ID to populate routing table...');
      await this.findNode(this.nodeId);
    } catch (err) {
      console.log('[DHT] Initial find_node failed:', err.message);
    }
    
    // Check if we have enough nodes
    if (this.nodesCount >= this._k) {
      this.isReady = true;
      console.log(`[DHT] Node ready with ${this.nodesCount} nodes in routing table`);
      
      if (this._onReadyCallback) {
        this._onReadyCallback();
      }
      this.emit('ready');
    } else {
      console.log(`[DHT] Bootstrap incomplete: only ${this.nodesCount} nodes in routing table`);
      this.emit('warning', `Only ${this.nodesCount} nodes in routing table`);
    }
  }
  
  /**
   * Start periodic maintenance tasks
   * @private
   */
  _startMaintenance() {
    console.log('[DHT] Starting maintenance tasks...');
    
    // Bucket refresh (every 15 minutes)
    this._maintenanceIntervals.bucketRefresh = setInterval(async () => {
      await this._refreshBuckets();
    }, 15 * 60 * 1000);
    
    // Node health check (every 10 minutes)
    this._maintenanceIntervals.nodeHealth = setInterval(async () => {
      await this._checkNodeHealth();
    }, 10 * 60 * 1000);
    
    // Token secret rotation (every 5 minutes)
    this._maintenanceIntervals.tokenRotation = setInterval(() => {
      this._rotateTokenSecret();
    }, this._tokenRotationInterval);
    
    // Peer storage cleanup (every 5 minutes)
    this._maintenanceIntervals.peerCleanup = setInterval(() => {
      this._cleanupExpiredPeers();
    }, 5 * 60 * 1000);
  }
  
  /**
   * Stop all maintenance tasks
   * @private
   */
  _stopMaintenance() {
    console.log('[DHT] Stopping maintenance tasks...');
    
    for (const [name, interval] of Object.entries(this._maintenanceIntervals)) {
      if (interval) {
        clearInterval(interval);
        this._maintenanceIntervals[name] = null;
      }
    }
  }
  
  /**
   * Refresh stale buckets
   * @private
   */
  async _refreshBuckets() {
    console.log('[DHT] Refreshing stale buckets...');
    
    // Pick a few random buckets to refresh
    const bucketsToRefresh = [];
    for (let i = 0; i < 3; i++) {
      const bucketIndex = Math.floor(Math.random() * 160);
      bucketsToRefresh.push(bucketIndex);
    }
    
    for (const bucketIndex of bucketsToRefresh) {
      try {
        const randomId = this._generateRandomIdForBucket(bucketIndex);
        console.log(`[DHT] Refreshing bucket ${bucketIndex}`);
        await this.findNode(randomId);
      } catch (err) {
        console.log(`[DHT] Failed to refresh bucket ${bucketIndex}:`, err.message);
      }
    }
  }
  
  /**
   * Check health of nodes in routing table
   * @private
   */
  async _checkNodeHealth() {
    console.log('[DHT] Checking node health...');
    
    const allNodes = Array.from(this._routingTable.values());
    
    if (allNodes.length === 0) {
      return;
    }
    
    // Pick a few random nodes to ping
    const nodesToCheck = [];
    const checkCount = Math.min(5, allNodes.length);
    
    for (let i = 0; i < checkCount; i++) {
      const randomIndex = Math.floor(Math.random() * allNodes.length);
      const node = allNodes[randomIndex];
      if (node && !nodesToCheck.includes(node)) {
        nodesToCheck.push(node);
      }
    }
    
    let removedCount = 0;
    
    for (const node of nodesToCheck) {
      try {
        await this.ping(node.host, node.port);
      } catch (err) {
        // Node didn't respond, remove it
        const nodeKey = node.id.toString('hex');
        this._routingTable.delete(nodeKey);
        removedCount++;
        console.log(`[DHT] Removed dead node ${node.host}:${node.port}`);
      }
    }
    
    if (removedCount > 0) {
      console.log(`[DHT] Health check: removed ${removedCount} dead nodes`);
      this.emit('warning', `Removed ${removedCount} dead nodes`);
    }
  }
  
  /**
   * Generate a random node ID that falls in a specific bucket
   * @private
   * @param {number} bucketIndex - Bucket index (0-159)
   * @returns {Buffer} 20-byte node ID
   */
  _generateRandomIdForBucket(bucketIndex) {
    if (bucketIndex < 0 || bucketIndex >= 160) {
      throw new Error('Bucket index must be between 0 and 159');
    }
    
    // Start with our node ID
    const id = Buffer.from(this.nodeId);
    
    // Calculate which bit position to flip (159 - bucketIndex)
    const bitPosition = 159 - bucketIndex;
    const byteIndex = Math.floor(bitPosition / 8);
    const bitIndex = 7 - (bitPosition % 8);
    
    // Flip that bit
    id[byteIndex] ^= (1 << bitIndex);
    
    // Randomize all bits after that position
    const remainingBits = bitPosition;
    
    // Randomize complete bytes after the current byte
    for (let i = byteIndex + 1; i < 20; i++) {
      id[i] = Math.floor(Math.random() * 256);
    }
    
    // Randomize remaining bits in the same byte if needed
    if (bitIndex > 0) {
      const mask = (1 << bitIndex) - 1;
      id[byteIndex] = (id[byteIndex] & ~mask) | (Math.floor(Math.random() * 256) & mask);
    }
    
    return id;
  }
  
  /**
   * Ping a node
   * @param {string} host
   * @param {number} port
   * @returns {Promise<{nodeId: Buffer, rtt: number}>}
   */
  async ping(host, port) {
    const query = {
      t: this._generateTransactionId(),
      y: 'q',
      q: 'ping',
      a: {
        id: this.nodeId
      }
    };
    
    const startTime = Date.now();
    const response = await this._sendQuery(query, host, port);
    const rtt = Date.now() - startTime;
    
    const nodeId = response.r.id;
    this._addNode(nodeId, host, port);
    
    console.log(`[DHT] Ping response from ${host}:${port} (${rtt}ms)`);
    
    return { nodeId, rtt };
  }
  
  /**
   * Find nodes closest to a target ID using iterative lookup
   * @param {Buffer} targetId - 20-byte target ID
   * @returns {Promise<Array<{id: Buffer, host: string, port: number}>>}
   */
  async findNode(targetId) {
    console.log(`[DHT] Finding nodes close to ${targetId.toString('hex').substring(0, 8)}...`);
    
    const result = await this._iterativeLookup(targetId, 'find_node');
    return result.nodes;
  }
  
  /**
   * Get peers for an info hash using iterative lookup
   * @param {Buffer} infoHash - 20-byte info hash
   * @returns {Promise<{peers: Array<{ip: string, port: number}>, nodes: Array, token: Buffer}>}
   */
  async getPeers(infoHash) {
    console.log(`[DHT] Getting peers for ${infoHash.toString('hex').substring(0, 8)}...`);
    
    const result = await this._iterativeLookup(infoHash, 'get_peers');
    
    console.log(`[DHT] Found ${result.peers.length} peers for info hash`);
    
    if (result.peers.length > 0 && this._onPeersCallback) {
      this._onPeersCallback(infoHash, result.peers);
    }
    
    return result;
  }
  
  /**
   * Announce that we have a torrent
   * @param {Buffer} infoHash - 20-byte info hash
   * @param {number} port - Our BitTorrent port
   */
  async announcePeer(infoHash, port) {
    console.log(`[DHT] Announcing peer for ${infoHash.toString('hex').substring(0, 8)}...`);
    
    // Do iterative lookup to find closest nodes and get tokens
    const { nodes } = await this._iterativeLookup(infoHash, 'get_peers');
    
    // Announce to the k closest nodes that gave us tokens
    const announcePromises = nodes.slice(0, this._k).map(async (node) => {
      const nodeKey = `${node.host}:${node.port}`;
      const tokenData = this._tokens.get(nodeKey);
      
      if (!tokenData) {
        return; // No token for this node
      }
      
      // Check token hasn't expired
      if (Date.now() - tokenData.receivedAt > this._tokenExpiry) {
        this._tokens.delete(nodeKey);
        return;
      }
      
      try {
        const query = {
          t: this._generateTransactionId(),
          y: 'q',
          q: 'announce_peer',
          a: {
            id: this.nodeId,
            info_hash: infoHash,
            port: port,
            token: tokenData.token
          }
        };
        
        await this._sendQuery(query, node.host, node.port);
        console.log(`[DHT] Announced to ${node.host}:${node.port}`);
      } catch (err) {
        console.log(`[DHT] Announce to ${node.host}:${node.port} failed:`, err.message);
      }
    });
    
    await Promise.all(announcePromises);
  }
  
  /**
   * Get closest nodes from routing table
   * @param {Buffer} targetId - 20-byte target ID
   * @param {number} count - Number of nodes to return
   * @returns {Array<{id: Buffer, host: string, port: number}>}
   */
  getClosestNodes(targetId, count = 8) {
    const nodes = Array.from(this._routingTable.values())
      .map(node => ({
        ...node,
        distance: this._xorDistance(targetId, node.id)
      }))
      .sort((a, b) => Buffer.compare(a.distance, b.distance))
      .slice(0, count)
      .map(({ id, host, port }) => ({ id, host, port }));
    
    return nodes;
  }
  
  /**
   * Perform iterative Kademlia lookup
   * @private
   * @param {Buffer} targetId - Target node ID or info hash
   * @param {'find_node' | 'get_peers'} queryType - Type of query
   * @returns {Promise<{nodes: Array, peers: Array, token: Buffer}>}
   */
  async _iterativeLookup(targetId, queryType) {
    console.log(`[DHT] Starting iterative ${queryType} lookup for ${targetId.toString('hex').substring(0, 8)}...`);
    
    // Initialize shortlist with closest nodes from routing table
    let shortlist = this.getClosestNodes(targetId, this._alpha);
    
    // If no nodes in routing table, try bootstrap nodes
    if (shortlist.length === 0) {
      console.log('[DHT] No nodes in routing table, using bootstrap nodes');
      shortlist = this.bootstrapNodes.map(node => ({
        id: null, // Bootstrap nodes don't have known IDs yet
        host: node.host,
        port: node.port
      }));
    }
    
    const queried = new Set(); // Node keys we've already queried
    const allNodes = new Map(); // All nodes discovered: nodeKey -> {id, host, port, distance}
    const peers = new Map(); // Accumulated peers: "ip:port" -> {ip, port}
    let closestResponded = null; // Closest node that responded
    let closestDistance = null;
    let closestToken = null;
    
    // Add initial nodes to allNodes
    for (const node of shortlist) {
      if (node.id) {
        const nodeKey = `${node.host}:${node.port}`;
        const distance = this._xorDistance(targetId, node.id);
        allNodes.set(nodeKey, { ...node, distance });
      }
    }
    
    let iteration = 0;
    let noProgressCount = 0;
    
    while (iteration < this._maxLookupIterations) {
      iteration++;
      
      // Get up to alpha unqueried nodes closest to target
      const toQuery = Array.from(allNodes.values())
        .filter(node => {
          const nodeKey = `${node.host}:${node.port}`;
          return !queried.has(nodeKey);
        })
        .sort((a, b) => {
          if (!a.distance) return 1;
          if (!b.distance) return -1;
          return Buffer.compare(a.distance, b.distance);
        })
        .slice(0, this._alpha);
      
      if (toQuery.length === 0) {
        console.log(`[DHT] Iterative lookup: no more nodes to query (iteration ${iteration})`);
        break;
      }
      
      console.log(`[DHT] Iterative lookup: round ${iteration}, querying ${toQuery.length} nodes, ${allNodes.size} in shortlist`);
      
      // Query nodes in parallel
      const queryPromises = toQuery.map(async (node) => {
        const nodeKey = `${node.host}:${node.port}`;
        queried.add(nodeKey);
        
        try {
          const query = {
            t: this._generateTransactionId(),
            y: 'q',
            q: queryType,
            a: {
              id: this.nodeId,
              ...(queryType === 'find_node' ? { target: targetId } : { info_hash: targetId })
            }
          };
          
          const response = await this._sendQuery(query, node.host, node.port);
          
          // Add responding node to routing table
          if (response.r.id) {
            this._addNode(response.r.id, node.host, node.port);
            
            // Update node in allNodes with actual ID if we didn't have it
            if (!node.id) {
              node.id = response.r.id;
              node.distance = this._xorDistance(targetId, response.r.id);
              allNodes.set(nodeKey, node);
            }
            
            // Check if this is the closest responding node
            const distance = this._xorDistance(targetId, response.r.id);
            if (!closestDistance || Buffer.compare(distance, closestDistance) < 0) {
              closestDistance = distance;
              closestResponded = { id: response.r.id, host: node.host, port: node.port };
              noProgressCount = 0; // Reset no progress counter
            }
          }
          
          // Handle get_peers response
          if (queryType === 'get_peers') {
            // Store token
            if (response.r.token) {
              this._tokens.set(nodeKey, {
                token: response.r.token,
                receivedAt: Date.now()
              });
              
              // Update closest token
              if (closestResponded && closestResponded.host === node.host && closestResponded.port === node.port) {
                closestToken = response.r.token;
              }
            }
            
            // Extract peers if present
            if (response.r.values) {
              const foundPeers = this._decodePeers(response.r.values);
              for (const peer of foundPeers) {
                const peerKey = `${peer.ip}:${peer.port}`;
                peers.set(peerKey, peer);
              }
            }
          }
          
          // Add returned nodes to shortlist
          if (response.r.nodes) {
            const foundNodes = this._decodeNodes(response.r.nodes);
            for (const foundNode of foundNodes) {
              const foundKey = `${foundNode.host}:${foundNode.port}`;
              if (!allNodes.has(foundKey)) {
                const distance = this._xorDistance(targetId, foundNode.id);
                allNodes.set(foundKey, { ...foundNode, distance });
              }
            }
          }
        } catch (err) {
          // Node didn't respond or error occurred, ignore
        }
      });
      
      await Promise.all(queryPromises);
      
      // Check if we've made progress
      noProgressCount++;
      
      // Stop if we've queried enough nodes and made no progress recently
      if (queried.size >= this._k && noProgressCount >= 2) {
        console.log(`[DHT] Iterative lookup: no progress after ${iteration} rounds, ${queried.size} nodes queried`);
        break;
      }
    }
    
    // Return k closest nodes
    const closestNodes = Array.from(allNodes.values())
      .filter(node => node.id) // Only nodes with known IDs
      .sort((a, b) => Buffer.compare(a.distance, b.distance))
      .slice(0, this._k)
      .map(({ id, host, port }) => ({ id, host, port }));
    
    console.log(`[DHT] Iterative lookup complete: found ${closestNodes.length} nodes, ${peers.size} peers`);
    
    return {
      nodes: closestNodes,
      peers: Array.from(peers.values()),
      token: closestToken
    };
  }
  
  /**
   * Handle incoming UDP message
   * @private
   */
  _handleMessage(buffer, rinfo) {
    try {
      const message = bencode.decode(buffer);
      
      // Handle responses to our queries
      if (message.y === 'r' && message.t) {
        this._handleResponse(message, rinfo);
      }
      // Handle incoming queries
      else if (message.y === 'q' && message.q) {
        this._handleQuery(message, rinfo);
      }
      // Handle errors
      else if (message.y === 'e') {
        this._handleError(message, rinfo);
      }
    } catch (err) {
      console.error(`[DHT] Failed to parse message from ${rinfo.address}:${rinfo.port}:`, err.message);
    }
  }
  
  /**
   * Handle query response
   * @private
   */
  _handleResponse(message, rinfo) {
    const tid = message.t.toString('hex');
    const pending = this._pendingQueries.get(tid);
    
    if (!pending) {
      return; // Unknown transaction
    }
    
    // Clear timeout
    clearTimeout(pending.timer);
    this._pendingQueries.delete(tid);
    
    // Add responding node to routing table
    if (message.r && message.r.id) {
      this._addNode(message.r.id, rinfo.address, rinfo.port);
    }
    
    // Resolve promise
    pending.resolve(message);
  }
  
  /**
   * Handle incoming query
   * @private
   */
  _handleQuery(message, rinfo) {
    try {
      const queryType = message.q.toString();
      
      // Add querying node to routing table
      if (message.a && message.a.id) {
        this._addNode(message.a.id, rinfo.address, rinfo.port);
      }
      
      let response;
      
      switch (queryType) {
        case 'ping':
          response = this._handlePingQuery(message);
          break;
        case 'find_node':
          response = this._handleFindNodeQuery(message);
          break;
        case 'get_peers':
          response = this._handleGetPeersQuery(message, rinfo);
          break;
        case 'announce_peer':
          response = this._handleAnnouncePeerQuery(message, rinfo);
          break;
        default:
          // Unknown query type
          this._sendError(message.t, 204, 'Method Unknown', rinfo.address, rinfo.port);
          return;
      }
      
      // Send response
      this._sendResponse(response, rinfo.address, rinfo.port);
    } catch (err) {
      console.error(`[DHT] Error handling query:`, err);
      this._sendError(message.t, 202, 'Server Error', rinfo.address, rinfo.port);
    }
  }
  
  /**
   * Handle ping query
   * @private
   */
  _handlePingQuery(message) {
    return {
      t: message.t,
      y: 'r',
      r: {
        id: this.nodeId
      }
    };
  }
  
  /**
   * Handle find_node query
   * @private
   */
  _handleFindNodeQuery(message) {
    const target = message.a.target;
    const closestNodes = this.getClosestNodes(target, 8);
    const nodesCompact = this._encodeNodes(closestNodes);
    
    return {
      t: message.t,
      y: 'r',
      r: {
        id: this.nodeId,
        nodes: nodesCompact
      }
    };
  }
  
  /**
   * Handle get_peers query
   * @private
   */
  _handleGetPeersQuery(message, rinfo) {
    const infoHash = message.a.info_hash;
    const infoHashHex = infoHash.toString('hex');
    
    // Generate a token for this IP
    const token = this._generateToken(rinfo.address);
    
    // Check if we have peers for this info hash
    const storedPeers = this._peerStorage.get(infoHashHex);
    
    if (storedPeers && storedPeers.size > 0) {
      // We have peers, return them
      const peers = Array.from(storedPeers)
        .filter(peer => Date.now() - peer.timestamp < this._peerExpiry)
        .map(peer => ({ ip: peer.ip, port: peer.port }));
      
      if (peers.length > 0) {
        const values = this._encodePeers(peers);
        console.log(`[DHT] Returning ${peers.length} peers for info hash ${infoHashHex.substring(0, 8)}`);
        
        return {
          t: message.t,
          y: 'r',
          r: {
            id: this.nodeId,
            token: token,
            values: values
          }
        };
      }
    }
    
    // No peers, return closest nodes
    const closestNodes = this.getClosestNodes(infoHash, 8);
    const nodesCompact = this._encodeNodes(closestNodes);
    
    return {
      t: message.t,
      y: 'r',
      r: {
        id: this.nodeId,
        token: token,
        nodes: nodesCompact
      }
    };
  }
  
  /**
   * Handle announce_peer query
   * @private
   */
  _handleAnnouncePeerQuery(message, rinfo) {
    const infoHash = message.a.info_hash;
    const infoHashHex = infoHash.toString('hex');
    const token = message.a.token;
    const port = message.a.port;
    
    // Validate token
    if (!this._validateToken(token, rinfo.address)) {
      console.log(`[DHT] Invalid token from ${rinfo.address}:${rinfo.port}`);
      throw new Error('Invalid token');
    }
    
    // Store the peer
    if (!this._peerStorage.has(infoHashHex)) {
      this._peerStorage.set(infoHashHex, new Set());
    }
    
    const peers = this._peerStorage.get(infoHashHex);
    const peerKey = `${rinfo.address}:${port}`;
    
    // Remove old entry if exists
    for (const peer of peers) {
      if (`${peer.ip}:${peer.port}` === peerKey) {
        peers.delete(peer);
        break;
      }
    }
    
    // Add new entry
    peers.add({
      ip: rinfo.address,
      port: port,
      timestamp: Date.now()
    });
    
    console.log(`[DHT] Peer announced for ${infoHashHex.substring(0, 8)}: ${rinfo.address}:${port} (${peers.size} total)`);
    
    // Emit peer event
    this.emit('peer', {
      infoHash: infoHash,
      peer: { ip: rinfo.address, port: port }
    });
    
    // Emit peers event for this info hash
    if (this._onPeersCallback) {
      const peersList = Array.from(peers)
        .filter(p => Date.now() - p.timestamp < this._peerExpiry)
        .map(p => ({ ip: p.ip, port: p.port }));
      this._onPeersCallback(infoHash, peersList);
    }
    
    return {
      t: message.t,
      y: 'r',
      r: {
        id: this.nodeId
      }
    };
  }
  
  /**
   * Handle error message
   * @private
   */
  _handleError(message, rinfo) {
    const tid = message.t.toString('hex');
    const pending = this._pendingQueries.get(tid);
    
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingQueries.delete(tid);
      
      const [code, msg] = message.e;
      pending.reject(new Error(`DHT error ${code}: ${msg}`));
    }
    
    console.log(`[DHT] Error from ${rinfo.address}:${rinfo.port}:`, message.e);
  }
  
  /**
   * Send a query and wait for response
   * @private
   */
  async _sendQuery(query, host, port) {
    const tid = query.t.toString('hex');
    
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this._pendingQueries.delete(tid);
        reject(new Error(`Query timeout: ${query.q}`));
      }, this._queryTimeout);
      
      // Store pending query
      this._pendingQueries.set(tid, {
        resolve,
        reject,
        timer,
        sentAt: Date.now()
      });
      
      // Send query
      const buffer = bencode.encode(query);
      this._socket.send(buffer, port, host, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pendingQueries.delete(tid);
          reject(err);
        }
      });
    });
  }
  
  /**
   * Send a response
   * @private
   */
  _sendResponse(response, host, port) {
    const buffer = bencode.encode(response);
    this._socket.send(buffer, port, host, (err) => {
      if (err) {
        console.error(`[DHT] Failed to send response:`, err);
      }
    });
  }
  
  /**
   * Send an error message
   * @private
   */
  _sendError(transactionId, code, message, host, port) {
    const error = {
      t: transactionId,
      y: 'e',
      e: [code, message]
    };
    
    const buffer = bencode.encode(error);
    this._socket.send(buffer, port, host);
  }
  
  /**
   * Add a node to the routing table
   * @private
   */
  _addNode(nodeId, host, port) {
    const nodeKey = nodeId.toString('hex');
    
    // Don't add ourselves
    if (nodeId.equals(this.nodeId)) {
      return;
    }
    
    // Check if table is full
    if (!this._routingTable.has(nodeKey) && this._routingTable.size >= this._maxRoutingTableSize) {
      // Simple eviction: remove oldest node
      const oldest = Array.from(this._routingTable.entries())
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      
      if (oldest) {
        this._routingTable.delete(oldest[0]);
      }
    }
    
    this._routingTable.set(nodeKey, {
      id: nodeId,
      host,
      port,
      lastSeen: Date.now()
    });
    
    this.emit('node', { id: nodeId, host, port });
  }
  
  /**
   * Generate a random 2-byte transaction ID
   * @private
   */
  _generateTransactionId() {
    return crypto.randomBytes(2);
  }
  
  /**
   * Calculate XOR distance between two IDs
   * @private
   */
  _xorDistance(id1, id2) {
    const distance = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) {
      distance[i] = id1[i] ^ id2[i];
    }
    return distance;
  }
  
  /**
   * Encode nodes to compact format
   * @private
   */
  _encodeNodes(nodes) {
    const buffers = nodes.map(node => {
      const buffer = Buffer.alloc(26);
      node.id.copy(buffer, 0); // 20 bytes: node ID
      
      // 4 bytes: IP address
      const ipParts = node.host.split('.').map(p => parseInt(p, 10));
      buffer[20] = ipParts[0];
      buffer[21] = ipParts[1];
      buffer[22] = ipParts[2];
      buffer[23] = ipParts[3];
      
      // 2 bytes: port (big-endian)
      buffer.writeUInt16BE(node.port, 24);
      
      return buffer;
    });
    
    return Buffer.concat(buffers);
  }
  
  /**
   * Decode nodes from compact format
   * @private
   */
  _decodeNodes(buffer) {
    if (!buffer || buffer.length % 26 !== 0) {
      return [];
    }
    
    const nodes = [];
    for (let i = 0; i < buffer.length; i += 26) {
      const id = buffer.slice(i, i + 20);
      const ip = `${buffer[i + 20]}.${buffer[i + 21]}.${buffer[i + 22]}.${buffer[i + 23]}`;
      const port = buffer.readUInt16BE(i + 24);
      
      nodes.push({ id, host: ip, port });
    }
    
    return nodes;
  }
  
  /**
   * Decode peers from compact format
   * @private
   */
  _decodePeers(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    
    const peers = [];
    
    for (const value of values) {
      if (value.length !== 6) {
        continue;
      }
      
      const ip = `${value[0]}.${value[1]}.${value[2]}.${value[3]}`;
      const port = value.readUInt16BE(4);
      
      peers.push({ ip, port });
    }
    
    return peers;
  }
  
  /**
   * Encode peers to compact format for BEP-0005
   * @private
   * @param {Array<{ip: string, port: number}>} peers
   * @returns {Array<Buffer>} Array of 6-byte buffers
   */
  _encodePeers(peers) {
    return peers.map(peer => {
      const buffer = Buffer.alloc(6);
      const ipParts = peer.ip.split('.').map(p => parseInt(p, 10));
      
      // 4 bytes: IP address
      buffer[0] = ipParts[0];
      buffer[1] = ipParts[1];
      buffer[2] = ipParts[2];
      buffer[3] = ipParts[3];
      
      // 2 bytes: port (big-endian)
      buffer.writeUInt16BE(peer.port, 4);
      
      return buffer;
    });
  }
  
  /**
   * Generate a token for an IP address
   * @private
   * @param {string} ip
   * @returns {Buffer}
   */
  _generateToken(ip) {
    return crypto.createHash('sha1')
      .update(Buffer.from(ip))
      .update(this._tokenSecret)
      .digest()
      .slice(0, 8);
  }
  
  /**
   * Validate a token for an IP address
   * @private
   * @param {Buffer} token
   * @param {string} ip
   * @returns {boolean}
   */
  _validateToken(token, ip) {
    if (!token || token.length !== 8) {
      return false;
    }
    
    // Check against current secret
    const currentToken = this._generateToken(ip);
    if (token.equals(currentToken)) {
      return true;
    }
    
    // Check against previous secret (if exists)
    if (this._previousTokenSecret) {
      const previousToken = crypto.createHash('sha1')
        .update(Buffer.from(ip))
        .update(this._previousTokenSecret)
        .digest()
        .slice(0, 8);
      
      if (token.equals(previousToken)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Rotate token secret (called every 5 minutes)
   * @private
   */
  _rotateTokenSecret() {
    console.log('[DHT] Rotating token secret');
    this._previousTokenSecret = this._tokenSecret;
    this._tokenSecret = crypto.randomBytes(20);
    this._lastTokenRotation = Date.now();
  }
  
  /**
   * Clean up expired peers from storage
   * @private
   */
  _cleanupExpiredPeers() {
    const now = Date.now();
    let totalPeers = 0;
    let expiredPeers = 0;
    
    for (const [infoHash, peers] of this._peerStorage.entries()) {
      const before = peers.size;
      totalPeers += before;
      
      // Remove expired peers
      for (const peer of peers) {
        if (now - peer.timestamp > this._peerExpiry) {
          peers.delete(peer);
          expiredPeers++;
        }
      }
      
      // Remove empty sets
      if (peers.size === 0) {
        this._peerStorage.delete(infoHash);
      }
    }
    
    if (expiredPeers > 0) {
      console.log(`[DHT] Cleaned up ${expiredPeers} expired peers (${totalPeers - expiredPeers} remaining)`);
    }
  }
}

module.exports = DHTNode;
