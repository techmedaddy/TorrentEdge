/**
 * TorrentEdge — Thundering Herd Load Test v2
 * Fix 1: http.setResponseCallback marks 200/201/409 as non-failed
 * Fix 2: Added 'other' counter to catch 401/403/etc for debugging
 * Fix 3: Console.log actual body on unexpected status for diagnosis
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────────────
const created     = new Counter('te_201_created');
const deduped     = new Counter('te_200_deduped');
const inflight    = new Counter('te_409_inflight');
const errors5xx   = new Counter('te_5xx_errors');
const unexpected  = new Counter('te_unexpected');  // catches 401, 403, etc
const latency     = new Trend('te_create_latency', true);

// ── Scenario ─────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    thundering_herd: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Use our OWN counter, not k6's built-in (which wrongly counts 409 as failed)
    'te_5xx_errors':  ['count==0'],
    'te_unexpected':  ['count==0'],
    // P99 latency guard
    'te_create_latency': ['p(99)<3000'],
  },
};

// ── Tell k6 that 200, 201, and 409 are all acceptable (non-failed) ──────────
// Without this, k6 counts 409 as http_req_failed because >= 400
export function setup() {
  http.setResponseCallback(http.expectedStatuses(200, 201, 409));
}

const PAYLOAD = JSON.stringify({
  magnetURI: 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=llama-3-70b-thundering-herd-test',
  autoStart: true,
});

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3029';

export default function () {
  const res = http.post(`${BASE_URL}/api/torrent/create`, PAYLOAD, {
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': 'thundering-herd-test-llama70b-run1',
      'Authorization': `Bearer ${__ENV.TEST_TOKEN || ''}`,
    },
    timeout: '15s',
  });

  latency.add(res.timings.duration);

  if      (res.status === 201) { created.add(1); }
  else if (res.status === 200) { deduped.add(1); }
  else if (res.status === 409) { inflight.add(1); }
  else if (res.status >= 500)  { errors5xx.add(1); console.error(`5xx: ${res.body}`); }
  else {
    // 401/403/404/etc — log for diagnosis
    unexpected.add(1);
    if (__VU <= 3) {
      console.warn(`[VU ${__VU}] Unexpected ${res.status}: ${res.body.substring(0, 200)}`);
    }
  }

  check(res, {
    'status is 200, 201, or 409': (r) => r.status === 200 || r.status === 201 || r.status === 409,
    'no 5xx errors':              (r) => r.status < 500,
  });
}

// ── Post-Test Report ──────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;

  const c   = m['te_201_created']?.values?.count   || 0;
  const d   = m['te_200_deduped']?.values?.count   || 0;
  const inf = m['te_409_inflight']?.values?.count  || 0;
  const e   = m['te_5xx_errors']?.values?.count    || 0;
  const u   = m['te_unexpected']?.values?.count    || 0;
  const p99 = m['te_create_latency']?.values?.['p(99)'] || 0;

  const total = c + d + inf + e + u;
  const pass5xx = e === 0 ? '✅' : '❌';
  const passKafka = c <= 1 ? '✅' : '❌';
  const passUnex = u === 0 ? '✅' : '❌';

  const report = `
╔══════════════════════════════════════════════════════════════╗
║         THUNDERING HERD LOAD TEST v2 — RESULTS              ║
╠══════════════════════════════════════════════════════════════╣
║  201 Created  (genesis write):   ${String(c).padStart(5)}                       ║
║  200 OK       (already exists):  ${String(d).padStart(5)}                       ║
║  409 Conflict (redis blocked):   ${String(inf).padStart(5)}                       ║
║  5xx Errors   (server crash):    ${String(e).padStart(5)}                       ║
║  Unexpected   (401/403/other):   ${String(u).padStart(5)}                       ║
║  Total Requests:                 ${String(total).padStart(5)}                       ║
║  P99 Latency:               ${String(p99.toFixed(0)).padStart(8)}ms                  ║
╠══════════════════════════════════════════════════════════════╣
║  ${pass5xx} Zero 5xx — system survived the herd                     ║
║  ${passKafka} At most 1 Kafka JOB_ASSIGNED dispatched               ║
║  ${passUnex} Zero unexpected (401/403) responses                    ║
╚══════════════════════════════════════════════════════════════╝`;

  console.log(report);

  return {
    'tests/load/thundering-herd-report.json': JSON.stringify({
      timestamp: new Date().toISOString(),
      created: c, deduplicated: d, inflight: inf,
      serverErrors: e, unexpected: u,
      p99LatencyMs: p99,
      verdict: (e === 0 && c <= 1 && u === 0) ? 'PASS' : 'FAIL',
    }, null, 2),
    stdout: report,
  };
}
