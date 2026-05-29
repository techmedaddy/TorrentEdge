#!/usr/bin/env node
/**
 * TorrentEdge Consumer CLI (tedge)
 * Zero-dependency Node.js binary for pulling artifacts in CI/CD environments.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// CLI Argument Parsing
const args = process.argv.slice(2);
const command = args[0];
const hash = args[1];

if (!command || command !== 'pull' || !hash) {
  console.error('\x1b[31mError:\x1b[0m Invalid command.');
  console.log('\nUsage:');
  console.log('  tedge pull <info_hash>\n');
  process.exit(1);
}

// Configuration
// In a real environment, this could be configured via env vars or a config file
const TE_SERVER_URL = process.env.TE_SERVER_URL || 'http://localhost:3029';
const TOKEN = process.env.TE_TOKEN || ''; // If auth is required

const pullArtifact = async (infoHash) => {
  const url = `${TE_SERVER_URL}/api/torrent/${infoHash}/download`;
  console.log(`\x1b[36m[TorrentEdge]\x1b[0m Pulling artifact \x1b[33m${infoHash}\x1b[0m...`);

  const client = url.startsWith('https') ? https : http;
  
  const options = {
    headers: {}
  };

  if (TOKEN) {
    options.headers['Authorization'] = `Bearer ${TOKEN}`;
  }

  const req = client.get(url, options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      // Handle redirect if any
      console.log('\x1b[33mRedirecting...\x1b[0m');
      // For a robust implementation, we would recursively follow redirects here.
      // But for this simple CI/CD tool, we assume direct download.
    }

    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', chunk => errBody += chunk);
      res.on('end', () => {
        console.error(`\x1b[31mError:\x1b[0m Server responded with status ${res.statusCode}`);
        try {
          const json = JSON.parse(errBody);
          if (json.message) console.error(json.message);
        } catch(e) {
          console.error(errBody);
        }
        process.exit(1);
      });
      return;
    }

    // Extract filename from Content-Disposition header if available
    let filename = `artifact-${infoHash.slice(0, 8)}.dat`;
    const contentDisposition = res.headers['content-disposition'];
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) {
        filename = match[1];
      }
    }

    const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
    const destPath = path.resolve(process.cwd(), filename);
    const fileStream = fs.createWriteStream(destPath);

    let downloadedBytes = 0;
    let lastLogged = 0;

    res.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      fileStream.write(chunk);
      
      const now = Date.now();
      if (now - lastLogged > 100 || downloadedBytes === totalBytes) {
        printProgressBar(downloadedBytes, totalBytes, filename);
        lastLogged = now;
      }
    });

    res.on('end', () => {
      fileStream.end();
      // Final progress bar update
      printProgressBar(totalBytes, totalBytes, filename);
      console.log(`\n\x1b[32mSuccess:\x1b[0m Artifact saved to ${destPath}\n`);
    });

    res.on('error', (err) => {
      console.error(`\n\x1b[31mStream Error:\x1b[0m ${err.message}`);
      fs.unlinkSync(destPath); // Clean up partial file
      process.exit(1);
    });
  });

  req.on('error', (err) => {
    console.error(`\x1b[31mNetwork Error:\x1b[0m Failed to connect to TorrentEdge server at ${TE_SERVER_URL}`);
    console.error(err.message);
    process.exit(1);
  });
};

const printProgressBar = (current, total, filename) => {
  const width = 40;
  if (!total) {
    // Unknown total size
    process.stdout.write(`\rDownloading ${filename} ... ${(current / (1024*1024)).toFixed(2)} MB`);
    return;
  }

  const percent = Math.min(100, Math.round((current / total) * 100));
  const completedWidth = Math.round((width * percent) / 100);
  const emptyWidth = width - completedWidth;

  const bar = '█'.repeat(completedWidth) + '░'.repeat(emptyWidth);
  const sizeStr = `${(current / (1024*1024)).toFixed(2)} MB / ${(total / (1024*1024)).toFixed(2)} MB`;

  process.stdout.write(`\r\x1b[36m[${bar}]\x1b[0m ${percent}% | ${sizeStr} | ${filename}`);
};

// Execute
pullArtifact(hash);
