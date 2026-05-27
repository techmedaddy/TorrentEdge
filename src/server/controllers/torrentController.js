/**
 * Torrent Controller
 * 
 * Manages torrent operations using the integrated BitTorrent engine.
 * All torrents are stored in PostgreSQL for persistence and merged with
 * live engine stats for real-time data.
 * 
 * API Endpoints:
 * - GET    /api/torrent               - Get all user's torrents with live stats
 * - GET    /api/torrent/:id           - Get torrent by ID/infoHash with live stats
 * - POST   /api/torrent/create        - Upload .torrent file or magnet URI and add to engine
 * - POST   /api/torrent/create-from-file - Generate a torrent from an uploaded source file
 * - PUT    /api/torrent/:id           - Update torrent metadata
 * - DELETE /api/torrent/:id           - Delete torrent (?deleteFiles=true to remove files)
 * - GET    /api/torrent/search        - Search torrents by name
 * - POST   /api/torrent/:id/start     - Start downloading torrent
 * - POST   /api/torrent/:id/pause     - Pause torrent download
 * - POST   /api/torrent/:id/resume    - Resume paused torrent
 * - GET    /api/torrent/:id/stats     - Get real-time torrent statistics
 * - GET    /api/torrent/engine/stats  - Get global engine statistics
 */

const { Transfer, User, TransferLeecher } = require('../models/sql'); // Phase 1.1 SQL Model
const { defaultEngine } = require('../torrentEngine');
const { broadcast } = require('../socket');
const path = require('path');
const fs = require('fs').promises;
const Checkpointer = require('../torrentEngine/checkpointer'); // Phase 1.2 CAS
const ResumeService = require('../torrentEngine/resumeService'); // Phase 1.3 Idempotent Resume
const { defaultDispatcher, DIRECTIVE_TYPES } = require('../torrentEngine'); // Phase 2.1 Dispatcher
const { parseTorrent } = require('../torrentEngine/torrentParser');

// Helper to validate UUID
const isValidObjectId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

// Helper to merge PostgreSQL data with live engine stats
const mergeTorrentData = (dbTorrent, engineTorrent) => {
  const data = dbTorrent.toJSON ? dbTorrent.toJSON() : dbTorrent;
  
  // Always map id to _id and info_hash to infoHash for frontend compatibility
  const mappedData = {
    ...data,
    _id: data.id || data._id,
    infoHash: data.info_hash || data.infoHash
  };

  if (!engineTorrent) {
    return mappedData;
  }

  const stats = engineTorrent.getStats();
  return {
    ...mappedData,
    status: stats.state,
    progress: stats.percentage,
    downloadSpeed: stats.downloadSpeed,
    uploadSpeed: stats.uploadSpeed,
    seeds: stats.seeds,
    leeches: stats.leeches,
    peers: stats.peers,
    eta: stats.eta,
    completedPieces: stats.completedPieces,
    totalPieces: stats.pieceCount,
    activePieces: stats.activePieces,
    pendingRequests: stats.pendingRequests
  };
};

const getUserId = (req) => req.user.userId || req.user.id;

const buildMergedResponse = (dbTorrent, isOwner) => {
  const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
  const merged = mergeTorrentData(dbTorrent, engineTorrent);
  merged.isOwner = isOwner;
  return merged;
};

const findExistingTorrentByInfoHash = async (infoHash) => Transfer.findOne({
  where: { info_hash: infoHash.toLowerCase() },
  include: [{ model: User, as: 'leechers', attributes: ['id'] }]
});

const resolveUploadInput = async (req) => {
  const torrentBuffer = req.file.buffer;
  const torrentsDir = path.join(process.env.DOWNLOAD_PATH || './downloads', '.torrentedge', 'torrents');
  await fs.mkdir(torrentsDir, { recursive: true });
  const torrentPath = path.join(torrentsDir, `${Date.now()}-${req.file.originalname}`);
  await fs.writeFile(torrentPath, torrentBuffer);
  return { torrentBuffer, torrentPath };
};

const resolveMagnetInput = async (magnetURI) => {
  const { parseMagnet } = require('../torrentEngine/magnet');
  try {
    return { magnetInfo: parseMagnet(magnetURI) };
  } catch (error) {
    return { error: { status: 400, message: `Invalid magnet link: ${error.message}` } };
  }
};

const handleExistingMagnetTorrent = async (existingTorrent, req, res) => {
  const userId = getUserId(req);
  const alreadyOwner = existingTorrent.uploaded_by === userId;
  const alreadyLeeching = existingTorrent.leechers && existingTorrent.leechers.some(l => l.id === userId);

  if (alreadyOwner || alreadyLeeching) {
    const merged = buildMergedResponse(existingTorrent, alreadyOwner);
    res.status(200).json({ message: 'Already in your list', torrent: merged });
    return true;
  }

  await TransferLeecher.create({ transfer_id: existingTorrent.id, user_id: userId });
  console.log(`[TorrentController] User ${userId} added as leecher for: ${existingTorrent.name}`);
  const merged = buildMergedResponse(existingTorrent, false);
  res.status(200).json(merged);
  return true;
};

