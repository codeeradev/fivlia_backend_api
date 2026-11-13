const express = require("express");
const path = require("path");
require("dotenv").config();
const connectDb = require("./database/database");
const fs = require("fs");
const https = require("https");
const http = require("http");
const socketIo = require("socket.io");
const registerDriverSocket = require("./socket/socket");
const cors = require("cors");
const {resumePendingDispatch} = require("./utils/resumePendingOrders");

require("./jobs/orderNotificationRetry");

const app = express();
app.set("etag", false);

app.use(cors());

app.use(
  "/razorpay-webhook",
  express.raw({ type: "application/json" })
);
app.use(
  "/cashfree-webhook",
  express.raw({ type: "application/json" })
);
app.use(
  "/fivlia/cashfree-webhook",
  express.raw({ type: "application/json" })
);

app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

registerDriverSocket(io);

const routes = require("./routes/route");
const foodRoutes = require("./routes/foodRoute");
app.get("/", (req, res) => {
  res.send("Fivlia api is running ...");
});
app.use("/fivlia", routes);
app.use("/", routes);
app.use("/food", foodRoutes);

const startServer = async () => {
  const mongoConnection = await connectDb();

  const PORT = process.env.PORT || 8080;
  const host = process.env.HOST || "localhost";
  server.listen(PORT, async () => {
    console.log(`Server running at http://${host}:${PORT}`);
    await resumePendingDispatch();
  });
};

startServer();
