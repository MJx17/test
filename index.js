require("dotenv").config();
const express = require("express");
const connectDB = require("./db");
const flowRoutes = require("./routes/flow");

const app = express();
app.use(express.json());

// Routes
app.use("/flow", flowRoutes);

// Connect to MongoDB and start server
connectDB().then(() => {
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`🚀 Node test API running on port ${port}`);
  });
});