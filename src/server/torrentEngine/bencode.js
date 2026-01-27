/**
 * Bencode Decoder for BitTorrent
 * 
 * Bencode is the encoding used by BitTorrent for storing and transmitting loosely structured data.
 * It supports four data types:
 * 
 * 1. Integers: i<integer encoded in base ten ASCII>e
 *    Example: i42e → 42, i-3e → -3, i0e → 0
 * 
 * 2. Byte strings: <length>:<contents>
 *    Example: 4:spam → Buffer("spam"), 0: → Buffer("")
 *    Note: Always returns Buffer since .torrent files contain binary data
 * 
 * 3. Lists: l<bencoded values>e
 *    Example: l4:spami42ee → [Buffer("spam"), 42]
 * 
 * 4. Dictionaries: d<bencoded string><bencoded element>e
 *    Example: d3:fooi42ee → {foo: Buffer("foo"): 42}
 *    Keys must be byte strings and appear in sorted order
 */

/**
 * Decodes a bencoded Buffer into a JavaScript value
 * 
 * @param {Buffer} buffer - The bencoded data to decode
 * @returns {*} The decoded JavaScript value (number, Buffer, array, or object)
 * @throws {Error} If the input is malformed or invalid
 * 
 * @example
 * const bencode = require('./bencode');
 * const result = bencode.decode(Buffer.from('d4:name5:hello3:numi42ee'));
 * // result = { name: <Buffer 68 65 6c 6c 6f>, num: 42 }
 */
