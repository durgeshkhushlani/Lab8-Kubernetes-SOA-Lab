require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const Product = require("./models/Product");
const { requestMetricsMiddleware, metricsHandler } = require("./metrics");

const app = express();
const PORT = process.env.PORT || 3002;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(requestMetricsMiddleware());
app.get("/metrics", metricsHandler);
app.use(express.json());

function validateProduct(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || "name" in body) {
    if (typeof body.name !== "string" || body.name.trim() === "") errors.push("name must be a non-empty string");
  }
  if (!partial || "price" in body) {
    if (typeof body.price !== "number" || body.price < 0) errors.push("price must be a non-negative number");
  }
  if ("stock" in body) {
    if (typeof body.stock !== "number" || body.stock < 0) errors.push("stock must be a non-negative number");
  }
  return errors;
}

function notFound(res, id) {
  return res.status(404).json({ error: { status: 404, message: `Product with id ${id} not found` } });
}

function validationFailed(res, details) {
  return res.status(400).json({ error: { status: 400, message: "Validation failed", details } });
}

function isMalformedId(err) {
  return err.name === "CastError" && err.kind === "ObjectId";
}

app.get("/health", (req, res) => res.status(200).json({ service: "product-service", status: "ok" }));

app.get("/products", async (req, res, next) => {
  try {
    const products = await Product.find().sort({ _id: 1 });
    res.status(200).json(products);
  } catch (err) {
    next(err);
  }
});

app.get("/products/:id", async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return notFound(res, req.params.id);
    res.status(200).json(product);
  } catch (err) {
    if (isMalformedId(err)) return notFound(res, req.params.id);
    next(err);
  }
});

app.post("/products", async (req, res, next) => {
  const body = req.body || {};
  const errors = validateProduct(body);
  if (errors.length > 0) return validationFailed(res, errors);

  try {
    const product = await Product.create({
      name: body.name.trim(),
      price: body.price,
      stock: "stock" in body ? body.stock : 0,
    });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

async function updateHandler(req, res, next) {
  const body = req.body || {};
  const isPatch = req.method === "PATCH";
  const errors = validateProduct(body, { partial: isPatch });
  if (errors.length > 0) return validationFailed(res, errors);

  const update = {};
  if ("name" in body) update.name = body.name.trim();
  if ("price" in body) update.price = body.price;
  if ("stock" in body) update.stock = body.stock;

  try {
    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!product) return notFound(res, req.params.id);
    res.status(200).json(product);
  } catch (err) {
    if (isMalformedId(err)) return notFound(res, req.params.id);
    next(err);
  }
}

app.put("/products/:id", updateHandler);
app.patch("/products/:id", updateHandler);

app.delete("/products/:id", async (req, res, next) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return notFound(res, req.params.id);
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
  console.log("product-service connected to MongoDB");
  app.listen(PORT, () => console.log(`product-service running on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start product-service:", err.message);
  process.exit(1);
});
