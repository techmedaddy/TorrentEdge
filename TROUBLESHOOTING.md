# TorrentEdge Troubleshooting & Known Bugs Log

This document serves as a persistent record of complex bugs, configuration gotchas, and system-level issues encountered during the development and deployment of TorrentEdge. 

Each entry details the symptom, root cause, and the definitive solution to prevent regressions and accelerate future debugging.

---

## 1. Google OAuth 2.0: `Error 400: redirect_uri_mismatch` in Local Production Docker

**Date Logged:** May 22, 2026
**Component:** Authentication / Docker / Nginx

### Symptom
When attempting to log in via Google OAuth while running the production container locally (`docker-compose -f docker-compose.prod.yml up`), Google rejected the authentication request with `Error 400: redirect_uri_mismatch`.

### Root Cause
There were two intersecting configuration mismatches causing Google to reject the request:
1. **Environment Variable Override:** The `docker-compose.prod.yml` file explicitly loads `.env.prod`. In `.env.prod`, the `GOOGLE_CALLBACK_URL` was set to the production placeholder `https://your-domain.com/auth/google/callback`. The Node.js backend blindly sent this placeholder to Google as the requested redirect URI, which did not match the `http://localhost:3029...` URI registered in the Google Cloud Console.
2. **Docker Port Isolation (Nginx Proxying):** In the production Docker layout, the Node.js backend (port `3029`) is completely isolated from the host. Only the Nginx reverse proxy (port `80`) is exposed. If Google were to redirect the browser back to `http://localhost:3029`, the connection would be refused.

### Solution
To successfully test the production environment locally:
1. **Update `.env.prod`:** Temporarily changed `GOOGLE_CALLBACK_URL` to point to the Nginx entry point: `http://localhost/auth/google/callback`.
2. **Update Google Cloud Console:** Added `http://localhost/auth/google/callback` to the "Authorized redirect URIs" list to exactly match the new environment variable.
3. **Nginx Routing:** Ensured `nginx/prod.conf` explicitly proxied the `/auth/` path to the backend container to ensure the callback successfully reached the Node.js API.

**Key Takeaway:** Google OAuth requires a 1:1 character-perfect match. Always ensure your `.env` target matches your Cloud Console, and ensure you account for Nginx port mapping when declaring callback URLs.

---

## 2. Architectural Decision Record (ADR): Complete Purge of MongoDB for PostgreSQL

**Date Logged:** May 23, 2026
**Component:** Persistence Layer / Database Architecture

### The Problem (What was happening before)
During early prototyping, TorrentEdge used a hybrid database approach: MongoDB for unstructured document storage (the `Torrent` model) and PostgreSQL for relational data. However, as the system evolved into an infrastructure-grade Kubernetes application, this created severe distributed systems flaws:

1. **The "Dual-Write" Anti-Pattern (Data Corruption):** The `torrentController.js` was saving state to MongoDB (`await torrent.save()`) and PostgreSQL (`await Transfer.create()`) simultaneously. Because Mongo and Postgres do not share a transaction manager, a network drop between the two commands would leave the cluster permanently out of sync. Fixing this would require extremely complex Two-Phase Commits (2PC) or Saga patterns.
2. **Bloated Operational Footprint:** Running a distributed system requires deploying and securing every dependency. Forcing users to deploy, monitor, and back up both an AWS RDS (Postgres) instance *and* an AWS DocumentDB (Mongo) instance heavily taxed DevOps engineers and drastically increased the Time-to-Value (TTV).
3. **Relational Mismatches:** TorrentEdge's data is inherently highly relational (Users own Transfers, Transfers have many Leechers, Transfers are broken into millions of Chunks). MongoDB’s document model forced either bloated 16MB BSON documents or slow Node.js-layer joins, bypassing the native foreign key constraints that protect data integrity.
4. **Concurrency and Locking:** TorrentEdge relies on horizontally scaled worker pods fighting over jobs. MongoDB's eventual consistency makes strict job orchestration difficult. 

