/**
 * Magnet URI Parser and Generator
 * 
 * Magnet URI format:
 * magnet:?xt=urn:btih:<info_hash>&dn=<display_name>&tr=<tracker_url>&tr=<tracker_url>...
 * 
 * Parameters:
 * - xt (exact topic): Required. Contains the info hash in hex or base32 format.
 * - dn (display name): Optional. Human-readable name for the torrent.
 * - tr (tracker): Optional. Tracker URL. Can appear multiple times.
 * - x.pe (peer): Optional. Direct peer address in format "ip:port".
 * - ws (web seed): Optional. HTTP URL for web seeding.
 * 
 * @module magnet
 */

/**
 * Base32 alphabet according to RFC 4648
 * A-Z = 0-25, 2-7 = 26-31
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes a base32-encoded string to a Buffer
 * Implements RFC 4648 base32 encoding
 * 
 * @param {string} base32Str - Base32 encoded string
 * @returns {Buffer} Decoded binary data
 * @private
 */
function decodeBase32(base32Str) {
  // Remove padding and convert to uppercase
  const str = base32Str.replace(/=/g, '').toUpperCase();
  
  if (!/^[A-Z2-7]+$/.test(str)) {
    throw new Error('Invalid base32 string');
  }

  const bits = [];
  
  // Convert each base32 character to 5 bits
  for (let i = 0; i < str.length; i++) {
    const val = BASE32_ALPHABET.indexOf(str[i]);
    if (val === -1) {
      throw new Error(`Invalid base32 character: ${str[i]}`);
    }
    
    // Add 5 bits
    for (let j = 4; j >= 0; j--) {
      bits.push((val >> j) & 1);
    }
  }
  
  // Convert bits to bytes
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    if (i + 8 <= bits.length) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        byte = (byte << 1) | bits[i + j];
      }
      bytes.push(byte);
    }
  }
  
  return Buffer.from(bytes);
}

/**
 * Encodes a Buffer to base32 string
 * Implements RFC 4648 base32 encoding
 * 
 * @param {Buffer} buffer - Binary data to encode
 * @returns {string} Base32 encoded string
 * @private
 */
function encodeBase32(buffer) {
  const bits = [];
  
  // Convert bytes to bits
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    for (let j = 7; j >= 0; j--) {
      bits.push((byte >> j) & 1);
    }
  }
  
  // Convert 5 bits at a time to base32 characters
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    if (i + 5 <= bits.length) {
      let val = 0;
      for (let j = 0; j < 5; j++) {
        val = (val << 1) | bits[i + j];
      }
      result += BASE32_ALPHABET[val];
    } else {
      // Pad remaining bits with zeros
      let val = 0;
      const remaining = bits.length - i;
      for (let j = 0; j < remaining; j++) {
        val = (val << 1) | bits[i + j];
      }
      // Shift left to align
      val <<= (5 - remaining);
      result += BASE32_ALPHABET[val];
    }
  }
  
  return result;
}

/**
 * Parses a magnet URI and extracts torrent information
 * 
 * @param {string} magnetURI - The magnet link to parse
 * @returns {Object} Parsed magnet link data
 * @returns {string} returns.infoHash - 40-character lowercase hex info hash
 * @returns {Buffer} returns.infoHashBuffer - 20-byte Buffer of info hash
 * @returns {string|null} returns.displayName - Display name or null if not provided
 * @returns {string[]} returns.trackers - Array of tracker URLs (URL-decoded)
 * @returns {Array<{ip: string, port: number}>} returns.peers - Direct peers from x.pe
 * @returns {string[]} returns.webSeeds - Web seed URLs
 * 
 * @throws {Error} If magnet URI is invalid or missing required parameters
 * 
 * @example
 * const info = parseMagnet('magnet:?xt=urn:btih:ABCD1234...&dn=My%20File&tr=http://tracker.com');
 * console.log(info.infoHash); // 'abcd1234...' (40 hex chars)
 * console.log(info.displayName); // 'My File'
 * console.log(info.trackers); // ['http://tracker.com']
 */
