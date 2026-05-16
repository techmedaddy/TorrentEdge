'use strict';

const client = require('prom-client');

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'torrentedge-backend';
const NODE_ID = process.env.WORKER_NODE_ID || `local-${process.pid}`;

const register = new client.Registry();

register.setDefaultLabels({
  service: SERVICE_NAME,
  node_id: NODE_ID,
});

client.collectDefaultMetrics({
  register,
  prefix: 'torrentedge_process_',
});

const transferThroughputMbps = new client.Gauge({
  name: 'transfer_throughput_mbps',
  help: 'Current aggregate transfer throughput in megabits per second.',
  labelNames: ['direction'],
  registers: [register],
});

const queueLagSeconds = new client.Gauge({
  name: 'queue_lag_seconds',
  help: 'Age in seconds of the oldest queued transfer.',
  registers: [register],
});

const activeWorkers = new client.Gauge({
  name: 'active_workers',
  help: 'Worker nodes currently reporting as active.',
  labelNames: ['node_id'],
  registers: [register],
});

const queueDepth = new client.Gauge({
  name: 'torrentedge_queue_depth',
  help: 'Current transfer queue depth by state.',
  labelNames: ['state'],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'torrentedge_http_requests_total',
  help: 'HTTP requests handled by the API.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'torrentedge_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const kafkaMessagesTotal = new client.Counter({
  name: 'torrentedge_kafka_messages_total',
  help: 'Kafka messages produced or consumed.',
  labelNames: ['boundary', 'topic', 'type', 'result'],
  registers: [register],
});

const kafkaMessageDuration = new client.Histogram({
  name: 'torrentedge_kafka_message_duration_seconds',
  help: 'Kafka produce/consume operation duration in seconds.',
  labelNames: ['boundary', 'topic', 'type', 'result'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const directivesTotal = new client.Counter({
  name: 'torrentedge_directives_total',
  help: 'Control-plane directives dispatched.',
  labelNames: ['type', 'mode', 'result'],
  registers: [register],
});

const workerDirectivesTotal = new client.Counter({
  name: 'torrentedge_worker_directives_total',
  help: 'Worker directives processed.',
  labelNames: ['type', 'result'],
  registers: [register],
});

const workerHeartbeatsTotal = new client.Counter({
  name: 'torrentedge_worker_heartbeats_total',
  help: 'Worker heartbeat events emitted.',
  labelNames: ['node_id'],
  registers: [register],
});

function normalizeRoute(req) {
  const routePath = req.route && req.route.path;
  if (routePath) {
    return `${req.baseUrl || ''}${routePath}` || '/';
  }

  const path = (req.originalUrl || req.url || 'unknown').split('?')[0];
  return path
    .replace(/[0-9a-f]{32,64}/gi, ':hash')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function createHttpMetricsMiddleware() {
  return function httpMetrics(req, res, next) {
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = {
        method: req.method,
        route: normalizeRoute(req),
        status_code: String(res.statusCode),
      };

      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, elapsedSeconds);
    });

    next();
  };
}

function bytesPerSecondToMbps(value) {
  const bytesPerSecond = Number(value) || 0;
  return (bytesPerSecond * 8) / 1_000_000;
}

function getOldestQueueLagSeconds(engine) {
  const queued = engine && engine._queueManager && Array.isArray(engine._queueManager.queue)
    ? engine._queueManager.queue
    : [];

  if (queued.length === 0) {
    return 0;
  }

  const now = Date.now();
  return queued.reduce((max, item) => {
    const addedAt = Number(item.addedAt) || now;
    return Math.max(max, Math.max(0, (now - addedAt) / 1000));
  }, 0);
}

function observeEngineMetrics(engine, worker) {
  let stats = null;
  try {
    if (engine && typeof engine.getStats === 'function') {
      stats = engine.getStats();
    } else if (engine && typeof engine.getGlobalStats === 'function') {
      stats = engine.getGlobalStats();
    }
  } catch (err) {
    stats = null;
  }

  const downloadSpeed = stats ? stats.totalDownloadSpeed : 0;
  const uploadSpeed = stats ? stats.totalUploadSpeed : 0;

  transferThroughputMbps.set({ direction: 'download' }, bytesPerSecondToMbps(downloadSpeed));
  transferThroughputMbps.set({ direction: 'upload' }, bytesPerSecondToMbps(uploadSpeed));
  queueLagSeconds.set(getOldestQueueLagSeconds(engine));

  const queue = stats && stats.queue ? stats.queue : {};
  queueDepth.set({ state: 'active' }, Number(queue.active) || Number(stats && stats.activeTorrents) || 0);
  queueDepth.set({ state: 'queued' }, Number(queue.queued) || 0);
  queueDepth.set({ state: 'paused' }, Number(queue.paused) || 0);
  queueDepth.set({ state: 'completed' }, Number(queue.completed) || 0);

  let workerStats = null;
  try {
    workerStats = worker && typeof worker.getStats === 'function' ? worker.getStats() : null;
  } catch (err) {
    workerStats = null;
  }

  const nodeId = (workerStats && workerStats.nodeId) || NODE_ID;
  activeWorkers.set({ node_id: nodeId }, workerStats && workerStats.isRunning ? 1 : 0);
}

function createMetricsHandler(options = {}) {
  const collect = options.collect;

  return async function metricsHandler(req, res, next) {
    try {
      if (typeof collect === 'function') {
        await collect();
      }

      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      next(err);
    }
  };
}

function startKafkaTimer(boundary, topic, type) {
  const started = process.hrtime.bigint();

  return function endKafkaTimer(result = 'success') {
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    kafkaMessageDuration.observe({
      boundary,
      topic: topic || 'unknown',
      type: type || 'unknown',
      result,
    }, elapsedSeconds);
  };
}

function recordKafkaMessage({ boundary, topic, type, result = 'success', count = 1 }) {
  kafkaMessagesTotal.inc({
    boundary: boundary || 'unknown',
    topic: topic || 'unknown',
    type: type || 'unknown',
    result,
  }, count);
}

function recordDirective({ type, mode = 'unknown', result = 'success' }) {
  directivesTotal.inc({ type: type || 'unknown', mode, result });
}

function recordWorkerDirective({ type, result = 'success' }) {
  workerDirectivesTotal.inc({ type: type || 'unknown', result });
}

function recordWorkerHeartbeat(nodeId = NODE_ID) {
  workerHeartbeatsTotal.inc({ node_id: nodeId });
  activeWorkers.set({ node_id: nodeId }, 1);
}

module.exports = {
  register,
  createHttpMetricsMiddleware,
  createMetricsHandler,
  observeEngineMetrics,
  recordKafkaMessage,
  recordDirective,
  recordWorkerDirective,
  recordWorkerHeartbeat,
  startKafkaTimer,
};
