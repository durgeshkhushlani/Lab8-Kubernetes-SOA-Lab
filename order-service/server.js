require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const Order = require("./models/Order");
const { fetchResource, DependencyError } = require("./dependencyClient");
const { requestMetricsMiddleware, metricsHandler } = require("./metrics");

const app = express();
const PORT = process.env.PORT || 3003;
const MONGODB_URI = process.env.MONGODB_URI;

// Never hard-coded, and never localhost - these must resolve to the other containers by their
// Compose service name (see compose.yaml / README "localhost vs service name").
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || "http://user-service:3001";
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || "http://product-service:3002";

app.use(cors());
app.use(requestMetricsMiddleware());
app.get("/metrics", metricsHandler);
app.use(express.json());

function notFound(res, id) {
  return res.status(404).json({ error: { status: 404, message: `Order with id ${id} not found` } });
}

function validationFailed(res, details) {
  return res.status(400).json({ error: { status: 400, message: "Validation failed", details } });
}

function isMalformedId(err) {
  return err.name === "CastError" && err.kind === "ObjectId";
}

app.get("/health", (req, res) => res.status(200).json({ service: "order-service", status: "ok" }));

app.get("/orders", async (req, res, next) => {
  try {
    const orders = await Order.find().sort({ _id: 1 });
    res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
});

app.get("/orders/:id", async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return notFound(res, req.params.id);
    res.status(200).json(order);
  } catch (err) {
    if (isMalformedId(err)) return notFound(res, req.params.id);
    next(err);
  }
});

// POST /orders - the actual Order -> User / Order -> Product service-to-service call this lab
// is built around. Both referenced resources are checked with the OTHER services over REST -
// this service never queries the User or Product databases directly.
app.post("/orders", async (req, res, next) => {
  const body = req.body || {};
  const errors = [];
  if (typeof body.userId !== "string" || body.userId.trim() === "") errors.push("userId is required");
  if (typeof body.productId !== "string" || body.productId.trim() === "") errors.push("productId is required");
  if (!Number.isInteger(body.quantity) || body.quantity < 1) errors.push("quantity must be a positive integer");
  if (errors.length > 0) return validationFailed(res, errors);

  try {
    const [user, product] = await Promise.all([
      fetchResource(USER_SERVICE_URL, `/users/${body.userId}`, "User"),
      fetchResource(PRODUCT_SERVICE_URL, `/products/${body.productId}`, "Product"),
    ]);

    const order = await Order.create({
      userId: user.id,
      productId: product.id,
      quantity: body.quantity,
    });
    res.status(201).json(order);
  } catch (err) {
    if (err instanceof DependencyError) {
      return res.status(err.status).json({ error: { status: err.status, message: err.message } });
    }
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
  console.log("order-service connected to MongoDB");
  app.listen(PORT, () => {
    console.log(`order-service running on http://localhost:${PORT}`);
    console.log(`  -> USER_SERVICE_URL=${USER_SERVICE_URL}`);
    console.log(`  -> PRODUCT_SERVICE_URL=${PRODUCT_SERVICE_URL}`);
  });
}

start().catch((err) => {
  console.error("Failed to start order-service:", err.message);
  process.exit(1);
});
