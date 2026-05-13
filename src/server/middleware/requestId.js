/**
 * Phase 1.3 — X-Request-ID Tracing Middleware
 *
 * Assigns every incoming HTTP request a deterministic correlation ID.
 * Rules:
 *  - If the client sends `X-Request-ID`, use that value (idempotency replay).
 *  - Otherwise, generate a new UUID.
 *
 * The ID is:
 *  1. Stored on `req.requestId` for downstream use.
 *  2. Reflected back as `X-Request-ID` in the response header.
 *
 * This enables:
 *  - End-to-end request tracing across logs.
 *  - Idempotent retry detection: a client can re-send the same ID and
 *    the handler can detect the duplicate rather than double-processing.
 */

'use strict';

const { randomUUID } = require('crypto');

/**
 * Middleware: attach and echo a unique per-request correlation ID.
 */
function requestId(req, res, next) {
  const incomingId = req.headers['x-request-id'];

  // Validate: allow only UUIDs or alphanumeric-dash strings (max 128 chars)
  const isValid = incomingId && /^[a-zA-Z0-9_-]{1,128}$/.test(incomingId);
  const id = isValid ? incomingId : randomUUID();

  req.requestId = id;
  res.setHeader('X-Request-ID', id);

  next();
}

module.exports = requestId;