const handleDispatcherAlreadyExists = async (error, magnetURI, req, res) => {
  if (!error.message || !error.message.toLowerCase().includes('already exists')) {
    return false;
  }

  try {
    const { parseMagnet } = require('../torrentEngine/magnet');
    const magnetInfo = magnetURI ? parseMagnet(magnetURI) : null;
    const infoHash = magnetInfo?.infoHash?.toLowerCase();

    if (infoHash) {
      const existingTorrent = await findExistingTorrentByInfoHash(infoHash);

      if (existingTorrent) {
        const isOwner = existingTorrent.uploaded_by === getUserId(req);
        const merged = buildMergedResponse(existingTorrent, isOwner);
        console.log(`[TorrentController] Idempotent recovery: returning existing record for ${infoHash.substring(0, 12)}`);
        res.status(200).json({ message: 'Already exists', torrent: merged });
        return true;
      }
    }
  } catch (recoveryErr) {
    console.warn(`[TorrentController] Recovery lookup failed: ${recoveryErr.message}`);
  }

  res.status(409).json({ message: 'Transfer already in progress on this node' });
  return true;
};

const resolveFinalMeta = (engineTorrent, magnetURI) => {
  let finalInfoHash = null;
  let finalName = null;
  let finalSize = 0;
  let finalState = magnetURI ? 'fetching_metadata' : 'pending';

  if (engineTorrent) {
    finalInfoHash = engineTorrent.infoHash.toLowerCase();
    finalName = engineTorrent.name;
    finalSize = engineTorrent.size || 0;
    finalState = engineTorrent.state || finalState;
    return { finalInfoHash, finalName, finalSize, finalState };
  }

  if (magnetURI) {
    try {
      const { parseMagnet } = require('../torrentEngine/magnet');
      const magnetInfo = parseMagnet(magnetURI);
      finalInfoHash = magnetInfo.infoHash.toLowerCase();
      finalName = magnetInfo.displayName || `Magnet-${finalInfoHash.substring(0, 8)}`;
      return { finalInfoHash, finalName, finalSize, finalState };
    } catch (e) {}
  }

  return {
    finalInfoHash: `temp-${Date.now()}`,
    finalName: `Upload-${Date.now()}`,
    finalSize,
    finalState
  };
};

const getEngineStats = (engineTorrent) => {
  if (!engineTorrent) return null;
  try {
    return engineTorrent.getStats();
  } catch (err) {
    console.log('[TorrentController] Stats not available yet (magnet link fetching metadata)');
    return null;
  }
};

const SAFE_TYPES = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.md', '.csv', '.json', '.xml',
  '.mp3', '.mp4', '.mkv', '.avi', '.mov', '.wav', '.flac', '.ogg',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.js', '.ts', '.py', '.html', '.css', '.epub', '.iso',
]);

const WARN_TYPES = new Set([
  '.exe', '.dll', '.bat', '.sh', '.cmd', '.msi', '.deb', '.rpm',
  '.apk', '.dmg', '.pkg',
]);

const validateUploadedFile = (req) => {
  if (!req.file) {
    return { error: { status: 400, payload: { error: 'No file uploaded. Send a file in the "file" field.' } } };
  }

  const uploadedFilePath = req.file.path;
  const fileSize = req.file.size;

  if (!uploadedFilePath || fileSize === 0) {
    return { error: { status: 400, payload: { error: 'Uploaded file is empty.' } } };
  }

  return {
    uploadedFilePath,
    fileSize,
    mimeType: req.file.mimetype || 'application/octet-stream',
    originalName: req.file.originalname || 'untitled',
    ext: path.extname(req.file.originalname || '').toLowerCase()
  };
};

const enforceMaxFileSize = async (uploadedFilePath, fileSize) => {
  const MAX_BYTES = parseInt(process.env.MAX_SEED_FILE_SIZE, 10) || (2 * 1024 * 1024 * 1024);
  if (fileSize <= MAX_BYTES) {
    return { maxBytes: MAX_BYTES };
  }

  const limitMB = (MAX_BYTES / (1024 * 1024)).toFixed(0);
  await fs.unlink(uploadedFilePath).catch(() => {});
  return {
    error: {
      status: 413,
      payload: {
        error: `File too large. Maximum allowed size is ${limitMB} MB.`,
        maxBytes: MAX_BYTES,
        fileBytes: fileSize,
      }
    }
  };
};

const buildFileWarnings = (ext) => {
  const warnings = [];
  if (WARN_TYPES.has(ext)) {
    warnings.push(`File type "${ext}" is an executable. Make sure you intended to share this.`);
  } else if (ext && !SAFE_TYPES.has(ext)) {
    warnings.push(`File type "${ext}" is uncommon — proceeding anyway.`);
  }

  if (!ext) {
    warnings.push('File has no extension — torrent will still be created, but recipients may not know the file type.');
  }

  return warnings;
};

const parseCreateFromFileOptions = (req, originalName) => {
  const rawName = req.body.name || originalName || 'untitled';
  const rawPrivate = req.body.private === 'true' || req.body.private === true;

  let trackers;
  if (req.body.trackers) {
    try {
      trackers = typeof req.body.trackers === 'string'
        ? JSON.parse(req.body.trackers)
        : req.body.trackers;
      if (!Array.isArray(trackers)) {
        return { error: { status: 400, payload: { error: 'trackers must be a JSON array of strings.' } } };
      }
    } catch {
      return { error: { status: 400, payload: { error: 'Invalid trackers format. Expected JSON array e.g. ["udp://..."]' } } };
    }
  }

  let pieceSize;
  if (req.body.pieceSize) {
    pieceSize = parseInt(req.body.pieceSize, 10);
    if (isNaN(pieceSize)) {
      return { error: { status: 400, payload: { error: 'pieceSize must be a number.' } } };
    }
  }

  return { rawName, rawPrivate, trackers, pieceSize };
};

