// routes/flow.js
const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Request = require("../models/request"); // note capital 'R' to match file name

const router = express.Router();

const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL;
if (!FLOW_WEBHOOK_URL) {
  console.warn("[WARN] FLOW_WEBHOOK_URL is not set. Set it in your environment.");
}

/** Helper: prefer explicit request_timestamp; else derive from createdAt */
function toRequestedAt(doc) {
  try {
    return (doc.request_timestamp ? new Date(doc.request_timestamp) : new Date(doc.createdAt)).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Build Flow payload from DB doc (no client overrides) */
function buildFlowPayloadFromDoc(doc) {
  return {
    request_uuid: doc.request_uuid,
    requestor_fullname: doc.requestor_fullname,
    system_name: doc.system_name,
    type: doc.type,
    reason: doc.reason,
    requested_at: toRequestedAt(doc),
  };
}

/** Extract messageId from Flow response */
function extractMessageId(resp) {
  const body = resp?.data || {};
  return (
    body.messageId ||
    body.id ||
    body?.outputs?.messageId ||
    resp?.headers?.["x-ms-message-id"] ||
    null
  );
}

/**
 * --------------------------------------------------------
 * CREATE + FORWARD (single call)
 * POST /flow
 * Body:
 * {
 *   requestor_fullname: string,
 *   system_name: string,
 *   type: string,
 *   reason: string,
 *   request_timestamp?: string|Date   // optional; if omitted, we use createdAt
 * }
 * --------------------------------------------------------
 */
router.post("/", async (req, res) => {
  try {
    const { requestor_fullname, system_name, type, reason, request_timestamp } = req.body;

    // Minimal validation
    if (!requestor_fullname || !system_name || !type || !reason) {
      return res.status(400).json({ error: "Missing required fields: requestor_fullname, system_name, type, reason" });
    }

    // 1) Generate UUID
    const request_uuid = uuidv4();

    // 2) Save to DB
    const doc = await Request.create({
      request_uuid,
      requestor_fullname,
      system_name,
      type,
      reason,
      status: "pending",
      request_timestamp: request_timestamp ? new Date(request_timestamp) : undefined,
    });

    // 3) Build payload from DB record (using createdAt/request_timestamp)
    const payload = buildFlowPayloadFromDoc(doc);

    // 4) Forward to Flow
    const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    // 5) Handle non-2xx
    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      console.error("[ERROR] Flow webhook failed", { status: resp.status, data: resp.data, request_uuid });
      return res.status(502).json({
        error: "Flow webhook failed",
        status: resp.status,
        data: resp.data,
        request_uuid,
      });
    }

    // 6) Extract & persist messageId (if available)
    const messageId = extractMessageId(resp);
    if (messageId) {
      doc.messageId = messageId;
      await doc.save();
    }

    return res.status(201).json({
      request: {
        request_uuid: doc.request_uuid,
        status: doc.status,
        messageId: doc.messageId || null,
        createdAt: doc.createdAt,
      },
      flow_response: resp.data || {},
    });
  } catch (err) {
    console.error("[ERROR] create+forward:", err?.message);
    return res.status(500).json({ error: "Failed to create & forward request", message: err?.message });
  }
});

/**
 * --------------------------------------------------------
 * FORWARD BY UUID (retry/manual forward)
 * POST /flow/:uuid/forward
 * --------------------------------------------------------
 */
router.post("/:uuid/forward", async (req, res) => {
  const { uuid } = req.params;

  try {
    const doc = await Request.findOne({ request_uuid: uuid });
    if (!doc) {
      return res.status(404).json({ error: "Request not found", request_uuid: uuid });
    }

    // Rebuild payload from DB values
    const payload = buildFlowPayloadFromDoc(doc);

    const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      console.error("[ERROR] Flow webhook failed", { status: resp.status, data: resp.data, request_uuid: uuid });
      return res.status(502).json({ error: "Flow webhook failed", status: resp.status, data: resp.data });
    }

    // Update messageId if returned
    const messageId = extractMessageId(resp);
    if (messageId) {
      doc.messageId = messageId;
      await doc.save();
    }

    return res.status(200).json({
      request_uuid: uuid,
      messageId: doc.messageId || null,
      flow_response: resp.data || {},
    });
  } catch (err) {
    console.error("[ERROR] forward:", err?.message, { uuid });
    return res.status(500).json({ error: "Flow HTTP request error", message: err?.message });
  }
});

/**
 * --------------------------------------------------------
 * APPROVAL (generic)
 * POST /flow/:uuid/:status
 * :status = "approved" | "declined" (or "approve"/"decline")
 * --------------------------------------------------------
 */
router.post("/:uuid/:status", async (req, res) => {
  const { uuid, status } = req.params;

  try {
    const normalized =
      status === "approve" ? "approved" :
      status === "decline" ? "declined" :
      status;

    const doc = await Request.findOne({ request_uuid: uuid });
    if (!doc) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (doc.status !== "pending") {
      return res.status(409).json({ error: `Request already ${doc.status}` });
    }

    doc.status = normalized;
    doc.actor_name = req.body.actor_name ?? doc.actor_name ?? null;
    await doc.save();

    return res.status(200).json({
      request_uuid: doc.request_uuid,
      status: doc.status,
      actor_name: doc.actor_name ?? null,
      messageId: doc.messageId ?? null,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error("[ERROR] approval:", err?.message);
    return res.status(500).json({ error: "Approval error", message: err?.message });
  }
});

/**
 * --------------------------------------------------------
 * TEAMS APPROVAL (wrapper)
 * POST /flow/:uuid/teams-approval
 * Body: { status: "approved" | "declined", actor_name?: string }
 * --------------------------------------------------------
 */
router.post("/:uuid/teams-approval", async (req, res) => {
  const { uuid } = req.params;
  const status = req.body.status;

  if (!status) {
    return res.status(400).json({ error: "Missing status" });
  }

  try {
    const normalized =
      status === "approve" ? "approved" :
      status === "decline" ? "declined" :
      status;

    const doc = await Request.findOne({ request_uuid: uuid });
    if (!doc) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (doc.status !== "pending") {
      return res.status(409).json({ error: `Request already ${doc.status}` });
    }

    doc.status = normalized;
    doc.actor_name = req.body.actor_name ?? "Teams User";
    await doc.save();

    return res.status(200).json({
      request_uuid: doc.request_uuid,
      status: doc.status,
      actor_name: doc.actor_name,
      messageId: doc.messageId ?? null,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error("[ERROR] teams-approval:", err?.message);
    return res.status(500).json({ error: "Teams approval error", message: err?.message });
  }
});

module.exports = router;
