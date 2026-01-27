const crypto = require('crypto');
const { decode, encode } = require('./bencode');

/**
 * Parses a .torrent file and extracts metadata
 * @param {Buffer} buffer - The .torrent file content
 * @returns {Object} Parsed torrent metadata
 */
function parseTorrent(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Input must be a Buffer');
  }

  let torrent;
  try {
    torrent = decode(buffer);
  } catch (error) {
    throw new Error(`Failed to decode torrent: ${error.message}`);
  }

  if (!torrent || typeof torrent !== 'object' || Array.isArray(torrent)) {
    throw new Error('Invalid torrent: root must be a dictionary');
  }

  if (!torrent.info) {
    throw new Error('Invalid torrent: missing info dictionary');
  }

  const info = torrent.info;

  // Calculate info_hash by re-encoding info dict and hashing
  const infoHashBuffer = calculateInfoHash(info);
  const infoHash = infoHashBuffer.toString('hex');

  // Extract required fields from info dict
  const name = extractString(info.name, 'info.name');
  const pieceLength = extractNumber(info['piece length'], 'info.piece length');
  const pieces = extractPieces(info.pieces);

  // Determine if single-file or multi-file
  const isMultiFile = info.files !== undefined;
  let length;
  let files = null;

  if (isMultiFile) {
    files = extractFiles(info.files);
    length = files.reduce((sum, file) => sum + file.length, 0);
  } else {
    length = extractNumber(info.length, 'info.length');
  }

  // Extract announce URLs
  const announce = extractString(torrent.announce, 'announce');
  const announceList = extractAnnounceList(torrent['announce-list']);

  // Extract optional fields
  const isPrivate = info.private === 1;

  return {
    infoHash,
    infoHashBuffer,
    name,
    pieceLength,
    pieces,
    length,
    files,
    isMultiFile,
    announce,
    announceList,
    private: isPrivate
  };
}

function calculateInfoHash(info) {
  try {
    const bencodedInfo = encode(info);
    return crypto.createHash('sha1').update(bencodedInfo).digest();
  } catch (error) {
    throw new Error(`Failed to calculate info hash: ${error.message}`);
  }
}

function extractString(value, fieldName) {
  if (!value) {
    throw new Error(`Missing required field: ${fieldName}`);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid type for ${fieldName}: expected string or Buffer`);
}

function extractNumber(value, fieldName) {
  if (typeof value !== 'number') {
    throw new Error(`Missing or invalid ${fieldName}: expected number`);
  }
  if (value < 0) {
    throw new Error(`Invalid ${fieldName}: must be non-negative`);
  }
  return value;
}

function extractPieces(piecesData) {
  if (!piecesData) {
    throw new Error('Missing required field: info.pieces');
  }

  const piecesBuffer = Buffer.isBuffer(piecesData) ? piecesData : Buffer.from(piecesData);

  if (piecesBuffer.length % 20 !== 0) {
    throw new Error(`Invalid pieces length: must be multiple of 20, got ${piecesBuffer.length}`);
  }

  const pieces = [];
  for (let i = 0; i < piecesBuffer.length; i += 20) {
    pieces.push(piecesBuffer.slice(i, i + 20));
  }

  return pieces;
}

function extractFiles(filesData) {
  if (!Array.isArray(filesData)) {
    throw new Error('Invalid files: expected array');
  }

  if (filesData.length === 0) {
    throw new Error('Invalid files: array cannot be empty');
  }

  return filesData.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error(`Invalid file at index ${index}: expected dictionary`);
    }

    const fileLength = extractNumber(file.length, `files[${index}].length`);

    if (!Array.isArray(file.path) || file.path.length === 0) {
      throw new Error(`Invalid path at files[${index}]: expected non-empty array`);
    }

    const pathComponents = file.path.map((component, i) => {
      const comp = Buffer.isBuffer(component) ? component.toString('utf8') : component;
      if (typeof comp !== 'string') {
        throw new Error(`Invalid path component at files[${index}].path[${i}]`);
      }
      return comp;
    });

    return {
      path: pathComponents.join('/'),
      length: fileLength
    };
  });
}

function extractAnnounceList(announceListData) {
  if (!announceListData) {
    return [];
  }

  if (!Array.isArray(announceListData)) {
    return [];
  }

  const result = [];
  for (const tier of announceListData) {
    if (!Array.isArray(tier)) {
      continue;
    }

    const tierUrls = tier
      .map(url => {
        if (Buffer.isBuffer(url)) {
          return url.toString('utf8');
        }
        return typeof url === 'string' ? url : null;
      })
      .filter(url => url !== null);

    if (tierUrls.length > 0) {
      result.push(tierUrls);
    }
  }

  return result;
}

module.exports = { parseTorrent };
