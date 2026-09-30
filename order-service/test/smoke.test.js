const test = require("node:test");
const assert = require("node:assert/strict");

const Order = require("../models/Order");
const { DependencyError } = require("../dependencyClient");
const { metricsHandler } = require("../metrics");

test("Order model requires userId, productId and a quantity of at least 1", () => {
  const paths = Order.schema.paths;
  assert.ok(paths.userId.isRequired);
  assert.ok(paths.productId.isRequired);
  assert.equal(paths.quantity.options.min, 1);
});

test("DependencyError carries the status it was constructed with", () => {
  const err = new DependencyError("Product not found", 404);
  assert.equal(err.status, 404);
  assert.equal(err.message, "Product not found");
});

test("metrics handler is exposed", () => {
  assert.equal(typeof metricsHandler, "function");
});
