// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // allow all for testing; change for production
    methods: ["GET", "POST"]
  }
});

// In-memory storage of waiting users
let waitingUsers = [];

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("request-chat", (data) => {
    // If there's a waiting user, pair them
    if (waitingUsers.length > 0) {
      const partnerSocket = waitingUsers.shift();
      socket.partnerId = partnerSocket.id;
      partnerSocket.partnerId = socket.id;

      // Notify both users they are paired
      socket.emit("paired", {
        partnerId: partnerSocket.id,
        partnerName: partnerSocket.name || "Stranger",
        partnerInterests: partnerSocket.interests || [],
      });
      partnerSocket.emit("paired", {
        partnerId: socket.id,
        partnerName: data.name || "Stranger",
        partnerInterests: data.interests || [],
      });
    } else {
      // Add to waiting list
      socket.name = data.name || "Stranger";
      socket.interests = data.interests || [];
      waitingUsers.push(socket);
    }
  });

  // WebRTC signaling
  socket.on("offer", (data) => {
    io.to(data.to).emit("offer", { from: socket.id, offer: data.offer });
  });

  socket.on("answer", (data) => {
    io.to(data.to).emit("answer", { answer: data.answer });
  });

  socket.on("ice-candidate", (data) => {
    io.to(data.to).emit("ice-candidate", { candidate: data.candidate });
  });

  // Chat messages
  socket.on("message", (data) => {
    io.to(data.recipient).emit("message", data.message);
  });

  socket.on("report-user", (data) => {
    console.log("User reported:", data);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // Remove from waiting list if still waiting
    waitingUsers = waitingUsers.filter((s) => s.id !== socket.id);
    // Notify partner if paired
    if (socket.partnerId) {
      io.to(socket.partnerId).emit("disconnected");
    }
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
