const crypto = require('crypto');
const bencode = require('./bencode');
const { EventEmitter } = require('events');

/**
 * Extension protocol reserved bit (BEP 10)
 * Bit 20 of the reserved bytes in BT handshake
 */
const EXTENSION_RESERVED_BIT = 0x100000;

/**
 * ut_metadata message types (BEP 9)
 */
const UT_METADATA_MSG_TYPES = {
  REQUEST: 0,
  DATA: 1,
  REJECT: 2
};

/**
 * Metadata piece size (16KB)
 */
const METADATA_PIECE_SIZE = 16384;

/**
 * Extended message IDs
 */
const EXTENDED_MESSAGE_ID = 20;
const EXTENDED_HANDSHAKE_ID = 0;

/**
 * MetadataDownloader - Downloads torrent metadata via extension protocol (BEP 9)
 * 
 * Used to fetch .torrent info from peers when only a magnet link is available.
 */
class MetadataDownloader extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Buffer} options.infoHash - 20-byte info hash from magnet link
   * @param {PeerManager} options.peerManager - Peer manager instance
   * @param {Function} options.onMetadata - Callback when metadata downloaded (metadata, infoDict)
   */
  constructor(options) {
    super();
    
    if (!options || !options.infoHash) {
      throw new Error('infoHash is required');
    }
    
    if (!Buffer.isBuffer(options.infoHash) || options.infoHash.length !== 20) {
      throw new Error('infoHash must be a 20-byte Buffer');
    }
    
    this.infoHash = options.infoHash;
    this.peerManager = options.peerManager;
    this._onMetadataCallback = options.onMetadata;
    
    // Metadata state
    this.metadata = null;
    this.metadataSize = null;
    this.isComplete = false;
    this.pieces = new Map(); // pieceIndex -> Buffer
    
    // Peer tracking
    this._peerExtensions = new Map(); // peerId -> { ut_metadata: msgId, metadata_size: size }
    this._requestedPieces = new Set(); // Track pieces we've requested
    this._activePeers = new Set(); // Peers we're actively using
    
    // State
    this._started = false;
    this._requestInterval = null;
    
    console.log(`[MetadataDownloader] Created for info hash ${this.infoHash.toString('hex').substring(0, 8)}...`);
  }
  
  /**
   * Start downloading metadata
   */
  start() {
    if (this._started) {
      return;
    }
    
    this._started = true;
    console.log('[MetadataDownloader] Starting metadata download...');
    
    // Send extension handshake to all connected peers
    if (this.peerManager) {
      this._initializePeers();
    }
    
    // Start periodic metadata piece requests
    this._requestInterval = setInterval(() => {
      this._requestNextPieces();
    }, 1000);
    
    this.emit('start');
  }
  
  /**
   * Stop downloading metadata
   */
  stop() {
    if (!this._started) {
      return;
    }
    
    console.log('[MetadataDownloader] Stopping metadata download...');
    
    this._started = false;
    
    if (this._requestInterval) {
      clearInterval(this._requestInterval);
      this._requestInterval = null;
    }
    
    this.emit('stop');
  }
  
  /**
   * Initialize peers with extension handshake
   * @private
   */
  _initializePeers() {
    // Note: This assumes peerManager has a way to access connected peers
    // In a real implementation, you'd iterate over connected peers
    console.log('[MetadataDownloader] Initializing peers with extension handshake...');
    
    // The extension handshake will be sent when peer connection is established
    // and we detect they support extensions via reserved bits
  }
  
  /**
   * Send extension handshake to a peer
   * @param {Object} peer - Peer connection object
   */
  sendExtensionHandshake(peer) {
    if (!peer || !peer.write) {
      return;
    }
    
    // Build extension handshake message
    const handshake = {
      m: {
        ut_metadata: 1 // Our message ID for ut_metadata
      }
    };
    
    const encoded = bencode.encode(handshake);
    
    // Build extended message: <len><id=20><ext_id=0><bencoded_dict>
    const message = Buffer.alloc(2 + encoded.length);
    message[0] = EXTENDED_MESSAGE_ID; // Extended message
    message[1] = EXTENDED_HANDSHAKE_ID; // Handshake
    encoded.copy(message, 2);
    
    // Prepend length
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.length, 0);
    
    const packet = Buffer.concat([length, message]);
    
    peer.write(packet);
    console.log(`[MetadataDownloader] Sent extension handshake to peer`);
  }
  
  /**
   * Handle incoming extended message from peer
   * @param {Object} peer - Peer connection
   * @param {number} extId - Extended message ID
   * @param {Buffer} payload - Message payload
   */
  handleExtendedMessage(peer, extId, payload) {
    try {
      if (extId === EXTENDED_HANDSHAKE_ID) {
        this._handleExtensionHandshake(peer, payload);
      } else {
        // This could be a ut_metadata message
        this._handleUtMetadataMessage(peer, extId, payload);
      }
    } catch (err) {
      console.error('[MetadataDownloader] Error handling extended message:', err);
    }
  }
  
  /**
   * Handle extension handshake from peer
   * @private
   */
  _handleExtensionHandshake(peer, payload) {
    try {
      const handshake = bencode.decode(payload);
      
      console.log('[MetadataDownloader] Received extension handshake from peer');
      
      // Check if peer supports ut_metadata
      if (handshake.m && handshake.m.ut_metadata) {
        const peerInfo = {
          ut_metadata: handshake.m.ut_metadata,
          metadata_size: handshake.metadata_size || null
        };
        
        // Store peer's extension info
        const peerId = peer.peerId || peer.host + ':' + peer.port;
        this._peerExtensions.set(peerId, peerInfo);
        this._activePeers.add(peerId);
        
        // Store metadata size if provided
        if (handshake.metadata_size && !this.metadataSize) {
          this.metadataSize = handshake.metadata_size;
          console.log(`[MetadataDownloader] Metadata size: ${this.metadataSize} bytes`);
          this.emit('size', this.metadataSize);
        }
        
        console.log(`[MetadataDownloader] Peer supports ut_metadata (id=${peerInfo.ut_metadata})`);
        
        // Start requesting pieces if we know the size
        if (this.metadataSize) {
          this._requestNextPieces();
        }
      }
    } catch (err) {
      console.error('[MetadataDownloader] Error parsing extension handshake:', err);
    }
  }
  
  /**
   * Handle ut_metadata message from peer
   * @private
   */
  _handleUtMetadataMessage(peer, extId, payload) {
    try {
      // Find the bencode dictionary end to separate dict from data
      let dictEnd = 0;
      let depth = 0;
      let inDict = false;
      
      for (let i = 0; i < payload.length; i++) {
        if (payload[i] === 0x64) { // 'd' - dict start
          depth++;
          inDict = true;
        } else if (payload[i] === 0x65 && inDict) { // 'e' - dict/list end
          depth--;
          if (depth === 0) {
            dictEnd = i + 1;
            break;
          }
        }
      }
      
      if (dictEnd === 0) {
        console.error('[MetadataDownloader] Failed to parse ut_metadata message');
        return;
      }
      
      const dictBuffer = payload.slice(0, dictEnd);
      const dict = bencode.decode(dictBuffer);
      
      const msgType = dict.msg_type;
      const pieceIndex = dict.piece;
      
      if (msgType === UT_METADATA_MSG_TYPES.DATA) {
        // Data message: has piece data after the dict
        const pieceData = payload.slice(dictEnd);
        this._handleMetadataData(pieceIndex, pieceData, dict.total_size);
      } else if (msgType === UT_METADATA_MSG_TYPES.REJECT) {
        console.log(`[MetadataDownloader] Peer rejected piece ${pieceIndex}`);
        this._requestedPieces.delete(pieceIndex);
      }
    } catch (err) {
      console.error('[MetadataDownloader] Error handling ut_metadata message:', err);
    }
  }
  
  /**
   * Handle received metadata piece
   * @private
   */
  _handleMetadataData(pieceIndex, data, totalSize) {
    if (this.isComplete) {
      return;
    }
    
    console.log(`[MetadataDownloader] Received metadata piece ${pieceIndex} (${data.length} bytes)`);
    
    // Store metadata size if we don't have it
    if (totalSize && !this.metadataSize) {
      this.metadataSize = totalSize;
      console.log(`[MetadataDownloader] Metadata size: ${this.metadataSize} bytes`);
      this.emit('size', this.metadataSize);
    }
    
    // Store piece
    this.pieces.set(pieceIndex, data);
    this._requestedPieces.delete(pieceIndex);
    
    this.emit('piece', { index: pieceIndex, data: data });
    
    // Check if we have all pieces
    if (this.metadataSize && this._isMetadataComplete()) {
      this._assembleMetadata();
    }
  }
  
  /**
   * Check if we have all metadata pieces
   * @private
   */
  _isMetadataComplete() {
    if (!this.metadataSize) {
      return false;
    }
    
    const numPieces = Math.ceil(this.metadataSize / METADATA_PIECE_SIZE);
    
    for (let i = 0; i < numPieces; i++) {
      if (!this.pieces.has(i)) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Assemble complete metadata from pieces
   * @private
   */
  _assembleMetadata() {
    console.log('[MetadataDownloader] Assembling metadata from pieces...');
    
    // Concatenate pieces in order
    const numPieces = Math.ceil(this.metadataSize / METADATA_PIECE_SIZE);
    const buffers = [];
    
    for (let i = 0; i < numPieces; i++) {
      const piece = this.pieces.get(i);
      if (!piece) {
        console.error(`[MetadataDownloader] Missing piece ${i}`);
        return;
      }
      buffers.push(piece);
    }
    
    const metadata = Buffer.concat(buffers).slice(0, this.metadataSize);
    
    // Verify hash
    const hash = crypto.createHash('sha1').update(metadata).digest();
    
    if (!hash.equals(this.infoHash)) {
      console.error('[MetadataDownloader] Metadata hash mismatch!');
      console.error(`Expected: ${this.infoHash.toString('hex')}`);
      console.error(`Got:      ${hash.toString('hex')}`);
      this.emit('error', new Error('Metadata hash verification failed'));
      return;
    }
    
    console.log('[MetadataDownloader] Metadata hash verified successfully!');
    
    // Decode metadata
    try {
      const infoDict = bencode.decode(metadata);
      
      this.metadata = metadata;
      this.isComplete = true;
      
      console.log('[MetadataDownloader] Metadata download complete!');
      console.log(`[MetadataDownloader] Torrent name: ${infoDict.name || 'Unknown'}`);
      
      // Stop requesting more pieces
      this.stop();
      
      // Call callback
      if (this._onMetadataCallback) {
        this._onMetadataCallback(metadata, infoDict);
      }
      
      this.emit('complete', { metadata, infoDict });
    } catch (err) {
      console.error('[MetadataDownloader] Error decoding metadata:', err);
      this.emit('error', err);
    }
  }
  
  /**
   * Request next metadata pieces from peers
   * @private
   */
  _requestNextPieces() {
    if (this.isComplete || !this.metadataSize) {
      return;
    }
    
    const numPieces = Math.ceil(this.metadataSize / METADATA_PIECE_SIZE);
    
    // Find pieces we need
    const neededPieces = [];
    for (let i = 0; i < numPieces; i++) {
      if (!this.pieces.has(i) && !this._requestedPieces.has(i)) {
        neededPieces.push(i);
      }
    }
    
    if (neededPieces.length === 0) {
      return;
    }
    
    console.log(`[MetadataDownloader] Requesting ${neededPieces.length} metadata pieces...`);
    
    // Request pieces from available peers
    // Note: In a real implementation, you'd get actual peer connections from peerManager
    // For now, we'll emit an event that the consumer can handle
    for (const pieceIndex of neededPieces) {
      this._requestedPieces.add(pieceIndex);
      this.emit('requestPiece', pieceIndex);
    }
  }
  
  /**
   * Send metadata piece request to a peer
   * @param {Object} peer - Peer connection
   * @param {number} pieceIndex - Piece index to request
   */
  requestPiece(peer, pieceIndex) {
    if (!peer || !peer.write) {
      return;
    }
    
    const peerId = peer.peerId || peer.host + ':' + peer.port;
    const peerInfo = this._peerExtensions.get(peerId);
    
    if (!peerInfo || !peerInfo.ut_metadata) {
      console.log('[MetadataDownloader] Peer does not support ut_metadata');
      return;
    }
    
    // Build request message
    const request = {
      msg_type: UT_METADATA_MSG_TYPES.REQUEST,
      piece: pieceIndex
    };
    
    const encoded = bencode.encode(request);
    
    // Build extended message: <len><id=20><ext_id=peer's_ut_metadata_id><bencoded_dict>
    const message = Buffer.alloc(2 + encoded.length);
    message[0] = EXTENDED_MESSAGE_ID; // Extended message
    message[1] = peerInfo.ut_metadata; // Peer's ut_metadata ID
    encoded.copy(message, 2);
    
    // Prepend length
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.length, 0);
    
    const packet = Buffer.concat([length, message]);
    
    peer.write(packet);
    console.log(`[MetadataDownloader] Requested piece ${pieceIndex} from peer`);
  }
  
  /**
   * Get download progress (0-1)
   */
  getProgress() {
    if (!this.metadataSize || this.metadataSize === 0) {
      return 0;
    }
    
    const numPieces = Math.ceil(this.metadataSize / METADATA_PIECE_SIZE);
    const downloaded = this.pieces.size;
    
    return downloaded / numPieces;
  }
}

/**
 * Check if reserved bytes indicate extension protocol support
 * @param {Buffer} reserved - 8-byte reserved field from handshake
 * @returns {boolean}
 */
function supportsExtensions(reserved) {
  if (!Buffer.isBuffer(reserved) || reserved.length !== 8) {
    return false;
  }
  
  // Check bit 20 (byte 5, bit 4)
  return (reserved[5] & 0x10) !== 0;
}

/**
 * Set extension protocol bit in reserved bytes
 * @param {Buffer} reserved - 8-byte reserved buffer
 */
function setExtensionBit(reserved) {
  if (!Buffer.isBuffer(reserved) || reserved.length !== 8) {
    throw new Error('Reserved must be an 8-byte Buffer');
  }
  
  // Set bit 20 (byte 5, bit 4)
  reserved[5] |= 0x10;
}

module.exports = {
  MetadataDownloader,
  EXTENSION_RESERVED_BIT,
  EXTENDED_MESSAGE_ID,
  EXTENDED_HANDSHAKE_ID,
  UT_METADATA_MSG_TYPES,
  METADATA_PIECE_SIZE,
  supportsExtensions,
  setExtensionBit
};
