const socket = io();

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const loginScreen = $('login-screen');
const mainScreen = $('main-screen');
const usernameInput = $('username');
const channelInput = $('channel');
const passwordInput = $('password');
const joinBtn = $('join-btn');
const loginError = $('login-error');
const channelsListEl = $('channels-list');
const leaveBtn = $('leave-btn');
const soundBtn = $('sound-btn');
const channelNameEl = $('channel-name');
const usersListEl = $('users-list');
const usersCountEl = $('users-count');
const pttBtn = $('ptt-btn');
const talkerIndicator = $('talker-indicator');
const talkerName = $('talker-name');
const idleIndicator = $('idle-indicator');
const statusDot = $('status-dot');
const statusText = $('status-text');
const toastEl = $('toast');
const vuBar = $('vu-bar');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const chatSend = $('chat-send');
const historyList = $('history-list');

// ===== State =====
let myName = '';
let myChannel = '';
let isTalking = false;
let soundsOn = true;
let users = new Map(); // id -> {name}
const MAX_HISTORY = 12;
let history = []; // {name, ts, chunks: [Int16Array], rate}
let incomingTx = new Map(); // talkerId -> {name, chunks, rate}

// ===== Audio =====
let audioCtx = null;       // single context for capture + playback
let micStream = null;
let workletNode = null;
let micReady = false;
let nextPlayTime = 0;

function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function ensureMic() {
  if (micReady) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    showToast('Permesso microfono negato');
    return false;
  }
  const ctx = ensureCtx();
  await ctx.audioWorklet.addModule('audio-processor.js');
  const source = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, 'capture-processor');
  workletNode.port.onmessage = (e) => {
    const { pcm, rate, rms } = e.data;
    if (!isTalking) return;
    setVu(rms);
    socket.emit('audio-chunk', { pcm, rate });
    // keep my own transmission for the history
    recordChunk('me', myName, new Int16Array(pcm.slice(0)), rate);
  };
  source.connect(workletNode);
  // not connected to destination: no self-monitoring
  micReady = true;
  return true;
}

function setVu(rms) {
  const pct = Math.min(100, Math.round(rms * 320));
  vuBar.style.width = pct + '%';
}

// ===== Playback (live PCM stream) =====
function playChunk(pcmBuf, rate, talkerId, name) {
  const ctx = ensureCtx();
  const int16 = new Int16Array(pcmBuf);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

  // remote VU
  let sumSq = 0;
  for (let i = 0; i < float32.length; i++) sumSq += float32[i] * float32[i];
  setVu(Math.sqrt(sumSq / float32.length));

  const buffer = ctx.createBuffer(1, float32.length, rate);
  buffer.getChannelData(0).set(float32);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);

  const now = ctx.currentTime;
  if (nextPlayTime < now + 0.05) nextPlayTime = now + 0.08; // small jitter buffer
  src.start(nextPlayTime);
  nextPlayTime += buffer.duration;

  recordChunk(talkerId, name, int16, rate);
}

// ===== History =====
function recordChunk(key, name, int16, rate) {
  let tx = incomingTx.get(key);
  if (!tx) {
    tx = { name, chunks: [], rate, ts: Date.now() };
    incomingTx.set(key, tx);
  }
  tx.chunks.push(int16);
}

