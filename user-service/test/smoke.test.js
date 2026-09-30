const test = require("node:test");
const assert = require("node:assert/strict");

const User = require("../models/User");
const { metricsHandler } = require("../metrics");

test("User model requires name and email", () => {
  const paths = User.schema.paths;
  assert.ok(paths.name.isRequired);
  assert.ok(paths.email.isRequired);
});

test("User model enforces a unique index on email", () => {
  const emailIndexOptions = User.schema.path("email").options;
  assert.equal(emailIndexOptions.unique, true);
});

test("metrics handler is exposed", () => {
  assert.equal(typeof metricsHandler, "function");
});
