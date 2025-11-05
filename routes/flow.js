const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Request = require("../models/request"); // adjust path to your model

const router = express.Router();
const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL;

/* ================================================
   CREATE + FIRE WEBHOOK
   POST /flow
   - Creates request with status = "pending"
   - Sends webhook (does NOT modify approval status)
================================================ */
router.post("/", async (req, res) => {
  try {
    const {
      requestor_fullname,
      system_name,
      type,
      reason,
      request_timestamp,
      source_system
    } = req.body;

    // Validate required fields
    if (!requestor_fullname || !system_name || !type || !reason) {
      return res.status(400).json({
        error: "Missing required fields: requestor_fullname, system_name, type, reason"
      });
    }

    const request_uuid = uuidv4();

    // Create DB record with approval status = pending
    const newRequest = await Request.create({
      request_uuid,
      requestor_fullname: String(requestor_fullname).trim(),
      system_name: String(system_name).trim(),
      type: String(type).trim(),
      reason: String(reason).trim(),
      request_timestamp: request_timestamp || new Date().toISOString(),
      source_system: source_system || "default",
      status: "pending" // approval status only
    });

    // Inline payload to Flow/Teams (no separate builder)
    const payload = {
      id: newRequest.request_uuid,
      requester: { name: newRequest.requestor_fullname },
      system: newRequest.system_name,
      type: newRequest.type,
      reason: newRequest.reason,
      timestamp: newRequest.request_timestamp,
      source: newRequest.source_system || "unknown",
      version: "v1",
      correlationId: newRequest.request_uuid
    };

    // Fire webhook (best-effort). Regardless of result, status stays "pending".
    try {
      const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
        timeout: 15000,
        headers: { "Content-Type": "application/json" }
      });

      const messageId = resp.data && resp.data.activityId ? String(resp.data.activityId) : undefined;
      const conversationId = resp.data && resp.data.conversationId ? String(resp.data.conversationId) : undefined;

      if (messageId || conversationId) {
        await Request.updateOne(
          { request_uuid },
          { $set: { messageId, conversationId } }
        );
      }
    } catch (e) {
      console.error("[Webhook ERROR] create -> post Flow:", e.message);
      // Optional: persist lastError for debugging
      await Request.updateOne(
        { request_uuid },
        { $set: { lastError: e.message } }
      );
    }

    // Respond with pending approval status
    return res.status(201).json({
      request: {
        uuid: newRequest.request_uuid,
        status: newRequest.status, // "pending"
        messageId: newRequest.messageId || null,
        conversationId: newRequest.conversationId || null,
        source_system: newRequest.source_system,
        createdAt: newRequest.createdAt
      }
    });
  } catch (err) {
    console.error("[ERROR] /flow create:", err.message);
    return res.status(500).json({
      error: "Failed to create request",
      message: err.message
    });
  }
});

/* ================================================
   TEAMS APPROVAL CALLBACK
   POST /flow/:uuid/teams-approval
   - Flow/Teams posts { status, actor_name }
   - We update ONLY approval status + actor_name
   - No posting of status from here; only update DB
================================================ */
router.post("/:uuid/teams-approval", async (req, res) => {
  const { uuid } = req.params;
  let { status, actor_name } = req.body;

  console.log("[DEBUG] Incoming Teams payload:", req.body);

  const normalized = (typeof status === "string" ? status : "").toLowerCase().trim();
  if (!["approved", "declined"].includes(normalized)) {
    return res.status(400).json({ error: "Invalid status", received: status });
  }

  try {
    // If you want to prevent double-processing, add status: "pending" to the filter
    const updateResult = await Request.updateOne(
      { request_uuid: uuid /*, status: "pending"*/ },
      {
        $set: {
          status: normalized, // approved | declined
          actor_name: (actor_name ? String(actor_name) : "Teams User").trim()
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "Request not found" });
    }

    const updated = await Request.findOne({ request_uuid: uuid }).lean();

    return res.status(200).json({
      request_uuid: updated.request_uuid,
      status: updated.status,
      actor_name: updated.actor_name,
      messageId: updated.messageId || null,
      source_system: updated.source_system,
      createdAt: updated.createdAt
    });
  } catch (err) {
    console.error("[ERROR] /flow/:uuid/teams-approval:", err.message);
    return res.status(500).json({ error: "Teams approval error", message: err.message });
  }
});

/* ================================================
   STATUS CHECK
   GET /flow/:uuid/status
   - Read-only: fetch current approval status + actor
================================================ */
router.get("/:uuid/status", async (req, res) => {
  try {
    const request = await Request.findOne({ request_uuid: req.params.uuid }).lean();
    if (!request) return res.status(404).json({ error: "Request not found" });

    return res.status(200).json({
      request_uuid: request.request_uuid,
      status: request.status,                 // pending | approved | declined
      actor_name: request.actor_name || null, // who approved/declined (if any)
      messageId: request.messageId || null,   // optional
      source_system: request.source_system,
      createdAt: request.createdAt
    });
  } catch (err) {
    console.error("[ERROR] /flow/:uuid/status:", err.message);
    return res.status(500).json({ error: "Failed to fetch request status", message: err.message });
  }
});

module.exports = router;