function parseMagnet(magnetURI) {
  if (!magnetURI || typeof magnetURI !== 'string') {
    throw new Error('Magnet URI must be a non-empty string');
  }

  // Check if it starts with magnet:?
  if (!magnetURI.startsWith('magnet:?')) {
    throw new Error('Invalid magnet URI: must start with "magnet:?"');
  }

  // Extract query string
  const queryString = magnetURI.slice(8); // Remove "magnet:?"
  
  if (!queryString) {
    throw new Error('Invalid magnet URI: no parameters');
  }

  // Parse query parameters
  const params = new URLSearchParams(queryString);
  
  // Extract xt (exact topic) - required
  const xt = params.get('xt');
  if (!xt) {
    throw new Error('Invalid magnet URI: missing xt parameter');
  }

  // Parse info hash from xt
  let infoHashBuffer;
  let infoHash;

  if (xt.startsWith('urn:btih:')) {
    const hashPart = xt.slice(9); // Remove "urn:btih:"
    
    if (hashPart.length === 40) {
      // Hex format (40 characters)
      if (!/^[a-fA-F0-9]{40}$/.test(hashPart)) {
        throw new Error('Invalid info hash: must be 40 hex characters');
      }
      infoHash = hashPart.toLowerCase();
      infoHashBuffer = Buffer.from(infoHash, 'hex');
    } else if (hashPart.length === 32) {
      // Base32 format (32 characters)
      try {
        infoHashBuffer = decodeBase32(hashPart);
        if (infoHashBuffer.length !== 20) {
          throw new Error('Decoded base32 info hash must be 20 bytes');
        }
        infoHash = infoHashBuffer.toString('hex');
      } catch (error) {
        throw new Error(`Invalid base32 info hash: ${error.message}`);
      }
    } else {
      throw new Error('Invalid info hash: must be 40 hex characters or 32 base32 characters');
    }
  } else {
    throw new Error('Invalid xt parameter: must start with "urn:btih:"');
  }

  // Extract dn (display name) - optional
  const displayName = params.get('dn') ? decodeURIComponent(params.get('dn')) : null;

  // Extract tr (trackers) - can be multiple
  const trackers = [];
  params.forEach((value, key) => {
    if (key === 'tr') {
      try {
        trackers.push(decodeURIComponent(value));
      } catch (error) {
        // Skip malformed tracker URLs
        console.warn(`Failed to decode tracker URL: ${value}`);
      }
    }
  });

  // Extract x.pe (peers) - can be multiple
  const peers = [];
  params.forEach((value, key) => {
    if (key === 'x.pe') {
      try {
        const decoded = decodeURIComponent(value);
        const match = decoded.match(/^(.+):(\d+)$/);
        if (match) {
          peers.push({
            ip: match[1],
            port: parseInt(match[2], 10)
          });
        }
      } catch (error) {
        console.warn(`Failed to parse peer: ${value}`);
      }
    }
  });

  // Extract ws (web seeds) - can be multiple
  const webSeeds = [];
  params.forEach((value, key) => {
    if (key === 'ws') {
      try {
        webSeeds.push(decodeURIComponent(value));
      } catch (error) {
        console.warn(`Failed to decode web seed URL: ${value}`);
      }
    }
  });

  return {
    infoHash,
    infoHashBuffer,
    displayName,
    trackers,
    peers,
    webSeeds
  };
}

/**
 * Creates a magnet URI from torrent information
 * 
 * @param {Object} options - Torrent information
 * @param {string|Buffer} options.infoHash - Info hash (40-char hex string or 20-byte Buffer)
 * @param {string} [options.displayName] - Display name for the torrent
 * @param {string[]} [options.trackers] - Array of tracker URLs
 * @returns {string} Magnet URI
 * 
 * @throws {Error} If options are invalid
 * 
 * @example
 * const magnet = createMagnet({
 *   infoHash: 'abc123def456...', // 40 hex chars
 *   displayName: 'My File',
 *   trackers: ['http://tracker1.com', 'http://tracker2.com']
 * });
 * // Returns: 'magnet:?xt=urn:btih:abc123def456...&dn=My%20File&tr=http%3A%2F%2Ftracker1.com&tr=...'
 */
function createMagnet(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Options must be an object');
  }

  const { infoHash, displayName, trackers } = options;

  if (!infoHash) {
    throw new Error('infoHash is required');
  }

  // Convert infoHash to hex string if it's a Buffer
  let infoHashHex;
  if (Buffer.isBuffer(infoHash)) {
    if (infoHash.length !== 20) {
      throw new Error('infoHash Buffer must be 20 bytes');
    }
    infoHashHex = infoHash.toString('hex');
  } else if (typeof infoHash === 'string') {
    if (!/^[a-fA-F0-9]{40}$/.test(infoHash)) {
      throw new Error('infoHash string must be 40 hex characters');
    }
    infoHashHex = infoHash.toLowerCase();
  } else {
    throw new Error('infoHash must be a Buffer or hex string');
  }

  // Build magnet URI
  let magnetURI = `magnet:?xt=urn:btih:${infoHashHex}`;

  // Add display name if provided
  if (displayName) {
    magnetURI += `&dn=${encodeURIComponent(displayName)}`;
  }

  // Add trackers if provided
  if (Array.isArray(trackers)) {
    for (const tracker of trackers) {
      if (tracker) {
        magnetURI += `&tr=${encodeURIComponent(tracker)}`;
      }
    }
  }

  return magnetURI;
}

module.exports = {
  parseMagnet,
  createMagnet,
  decodeBase32,
  encodeBase32
};
