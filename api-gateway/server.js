require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");

const registry = require("./registry");
const { requestMetricsMiddleware, metricsHandler } = require("./metrics");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// No express.json() here on purpose - the gateway has no business logic and must not consume the
// request body before it reaches the target service; http-proxy-middleware streams the raw body
// through untouched. Parsing/validation stays in the services that actually own the data.

function resolveServiceName(path) {
  for (const [name, cfg] of Object.entries(registry)) {
    if (path === cfg.prefix || path.startsWith(`${cfg.prefix}/`)) return name;
  }
  return null;
}

// Request logging: method, path, target service, response status - the one cross-cutting concern
// every request goes through, regardless of which service (or /health) it ends up hitting.
app.use((req, res, next) => {
  const target = req.path === "/health" ? "gateway" : resolveServiceName(req.path) || "unmatched";
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${target} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Metrics use the resolved service name as the route label (low cardinality) rather than the raw
// path, which would otherwise contain real ids and blow up the number of distinct time series.
app.use(requestMetricsMiddleware((req) => (req.path === "/health" ? "/health" : resolveServiceName(req.path) || "unmatched")));
app.get("/metrics", metricsHandler);

// Gateway's own health check - answered directly, never proxied.
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "api-gateway",
    routes: Object.fromEntries(Object.entries(registry).map(([name, cfg]) => [cfg.prefix, { service: name, target: cfg.target }])),
  });
});

// One reverse-proxy route per registry entry. Nothing here is a literal URL - cfg.target came from
// registry.js, which reads it from an environment variable. Change the env var, restart, and every
// route below points somewhere else without a single line of this file changing.
for (const [name, cfg] of Object.entries(registry)) {
  app.use(
    cfg.prefix,
    createProxyMiddleware({
      target: cfg.target,
      changeOrigin: true,
      logLevel: "silent",
      onError: (err, req, res) => {
        console.error(`Gateway: ${name} (${cfg.target}) is unreachable - ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({
            error: { status: 502, message: `${name} is unreachable`, target: cfg.target },
          });
        }
      },
    })
  );
}

app.use((req, res) => {
  res.status(404).json({ error: { status: 404, message: "Route not found" } });
});

app.listen(PORT, () => {
  console.log(`api-gateway running on http://localhost:${PORT}`);
  for (const [name, cfg] of Object.entries(registry)) {
    console.log(`  ${cfg.prefix}/* -> ${name} (${cfg.target})`);
  }
});
