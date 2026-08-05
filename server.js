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

// require("./utils/telegram_logs");
// const { initAgenda } = require('./config/agenda'); // ✅ your agenda setup
require("./jobs/orderNotificationRetry");

const app = express();
app.set("etag", false);

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const duration = Number(end - start) / 1_000_000; // ms

    console.log(
      `[${res.statusCode}] ${req.method} ${req.originalUrl} - ${duration.toFixed(2)} ms`
    );
  });

  next();
});

app.use(cors());

app.use(
  "/razorpay-webhook",
  express.raw({ type: "application/json" })
);

app.use(express.json());
// const key = fs.readFileSync('/etc/letsencrypt/live/api.fivlia.in/privkey.pem', 'utf8');
// const cert = fs.readFileSync('/etc/letsencrypt/live/api.fivlia.in/cert.pem', 'utf8');
// const server = https.createServer({ key, cert }, app);
const server = http.createServer(app); // <-- create HTTP server
const io = socketIo(server, {
  cors: {
    origin: "*", // Set your frontend domain here in production
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

  // const agenda = await initAgenda(mongoConnection);
  // backgroundInvoice(agenda);

  const PORT = process.env.PORT || 8080;
  const host = process.env.HOST || "localhost";
  server.listen(PORT, async () => {
    console.log(`Server running at http://${host}:${PORT}`);
    await resumePendingDispatch();
  });
};

startServer();
