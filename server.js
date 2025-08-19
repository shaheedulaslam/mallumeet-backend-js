const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");

const app = express();
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? "https://mallumeet.netlify.app/"
        : "http://localhost:3000",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(bodyParser.json());

// Health check endpoints
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // In production, specify your frontend URL
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

// Constants
const MAX_QUEUE_TIME = 5 * 60 * 1000; // 5 minutes
const MATCH_INTERVAL = 5000; // Check for matches every 5 seconds

// User queue storage
let waitingQueue = [];

// Helper function to find socket by ID
const getSocketById = (id) => io.sockets.sockets.get(id);

// Improved matching function with interest-based pairing
function matchUsers() {
  // Sort by most compatible matches first (based on shared interests)
  waitingQueue.sort((a, b) => {
    const commonA = a.interests.filter((i) => b.interests.includes(i)).length;
    const commonB = b.interests.filter((i) => a.interests.includes(i)).length;
    return commonB - commonA;
  });

  while (waitingQueue.length >= 2) {
    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();

    const socket1 = getSocketById(user1.id);
    const socket2 = getSocketById(user2.id);

    // Verify both sockets are still connected
    if (!socket1 || !socket2) {
      if (socket1) waitingQueue.unshift(user1);
      if (socket2) waitingQueue.unshift(user2);
      continue;
    }

    // Pair them
    socket1.partnerId = user2.id;
    socket2.partnerId = user1.id;

    // Clear any queue timeouts
    if (socket1.queueTimeout) clearTimeout(socket1.queueTimeout);
    if (socket2.queueTimeout) clearTimeout(socket2.queueTimeout);

    // Notify both users
    socket1.emit("paired", {
      partnerId: user2.id,
      partnerName: user2.name || "Stranger",
      partnerInterests: user2.interests || [],
    });

    socket2.emit("paired", {
      partnerId: user1.id,
      partnerName: user1.name || "Stranger",
      partnerInterests: user1.interests || [],
    });

    console.log(`Matched ${user1.id} with ${user2.id}`);
  }
}

// Periodically check for matches
setInterval(matchUsers, MATCH_INTERVAL);

io.on("connection", (socket) => {
  const userId = socket.handshake.query?.userId || socket.id;
  console.log(`User connected: ${userId}`);

  // Set up queue timeout
  socket.queueTimeout = setTimeout(() => {
    if (!socket.partnerId && waitingQueue.some((u) => u.id === socket.id)) {
      socket.emit("queue-timeout");
      waitingQueue = waitingQueue.filter((u) => u.id !== socket.id);
      console.log(`User ${userId} timed out waiting for match`);
    }
  }, MAX_QUEUE_TIME);

  // Request to find a chat partner
  socket.on("request-chat", (data = {}) => {
    // Already paired? Ignore
    if (socket.partnerId) return;

    const userData = {
      id: socket.id,
      name: data.name || "Stranger",
      interests: Array.isArray(data.interests) ? data.interests : [],
      timestamp: Date.now(),
    };

    // Remove if already in queue (prevent duplicates)
    waitingQueue = waitingQueue.filter((u) => u.id !== socket.id);

    // Add to queue
    waitingQueue.push(userData);
    socket.emit("queue-position", { position: waitingQueue.length });

    console.log(`User ${userId} joined queue (${waitingQueue.length} waiting)`);
  });

  // WebRTC Signaling
  socket.on("offer", ({ to, offer }) => {
    const targetSocket = getSocketById(to);
    if (targetSocket) {
      targetSocket.emit("offer", { from: socket.id, offer });
    }
  });

  socket.on("answer", ({ to, answer }) => {
    const targetSocket = getSocketById(to);
    if (targetSocket) {
      targetSocket.emit("answer", { answer });
    }
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    const targetSocket = getSocketById(to);
    if (targetSocket) {
      targetSocket.emit("ice-candidate", { candidate });
    }
  });

  // Text chat
  socket.on("message", ({ to, message }) => {
    const targetSocket = getSocketById(to);
    if (targetSocket) {
      targetSocket.emit("message", message);
    }
  });

  // Leave current chat and find new partner
  socket.on("leave", () => {
    // Notify current partner if exists
    if (socket.partnerId) {
      const partnerSocket = getSocketById(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.partnerId = null;
        partnerSocket.emit("disconnected");
      }
      socket.partnerId = null;
    }

    // Rejoin queue with existing data or as new user
    const existingUser = waitingQueue.find((u) => u.id === socket.id);
    if (!existingUser) {
      waitingQueue.push({
        id: socket.id,
        name: "Stranger",
        interests: [],
        timestamp: Date.now(),
      });
    }

    console.log(`User ${userId} left chat and rejoined queue`);
  });

  // Disconnect cleanup
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${userId}`);

    // Clear timeout if exists
    if (socket.queueTimeout) clearTimeout(socket.queueTimeout);

    // Remove from queue
    waitingQueue = waitingQueue.filter((u) => u.id !== socket.id);

    // Notify partner if in a chat
    if (socket.partnerId) {
      const partnerSocket = getSocketById(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.partnerId = null;
        partnerSocket.emit("disconnected");
      }
    }
  });
});

// Error handling
server.on("error", (err) => {
  console.error("Server error:", err);
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

// Cleanup on process termination
process.on("SIGINT", () => {
  console.log("Shutting down server...");
  io.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});
