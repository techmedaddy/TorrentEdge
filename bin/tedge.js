#!/usr/bin/env node

/**
 * TorrentEdge CLI (tedge)
 * Zero-dependency infrastructure binary for CI/CD pipelines.
 * 
 * Usage:
 *   tedge dispatch <uri> [--wait] [--request-id <id>]
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Configuration from Environment
const API_URL = process.env.TEDGE_API_URL || 'http://localhost:3029';
const AUTH_TOKEN = process.env.TEDGE_AUTH_TOKEN;

function printHelp() {
  console.log(`
TorrentEdge CLI - CI/CD Integration Tool

Usage:
  tedge dispatch <s3-uri | magnet-uri> [--wait]
  tedge --help

Options:
  --wait          Block the pipeline until the artifact is fully seeded to the swarm
  --request-id    Explicitly set the X-Request-ID for idempotency (defaults to CI run ID)

Environment Variables:
  TEDGE_API_URL      URL of the Control Plane (default: http://localhost:3029)
  TEDGE_AUTH_TOKEN   JWT or access token for authentication (Required)
`);
}

function generateDeterministicId() {
  // Use CI variables if available for true idempotency across pipeline retries
  const ciVar = process.env.GITHUB_RUN_ID || 
                process.env.GITLAB_CI || 
                process.env.CIRCLE_BUILD_NUM || 
                process.env.TRAVIS_BUILD_ID || 
                crypto.randomUUID();
  return `pipeline-${ciVar}`;
}

function parseArgs(args) {
  const options = {
    command: null,
    target: null,
    wait: false,
    requestId: generateDeterministicId()
  };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--wait') {
      options.wait = true;
    } else if (arg === '--request-id') {
      options.requestId = args[++i];
    } else if (!options.command) {
      options.command = arg;
    } else if (!options.target) {
      options.target = arg;
    }
  }

  return options;
}

function makeRequest(urlStr, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    
    const reqHeaders = { ...headers };
    let bodyData = null;
    
    if (body) {
      bodyData = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const options = {
      method,
      headers: reqHeaders,
    };

    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', (err) => reject(err));
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function pollStatus(torrentId) {
  console.log(`[tedge] Waiting for swarm seeding... (Torrent ID: ${torrentId})`);
  
  const headers = { 'Authorization': `Bearer ${AUTH_TOKEN}` };
  const endpoint = `${API_URL}/api/torrent/${torrentId}`;

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const res = await makeRequest(endpoint, 'GET', headers, null);
        if (res.status === 200 && res.body) {
          const status = res.body.status;
          const progress = res.body.progress;
          
          process.stdout.write(`\r[tedge] Status: ${status} | Progress: ${(progress * 100).toFixed(1)}% `);
          
          if (status === 'seeding' || progress >= 1) {
            clearInterval(interval);
            console.log('\n[tedge] Artifact is fully seeded to the swarm. ✅');
            resolve();
          } else if (status === 'error' || status === 'failed') {
            clearInterval(interval);
            console.error('\n[tedge] Swarm reported an error state. ❌');
            process.exit(1);
          }
        }
      } catch (err) {
        // Ignore network hiccups during polling
      }
    }, 2000);
  });
}

function ensureValidCommand(options) {
  if (options.command !== 'dispatch') {
    if (options.command) console.error(`Unknown command: ${options.command}`);
    printHelp();
    process.exit(1);
  }
}

function ensureTargetProvided(options) {
  if (!options.target) {
    console.error('Error: Target URI is required.');
    printHelp();
    process.exit(1);
  }
}

function ensureAuthToken() {
  if (!AUTH_TOKEN) {
    console.error('Error: TEDGE_AUTH_TOKEN environment variable is not set.');
    process.exit(1);
  }
}

function buildSyntheticMagnet(targetUri) {
  const hash = crypto.createHash('sha1').update(targetUri).digest('hex');
  const filename = targetUri.split('/').pop() || 'artifact';
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(filename)}`;
}

function resolveTarget(targetUri) {
  if (targetUri.startsWith('s3://')) {
    const s3Path = targetUri.slice(5);
    const bucket = s3Path.split('/')[0];
    const key = s3Path.split('/').slice(1).join('/');
    const sourceUri = `https://${bucket}.s3.amazonaws.com/${key}`;
    const magnetURI = buildSyntheticMagnet(targetUri);
    console.log(`[tedge] Parsed S3 target: ${targetUri}`);
    console.log(`[tedge] Resolved to Streamable URI: ${sourceUri}`);
    console.log(`[tedge] Generated synthetic magnet: ${magnetURI}`);
    return { sourceUri, magnetURI };
  }

  if (targetUri.startsWith('http://') || targetUri.startsWith('https://')) {
    const sourceUri = targetUri;
    const magnetURI = buildSyntheticMagnet(targetUri);
    console.log(`[tedge] Parsed HTTP target: ${targetUri}`);
    console.log(`[tedge] Generated synthetic magnet: ${magnetURI}`);
    return { sourceUri, magnetURI };
  }

  if (targetUri.startsWith('magnet:')) {
    console.log(`[tedge] Parsed magnet link: ${targetUri.substring(0, 50)}...`);
    return { sourceUri: null, magnetURI: targetUri };
  }

  console.error('Error: Target must be an S3 URI, HTTP(S) URL, or magnet link.');
  process.exit(1);
}

function getTorrentIdFromResponse(resBody) {
  if (resBody && resBody._id) return resBody._id;
  if (resBody && resBody.torrent && resBody.torrent._id) return resBody.torrent._id;
  return null;
}

function getHashFromMagnet(magnetURI) {
  if (!magnetURI) return null;
  const hashMatch = magnetURI.match(/urn:btih:([a-zA-Z0-9]{40})/i);
  return hashMatch ? hashMatch[1] : null;
}

async function handleSuccessResponse(res, options, magnetURI) {
  if (res.status === 201) {
    console.log('[tedge] Success: Artifact dispatched (Status: 201 Created)');
  } else {
    console.log(`[tedge] Success: Idempotent guard engaged (Status: ${res.status}). Intent already fulfilled.`);
  }

  if (!options.wait) {
    process.exit(0);
  }

  const responseId = getTorrentIdFromResponse(res.body);
  if (responseId) {
    await pollStatus(responseId);
    process.exit(0);
  }

  if (res.status === 409) {
    const hashId = getHashFromMagnet(magnetURI);
    if (hashId) {
      console.log('[tedge] In-flight request detected. Polling via hash lookup...');
      await new Promise(r => setTimeout(r, 2000));
      await pollStatus(hashId);
    }
  }

  process.exit(0);
}

async function main() {
  const options = parseArgs(process.argv);

  ensureValidCommand(options);
  ensureTargetProvided(options);
  ensureAuthToken();

  const targetUri = options.target;
  const { magnetURI, sourceUri } = resolveTarget(targetUri);

  const payload = {
    magnetURI,
    sourceUri,
    autoStart: true
  };

  const headers = {
    'Authorization': `Bearer ${AUTH_TOKEN}`,
    'X-Request-ID': options.requestId
  };

  console.log(`[tedge] Dispatching request with Correlation ID: ${options.requestId}`);

  try {
    const res = await makeRequest(`${API_URL}/api/torrent/create`, 'POST', headers, payload);

    if (res.status === 201 || res.status === 200 || res.status === 409) {
      await handleSuccessResponse(res, options, magnetURI);
    }

    console.error(`[tedge] Error: API returned status ${res.status}`);
    console.error(res.body);
    process.exit(1);
  } catch (err) {
    console.error(`[tedge] Connection Error: ${err.message}`);
    process.exit(1);
  }
}

main();
