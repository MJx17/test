// models/Request.js
const mongoose = require("mongoose");

const RequestSchema = new mongoose.Schema({
  request_uuid: { type: String, required: true, unique: true },

  // Authoritative fields used to build Flow payload
  requestor_fullname: { type: String, required: true },
  system_name: { type: String, required: true },
  type: { type: String, required: true },
  reason: { type: String, required: true },

  // Optional explicit timestamp; otherwise we derive from createdAt
  request_timestamp: { type: Date },

  // Teams / Flow outputs
  messageId: { type: String }, // Teams message id returned by Flow (if available)

  // Workflow state
  status: { type: String, enum: ["pending", "approved", "declined"], default: "pending" },
  actor_name: { type: String },

  // Automatic audit
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});

module.exports = mongoose.model("Request", RequestSchema);
``