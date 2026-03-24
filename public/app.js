const socket = io();

// DOM elements
const loginScreen = document.getElementById('login-screen');
const mainScreen = document.getElementById('main-screen');
const usernameInput = document.getElementById('username');
const channelInput = document.getElementById('channel');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const channelNameEl = document.getElementById('channel-name');
const usersListEl = document.getElementById('users-list');
const pttBtn = document.getElementById('ptt-btn');
const talkerIndicator = document.getElementById('talker-indicator');
const talkerName = document.getElementById('talker-name');
const idleIndicator = document.getElementById('idle-indicator');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const toastEl = document.getElementById('toast');

let myName = '';
let myChannel = '';
let mediaStream = null;
let mediaRecorder = null;
let isTalking = false;
let users = new Map(); // id -> {name}
let playbackCtx = null; // AudioContext for playback, created on user gesture

// === LOGIN ===
joinBtn.addEventListener('click', join);
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') channelInput.focus(); });
channelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const name = usernameInput.value.trim();
  const channel = channelInput.value.trim().toLowerCase();
  if (!name || !channel) return;

  myName = name;
  myChannel = channel;

  // Create AudioContext on user gesture (required for mobile playback)
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume();
  }

  socket.emit('join', { channel, name });

  loginScreen.classList.remove('active');
  mainScreen.classList.add('active');
  channelNameEl.textContent = channel;
  pttBtn.disabled = false;

  updateUsersList();
}

leaveBtn.addEventListener('click', () => {
  stopAudio();
  socket.disconnect();
  socket.connect();
  mainScreen.classList.remove('active');
  loginScreen.classList.add('active');
  users.clear();
  pttBtn.disabled = true;
  isTalking = false;
  pttBtn.classList.remove('active');
});

// === SOCKET EVENTS ===
socket.on('connect', () => {
  statusDot.classList.remove('disconnected');
  statusText.textContent = 'Connesso';
});

socket.on('disconnect', () => {
  statusDot.classList.add('disconnected');
  statusText.textContent = 'Disconnesso';
  if (isTalking) {
    isTalking = false;
    pttBtn.classList.remove('active');
    stopAudio();
  }
});

socket.on('channel-users', (userList) => {
  users.clear();
  userList.forEach(u => users.set(u.id, u));
  updateUsersList();
});

socket.on('user-joined', ({ name, id }) => {
  users.set(id, { name });
  updateUsersList();
  showToast(`${name} si e' unito`);
});

socket.on('user-left', ({ name, id }) => {
  users.delete(id);
  updateUsersList();
  showToast(`${name} ha lasciato il canale`);
});

socket.on('ptt-granted', () => {
  isTalking = true;
  pttBtn.classList.add('active');
  startAudio();
});

socket.on('channel-busy', ({ name }) => {
  showToast(`Canale occupato da ${name}`);
  pttBtn.classList.remove('active');
});

socket.on('ptt-start', ({ name, id }) => {
  talkerIndicator.classList.remove('hidden');
  idleIndicator.classList.add('hidden');
  talkerName.textContent = name;

  // Highlight talking user
  const badge = document.querySelector(`[data-uid="${id}"]`);
  if (badge) badge.classList.add('talking');


});

socket.on('audio-message', (data) => {
  playAudioMessage(data);
});

socket.on('ptt-end', ({ name, id }) => {
  talkerIndicator.classList.add('hidden');
  idleIndicator.classList.remove('hidden');

  const badge = document.querySelector(`[data-uid="${id}"]`);
  if (badge) badge.classList.remove('talking');

  // Play roger beep
  playRogerBeep();
});

// === PTT BUTTON ===
function pttDown(e) {
  e.preventDefault();
  if (pttBtn.disabled || isTalking) return;
  pttBtn.classList.add('active');
  socket.emit('ptt-start');
}

function pttUp(e) {
  if (!isTalking && !pttBtn.classList.contains('active')) return;
  e.preventDefault();
  isTalking = false;
  pttBtn.classList.remove('active');
  stopAudio();
  socket.emit('ptt-end');
}

// Mouse events
pttBtn.addEventListener('mousedown', pttDown);
window.addEventListener('mouseup', (e) => {
  if (isTalking || pttBtn.classList.contains('active')) pttUp(e);
});

// Touch events - only intercept on the PTT button itself
pttBtn.addEventListener('touchstart', pttDown, { passive: false });
pttBtn.addEventListener('touchend', pttUp, { passive: false });
pttBtn.addEventListener('touchcancel', pttUp, { passive: false });

// Prevent context menu on long press
pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// === AUDIO CAPTURE (MediaRecorder + Opus) ===
let audioChunks = [];

async function startAudio() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    console.error('getUserMedia error:', err);
    showToast('Errore: permesso microfono negato');
    isTalking = false;
    pttBtn.classList.remove('active');
    socket.emit('ptt-end');
    return;
  }

  audioChunks = [];

  // Pick best supported mime type
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || '';

  try {
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType,
      audioBitsPerSecond: 32000
    });
  } catch (err) {
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = () => {
    if (audioChunks.length === 0) return;
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    blob.arrayBuffer().then(buf => {
      socket.emit('audio-message', { audio: buf, mime: mediaRecorder.mimeType });
    });
    audioChunks = [];
  };

  mediaRecorder.start(100); // collect data every 100ms for quick stop
  console.log('Recording with', mediaRecorder.mimeType);
}

function stopAudio() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // .stop() triggers onstop asynchronously — don't null the reference yet
    mediaRecorder.stop();
    // Stop mic tracks after a short delay to let onstop fire
    const stream = mediaStream;
    mediaStream = null;
    setTimeout(() => {
      if (stream) stream.getTracks().forEach(t => t.stop());
      mediaRecorder = null;
    }, 500);
  } else {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
  }
}

// === AUDIO PLAYBACK ===
function playAudioMessage(data) {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume();
  }

  let buf = data.audio;
  if (!(buf instanceof ArrayBuffer)) {
    buf = new Uint8Array(buf).buffer;
  }

  // decodeAudioData needs a copy (it detaches the buffer)
  const copy = buf.slice(0);

  playbackCtx.decodeAudioData(copy, (audioBuffer) => {
    const source = playbackCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackCtx.destination);
    source.start(0);
  }, (err) => {
    console.error('decodeAudioData failed:', err);
    // Fallback: try Audio element
    const blob = new Blob([buf], { type: data.mime || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play().catch(() => showToast('Tap per abilitare audio'));
  });
}

// === ROGER BEEP ===
function playRogerBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime + 0.05;
    const tones = [1200, 900];
    const duration = 0.08;

    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, now + i * duration);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * duration);
      osc.stop(now + (i + 1) * duration);
    });
  } catch (e) { /* ignore */ }
}

// === UI ===
function updateUsersList() {
  let html = `<span class="user-badge me" data-uid="${socket.id}">${myName} (tu)</span>`;
  for (const [id, user] of users) {
    html += `<span class="user-badge" data-uid="${id}">${user.name}</span>`;
  }
  usersListEl.innerHTML = html;
}

let toastTimeout = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}
