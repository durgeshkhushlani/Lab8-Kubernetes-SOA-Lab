require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const User = require("./models/User");
const { requestMetricsMiddleware, metricsHandler } = require("./metrics");

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(requestMetricsMiddleware());
app.get("/metrics", metricsHandler);
app.use(express.json());

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUser(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || "name" in body) {
    if (typeof body.name !== "string" || body.name.trim() === "") errors.push("name must be a non-empty string");
  }
  if (!partial || "email" in body) {
    if (typeof body.email !== "string" || body.email.trim() === "") errors.push("email must be a non-empty string");
    else if (!EMAIL_REGEX.test(body.email.trim())) errors.push("email must be a valid email address");
  }
  return errors;
}

function notFound(res, id) {
  return res.status(404).json({ error: { status: 404, message: `User with id ${id} not found` } });
}

function validationFailed(res, details) {
  return res.status(400).json({ error: { status: 400, message: "Validation failed", details } });
}

function isMalformedId(err) {
  return err.name === "CastError" && err.kind === "ObjectId";
}

function isDuplicateEmail(err) {
  return err.code === 11000 && err.keyPattern && err.keyPattern.email;
}

app.get("/health", (req, res) => res.status(200).json({ service: "user-service", status: "ok" }));

app.get("/users", async (req, res, next) => {
  try {
    const users = await User.find().sort({ _id: 1 });
    res.status(200).json(users);
  } catch (err) {
    next(err);
  }
});

app.get("/users/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, req.params.id);
    res.status(200).json(user);
  } catch (err) {
    if (isMalformedId(err)) return notFound(res, req.params.id);
    next(err);
  }
});

app.post("/users", async (req, res, next) => {
  const body = req.body || {};
  const errors = validateUser(body);
  if (errors.length > 0) return validationFailed(res, errors);

  try {
    const user = await User.create({
      name: body.name.trim(),
      email: body.email.trim(),
      role: body.role ? String(body.role).trim() : undefined,
    });
    res.status(201).json(user);
  } catch (err) {
    if (isDuplicateEmail(err)) return validationFailed(res, [`email ${body.email.trim()} is already registered`]);
    next(err);
  }
});

async function updateHandler(req, res, next) {
  const body = req.body || {};
  const isPatch = req.method === "PATCH";
  const errors = validateUser(body, { partial: isPatch });
  if (errors.length > 0) return validationFailed(res, errors);

  const update = {};
  if ("name" in body) update.name = body.name.trim();
  if ("email" in body) update.email = body.email.trim();
  if ("role" in body) update.role = body.role;

  try {
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!user) return notFound(res, req.params.id);
    res.status(200).json(user);
  } catch (err) {
    if (isMalformedId(err)) return notFound(res, req.params.id);
    if (isDuplicateEmail(err)) return validationFailed(res, [`email ${body.email.trim()} is already registered`]);
    next(err);
  }
}

app.put("/users/:id", updateHandler);
app.patch("/users/:id", updateHandler);

app.delete("/users/:id", async (req, res, next) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return notFound(res, req.params.id);
    res.status(204).send();
  } catch (err) {
    if (isMalformedId(err)) return notFound(res, req.params.id);
    next(err);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: { status: 404, message: "Route not found" } });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: { status: 500, message: "Internal server error" } });
});

async function start() {
  if (!MONGODB_URI) {
    console.error("Missing MONGODB_URI");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);
  console.log("user-service connected to MongoDB");
  app.listen(PORT, () => console.log(`user-service running on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start user-service:", err.message);
  process.exit(1);
});
