const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Request = require("../models/request");

const router = express.Router();

const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL;
if (!FLOW_WEBHOOK_URL) {
    console.warn("[WARN] FLOW_WEBHOOK_URL is not set in environment variables.");
}

router.post("/", async (req, res) => {
  try {
    const {
      requestor_fullname,
      system_name,
      type,
      reason,
      requested_at,
      source_system
    } = req.body;

    // Validate required fields
    if (!requestor_fullname || !system_name || !type || !reason) {
      return res.status(400).json({
        error: "Missing required fields: requestor_fullname, system_name, type, reason"
      });
    }

    const request_uuid = uuidv4();

    // Create DB record with status = pending
    const newRequest = await Request.create({
      request_uuid,
      requestor_fullname: requestor_fullname.trim(),
      system_name: system_name.trim(),
      type: type.trim(),
      reason: reason.trim(),
      request_timestamp: requested_at ?? new Date().toISOString(),
      source_system: source_system ?? "default",
      status: "pending"
    });

    // Construct payload for Flow webhook (matching schema)
    const payload = {
      request_uuid: newRequest.request_uuid,
      requestor_fullname: newRequest.requestor_fullname,
      system_name: newRequest.system_name,
      type: newRequest.type,
      reason: newRequest.reason,
      requested_at: newRequest.request_timestamp
    };

    // Fire webhook (best-effort)
    try {
      const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
        timeout: 15000,
        headers: { "Content-Type": "application/json" }
      });

      const messageId = resp.data?.activityId?.toString();
      const conversationId = resp.data?.conversationId?.toString();

      // Update only messageId and conversationId, not status
      await Request.updateOne(
        { request_uuid },
        { $set: { messageId, conversationId } }
      );
    } catch (e) {
      console.error("[Webhook ERROR] create -> post Flow:", e.message);
      await Request.updateOne(
        { request_uuid },
        { $set: { lastError: e.message } }
      );
    }

    // Final response
    const updated = await Request.findOne({ request_uuid }).lean();

    res.status(201).json({
      request: {
        uuid: updated.request_uuid,
        status: updated.status,
        messageId: updated.messageId || null,
        conversationId: updated.conversationId || null,
        source_system: updated.source_system,
        createdAt: updated.createdAt
      }
    });
  } catch (err) {
    console.error("[ERROR] /flow create:", err.message);
    res.status(500).json({
      error: "Failed to create request",
      message: err.message
    });
  }
});




router.get("/:uuid/status", async (req, res) => {
  try {
    const request = await Request.findOne({ request_uuid: req.params.uuid }).lean();
    if (!request) return res.status(404).json({ error: "Request not found" });

    res.status(200).json({
      request_uuid: request.request_uuid,
      status: request.status,
      actor_name: request.actor_name || null,
      messageId: request.messageId || null,
      source_system: request.source_system,
      createdAt: request.createdAt
    });
  } catch (err) {
    console.error("[ERROR] /flow/:uuid/status:", err.message);
    res.status(500).json({ error: "Failed to fetch request status", message: err.message });
  }
});
/* =======================================================
   TEAMS APPROVAL
   POST /flow/:uuid/teams-approval

======================================================= */
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
module.exports = router;






