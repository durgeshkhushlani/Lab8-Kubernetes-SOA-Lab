const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../registry");
const { register, metricsHandler, requestMetricsMiddleware } = require("../metrics");

test("registry defines all three backend services with a prefix and target", () => {
  for (const name of ["user-service", "product-service", "order-service"]) {
    assert.ok(registry[name], `${name} missing from registry`);
    assert.match(registry[name].prefix, /^\/[a-z]+$/);
    assert.match(registry[name].target, /^https?:\/\//);
  }
});

test("metrics module exposes a Prometheus registry and handler", () => {
  assert.equal(typeof metricsHandler, "function");
  assert.equal(typeof requestMetricsMiddleware, "function");
  assert.equal(typeof register.metrics, "function");
});
