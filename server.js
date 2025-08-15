const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

// simple health route for uptime checks
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // tighten in production (set your frontend origin)
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

// keep only minimal info here, not full socket objects
let waitingQueue = []; // { id, name, interests }

io.on("connection", (socket) => {
  const userId = socket.handshake.query?.userId || socket.id;
  console.log("User connected:", userId);

  // 1) Request to find partner
  socket.on("request-chat", (data = {}) => {
    const name = data.name || "Stranger";
    const interests = Array.isArray(data.interests) ? data.interests : [];

    // already paired? ignore re-requests
    if (socket.partnerId) return;

    // pair with first waiting person (simple FIFO). Improve with interest matching if you want.
    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();

      // tell both they are paired
      socket.partnerId = partner.id;
      io.sockets.sockets.get(partner.id).partnerId = socket.id;

      io.to(socket.id).emit("paired", {
        partnerId: partner.id,
        partnerName: partner.name,
        partnerInterests: partner.interests,
      });

      io.to(partner.id).emit("paired", {
        partnerId: socket.id,
        partnerName: name,
        partnerInterests: interests,
      });
    } else {
      // put current user into waiting queue
      waitingQueue.push({
        id: socket.id,
        name,
        interests,
      });
    }
  });

  // 2) WebRTC signaling — keep field names EXACTLY matching frontend usage
  socket.on("offer", (data) => {
    // { to, offer }
    io.to(data.to).emit("offer", { from: socket.id, offer: data.offer });
  });

  socket.on("answer", (data) => {
    // { to, answer }
    io.to(data.to).emit("answer", { answer: data.answer });
  });

  socket.on("ice-candidate", (data) => {
    // { to, candidate }
    io.to(data.to).emit("ice-candidate", { candidate: data.candidate });
  });

  // 3) Text chat
  socket.on("message", (data) => {
    // { to, message }
    io.to(data.to).emit("message", data.message);
  });

  // 4) Leave / next
  socket.on("leave", () => {
    if (socket.partnerId) {
      const partnerSock = io.sockets.sockets.get(socket.partnerId);
      if (partnerSock) {
        partnerSock.partnerId = null;
        io.to(socket.partnerId).emit("disconnected");
      }
      socket.partnerId = null;
    }
    // Immediately put them back in queue
    waitingQueue.push({ id: socket.id, name: "Stranger", interests: [] });
    tryMatch(socket); // function to check if we can pair immediately
  });

  function tryMatch(socket) {
    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      if (partner.id !== socket.id) {
        socket.partnerId = partner.id;
        io.sockets.sockets.get(partner.id).partnerId = socket.id;
        io.to(socket.id).emit("paired", { partnerId: partner.id });
        io.to(partner.id).emit("paired", { partnerId: socket.id });
      }
    }
  }

  // 5) Disconnect cleanup
  socket.on("disconnect", () => {
    console.log("User disconnected:", userId);

    // remove if still waiting
    waitingQueue = waitingQueue.filter((w) => w.id !== socket.id);

    // notify partner
    if (socket.partnerId) {
      io.to(socket.partnerId).emit("disconnected");
      const partnerSock = io.sockets.sockets.get(socket.partnerId);
      if (partnerSock) partnerSock.partnerId = null;
    }
  });
});

// Start
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Signaling server on :${PORT}`));