const buildProgressEmitter = (req, originalName, pieceCount) => {
  if (pieceCount <= 1) return undefined;

  let lastEmittedPct = -1;
  let lastEmitTime = 0;
  const THROTTLE_MS = 100;

  return (hashed, total) => {
    const pct = Math.floor((hashed / total) * 100);
    const now = Date.now();
    if (pct !== lastEmittedPct && (now - lastEmitTime) >= THROTTLE_MS) {
      lastEmittedPct = pct;
      lastEmitTime = now;
      try {
        broadcast('torrent:hash-progress', {
          userId: req.user?._id?.toString() || req.user?.id,
          fileName: originalName,
          hashed,
          total,
          percent: pct,
        });
      } catch (_) { /* socket not yet ready — non-fatal */ }
    }
  };
};

const emitHashComplete = (req, originalName, pieceCount) => {
  try {
    broadcast('torrent:hash-progress', {
      userId: req.user?._id?.toString() || req.user?.id,
      fileName: originalName,
      hashed: pieceCount,
      total: pieceCount,
      percent: 100,
      done: true,
    });
  } catch (_) {}
};

const persistCreatedFiles = async (created, originalName, fileBuffer) => {
  const baseDir = process.env.DOWNLOAD_PATH || './downloads';
  const seedsDir = path.join(baseDir, '.torrentedge', 'seeds');
  const torrentsDir = path.join(baseDir, '.torrentedge', 'torrents');

  await fs.mkdir(seedsDir, { recursive: true });
  await fs.mkdir(torrentsDir, { recursive: true });

  const safeOrigName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const hashPrefix = created.infoHash.slice(0, 8);

  const savedSourcePath = path.join(seedsDir, `${hashPrefix}-${safeOrigName}`);
  const savedTorrentPath = path.join(torrentsDir, `${hashPrefix}-${safeOrigName}.torrent`);

  await fs.writeFile(savedSourcePath, fileBuffer);
  await fs.writeFile(savedTorrentPath, created.torrentBuffer);

  console.log(`[TorrentController] Saved source file  : ${savedSourcePath}`);
  console.log(`[TorrentController] Saved .torrent file: ${savedTorrentPath}`);

  return { savedSourcePath, savedTorrentPath };
};

const saveCreatedTorrent = async (created, savedSourcePath, req) => {
  try {
    const torrent = await Transfer.create({
      name: created.name,
      info_hash: created.infoHash.toLowerCase(),
      magnet_uri: created.magnetURI,
      size_bytes: created.fileSize,
      status: 'seeding',
      progress: 100,
      uploaded_by: getUserId(req),
      source_path: savedSourcePath
    });

    if (created.chunkHashes && created.chunkHashes.length > 0) {
      await Checkpointer.initializeChunks(created.infoHash, created.chunkHashes, torrent.id);
      await Checkpointer.markChunksVerifiedBulk(created.infoHash, created.chunkHashes);
    }

    return torrent;
  } catch (sqlErr) {
    console.error('[TorrentController] SQL Dual-Write failed:', sqlErr.message);
    return null;
  }
};

const scheduleAutoSeed = (created, savedSourcePath) => {
  setImmediate(async () => {
    try {
      await defaultEngine.seedFromFile({
        torrentBuffer: created.torrentBuffer,
        sourcePath: savedSourcePath,
        downloadPath: path.join(process.env.DOWNLOAD_PATH || './downloads', 'seeds'),
        autoStart: true,
      });
      console.log(`[TorrentController] Engine seeding started: ${created.infoHash}`);

      const engineTorrent = defaultEngine.getTorrent(created.infoHash);
      if (engineTorrent && typeof engineTorrent._transitionToSeeding === 'function') {
        if (engineTorrent._state !== 'seeding') {
          await engineTorrent._transitionToSeeding();
          console.log(`[TorrentController] Force-transitioned to seeding: ${created.infoHash}`);
        }
      }

      await Transfer.update(
        { status: 'seeding', progress: 100 },
        { where: { info_hash: created.infoHash.toLowerCase() } }
      );
    } catch (err) {
      console.warn(`[TorrentController] Engine seed failed (non-fatal): ${err.message}`);
    }
  });
};

const findTorrentByIdOrHash = async (id) => {
  if (isValidObjectId(id)) {
    return Transfer.findByPk(id);
  }

  return Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
};

const buildFilesFromParsedTorrent = (parsed) => {
  const rawFiles = parsed.files || [{ path: parsed.name, length: parsed.length }];
  return rawFiles.map((f, index) => ({
    index,
    path: f.path,
    name: Array.isArray(f.path) ? f.path[f.path.length - 1] : f.path,
    length: f.length,
    selected: true
  }));
};

const buildFilesFromDbFallback = (dbTorrent) => ([{
  index: 0,
  path: dbTorrent.name,
  name: dbTorrent.name,
  length: dbTorrent.size_bytes || 0,
  selected: true
}]);

const getFilesForTorrent = async (dbTorrent, engineTorrent) => {
  if (engineTorrent) {
    return engineTorrent.getFilesWithSelection();
  }

  if (dbTorrent.torrent_file_path) {
    try {
      const torrentBuffer = await fs.readFile(dbTorrent.torrent_file_path);
      const parsed = parseTorrent(torrentBuffer);
      return buildFilesFromParsedTorrent(parsed);
    } catch (err) {
      console.error('[TorrentController] Failed to parse .torrent fallback:', err);
    }
  }

  return buildFilesFromDbFallback(dbTorrent);
};

