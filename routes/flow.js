const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Request = require("../models/request");

const router = express.Router();

const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL;
if (!FLOW_WEBHOOK_URL) {
    console.warn("[WARN] FLOW_WEBHOOK_URL is not set in environment variables.");
}



// router.post("/", async (req, res) => {
//     try {
//         const { requestor_fullname, system_name, type, reason, request_timestamp, source_system } = req.body;

//         if (!requestor_fullname || !system_name || !type || !reason) {
//             return res.status(400).json({
//                 error: "Missing required fields: requestor_fullname, system_name, type, reason",
//             });
//         }

//         const doc = await Request.create({
//             request_uuid: uuidv4(),
//             requestor_fullname,
//             system_name,
//             type,
//             reason,
//             request_timestamp,
//             source_system,
//         });

//         const payload = buildFlowPayload(doc);
//         await axios.post(FLOW_WEBHOOK_URL, payload, {
//             timeout: 15000,
//             headers: { "Content-Type": "application/json" },
//         });

//         return res.status(201).json({
//             request: {
//                 uuid: doc.request_uuid,
//                 status: doc.status,
//                 source_system: doc.source_system,
//                 createdAt: doc.createdAt,
//             }
//         });
//     } catch (err) {
//         console.error("[ERROR] /flow create+forward:", err.message);
//         return res.status(500).json({ error: "Failed to create & forward request", message: err.message });
//     }
// });



/* =======================================================
   CREATE + FORWARD
   POST /flow/
======================================================= */
// route.ts

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

    // Create DB record first
    const newRequest = await Request.create({
      request_uuid,
      requestor_fullname,
      system_name,
      type,
      reason,
      request_timestamp: request_timestamp ?? new Date().toISOString(),
      source_system
    });

    // ✅ Inline payload construction
    const payload = {
      id: newRequest.request_uuid,
      requester: { name: newRequest.requestor_fullname.trim() },
      system: newRequest.system_name.trim(),
      type: newRequest.type.trim(),
      reason: newRequest.reason.trim(),
      timestamp: newRequest.request_timestamp,
      source: newRequest.source_system ?? "unknown",
      version: "v1",
      correlationId: newRequest.request_uuid
    };

    // Send to Flow webhook
    const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" }
    });

    const messageId = resp.data?.activityId?.toString();
    const conversationId = resp.data?.conversationId?.toString();

    // Update DB with response IDs
    await Request.updateOne(
      { request_uuid },
      { $set: { messageId, conversationId, status: "forwarded" } }
    );

    const updated = await Request.findOne({ request_uuid }).lean();

    res.status(201).json({
      request: {
        uuid: updated.request_uuid,
        status: updated.status,
        messageId: updated.messageId,
        conversationId: updated.conversationId,
        source_system: updated.source_system,
        createdAt: updated.createdAt
      }
    });
  } catch (err) {
    console.error("[ERROR] /flow create+forward:", err.message);
    res.status(500).json({
      error: "Failed to create & forward request",
      message: err.message
    });
  }
});


/* =======================================================
   FORWARD EXISTING
   POST /flow/:uuid/forward
======================================================= */
// router.post("/:uuid/forward", async (req, res) => {
//   const { uuid } = req.params;

//   try {
//     const request = await Request.findOne({ request_uuid: uuid }).lean();
//     if (!request) return res.status(404).json({ error: "Request not found", uuid });

//     const payload = buildFlowPayload(request);
//     const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
//       timeout: 15000,
//       headers: { "Content-Type": "application/json" }
//     });

//     const messageId = resp.data?.activityId?.toString();
//     const conversationId = resp.data?.conversationId?.toString();

//     await Request.updateOne(
//       { request_uuid: uuid },
//       { $set: { messageId, conversationId } }
//     );

//     res.status(200).json({
//       request_uuid: uuid,
//       messageId,
//       conversationId,
//       source_system: request.source_system
//     });
//   } catch (err) {
//     console.error("[ERROR] /flow/:uuid/forward:", err.message);
//     res.status(500).json({ error: "Flow forwarding error", message: err.message });
//   }
// });

/* =======================================================
   APPROVAL VIA URI
   POST /flow/:uuid/:status
======================================================= */
router.post("/:uuid/:status", async (req, res) => {
  const { uuid, status } = req.params;
  const actor_name = req.body.actor_name?.trim() || "API User";

  const normalized =
    status === "approve" ? "approved" :
    status === "decline" ? "declined" :
    status;

  if (!["approved", "declined"].includes(normalized)) {
    return res.status(400).json({ error: "Invalid status", received: status });
  }

  try {
    const updateResult = await Request.updateOne(
      { request_uuid: uuid, status: "pending" },
      { $set: { status: normalized, actor_name } }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "Request not found or already processed" });
    }

    const updated = await Request.findOne({ request_uuid: uuid }).lean();

    res.status(200).json({
      request_uuid: updated.request_uuid,
      status: updated.status,
      actor_name: updated.actor_name,
      messageId: updated.messageId || null,
      source_system: updated.source_system,
      createdAt: updated.createdAt
    });
  } catch (err) {
    console.error("[ERROR] /flow/:uuid/:status:", err.message);
    res.status(500).json({ error: "Approval update failed", message: err.message });
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

  console.log("[DEBUG] Incoming payload:", req.body);

  if (typeof status !== "string" || !["approved", "declined"].includes(status.toLowerCase().trim())) {
    return res.status(400).json({ error: "Invalid status", received: status });
  }

  try {
    const updateResult = await Request.updateOne(
      { request_uuid: uuid },
      {
        $set: {
          status: status.toLowerCase().trim(),
          actor_name: actor_name?.trim() || "Teams User"
        }
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "Request not found" });
    }

    const updated = await Request.findOne({ request_uuid: uuid }).lean();

    res.status(200).json({
      request_uuid: updated.request_uuid,
      status: updated.status,
      actor_name: updated.actor_name,
      messageId: updated.messageId || null,
      source_system: updated.source_system,
      createdAt: updated.createdAt
    });
  } catch (err) {
    console.error("[ERROR] /flow/:uuid/teams-approval:", err.message);
    res.status(500).json({ error: "Teams approval error", message: err.message });
  }
});

module.exports = router;