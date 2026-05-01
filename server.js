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

connectDb();

const app = express();
app.use("eta", false)
app.use(cors());
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
app.get("/", (req, res) => {
  res.send("Fivlia api is running ...");
});
app.use("/fivlia", routes);
app.use("/", routes);

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
