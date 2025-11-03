const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Request = require("../models/request");

const router = express.Router();

const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL;
if (!FLOW_WEBHOOK_URL) {
    console.warn("[WARN] FLOW_WEBHOOK_URL is not set in environment variables.");
}




function buildFlowPayload(doc) {
    return {
        request_uuid: doc.request_uuid,
        requestor_fullname: doc.requestor_fullname,
        system_name: doc.system_name,
        type: doc.type,
        reason: doc.reason,
        request_timestamp: doc.request_timestamp,
        source_system: doc.source_system || "default",
        messageId: doc.messageId || null
    };
}


router.post("/", async (req, res) => {
    try {
        const { requestor_fullname, system_name, type, reason, request_timestamp, source_system } = req.body;

        if (!requestor_fullname || !system_name || !type || !reason) {
            return res.status(400).json({
                error: "Missing required fields: requestor_fullname, system_name, type, reason",
            });
        }

        const doc = await Request.create({
            request_uuid: uuidv4(),
            requestor_fullname,
            system_name,
            type,
            reason,
            request_timestamp,
            source_system,
        });

        const payload = buildFlowPayload(doc);
        const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
            timeout: 15000,
            headers: { "Content-Type": "application/json" },
        });

        // Store the Flow response directly as messageId
        doc.messageId = resp.data?.toString();
        await doc.save();

        return res.status(201).json({
            request: {
                uuid: doc.request_uuid,
                status: doc.status,
                messageId: doc.messageId,
                source_system: doc.source_system,
                createdAt: doc.createdAt,
            }
        });
    } catch (err) {
        console.error("[ERROR] /flow create+forward:", err.message);
        return res.status(500).json({ error: "Failed to create & forward request", message: err.message });
    }
});

router.post("/:uuid/forward", async (req, res) => {
    const { uuid } = req.params;

    try {
        const doc = await Request.findOne({ request_uuid: uuid });
        if (!doc) return res.status(404).json({ error: "Request not found", uuid });

        const payload = buildFlowPayload(doc);
        const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
            timeout: 15000,
            headers: { "Content-Type": "application/json" },
        });

        // Store the Flow response directly as messageId
        doc.messageId = resp.data?.toString();
        await doc.save();

        return res.status(200).json({
            request_uuid: doc.request_uuid,
            messageId: doc.messageId,
            source_system: doc.source_system
        });
    } catch (err) {
        console.error("[ERROR] /flow/:uuid/forward:", err.message);
        return res.status(500).json({ error: "Flow HTTP request error", message: err.message });
    }
});

/* =======================================================
   APPROVAL (manual or via API)
   POST /flow/:uuid/:status
======================================================= */
router.post("/:uuid/:status", async(req, res) => {
    const { uuid, status } = req.params;

    try {
        const normalized =
            status === "approve" ? "approved" :
            status === "decline" ? "declined" :
            status;

        const doc = await Request.findOne({ request_uuid: uuid });
        if (!doc) return res.status(404).json({ error: "Request not found" });

        if (doc.status !== "pending") {
            return res.status(409).json({ error: `Request already ${doc.status}` });
        }

        doc.status = normalized;
        doc.actor_name = req.body.actor_name || doc.actor_name || null;
        await doc.save();

        return res.status(200).json({
            request_uuid: doc.request_uuid,
            status: doc.status,
            actor_name: doc.actor_name,
            messageId: doc.messageId || null,
            source_system: doc.source_system,
            createdAt: doc.createdAt,
        });
    } catch (err) {
        console.error("[ERROR] /flow/:uuid/:status:", err.message);
        return res.status(500).json({ error: "Approval update failed", message: err.message });
    }
});

/* =======================================================
   TEAMS APPROVAL (wrapper)
   POST /flow/:uuid/teams-approval
======================================================= */
// Ensure this is in place globally, before routes:
// app.use(express.json());

router.post("/:uuid/teams-approval", async (req, res) => {
  const { uuid } = req.params;
  let { status, actor_name } = req.body;

  console.log("[DEBUG] Incoming payload:", req.body);

  // 1️⃣ Validate payload
  if (typeof status !== "string" || !status.trim()) {
    return res.status(400).json({ error: "Missing or invalid status" });
  }

  status = status.toLowerCase().trim();
  if (!["approved", "declined"].includes(status)) {
    return res.status(400).json({
      error: "Invalid status. Must be 'approved' or 'declined'.",
      received: status
    });
  }

  try {
    // 2️⃣ Update directly in DB (bypasses in-memory doc issues)
    const updateResult = await Request.updateOne(
      { request_uuid: uuid },
      {
        $set: {
          status: status,
          actor_name: actor_name?.trim() || "Teams User"
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "Request not found" });
    }

    // 3️⃣ Fetch the updated document to return
    const updatedDoc = await Request.findOne({ request_uuid: uuid });

    return res.status(200).json({
      request_uuid: updatedDoc.request_uuid,
      status: updatedDoc.status,
      actor_name: updatedDoc.actor_name,
      messageId: updatedDoc.messageId || null,
      source_system: updatedDoc.source_system,
      createdAt: updatedDoc.createdAt,
    });

  } catch (err) {
    console.error("[ERROR] /flow/:uuid/teams-approval:", err);
    return res.status(500).json({ error: "Teams approval error", message: err.message });
  }
});

module.exports = router;