# TorrentEdge Observability

Phase 3.1 adds Prometheus metrics, Grafana dashboards, and OpenTelemetry trace propagation across HTTP and Kafka boundaries.

## Runtime Endpoints

- `GET /metrics` exposes Prometheus metrics.
- `GET /api/metrics` exposes the same metrics for environments that route only `/api/*`.

Core metrics:

- `transfer_throughput_mbps{direction="download|upload"}`
- `queue_lag_seconds`
- `active_workers{node_id="..."}`
- `torrentedge_http_requests_total`
- `torrentedge_http_request_duration_seconds`
- `torrentedge_kafka_messages_total`
- `torrentedge_kafka_message_duration_seconds`
- `torrentedge_directives_total`
- `torrentedge_worker_directives_total`

## Local Stack

Start the stack with:

```bash
docker-compose up -d
```

Local observability URLs:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3033` (`admin` / `admin`)
- Tempo: `http://localhost:3200`
- OpenTelemetry Collector OTLP/HTTP: `http://localhost:4318`
- OpenTelemetry Collector OTLP/gRPC: `localhost:4317`

Grafana provisions the `TorrentEdge Overview` dashboard automatically from `observability/grafana/dashboards`.

## Tracing Configuration

Tracing is disabled unless one of these is set:

- `OTEL_ENABLED=true`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`

Docker Compose enables tracing for the backend and sends spans to:

```text
http://otel-collector:4318/v1/traces
```

Kafka producer messages inject W3C trace headers (`traceparent`, `baggage`), and worker consumers extract them before processing directives. This preserves request lineage from API dispatch through worker execution.