### The Solution (What is happening now)
We completely stripped MongoDB and Mongoose out of the codebase and fully committed to an ACID-compliant PostgreSQL schema using Sequelize.

1. **Strict ACID Guarantees:** We rely entirely on Postgres row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`) to safely dequeue jobs in highly concurrent environments without race conditions.
2. **Simplified Infrastructure:** By dropping MongoDB entirely, we reduced the infrastructure footprint. There is only one database to deploy, back up, and secure via Terraform.
3. **Relational Integrity:** The legacy Mongoose `Torrent` and `User` models were replaced with Sequelize `Transfer`, `TransferLeecher`, and `User` models inside `src/server/models/sql/`. The junction tables naturally enforce constraints (e.g., preventing the deletion of a User who owns an active Transfer).

**Key Takeaway:** Transitioning from a prototype to a distributed Kubernetes application requires burning the boats. Committing 100% to PostgreSQL ensured the architecture stayed clean, predictable, resilient, and true to the Engineering Constitution.

---

## 3. WebTorrent Engine Memory Wipe on Container Restart (Missing UI Elements & 404 Errors)

**Date Logged:** May 23, 2026
**Component:** BitTorrent Engine / Express API / React Frontend

### Symptom
When the backend Docker container was restarted (`docker compose restart backend`), all previously completed/seeding torrents appeared in the UI, but their file lists were completely empty (showing "No files"). Consequently, the "Download" button disappeared from the UI. Attempting to force a download via raw API calls resulted in a `404 Not Found` or `400 Bad Request` error.

### Root Cause
There was a complex chain of state mismatches caused by the container restart:
1. **Engine Memory Wipe:** The Node.js BitTorrent engine (`webtorrent`) is strictly in-memory. When the container restarts, the engine drops all active torrents.
2. **Incomplete DB Restoration:** The `server.js` startup script was only configured to automatically resume torrents where `created_from_upload: true`. Downloaded torrents (e.g. from magnet links) were left dormant in the Postgres database, never re-entering the active engine memory.
3. **API Brittleness:** When the frontend requested the file list (`GET /files`), the API queried the engine. Because the engine memory was empty, the API returned an empty `files: []` array.
4. **Data Truncation Bug:** In `mergeTorrentData`, if the engine memory was empty, the backend skipped mapping the `id` field to `_id` and `info_hash` to `infoHash`. This caused the frontend to receive `undefined` IDs, leading to malformed API calls like `GET /api/torrent/undefined/stats`.
5. **Download Path Resolution:** When trying to download seeded files, the backend was strictly checking `./downloads`, completely unaware that uploaded files are actually stored in `./downloads/seeds/` or in custom `source_path` locations.

### Solution
We implemented a robust "Absolute Fallback" architecture to ensure the frontend always receives file metadata, even if the engine is totally offline:
1. **Safe Data Mapping:** Fixed `mergeTorrentData` to unconditionally map `_id` and `infoHash` for frontend compatibility, regardless of the active engine state.
2. **The `.torrent` Fallback:** If the engine is empty, the API now attempts to read and parse the physical `.torrent` file from the hard drive (`dbTorrent.torrent_file_path`) to reconstruct the file list.
3. **The Absolute Fallback:** If there is no `.torrent` file (e.g., magnet links without saved metadata), the API synthesizes a file object directly from the PostgreSQL row (`dbTorrent.name` and `dbTorrent.size_bytes`). This guarantees the `files` array is never empty, forcing the React UI to render the file row and Download button.
4. **Dynamic Path Resolution:** Updated `downloadTorrentFile` to recursively check multiple directories (`absolutePath`, `seedPath`, and `sourcePath`) to locate and pipe the physical file correctly.

**Key Takeaway:** Never assume an in-memory application state will persist. Always build API endpoints with absolute fallback mechanisms to serve essential data directly from the persistent database or file system when the active engine goes offline.