function decode(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Input must be a Buffer');
  }

  let position = 0;

  /**
   * Parses an integer from the buffer
   * Format: i<number>e
   * @returns {number} The parsed integer
   */
  function parseInteger() {
    position++; // skip 'i'
    
    // Find the ending 'e'
    let endIdx = position;
    while (endIdx < buffer.length && buffer[endIdx] !== 0x65) { // 0x65 is 'e'
      endIdx++;
    }
    
    if (endIdx >= buffer.length) {
      throw new Error('Invalid integer: missing end marker "e"');
    }
    
    // Extract the number string
    const numberStr = buffer.toString('utf8', position, endIdx);
    
    if (numberStr === '') {
      throw new Error('Invalid integer: empty value');
    }
    
    // Validate: no leading zeros except for "0", and no "-0"
    if ((numberStr[0] === '0' && numberStr.length > 1) || 
        (numberStr[0] === '-' && numberStr[1] === '0')) {
      throw new Error(`Invalid integer encoding: ${numberStr} (no leading zeros allowed)`);
    }
    
    position = endIdx + 1; // move past 'e'
    
    const num = parseInt(numberStr, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid integer: ${numberStr}`);
    }
    
    return num;
  }

  /**
   * Parses a byte string from the buffer
   * Format: <length>:<content>
   * @returns {Buffer} The parsed byte string as a Buffer
   */
  function parseByteString() {
    // Find the colon separator
    let colonIdx = position;
    while (colonIdx < buffer.length && buffer[colonIdx] !== 0x3a) { // 0x3a is ':'
      colonIdx++;
    }
    
    if (colonIdx >= buffer.length) {
      throw new Error('Invalid byte string: missing colon separator');
    }
    
    // Parse the length
    const lengthStr = buffer.toString('utf8', position, colonIdx);
    
    if (lengthStr === '') {
      throw new Error('Invalid byte string: missing length');
    }
    
    // Validate no leading zeros (except "0" itself)
    if (lengthStr[0] === '0' && lengthStr.length > 1) {
      throw new Error(`Invalid byte string length: ${lengthStr} (no leading zeros allowed)`);
    }
    
    const length = parseInt(lengthStr, 10);
    
    if (isNaN(length) || length < 0) {
      throw new Error(`Invalid byte string length: ${lengthStr}`);
    }
    
    position = colonIdx + 1; // move past colon
    
    // Extract the byte string content
    const endIdx = position + length;
    if (endIdx > buffer.length) {
      throw new Error(`Byte string length exceeds buffer: expected ${length} bytes but only ${buffer.length - position} available`);
    }
    
    const content = buffer.slice(position, endIdx);
    position = endIdx;
    
    // Always return as Buffer (binary data)
    return content;
  }

  /**
   * Parses a list from the buffer
   * Format: l<bencoded values>e
   * @returns {Array} The parsed array
   */
  function parseList() {
    position++; // skip 'l'
    
    const list = [];
    
    while (position < buffer.length && buffer[position] !== 0x65) { // 0x65 is 'e'
      list.push(parseNext());
    }
    
    if (position >= buffer.length) {
      throw new Error('Invalid list: missing end marker "e"');
    }
    
    position++; // skip 'e'
    return list;
  }

  /**
   * Parses a dictionary from the buffer
   * Format: d<bencoded string><bencoded element>e
   * @returns {Object} The parsed object
   */
  function parseDictionary() {
    position++; // skip 'd'
    
    const dict = {};
    
    while (position < buffer.length && buffer[position] !== 0x65) { // 0x65 is 'e'
      // Keys must be byte strings
      if (!isByteStringStart()) {
        throw new Error(`Dictionary key must be a byte string at position ${position}`);
      }
      
      const keyBuffer = parseByteString();
      
      // Convert key Buffer to string for JavaScript object key
      const key = keyBuffer.toString('utf8');
      
      // Parse the value
      if (position >= buffer.length) {
        throw new Error(`Dictionary key "${key}" has no value`);
      }
      
      const value = parseNext();
      dict[key] = value;
    }
    
    if (position >= buffer.length) {
      throw new Error('Invalid dictionary: missing end marker "e"');
    }
    
    position++; // skip 'e'
    return dict;
  }

  /**
   * Checks if the current position starts a byte string
   * @returns {boolean} True if current byte is a digit (0-9)
   */
  function isByteStringStart() {
    const byte = buffer[position];
    return byte >= 0x30 && byte <= 0x39; // ASCII '0' to '9'
  }

  /**
   * Parses the next value based on the current position
   * @returns {*} The parsed value
   */
  function parseNext() {
    if (position >= buffer.length) {
      throw new Error('Unexpected end of buffer');
    }
    
    const byte = buffer[position];
    
    if (byte === 0x69) { // 'i' - integer
      return parseInteger();
    } else if (byte === 0x6c) { // 'l' - list
      return parseList();
    } else if (byte === 0x64) { // 'd' - dictionary
      return parseDictionary();
    } else if (isByteStringStart()) { // digit - byte string
      return parseByteString();
    } else {
      throw new Error(`Invalid bencode data at position ${position}: unexpected byte 0x${byte.toString(16)}`);
    }
  }

  // Start parsing from the beginning
  const result = parseNext();
  
  // Ensure we've consumed the entire buffer
  if (position !== buffer.length) {
    throw new Error(`Unexpected data after bencode structure: ${buffer.length - position} bytes remaining`);
  }
  
  return result;
}

/**
 * Encodes a JavaScript value into bencoded Buffer
 * @param {*} value - Value to encode (number, string, Buffer, array, or object)
 * @returns {Buffer} Bencoded data
 */
function encode(value) {
  const buffers = [];

  function encodeInteger(num) {
    if (!Number.isInteger(num)) {
      throw new Error(`Cannot encode non-integer number: ${num}`);
    }
    buffers.push(Buffer.from(`i${num}e`));
  }

  function encodeByteString(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    buffers.push(Buffer.from(`${buf.length}:`));
    buffers.push(buf);
  }

  function encodeList(arr) {
    buffers.push(Buffer.from('l'));
    for (const item of arr) {
      encodeValue(item);
    }
    buffers.push(Buffer.from('e'));
  }

  function encodeDictionary(obj) {
    buffers.push(Buffer.from('d'));
    
    // Sort keys alphabetically (byte-order)
    const keys = Object.keys(obj).sort();
    
    for (const key of keys) {
      encodeByteString(key);
      encodeValue(obj[key]);
    }
    
    buffers.push(Buffer.from('e'));
  }

  function encodeValue(val) {
    if (val === null || val === undefined) {
      throw new Error('Cannot encode null or undefined');
    }

    const type = typeof val;

    if (type === 'number') {
      encodeInteger(val);
    } else if (type === 'string') {
      encodeByteString(val);
    } else if (Buffer.isBuffer(val)) {
      encodeByteString(val);
    } else if (Array.isArray(val)) {
      encodeList(val);
    } else if (type === 'object') {
      encodeDictionary(val);
    } else {
      throw new Error(`Cannot encode type: ${type}`);
    }
  }

  encodeValue(value);
  return Buffer.concat(buffers);
}

module.exports = { decode, encode };
