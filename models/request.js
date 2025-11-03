const mongoose = require("mongoose");

const RequestSchema = new mongoose.Schema({
    request_uuid: { type: String, required: true, unique: true },

    // Authoritative fields
    requestor_fullname: { type: String, required: true },
    system_name: { type: String, required: true },
    type: { type: String, required: true },
    reason: { type: String, required: true },

    request_timestamp: { type: Date },

    // Teams / Flow outputs
    messageId: { type: String },

    // Workflow state
    status: { type: String, default: "pending" },
    actor_name: { type: String },

    // Optional source marker
    source_system: { type: String, default: "default" },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});

module.exports = mongoose.model("Request", RequestSchema);