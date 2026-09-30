const mongoose = require("mongoose");

// Order Service owns only its own data - the userId/productId are references by id only,
// never a copy of the User/Product documents themselves (no cross-service DB access).
const orderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  productId: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  status: { type: String, default: "created" },
  createdAt: { type: Date, default: Date.now },
});

orderSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
  },
});

module.exports = mongoose.model("Order", orderSchema);