function finalizeTx(key) {
  const tx = incomingTx.get(key);
  incomingTx.delete(key);
  if (!tx || tx.chunks.length < 2) return; // skip blips
  history.unshift(tx);
  if (history.length > MAX_HISTORY) history.pop();
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historyList.innerHTML = '<span class="channels-empty">Nessuna trasmissione registrata</span>';
    return;
  }
  historyList.innerHTML = '';
  history.forEach((tx, i) => {
    const secs = (tx.chunks.reduce((a, c) => a + c.length, 0) / tx.rate).toFixed(1);
    const item = document.createElement('div');
    item.className = 'history-item';
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<span class="who"></span><span class="when">${fmtTime(tx.ts)} &middot; ${secs}s</span>`;
    info.querySelector('.who').textContent = tx.name === myName ? `${tx.name} (tu)` : tx.name;
    const btn = document.createElement('button');
    btn.className = 'btn-play';
    btn.textContent = '▶ Riascolta';
    btn.addEventListener('click', () => replayTx(i));
    item.append(info, btn);
    historyList.appendChild(item);
  });
}

function replayTx(i) {
  const tx = history[i];
  if (!tx) return;
  const ctx = ensureCtx();
  const total = tx.chunks.reduce((a, c) => a + c.length, 0);
  const buffer = ctx.createBuffer(1, total, tx.rate);
  const data = buffer.getChannelData(0);
  let off = 0;
  for (const c of tx.chunks) {
    for (let j = 0; j < c.length; j++) data[off + j] = c[j] / 0x8000;
    off += c.length;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

// ===== Login / channels =====
joinBtn.addEventListener('click', join);
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') channelInput.focus(); });
channelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

socket.on('channels', (list) => {
  if (!list || list.length === 0) {
    channelsListEl.innerHTML = '<span class="channels-empty">Nessun canale attivo</span>';
    return;
  }
  channelsListEl.innerHTML = '';
  list.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    const nm = document.createElement('span');
    nm.className = 'ch-name';
    nm.textContent = c.name;
    const meta = document.createElement('span');
    meta.className = 'ch-meta';
    meta.textContent = `${c.locked ? '\u{1F512} ' : ''}${c.users} \u{1F464}`;
    el.append(nm, meta);
    el.addEventListener('click', () => {
      channelInput.value = c.name;
      (usernameInput.value.trim() ? (c.locked ? passwordInput : joinBtn) : usernameInput).focus();
      if (usernameInput.value.trim() && !c.locked) join();
    });
    channelsListEl.appendChild(el);
  });
});

function join() {
  const name = usernameInput.value.trim();
  const channel = channelInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  if (!name || !channel) return;

  ensureCtx(); // user gesture: unlock audio on mobile

  socket.emit('join', { channel, name, password }, (res) => {
    if (!res || !res.ok) {
      loginError.textContent = res ? res.error : 'Errore di connessione';
      loginError.classList.remove('hidden');
      return;
    }
    myName = name;
    myChannel = channel;
    loginError.classList.add('hidden');
    loginScreen.classList.remove('active');
    mainScreen.classList.add('active');
    channelNameEl.textContent = channel;
    pttBtn.disabled = false;

    users.clear();
    res.users.forEach((u) => users.set(u.id, u));
    updateUsersList();

    chatMessages.innerHTML = '';
    (res.chat || []).forEach(addChatMessage);

    history = [];
    incomingTx.clear();
    renderHistory();

    if (res.talker) setTalker(res.talker.name, res.talker.id);
  });
}

leaveBtn.addEventListener('click', () => {
  if (isTalking) pttUp(new Event('leave'));
  socket.emit('leave');
  mainScreen.classList.remove('active');
  loginScreen.classList.add('active');
  users.clear();
  pttBtn.disabled = true;
  clearTalker();
});

// ===== Socket events =====
socket.on('connect', () => {
  statusDot.classList.remove('disconnected');
  statusText.textContent = 'Connesso';
  // rejoin after a server restart / connection drop
  if (myChannel && mainScreen.classList.contains('active')) {
    socket.emit('join', { channel: myChannel, name: myName, password: passwordInput.value }, () => {});
  }
});

socket.on('disconnect', () => {
  statusDot.classList.add('disconnected');
  statusText.textContent = 'Disconnesso';
  if (isTalking) pttUp(new Event('disconnect'));
});

socket.on('user-joined', ({ name, id }) => {
  users.set(id, { name });
  updateUsersList();
  showToast(`${name} si è unito`);
  playJoinBeep();
});

socket.on('user-left', ({ name, id }) => {
  users.delete(id);
  updateUsersList();
  showToast(`${name} ha lasciato il canale`);
});

socket.on('ptt-granted', async () => {
  const ok = await ensureMic();
  if (!ok) {
    isTalking = false;
    pttBtn.classList.remove('active');
    socket.emit('ptt-end');
    return;
  }
  isTalking = true;
  incomingTx.delete('me');
  workletNode.port.postMessage('start');
  vibrate(30);
});

socket.on('channel-busy', ({ name }) => {
  showToast(`Canale occupato da ${name}`);
  pttBtn.classList.remove('active');
  vibrate([15, 40, 15]);
});

socket.on('ptt-start', ({ name, id }) => {
  setTalker(name, id);
  nextPlayTime = 0;
  vibrate(20);
});

socket.on('audio-chunk', ({ pcm, rate, id }) => {
  const u = users.get(id);
  playChunk(pcm instanceof ArrayBuffer ? pcm : new Uint8Array(pcm).buffer, rate, id, u ? u.name : '...');
});

socket.on('ptt-end', ({ id }) => {
  clearTalker(id);
  finalizeTx(id);
  playRogerBeep();
});

socket.on('chat-message', (msg) => {
  addChatMessage(msg);
  if (msg.name !== myName) playChatBeep();
});

// ===== Talker UI =====
function setTalker(name, id) {
  talkerIndicator.classList.remove('hidden');
  idleIndicator.classList.add('hidden');
  talkerName.textContent = name;
  const badge = document.querySelector(`[data-uid="${id}"]`);
  if (badge) badge.classList.add('talking');
}

function clearTalker(id) {
  talkerIndicator.classList.add('hidden');
  idleIndicator.classList.remove('hidden');
  vuBar.style.width = '0%';
  document.querySelectorAll('.user-badge.talking').forEach((b) => b.classList.remove('talking'));
}

// ===== PTT =====
function pttDown(e) {
  e.preventDefault();
  if (pttBtn.disabled || isTalking) return;
  pttBtn.classList.add('active');
  ensureCtx();
  socket.emit('ptt-start');
}

function pttUp(e) {
  if (!isTalking && !pttBtn.classList.contains('active')) return;
  if (e && e.preventDefault) e.preventDefault();
  isTalking = false;
  pttBtn.classList.remove('active');
  vuBar.style.width = '0%';
  if (workletNode) workletNode.port.postMessage('stop');
  socket.emit('ptt-end');
  finalizeTx('me');
}

pttBtn.addEventListener('mousedown', pttDown);
window.addEventListener('mouseup', (e) => {
  if (isTalking || pttBtn.classList.contains('active')) pttUp(e);
});
pttBtn.addEventListener('touchstart', pttDown, { passive: false });
pttBtn.addEventListener('touchend', pttUp, { passive: false });
pttBtn.addEventListener('touchcancel', pttUp, { passive: false });
pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// Spacebar PTT (desktop)
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  if (!mainScreen.classList.contains('active')) return;
  if (document.activeElement === chatInput || document.activeElement.tagName === 'INPUT') return;
  pttDown(e);
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if (document.activeElement === chatInput || document.activeElement.tagName === 'INPUT') return;
  if (isTalking || pttBtn.classList.contains('active')) pttUp(e);
});

// ===== Chat =====
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', text);
  chatInput.value = '';
}
chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function addChatMessage({ name, text, ts }) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (name === myName ? 'mine' : 'other');
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${name === myName ? 'Tu' : name} · ${fmtTime(ts)}`;
  const body = document.createElement('div');
  body.textContent = text;
  el.append(meta, body);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===== Tabs =====
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ===== Users =====
function updateUsersList() {
  usersListEl.innerHTML = '';
  const mine = document.createElement('span');
  mine.className = 'user-badge me';
  mine.dataset.uid = socket.id;
  mine.textContent = `${myName} (tu)`;
  usersListEl.appendChild(mine);
  for (const [id, user] of users) {
    const b = document.createElement('span');
    b.className = 'user-badge';
    b.dataset.uid = id;
    b.textContent = user.name;
    usersListEl.appendChild(b);
  }
  usersCountEl.textContent = users.size + 1;
}

// ===== Sounds =====
soundBtn.addEventListener('click', () => {
  soundsOn = !soundsOn;
  soundBtn.classList.toggle('off', !soundsOn);
  soundBtn.innerHTML = soundsOn ? '&#128266;' : '&#128263;';
});

function beep(freqs, dur, vol) {
  if (!soundsOn) return;
  try {
    const ctx = ensureCtx();
    const now = ctx.currentTime + 0.03;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(vol, now + i * dur);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + i * dur); osc.stop(now + (i + 1) * dur);
    });
  } catch (e) { /* ignore */ }
}
const playRogerBeep = () => beep([1200, 900], 0.08, 0.12);
const playJoinBeep = () => beep([700, 1000], 0.07, 0.08);
const playChatBeep = () => beep([900], 0.06, 0.06);

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ===== Toast =====
let toastTimeout = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}