const resolveDownloadPath = async (baseDir, selectedFile, dbTorrent) => {
  const relativePath = Array.isArray(selectedFile.path) ? selectedFile.path.join(path.sep) : selectedFile.path;
  const absolutePath = path.resolve(baseDir, relativePath);
  const seedPath = path.resolve(baseDir, 'seeds', relativePath);
  const sourcePath = dbTorrent.source_path ? path.resolve(dbTorrent.source_path) : null;

  const pathsToTry = [absolutePath, seedPath];
  if (sourcePath) pathsToTry.push(sourcePath);

  for (const p of pathsToTry) {
    try {
      await fs.access(p);
      return p;
    } catch (e) {
      // Continue to next path
    }
  }

  return null;
};

// Get all torrents for the authenticated user
exports.getAllTorrents = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    // 2.1 — show torrents where user is uploader OR downloader
    const qry = {
      include: [
        { model: User, as: 'uploader', attributes: ['id', 'username'] },
        { model: User, as: 'leechers', attributes: ['id'] }
      ],
      order: [['createdAt', 'DESC']]
    };
    
    const allTorrents = await Transfer.findAll(qry);
    
    const torrents = allTorrents.filter(t => 
      t.uploaded_by === userId || 
      t.leechers.some(l => l.id === userId)
    );

    // Merge with live engine stats + attach isOwner flag
    const mergedTorrents = torrents.map(torrent => {
      const engineTorrent = defaultEngine.getTorrent(torrent.info_hash);
      const merged = mergeTorrentData(torrent, engineTorrent);
      merged.isOwner = torrent.uploaded_by === userId;
      return merged;
    });

    res.json(mergedTorrents);
  } catch (error) {
    console.error('[TorrentController] getAllTorrents error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get torrent by ID or infoHash
exports.getTorrentById = async (req, res) => {
  try {
    let torrent;

    const qry = {
      include: [
        { model: User, as: 'uploader', attributes: ['id', 'username', 'email'] },
        { model: User, as: 'leechers', attributes: ['id'] }
      ]
    };

    if (isValidObjectId(req.params.id)) {
      torrent = await Transfer.findByPk(req.params.id, qry);
    } else {
      torrent = await Transfer.findOne({ where: { info_hash: req.params.id.toLowerCase() }, ...qry });
    }

    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const userId = req.user.userId || req.user.id;
    const isOwner = torrent.uploader && torrent.uploader.id === userId;
    const isLeecher = torrent.leechers && torrent.leechers.some(l => l.id === userId);

    if (!isOwner && !isLeecher) {
      return res.status(403).json({ message: 'Not authorized to view this torrent' });
    }

    // Merge with live engine stats + attach isOwner flag
    const engineTorrent = defaultEngine.getTorrent(torrent.info_hash);
    const mergedData = mergeTorrentData(torrent, engineTorrent);
    mergedData.isOwner = isOwner;

    res.json(mergedData);
  } catch (error) {
    console.error('[TorrentController] getTorrentById error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Create a new torrent (from file upload or magnet URI)
exports.createTorrent = async (req, res) => {
  try {
    const { magnetURI, autoStart = true } = req.body;
    let torrentBuffer = null;
    let torrentPath = null;
    let magnetInfo = null;

    // Handle file upload
    if (req.file) {
      const uploadInput = await resolveUploadInput(req);
      torrentBuffer = uploadInput.torrentBuffer;
      torrentPath = uploadInput.torrentPath;
    } else if (magnetURI) {
      const magnetInput = await resolveMagnetInput(magnetURI);
      if (magnetInput.error) {
        return res.status(magnetInput.error.status).json({ message: magnetInput.error.message });
      }

      magnetInfo = magnetInput.magnetInfo;
      const existingTorrent = await findExistingTorrentByInfoHash(magnetInfo.infoHash);
      if (existingTorrent && await handleExistingMagnetTorrent(existingTorrent, req, res)) {
        return;
      }

      console.log(`[TorrentController] Adding magnet: ${magnetInfo.displayName || magnetInfo.infoHash}`);
    } else {
      return res.status(400).json({ message: 'Must provide torrent file or magnet URI' });
    }

    // Add to engine via Dispatcher (Phase 2.1: decoupled from direct engine call)
    let engineTorrent;
    try {
      // Dispatch through the Dispatcher which will route to
      // Kafka (distributed) or local engine (embedded)
      await defaultDispatcher.dispatch(
        DIRECTIVE_TYPES.JOB_ASSIGNED,
        {
          torrentPath: torrentPath,
          torrentBuffer: torrentBuffer ? torrentBuffer.toString('base64') : null,
          magnetUri: magnetURI || null,
          sourceUri: req.body.sourceUri || null,
          autoStart: autoStart,
          downloadPath: process.env.DOWNLOAD_PATH || './downloads',
        },
        { requestId: req.requestId }
      );

      // In local mode, the engine executed synchronously above.
      // Retrieve the torrent instance from the engine for response building.
      // For distributed mode, we would query the Transfer table instead.
      if (magnetURI) {
        const { parseMagnet } = require('../torrentEngine/magnet');
        const magnetInfo = parseMagnet(magnetURI);
        engineTorrent = defaultEngine.getTorrent(magnetInfo.infoHash);
      } else {
        // For .torrent file uploads, iterate to find the newly added one
        const allTorrents = Array.from(defaultEngine.torrents.values());
        engineTorrent = allTorrents[allTorrents.length - 1];
      }
    } catch (error) {
      // Clean up saved file on any error
      if (torrentPath) {
        await fs.unlink(torrentPath).catch(() => {});
      }

      if (await handleDispatcherAlreadyExists(error, magnetURI, req, res)) {
        return;
      }

      console.error('[TorrentController] Dispatcher error:', error);
      throw error;
    }

    // Ensure we have an infoHash even in distributed mode
    const { finalInfoHash, finalName, finalSize, finalState } = resolveFinalMeta(engineTorrent, magnetURI);

    if (!finalInfoHash) {
      return res.status(500).json({ message: "Server error: Unable to determine infoHash in distributed mode." });
    }

    // Check if torrent already exists in DB (e.g. added via .torrent file with same hash)
    const existingTorrent = await findExistingTorrentByInfoHash(finalInfoHash);
    if (existingTorrent) {
      const userId = getUserId(req);
      const alreadyOwner = existingTorrent.uploaded_by === userId;
      const alreadyLeeching = existingTorrent.leechers && existingTorrent.leechers.some(l => l.id === userId);
      if (!alreadyOwner && !alreadyLeeching) {
        await TransferLeecher.create({ transfer_id: existingTorrent.id, user_id: userId });
      }
      return res.status(200).json(buildMergedResponse(existingTorrent, alreadyOwner));
    }

    // Get initial stats (may fail for magnet links without metadata yet)
    const stats = getEngineStats(engineTorrent);

    // Save to DB
    const torrent = await Transfer.create({
      name: finalName || `Torrent-${finalInfoHash.substring(0, 8)}`,
      info_hash: finalInfoHash,
      magnet_uri: magnetURI || null,
      size_bytes: finalSize,
      uploaded_by: getUserId(req),
      status: finalState,
      progress: stats?.percentage || 0,
      source_path: torrentPath || null,
      s3_source_uri: req.body.sourceUri || null
    });

    console.log(`[TorrentController] Created torrent: ${torrent.name} (${torrent.info_hash})`);
    
    // 5.3 — always include isOwner in response
    const response = mergeTorrentData(torrent, engineTorrent);
    response.isOwner = true;
    res.status(201).json(response);
  } catch (error) {
    console.error('[TorrentController] createTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Update torrent status/progress
exports.updateTorrent = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid torrent ID format' });
    }

    const { status, progress, seeds, leeches, downloadSpeed, uploadSpeed } = req.body;
    
    let torrent;
    if (isValidObjectId(req.params.id)) {
      torrent = await Transfer.findByPk(req.params.id);
    } else {
      torrent = await Transfer.findOne({ where: { info_hash: req.params.id.toLowerCase() } });
    }

    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (progress !== undefined) updateData.progress = progress;

    if (Object.keys(updateData).length > 0) {
      await Transfer.update(updateData, { where: { id: torrent.id } });
    }
    
    res.json({ ...torrent.toJSON(), ...updateData });
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Delete a torrent
exports.deleteTorrent = async (req, res) => {
  try {
    const deleteFiles = req.query.deleteFiles === 'true';
    const userId = req.user.userId || req.user.id;

    let torrent;
    const qry = { include: [{ model: User, as: 'leechers', attributes: ['id'] }] };
    if (isValidObjectId(req.params.id)) {
      torrent = await Transfer.findByPk(req.params.id, qry);
    } else {
      torrent = await Transfer.findOne({ where: { info_hash: req.params.id.toLowerCase() }, ...qry });
    }

    if (!torrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const isOwner = torrent.uploaded_by === userId;
    const isLeecher = torrent.leechers && torrent.leechers.some(l => l.id === userId);

    if (!isOwner && !isLeecher) {
      return res.status(403).json({ message: 'Not authorized to remove this torrent' });
    }

    // 5.2 — leechers just get removed from downloadedBy, torrent stays alive
    if (!isOwner && isLeecher) {
      await TransferLeecher.destroy({ where: { transfer_id: torrent.id, user_id: userId } });
      console.log(`[TorrentController] Leecher ${userId} removed from: ${torrent.name}`);
      return res.json({ message: 'Removed from your list' });
    }

    if (torrent.leechers && torrent.leechers.length > 0) {
      console.log(`[TorrentController] Owner deleting torrent with ${torrent.leechers.length} leecher(s) still attached`);
    }

    try {
      await Promise.race([
        defaultEngine.removeTorrent(torrent.info_hash, deleteFiles),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      console.log(`[TorrentController] Removed from engine: ${torrent.info_hash}`);
    } catch (error) {
      console.warn(`[TorrentController] Failed to remove from engine (non-fatal): ${error.message}`);
    }

    await TransferLeecher.destroy({ where: { transfer_id: torrent.id } });
    await Transfer.destroy({ where: { id: torrent.id } });

    console.log(`[TorrentController] Deleted torrent: ${torrent.name}`);
    res.json({
      message: 'Torrent deleted successfully',
      deletedFiles: deleteFiles
    });
  } catch (error) {
    console.error('[TorrentController] deleteTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Search torrents by name
exports.searchTorrents = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ message: 'Search query required' });
    }

    const { Op } = require('sequelize');
    const torrents = await Transfer.findAll({
      where: { name: { [Op.iLike]: `%${q}%` } },
      include: [{ model: User, as: 'uploader', attributes: ['username'] }]
    });

    // Merge with live engine stats
    const mergedTorrents = torrents.map(torrent => {
      const engineTorrent = defaultEngine.getTorrent(torrent.info_hash);
      return mergeTorrentData(torrent, engineTorrent);
    });

    res.json(mergedTorrents);
  } catch (error) {
    console.error('[TorrentController] searchTorrents error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Start a torrent
exports.startTorrent = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Transfer.findByPk(id);
    } else {
      dbTorrent = await Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    let engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
    
    if (!engineTorrent) {
      return res.status(400).json({ 
        message: 'Torrent not loaded in engine. Please re-add the torrent.' 
      });
    }

    // Start the torrent
    await engineTorrent.start();
    
    // Update DB status
    await Transfer.update({ status: 'downloading' }, { where: { id: dbTorrent.id } });

    console.log(`[TorrentController] Started torrent: ${dbTorrent.name}`);
    
    res.json(mergeTorrentData(dbTorrent, engineTorrent));
  } catch (error) {
    console.error('[TorrentController] startTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Pause a torrent
exports.pauseTorrent = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Transfer.findByPk(id);
    } else {
      dbTorrent = await Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
    
    if (!engineTorrent) {
      return res.status(400).json({ 
        message: 'Torrent not running in engine' 
      });
    }

    // Phase 2.1: Pause via Dispatcher (routes to Kafka or local engine)
    await defaultDispatcher.dispatch(
      DIRECTIVE_TYPES.JOB_PAUSED,
      { infoHash: dbTorrent.info_hash },
      { requestId: req.requestId }
    );
    
    // Update DB status
    await Transfer.update({ status: 'paused' }, { where: { id: dbTorrent.id } });

    console.log(`[TorrentController] [${req.requestId}] Paused torrent: ${dbTorrent.name}`);
    
    // Re-fetch engine state for response
    const engineTorrentAfter = defaultEngine.getTorrent(dbTorrent.info_hash);
    res.json(mergeTorrentData(dbTorrent, engineTorrentAfter));
  } catch (error) {
    console.error('[TorrentController] pauseTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Resume a torrent
exports.resumeTorrent = async (req, res) => {
  try {
    const { id } = req.params;
    const requestId = req.requestId; // Phase 1.3: correlation ID

    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Transfer.findByPk(id);
    } else {
      dbTorrent = await Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);

    if (!engineTorrent) {
      return res.status(400).json({
        message: 'Torrent not loaded in engine. Please re-add or start the torrent.'
      });
    }

    // ── Phase 1.3: CAS-aware resume ────────────────────────────────────────
    let resumeContext = null;
    try {
      resumeContext = await ResumeService.getResumeContext(dbTorrent.info_hash);

      if (resumeContext) {
        if (resumeContext.isFullyVerified) {
          // All chunks verified in DB — nothing to re-download
          console.log(`[TorrentController] [${requestId}] All chunks verified for ${dbTorrent.info_hash}, skipping re-download`);
          await Transfer.update({ status: 'completed' }, { where: { id: dbTorrent.id } });
          return res.json({
            ...mergeTorrentData(dbTorrent, engineTorrent),
            resumeContext: { isFullyVerified: true, verifiedChunks: resumeContext.totalTracked }
          });
        }

        // Reset any failed chunks so they will be re-attempted
        if (resumeContext.failedIndices.length > 0) {
          await ResumeService.resetFailedChunks(dbTorrent.info_hash);
          console.log(`[TorrentController] [${requestId}] Reset ${resumeContext.failedIndices.length} failed chunks for retry`);
        }

        // Hand the verified piece list to the engine so it skips those pieces
        if (resumeContext.verifiedIndices.length > 0 && typeof engineTorrent.setCompletedPieces === 'function') {
          engineTorrent.setCompletedPieces(resumeContext.verifiedIndices);
          console.log(`[TorrentController] [${requestId}] Restored ${resumeContext.verifiedIndices.length} verified pieces to engine, resuming from index ${resumeContext.resumeFromIndex}`);
        }
      }
    } catch (resumeErr) {
      // Non-fatal: fall back to standard resume if DB is unavailable
      console.warn(`[TorrentController] [${requestId}] ResumeService failed (non-fatal): ${resumeErr.message}`);
    }

    // Phase 2.1: Resume via Dispatcher
    await defaultDispatcher.dispatch(
      DIRECTIVE_TYPES.JOB_RESUMED,
      { infoHash: dbTorrent.info_hash },
      { requestId }
    );

    // Update DB status
    await Transfer.update({ status: 'downloading' }, { where: { id: dbTorrent.id } });

    console.log(`[TorrentController] [${requestId}] Resumed torrent: ${dbTorrent.name}`);

    res.json({
      ...mergeTorrentData(dbTorrent, engineTorrent),
      ...(resumeContext && {
        resumeContext: {
          resumeFromIndex: resumeContext.resumeFromIndex,
          verifiedChunks:  resumeContext.verifiedIndices.length,
          pendingChunks:   resumeContext.pendingIndices.length,
          failedChunks:    resumeContext.failedIndices.length,
        }
      })
    });
  } catch (error) {
    console.error('[TorrentController] resumeTorrent error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get torrent stats (real-time)
exports.getTorrentStats = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Transfer.findByPk(id);
    } else {
      dbTorrent = await Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    // Get from engine
    const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
    
    if (!engineTorrent) {
      // Torrent is saved in DB but not currently loaded in the engine.
      // Return DB-based stats so the dashboard shows the correct persisted state
      // instead of an error. This happens when the engine hasn't loaded it yet,
      // or when seedFromFile/addTorrent fails after the DB record is created.
      return res.json({
        state:         dbTorrent.status || 'paused',
        progress:      dbTorrent.progress ?? 0,
        downloadSpeed: 0,
        uploadSpeed:   0,
        peers:         0,
        seeds:         0,
        downloaded:    dbTorrent.downloaded ?? 0,
        uploaded:      dbTorrent.uploaded ?? 0,
        size:          dbTorrent.size ?? 0,
        eta:           null,
        pieces: { total: 0, done: 0, active: 0 },
        _engineMissing: true,
      });
    }

    // Return real-time stats
    const stats = engineTorrent.getStats();
    res.json(stats);
  } catch (error) {
    console.error('[TorrentController] getTorrentStats error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Get files with selection status
exports.getFiles = async (req, res) => {
  try {
    const { id } = req.params;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Transfer.findByPk(id);
    } else {
      dbTorrent = await Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
    
    let files = [];
    if (engineTorrent) {
      files = engineTorrent.getFilesWithSelection();
    } else {
      if (dbTorrent.torrent_file_path) {
        // Container was restarted, engine memory is empty. Parse the .torrent file directly.
        try {
          const torrentBuffer = await fs.readFile(dbTorrent.torrent_file_path);
          const parsed = parseTorrent(torrentBuffer);
          const rawFiles = parsed.files || [{ path: parsed.name, length: parsed.length }];
          files = rawFiles.map((f, index) => ({
            index,
            path: f.path,
            name: Array.isArray(f.path) ? f.path[f.path.length - 1] : f.path,
            length: f.length,
            selected: true
          }));
        } catch (err) {
          console.error('[TorrentController] Failed to parse .torrent fallback:', err);
        }
      }

      // If we still have no files (e.g. magnet link without saved metadata), synthesize it from the database record
      if (files.length === 0) {
        files = [{
          index: 0,
          path: dbTorrent.name,
          name: dbTorrent.name,
          length: dbTorrent.size_bytes || 0,
          selected: true
        }];
      }
    }

    const selectedCount = files.filter(f => f.selected).length;
    
    res.json({
      files,
      selectedCount,
      totalCount: files.length
    });
  } catch (error) {
    console.error('[TorrentController] getFiles error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// Select/deselect files
exports.selectFiles = async (req, res) => {
  try {
    const { id } = req.params;
    const { fileIndices, selectAll } = req.body;
    
    let dbTorrent;
    if (isValidObjectId(id)) {
      dbTorrent = await Transfer.findByPk(id);
    } else {
      dbTorrent = await Transfer.findOne({ where: { info_hash: id.toLowerCase() } });
    }

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
    
    if (!engineTorrent) {
      return res.status(400).json({ message: 'Torrent not running in engine' });
    }

    if (selectAll) {
      engineTorrent.selectAllFiles();
    } else if (Array.isArray(fileIndices)) {
      if (fileIndices.length === 0) {
        return res.status(400).json({ message: 'Must select at least one file' });
      }
      engineTorrent.selectFiles(fileIndices);
    } else {
      return res.status(400).json({ message: 'Must provide fileIndices array or selectAll: true' });
    }

    const files = engineTorrent.getFilesWithSelection();
    const selectedCount = files.filter(f => f.selected).length;
    
    res.json({
      message: 'File selection updated',
      files,
      selectedCount,
      totalCount: files.length
    });
  } catch (error) {
    console.error('[TorrentController] selectFiles error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// ─── Create Torrent FROM a user's file (Phase 2.1) ───────────────────────────

/**
 * POST /api/torrent/create-from-file
 *
 * Accepts any file upload (PDF, MP3, MP4, ZIP, etc.) and generates:
 *  - A .torrent file (returned as base64)
 *  - An infoHash
 *  - A magnet URI the user can share
 *
 * Body (multipart/form-data):
 *  - file         : [required] the file to create a torrent from
 *  - name         : [optional] override torrent name (defaults to original filename)
 *  - trackers     : [optional] JSON array of tracker URLs e.g. '["udp://..."]'
 *  - pieceSize    : [optional] piece size in bytes (16384 – 8388608)
 *  - private      : [optional] "true" to make private torrent (disables DHT)
 *
 * Response 201:
 *  {
 *    infoHash     : string,   // 40-char hex
 *    magnetURI    : string,   // ready-to-share magnet link
 *    name         : string,   // torrent name used
 *    fileSize     : number,   // original file size in bytes
 *    pieceLength  : number,   // piece size used
 *    pieceCount   : number,   // number of pieces
 *    trackers     : string[], // tracker URLs included
 *    torrentFile  : string,   // base64-encoded .torrent file
 *    torrent      : Object,   // saved DB entry (same shape as other torrent endpoints)
 *  }
 */
exports.createTorrentFromFile = async (req, res) => {
  // Track paths for cleanup on failure
  let savedSourcePath  = null;
  let savedTorrentPath = null;

  try {
    // ── 1. Validate upload present ──────────────────────────────────────────
    const fileValidation = validateUploadedFile(req);
    if (fileValidation.error) {
      return res.status(fileValidation.error.status).json(fileValidation.error.payload);
    }

    const { uploadedFilePath, fileSize, originalName, ext } = fileValidation;

    // ── 2. File too large guard (controller-level, defence-in-depth) ────────
    // Multer already enforces this at HTTP layer but we double-check here so
    // the limit is respected even if the route is called programmatically.
    const sizeCheck = await enforceMaxFileSize(uploadedFilePath, fileSize);
    if (sizeCheck.error) {
      return res.status(sizeCheck.error.status).json(sizeCheck.error.payload);
    }

    // ── 3. File type check — WARN, never block ──────────────────────────────
    // Any file can be torrented. We just warn the user if the type looks odd
    // so they know what they're sharing (e.g. accidentally uploading .exe)
    const warnings = buildFileWarnings(ext);

    // ── 4. Parse options from body ──────────────────────────────────────────
    const parsedOptions = parseCreateFromFileOptions(req, originalName);
    if (parsedOptions.error) {
      return res.status(parsedOptions.error.status).json(parsedOptions.error.payload);
    }
    const { rawName, rawPrivate, trackers, pieceSize } = parsedOptions;

    // ── 5. Create .torrent from file ────────────────────────────────────────
    const { createTorrentWithMagnet } = require('../torrentEngine/torrentCreator');
    const fileBuffer = await fs.readFile(uploadedFilePath);

    // Throttle progress broadcasts — emit at most once every 100ms and
    // only when progress actually changes by ≥1% to avoid flooding the socket.
    const pieceCount = Math.ceil(fileBuffer.length / (pieceSize || 262144));
    const onProgress = buildProgressEmitter(req, originalName, pieceCount);

    let created;
    try {
      created = createTorrentWithMagnet(fileBuffer, {
        name:       rawName,
        trackers,
        pieceSize,
        private:    rawPrivate,
        onProgress: pieceCount > 1 ? onProgress : undefined, // skip for tiny files
      });
    } catch (err) {
      return res.status(400).json({ error: `Failed to create torrent: ${err.message}` });
    }

    // Emit 100% done event
    emitHashComplete(req, originalName, pieceCount);

    // ── 6. Duplicate detection ──────────────────────────────────────────────
    // Check by infoHash — if same file + same name was already uploaded,
    // this catches it. We return the existing record so the client can
    // reuse the magnet link immediately rather than re-uploading.
    const existing = await Transfer.findOne({ where: { info_hash: created.infoHash.toLowerCase() } });
    if (existing) {
      return res.status(409).json({
        error:    'This exact file has already been added (same content and name).',
        hint:     'Use the existing magnet link below to share it.',
        infoHash: created.infoHash,
        magnetURI: existing.magnet_uri || created.magnetURI,
        torrent:  existing,
      });
    }

    // ── 7. Write files to disk ──────────────────────────────────────────────
    const persistedPaths = await persistCreatedFiles(created, originalName, fileBuffer);
    savedSourcePath = persistedPaths.savedSourcePath;
    savedTorrentPath = persistedPaths.savedTorrentPath;

    // ── 8. Save to DB & Initialize CAS Chunks ───────────────────────────────
    const torrent = await saveCreatedTorrent(created, savedSourcePath, req);

    console.log(`[TorrentController] Created torrent from file: ${created.name} (${created.infoHash})`);

    // ── 9. Auto-seed: wire into engine (Phase 3.1) ──────────────────────────
    // Fire-and-forget — seeding starting up shouldn't delay the HTTP response.
    // Engine errors are logged but don't fail the request (torrent is saved, user
    // already has the magnet link they need to share).
    scheduleAutoSeed(created, savedSourcePath);

    // ── 10. Respond ─────────────────────────────────────────────────────────
    const response = {
      infoHash:        created.infoHash,
      magnetURI:       created.magnetURI,
      name:            created.name,
      fileSize:        created.fileSize,
      pieceLength:     created.pieceLength,
      pieceCount:      created.pieceCount,
      trackers:        created.trackers,
      torrentFile:     created.torrentBuffer.toString('base64'),
      sourcePath:      savedSourcePath,
      torrentFilePath: savedTorrentPath,
      torrent:         { ...(torrent ? torrent.toJSON() : {}), isOwner: true },  // 5.3
    };

    // Attach warnings if any (non-blocking)
    if (warnings.length > 0) {
      response.warnings = warnings;
    }

    return res.status(201).json(response);

  } catch (error) {
    // ── Cleanup on failure — never leave orphan files on disk ───────────────
    if (savedSourcePath)  await fs.unlink(savedSourcePath).catch(() => {});
    if (savedTorrentPath) await fs.unlink(savedTorrentPath).catch(() => {});

    console.error('[TorrentController] createTorrentFromFile error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

// Get global engine stats
exports.getGlobalStats = async (req, res) => {
  try {
    const globalStats = defaultEngine.getGlobalStats();
    
    // Add DB info
    const totalInDb = await Transfer.count();
    
    res.json({
      ...globalStats,
      totalInDatabase: totalInDb
    });
  } catch (error) {
    console.error('[TorrentController] getGlobalStats error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

// ─── Direct File Download ──────────────────────────────────────────────────────

// Download a specific file from a completed torrent
exports.downloadTorrentFile = async (req, res) => {
  try {
    const { id } = req.params;
    const fileIndex = parseInt(req.query.fileIndex || 0, 10);

    const dbTorrent = await findTorrentByIdOrHash(id);

    if (!dbTorrent) {
      return res.status(404).json({ message: 'Torrent not found' });
    }

    if (dbTorrent.status !== 'completed' && dbTorrent.status !== 'seeding') {
      return res.status(400).json({ message: 'Torrent has not finished downloading yet' });
    }

    const engineTorrent = defaultEngine.getTorrent(dbTorrent.info_hash);
    const files = await getFilesForTorrent(dbTorrent, engineTorrent);

    if (files.length === 0) {
      return res.status(400).json({ message: 'Torrent not active in engine and no metadata could be reconstructed' });
    }

    if (fileIndex < 0 || fileIndex >= files.length) {
      return res.status(404).json({ message: 'File index out of bounds' });
    }

    const selectedFile = files[fileIndex];
    const baseDir = process.env.DOWNLOAD_PATH || './downloads';
    const finalPath = await resolveDownloadPath(baseDir, selectedFile, dbTorrent);

    if (!finalPath) {
      return res.status(404).json({ message: 'File not found on disk. Ensure worker has completed the transfer.' });
    }

    res.download(finalPath, selectedFile.name, (err) => {
      if (err) {
        console.error('[TorrentController] File download error:', err);
        if (!res.headersSent) res.status(500).json({ message: 'Failed to download file' });
      }
    });

  } catch (error) {
    console.error('[TorrentController] downloadTorrentFile error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};
