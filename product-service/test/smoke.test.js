const test = require("node:test");
const assert = require("node:assert/strict");

const Product = require("../models/Product");
const { metricsHandler } = require("../metrics");

test("Product model requires name and price, with a non-negative minimum", () => {
  const paths = Product.schema.paths;
  assert.ok(paths.name.isRequired);
  assert.ok(paths.price.isRequired);
  assert.equal(paths.price.options.min, 0);
});

test("metrics handler is exposed", () => {
  assert.equal(typeof metricsHandler, "function");
});
