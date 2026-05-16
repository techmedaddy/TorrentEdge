'use strict';

const {
  context,
  propagation,
  SpanStatusCode,
  trace,
} = require('@opentelemetry/api');

let sdk = null;
let started = false;

function isTracingConfigured() {
  if (process.env.OTEL_ENABLED === 'false' || process.env.OTEL_SDK_DISABLED === 'true') {
    return false;
  }

  return process.env.OTEL_ENABLED === 'true' ||
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) ||
    Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

function getTraceEndpoint() {
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  }

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  return base.endsWith('/v1/traces') ? base : `${base.replace(/\/$/, '')}/v1/traces`;
}

function buildResource() {
  const attributes = {
    'service.name': process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'torrentedge-backend',
    'service.version': process.env.npm_package_version || '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
    'service.instance.id': process.env.WORKER_NODE_ID || `local-${process.pid}`,
  };

  try {
    const resources = require('@opentelemetry/resources');
    if (typeof resources.resourceFromAttributes === 'function') {
      return resources.resourceFromAttributes(attributes);
    }
    if (typeof resources.Resource === 'function') {
      return new resources.Resource(attributes);
    }
  } catch (err) {
    // The SDK can still start with OTEL_SERVICE_NAME from env.
  }

  return undefined;
}

function startTracing() {
  if (started || !isTracingConfigured()) {
    return false;
  }

  try {
    process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'torrentedge-backend';

    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    sdk = new NodeSDK({
      resource: buildResource(),
      traceExporter: new OTLPTraceExporter({
        url: getTraceEndpoint(),
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': {
            enabled: false,
          },
        }),
      ],
    });

    const maybePromise = sdk.start();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((err) => {
        console.warn(`[Tracing] Failed to start OpenTelemetry SDK: ${err.message}`);
      });
    }

    started = true;
    console.log(`[Tracing] OpenTelemetry enabled (${getTraceEndpoint()})`);
    return true;
  } catch (err) {
    console.warn(`[Tracing] OpenTelemetry disabled: ${err.message}`);
    sdk = null;
    started = false;
    return false;
  }
}

async function shutdownTracing() {
  if (!sdk || !started) {
    return;
  }

  try {
    await sdk.shutdown();
  } catch (err) {
    console.warn(`[Tracing] OpenTelemetry shutdown failed: ${err.message}`);
  } finally {
    sdk = null;
    started = false;
  }
}

function getTracer() {
  return trace.getTracer('torrentedge', process.env.npm_package_version || '1.0.0');
}

async function withSpan(name, attributes, fn, parentContext) {
  if (typeof attributes === 'function') {
    parentContext = fn;
    fn = attributes;
    attributes = {};
  }

  const baseContext = parentContext || context.active();
  const span = getTracer().startSpan(name, { attributes: attributes || {} }, baseContext);
  const spanContext = trace.setSpan(baseContext, span);

  return context.with(spanContext, async () => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

function injectKafkaHeaders(headers = {}) {
  propagation.inject(context.active(), headers, {
    set(carrier, key, value) {
      carrier[key] = String(value);
    },
  });

  return headers;
}

function extractKafkaContext(headers = {}) {
  const carrier = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (Buffer.isBuffer(value)) {
      carrier[key] = value.toString();
    } else if (Array.isArray(value)) {
      carrier[key] = value.map((item) => Buffer.isBuffer(item) ? item.toString() : String(item));
    } else if (value !== undefined && value !== null) {
      carrier[key] = String(value);
    }
  }

  return propagation.extract(context.active(), carrier);
}

module.exports = {
  startTracing,
  shutdownTracing,
  withSpan,
  injectKafkaHeaders,
  extractKafkaContext,
};
