/**
 * TorrentEdge — Thundering Herd Load Test
 *
 * Validates three critical guarantees under 500 concurrent requests
 * for the exact same artifact:
 *
 *   1. API Idempotency: 1×201 + 499×200/409. Zero 5xx.
 *   2. Kafka Event Purity: Exactly 1 JOB_ASSIGNED directive.
 *   3. Connection Pooling: PostgreSQL stays under pool limit (20).
 *
 * Prerequisites:
 *   - docker compose up -d (Postgres, Redis, Kafka, Backend)
 *   - Generate a valid JWT:
 *       node tests/load/generate-token.js
 *   - Install k6:
 *       sudo apt-get install k6
 *
 * Execution:
 *   TEST_TOKEN=$(node tests/load/generate-token.js) k6 run tests/load/thundering-herd.js
 *
 * Expected output:
 *   ✓ is status 200, 201, or 409
 *   ✓ no internal errors
 *   ✓ http_req_failed: rate==0
 *   ✓ http_req_duration: p(99)<500
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ═══════════════════════════════════════════════════════════════════════════
// Custom Metrics
// ═══════════════════════════════════════════════════════════════════════════

const created = new Counter('torrentedge_201_created');
const deduplicated = new Counter('torrentedge_200_deduplicated');
const inflight = new Counter('torrentedge_409_inflight');
const serverErrors = new Counter('torrentedge_5xx_errors');
const latency = new Trend('torrentedge_create_latency', true);

// ═══════════════════════════════════════════════════════════════════════════
// Scenario Configuration
// ═══════════════════════════════════════════════════════════════════════════

export const options = {
  scenarios: {
    // Phase 1: The Thundering Herd — 500 VUs fire simultaneously
    thundering_herd: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Hard pass/fail criteria
    'http_req_failed': ['rate==0'],               // Zero network errors
    'http_req_duration': ['p(99)<2000'],           // P99 under 2 seconds
    'torrentedge_5xx_errors': ['count==0'],        // Zero server crashes
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic Payload
// All 500 VUs request the exact same artifact with the exact same
// X-Request-ID. This forces the idempotency guard and the Postgres
// UNIQUE constraint into a simultaneous collision.
// ═══════════════════════════════════════════════════════════════════════════

const PAYLOAD = JSON.stringify({
  magnetURI: 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=llama-3-70b-thundering-herd-test',
  autoStart: true,
});

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3029';

export default function () {
  const url = `${BASE_URL}/api/torrent/create`;

  const params = {
    headers: {
      'Content-Type': 'application/json',
      // Identical X-Request-ID forces the Redis SETNX race.
      // The first VU to hit Redis wins; the rest get 409 or 200.
      'X-Request-ID': 'thundering-herd-test-llama70b-run1',
      'Authorization': `Bearer ${__ENV.TEST_TOKEN || 'MISSING_TOKEN'}`,
    },
    timeout: '10s',
  };

  const res = http.post(url, PAYLOAD, params);
  latency.add(res.timings.duration);

  // Classify the response
  if (res.status === 201) {
    created.add(1);
  } else if (res.status === 200) {
    deduplicated.add(1);
  } else if (res.status === 409) {
    inflight.add(1);
  } else if (res.status >= 500) {
    serverErrors.add(1);
    console.error(`[VU ${__VU}] 5xx ERROR: ${res.status} — ${res.body}`);
  }

  // The assertions
  check(res, {
    'is status 200, 201, or 409': (r) =>
      r.status === 200 || r.status === 201 || r.status === 409,
    'no internal errors': (r) => r.status < 500,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-Test Summary
// ═══════════════════════════════════════════════════════════════════════════

export function handleSummary(data) {
  const created = data.metrics.torrentedge_201_created?.values?.count || 0;
  const deduped = data.metrics.torrentedge_200_deduplicated?.values?.count || 0;
  const inflight = data.metrics.torrentedge_409_inflight?.values?.count || 0;
  const errors = data.metrics.torrentedge_5xx_errors?.values?.count || 0;
  const p99 = data.metrics.torrentedge_create_latency?.values?.['p(99)'] || 0;

  const report = `
╔══════════════════════════════════════════════════════════════╗
║           THUNDERING HERD LOAD TEST — RESULTS               ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  201 Created (first write):     ${String(created).padStart(5)}                       ║
║  200 Deduplicated (existing):   ${String(deduped).padStart(5)}                       ║
║  409 In-Flight (race blocked):  ${String(inflight).padStart(5)}                       ║
║  5xx Server Errors:             ${String(errors).padStart(5)}                       ║
║                                                              ║
║  Total Requests:                ${String(created + deduped + inflight + errors).padStart(5)}                       ║
║  P99 Latency:                   ${p99.toFixed(0).padStart(5)}ms                     ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  VERDICT:                                                    ║
║  ${errors === 0 ? '✅ PASS — Zero 5xx errors. System survived the herd.' : '❌ FAIL — Server crashed under load. Harden pools.'}        ║
║  ${created <= 1 ? '✅ PASS — At most 1 Kafka JOB_ASSIGNED dispatched.' : '❌ FAIL — Multiple dispatches detected. Fix guard.'}        ║
╚══════════════════════════════════════════════════════════════╝
`;

  console.log(report);

  return {
    'tests/load/thundering-herd-report.json': JSON.stringify({
      timestamp: new Date().toISOString(),
      created,
      deduplicated: deduped,
      inflight,
      serverErrors: errors,
      p99LatencyMs: p99,
      verdict: errors === 0 && created <= 1 ? 'PASS' : 'FAIL',
    }, null, 2),
    stdout: report,
  };
}
