const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Request = require("../models/request");

const router = express.Router();

const FLOW_WEBHOOK_URL = process.env.FLOW_WEBHOOK_URL;
if (!FLOW_WEBHOOK_URL) {
    console.warn("[WARN] FLOW_WEBHOOK_URL is not set in environment variables.");
}

/** Helper: return ISO timestamp */
const toISO = (date) => (date ? new Date(date).toISOString() : new Date().toISOString());

/** Build Flow payload directly from DB document */
function buildFlowPayload(doc) {
    return {
        request_uuid: doc.request_uuid,
        requestor_fullname: doc.requestor_fullname,
        system_name: doc.system_name,
        type: doc.type,
        reason: doc.reason,
        requested_at: toISO(doc.request_timestamp || doc.createdAt),
        source_system: doc.source_system || "default",
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



/* =======================================================
   CREATE + FORWARD
   POST /flow
======================================================= */
router.post("/", async(req, res) => {
    try {
        const { requestor_fullname, system_name, type, reason, request_timestamp, source_system } = req.body;

        // ✅ Validation
        if (!requestor_fullname || !system_name || !type || !reason) {
            return res.status(400).json({
                error: "Missing required fields: requestor_fullname, system_name, type, reason",
            });
        }

        // ✅ Create record (timestamps auto-managed)
        const doc = await Request.create({
            request_uuid: uuidv4(),
            requestor_fullname,
            system_name,
            type,
            reason,
            request_timestamp,
            source_system, // default handled by schema if undefined
        });

        const payload = buildFlowPayload(doc);
        const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
            timeout: 15000,
            headers: { "Content-Type": "application/json" },
        });

        const ok = resp.status >= 200 && resp.status < 300;
        if (!ok) {
            console.error("[ERROR] Flow webhook failed", { status: resp.status, data: resp.data });
            return res.status(502).json({ error: "Flow webhook failed", status: resp.status, data: resp.data });
        }

        // ✅ Save messageId if available
        const messageId = extractMessageId(resp);
        if (messageId) {
            doc.messageId = messageId;
            await doc.save();
        }

        return res.status(201).json({
            request: {
                uuid: doc.request_uuid,
                status: doc.status,
                messageId: doc.messageId || null,
                source_system: doc.source_system,
                createdAt: doc.createdAt,
            },
            flow_response: resp.data || {},
        });
    } catch (err) {
        console.error("[ERROR] /flow create+forward:", err.message);
        return res.status(500).json({ error: "Failed to create & forward request", message: err.message });
    }
});

/* =======================================================
   FORWARD BY UUID
   POST /flow/:uuid/forward
======================================================= */
router.post("/:uuid/forward", async(req, res) => {
    const { uuid } = req.params;

    try {
        const doc = await Request.findOne({ request_uuid: uuid });
        if (!doc) return res.status(404).json({ error: "Request not found", uuid });

        const payload = buildFlowPayload(doc);
        const resp = await axios.post(FLOW_WEBHOOK_URL, payload, {
            timeout: 15000,
            headers: { "Content-Type": "application/json" },
        });

        const ok = resp.status >= 200 && resp.status < 300;
        if (!ok) {
            console.error("[ERROR] Flow webhook failed", { status: resp.status, data: resp.data });
            return res.status(502).json({ error: "Flow webhook failed", status: resp.status, data: resp.data });
        }

        const messageId = extractMessageId(resp);
        if (messageId) {
            doc.messageId = messageId;
            await doc.save();
        }

        return res.status(200).json({
            request_uuid: doc.request_uuid,
            messageId: doc.messageId || null,
            source_system: doc.source_system,
            flow_response: resp.data || {},
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
router.post("/:uuid/teams-approval", async(req, res) => {
    const { uuid } = req.params;
    const { status, actor_name } = req.body;

    if (!status) return res.status(400).json({ error: "Missing status" });

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
        doc.actor_name = actor_name || "Teams User";
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
        console.error("[ERROR] /flow/:uuid/teams-approval:", err.message);
        return res.status(500).json({ error: "Teams approval error", message: err.message });
    }
});

module.exports = router;