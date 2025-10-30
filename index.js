require("dotenv").config();
const express = require("express");
const connectDB = require("./db");
const flowRoutes = require("./routes/flow");
const https = require("https"); // built‑in, no extra dependency

const app = express();
app.use(express.json());

// ✅ Hello World test route
app.get("/", (req, res) => {
  res.send("👋 Hello World from Node API!");
});

// ✅ Health check route
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// Routes
app.use("/flow", flowRoutes);

// Connect to MongoDB and start server
connectDB().then(() => {
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`🚀 Node test API running on port ${port}`);

    // 🔄 Self‑ping every 14 minutes to keep Render awake
    const baseUrl = process.env.BASE_URL || `https://test-y14n.onrender.com`;
    setInterval(() => {
      https
        .get(`${baseUrl}/health`, (res) => {
          console.log(`Self‑ping status: ${res.statusCode}`);
        })
        .on("error", (err) => {
          console.error("Self‑ping failed:", err.message);
        });
    }, 14 * 60 * 1000); // 14 minutes
  });
});