const client = require("prom-client");

// One shared registry for this process - collectDefaultMetrics adds the usual Node/process
// metrics (memory, event loop lag, GC) on top of the two custom ones below.
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests handled, labeled by method/route/status",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method/route/status",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// getRouteLabel(req) lets callers pick a low-cardinality label (e.g. "/users/:id" or, for the
// gateway, the target service name) instead of the raw path with real ids in it.
function requestMetricsMiddleware(getRouteLabel) {
  return function (req, res, next) {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = getRouteLabel ? getRouteLabel(req) : req.route?.path || req.path;
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, seconds);
    });
    next();
  };
}

function metricsHandler(req, res) {
  res.set("Content-Type", register.contentType);
  register.metrics().then((data) => res.end(data));
}

module.exports = { register, httpRequestsTotal, httpRequestDuration, requestMetricsMiddleware, metricsHandler };
