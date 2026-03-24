const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();

// Use HTTPS if certs exist, otherwise HTTP
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');
// Run both HTTP (port 3000) and HTTPS (port 3443) so smartphone can use mic
const httpServer = http.createServer(app);

let httpsServer = null;
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, app);
}

const ioOptions = { maxHttpBufferSize: 5e6 }; // 5MB for audio messages

// Share the same Socket.IO instance across both servers
const io = new Server(ioOptions);
io.attach(httpServer);
if (httpsServer) io.attach(httpsServer);

app.use(express.static('public'));

// Track who is currently talking per channel
const channelLocks = new Map();

io.on('connection', (socket) => {
  let currentChannel = null;
  let userName = null;

  socket.on('join', ({ channel, name }) => {
    // Leave previous channel
    if (currentChannel) {
      socket.leave(currentChannel);
      io.to(currentChannel).emit('user-left', { name: userName, id: socket.id });
      if (channelLocks.get(currentChannel) === socket.id) {
        channelLocks.delete(currentChannel);
      }
    }

    currentChannel = channel;
    userName = name;
    socket.join(channel);

    // Get list of users in this channel
    const room = io.sockets.adapter.rooms.get(channel);
    const userList = [];
    if (room) {
      for (const sid of room) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.id !== socket.id) {
          userList.push({ name: s.data.userName, id: s.id });
        }
      }
    }
    socket.data.userName = name;

    socket.emit('channel-users', userList);
    socket.to(channel).emit('user-joined', { name, id: socket.id });

    console.log(`${name} joined channel "${channel}" (${room ? room.size : 1} users)`);
  });

  socket.on('ptt-start', () => {
    if (!currentChannel) return;

    const currentTalker = channelLocks.get(currentChannel);
    if (currentTalker && currentTalker !== socket.id) {
      socket.emit('channel-busy', { name: getUserName(currentTalker) });
      return;
    }

    channelLocks.set(currentChannel, socket.id);
    socket.emit('ptt-granted');
    socket.to(currentChannel).emit('ptt-start', { name: userName, id: socket.id });
  });

  socket.on('audio-message', (data) => {
    if (!currentChannel) return;
    const size = data.audio ? data.audio.byteLength || data.audio.length : 0;
    console.log(`Audio from ${userName}: ${size} bytes, mime: ${data.mime}`);
    socket.to(currentChannel).emit('audio-message', data);
  });

  socket.on('ptt-end', () => {
    if (!currentChannel) return;
    if (channelLocks.get(currentChannel) !== socket.id) return;

    channelLocks.delete(currentChannel);
    socket.to(currentChannel).emit('ptt-end', { name: userName, id: socket.id });
  });

  socket.on('disconnect', () => {
    if (currentChannel) {
      if (channelLocks.get(currentChannel) === socket.id) {
        channelLocks.delete(currentChannel);
        io.to(currentChannel).emit('ptt-end', { name: userName, id: socket.id });
      }
      io.to(currentChannel).emit('user-left', { name: userName, id: socket.id });
      console.log(`${userName} left channel "${currentChannel}"`);
    }
  });

  function getUserName(socketId) {
    const s = io.sockets.sockets.get(socketId);
    return s ? s.data.userName : 'Unknown';
  }
});

const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = 3443;

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP server on port ${HTTP_PORT} (PC/localhost)`);
  console.log(`Open http://localhost:${HTTP_PORT}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS server on port ${HTTPS_PORT} (smartphone)`);
    console.log(`Open https://192.168.x.x:${HTTPS_PORT} from your phone`);
  });
}
