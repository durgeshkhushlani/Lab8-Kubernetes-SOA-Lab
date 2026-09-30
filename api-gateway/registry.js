// The gateway's service registry - the "lightweight, practical form of service discovery" this lab
// asks for. Every route handler below reads from this object; none of them contain a literal URL.
// To point the gateway at a service running somewhere else, change the env var - nothing here changes.
const registry = {
  "user-service": {
    prefix: "/users",
    target: process.env.USER_SERVICE_URL || "http://user-service:3001",
  },
  "product-service": {
    prefix: "/products",
    target: process.env.PRODUCT_SERVICE_URL || "http://product-service:3002",
  },
  "order-service": {
    prefix: "/orders",
    target: process.env.ORDER_SERVICE_URL || "http://order-service:3003",
  },
};

module.exports = registry;
