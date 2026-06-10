const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static('public'));

// HTTP always; HTTPS if certs exist (needed for mic on smartphones)
const httpServer = http.createServer(app);
let httpsServer = null;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, app);
}

const io = new Server({ maxHttpBufferSize: 1e6 });
io.attach(httpServer);
if (httpsServer) io.attach(httpsServer);

const MAX_CHAT_HISTORY = 50;

// name -> { password, lock (socketId|null), chat: [{name,text,ts}] }
const channels = new Map();

function getChannel(name) {
  return channels.get(name);
}

function channelSummary() {
  const list = [];
  for (const [name, ch] of channels) {
    const room = io.sockets.adapter.rooms.get(name);
    const count = room ? room.size : 0;
    if (count > 0) list.push({ name, users: count, locked: !!ch.password });
  }
  return list.sort((a, b) => b.users - a.users);
}

function broadcastChannels() {
  io.emit('channels', channelSummary());
}

function usersInChannel(name, exceptId) {
  const room = io.sockets.adapter.rooms.get(name);
  const list = [];
  if (room) {
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.id !== exceptId) list.push({ name: s.data.userName, id: s.id });
    }
  }
  return list;
}

io.on('connection', (socket) => {
  let currentChannel = null;

  socket.emit('channels', channelSummary());

  function leaveCurrent() {
    if (!currentChannel) return;
    const ch = getChannel(currentChannel);
    socket.leave(currentChannel);
    if (ch && ch.lock === socket.id) {
      ch.lock = null;
      socket.to(currentChannel).emit('ptt-end', { name: socket.data.userName, id: socket.id });
    }
    socket.to(currentChannel).emit('user-left', { name: socket.data.userName, id: socket.id });
    // Drop empty channels (frees the password too)
    const room = io.sockets.adapter.rooms.get(currentChannel);
    if (!room || room.size === 0) channels.delete(currentChannel);
    console.log(`${socket.data.userName} left "${currentChannel}"`);
    currentChannel = null;
    broadcastChannels();
  }

  socket.on('join', ({ channel, name, password }, ack) => {
    channel = String(channel || '').trim().toLowerCase().slice(0, 30);
    name = String(name || '').trim().slice(0, 20);
    password = String(password || '');
    if (!channel || !name) return ack && ack({ ok: false, error: 'Nome e canale obbligatori' });

    let ch = getChannel(channel);
    if (ch && ch.password && ch.password !== password) {
      return ack && ack({ ok: false, error: 'Password errata' });
    }
    if (!ch) {
      ch = { password: password || null, lock: null, chat: [] };
      channels.set(channel, ch);
    }

    leaveCurrent();
    currentChannel = channel;
    socket.data.userName = name;
    socket.join(channel);

    socket.to(channel).emit('user-joined', { name, id: socket.id });
    broadcastChannels();
    console.log(`${name} joined "${channel}"`);

    ack && ack({
      ok: true,
      users: usersInChannel(channel, socket.id),
      chat: ch.chat,
      talker: ch.lock ? { id: ch.lock, name: getUserName(ch.lock) } : null
    });
  });

  socket.on('leave', () => leaveCurrent());

  socket.on('ptt-start', () => {
    const ch = getChannel(currentChannel);
    if (!ch) return;
    if (ch.lock && ch.lock !== socket.id) {
      return socket.emit('channel-busy', { name: getUserName(ch.lock) });
    }
    ch.lock = socket.id;
    socket.emit('ptt-granted');
    socket.to(currentChannel).emit('ptt-start', { name: socket.data.userName, id: socket.id });
  });

  // Live audio: small PCM chunks relayed in real time while talking
  socket.on('audio-chunk', (data) => {
    const ch = getChannel(currentChannel);
    if (!ch || ch.lock !== socket.id) return;
    socket.to(currentChannel).volatile.emit('audio-chunk', {
      pcm: data.pcm, rate: data.rate, id: socket.id
    });
  });

  socket.on('ptt-end', () => {
    const ch = getChannel(currentChannel);
    if (!ch || ch.lock !== socket.id) return;
    ch.lock = null;
    socket.to(currentChannel).emit('ptt-end', { name: socket.data.userName, id: socket.id });
  });

  socket.on('chat-message', (text) => {
    const ch = getChannel(currentChannel);
    if (!ch) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const msg = { name: socket.data.userName, text, ts: Date.now() };
    ch.chat.push(msg);
    if (ch.chat.length > MAX_CHAT_HISTORY) ch.chat.shift();
    io.to(currentChannel).emit('chat-message', msg);
  });

  socket.on('disconnect', () => leaveCurrent());

  function getUserName(socketId) {
    const s = io.sockets.sockets.get(socketId);
    return s ? s.data.userName : 'Sconosciuto';
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
