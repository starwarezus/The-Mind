'use strict';

// ══════════════════════════════════════════════════════════════
//  STARFIELD
// ══════════════════════════════════════════════════════════════
(function initStars() {
  const canvas = document.getElementById('stars-canvas');
  const ctx    = canvas.getContext('2d');
  let stars    = [];
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  function makeStars(n) {
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      r: Math.random() * 1.3 + 0.2,   a: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.005 + 0.001,
    }));
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      s.a += s.speed;
      ctx.globalAlpha = (Math.sin(s.a) * 0.5 + 0.5) * 0.75 + 0.1;
      ctx.fillStyle = '#c8e0ff';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  resize(); makeStars(220); draw();
  window.addEventListener('resize', () => { resize(); makeStars(220); });
})();

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
let socket;
let myName            = '';
let myHand            = [];
let gameState         = null;
let myRoomCode        = null;
let isHost            = false;
let selectedCard      = null;
let countdownInterval = null;
let levelTimerInterval= null;
let wrongPopupTimeout = null;
let pendingStartLevel = 1;
let chooseLevelVal    = 1;
let prevPlayedCount   = 0;

// ══════════════════════════════════════════════════════════════
//  DOM HELPERS
// ══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const screens = ['landing', 'choose', 'lobby', 'game'];

function showScreen(name) {
  screens.forEach(s => $('screen-' + s).classList.toggle('hidden', s !== name));
  $('rabbit-bg').classList.toggle('visible', name === 'game');
  if (name !== 'game') closeMobPanel();
}
function setOverlay(name) {
  ['pause', 'level', 'gameover', 'won'].forEach(n =>
    $('overlay-' + n).classList.toggle('hidden', n !== name));
}

// ══════════════════════════════════════════════════════════════
//  RESET CHAT + LOG
// ══════════════════════════════════════════════════════════════
function resetChatAndLog() {
  ['chat-messages','log-entries','mob-chat-messages','mob-log-entries'].forEach(id => {
    const el = $(id);
    if (el) el.innerHTML = '';
  });
}

// ══════════════════════════════════════════════════════════════
//  WRONG CARD POPUP
// ══════════════════════════════════════════════════════════════
function showWrongCardPopup(evt) {
  const popup = $('wrong-card-popup');
  if (!popup) return;

  // Build body text
  let body = '';
  if (evt.lowerCards && evt.lowerCards.length > 0) {
    const who = evt.lowerCards.map(c => `${c.playerName} had ${c.card}.`).join(' · ');
    body = who;
  } else {
    body = 'A lower card was still in play!';
  }
  $('wcp-body').textContent = body;
  $('wcp-lives').textContent = evt.lives > 0
    ? `♥ ${evt.lives} live${evt.lives !== 1 ? 's' : ''} remaining`
    : '♥ No lives left!';

  // Clear any existing timeout
  if (wrongPopupTimeout) { clearTimeout(wrongPopupTimeout); wrongPopupTimeout = null; }
  popup.classList.remove('hide');
  popup.classList.add('show');

  wrongPopupTimeout = setTimeout(() => {
    popup.classList.remove('show');
    popup.classList.add('hide');
    wrongPopupTimeout = setTimeout(() => popup.classList.remove('hide'), 300);
  }, 2800);
}

// ══════════════════════════════════════════════════════════════
//  EVENT LOG  (game events only, mirrored to mobile panel)
// ══════════════════════════════════════════════════════════════
function log(msg, type = 'play') {
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  ['log-entries', 'mob-log-entries'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `${msg}<span class="log-ts">${ts}</span>`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 120) el.removeChild(el.firstChild);
  });
}

// ══════════════════════════════════════════════════════════════
//  CHAT (mirrored to mobile panel)
// ══════════════════════════════════════════════════════════════
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function appendChatMsg({ name, text, ts, isMe }) {
  const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const html =
    `<span class="chat-name${isMe ? ' me' : ''}">${escHtml(name)}</span>` +
    `<span class="chat-text">${escHtml(text)}</span>` +
    `<span class="chat-ts">${timeStr}</span>`;

  ['chat-messages', 'mob-chat-messages'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const msg = document.createElement('div');
    msg.className = 'chat-msg' + (isMe ? ' mine' : '');
    msg.innerHTML = html;
    el.appendChild(msg);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 200) el.removeChild(el.firstChild);
  });
}

function sendChat() {
  const inputs = ['chat-input', 'mob-chat-input'];
  let text = '';
  for (const id of inputs) {
    const el = $(id);
    if (el && el.value.trim()) { text = el.value.trim(); el.value = ''; break; }
  }
  if (!text || !socket) return;
  socket.emit('chat_msg', { text });
}

// ══════════════════════════════════════════════════════════════
//  MOBILE PANEL NAV
// ══════════════════════════════════════════════════════════════
let activeMobPanel = null;

function openMobPanel(panelId) {
  closeMobPanel();
  if (!panelId || panelId === 'none') return;
  const panel = $(panelId);
  if (panel) { panel.classList.add('open'); activeMobPanel = panelId; }
  // update tab states
  document.querySelectorAll('.mob-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.panel === panelId);
  });
  $('tab-game').classList.toggle('active', !panelId || panelId === 'none');
}

function closeMobPanel() {
  if (activeMobPanel) { const p = $(activeMobPanel); if (p) p.classList.remove('open'); }
  activeMobPanel = null;
  document.querySelectorAll('.mob-tab').forEach(t => t.classList.remove('active'));
  $('tab-game') && $('tab-game').classList.add('active');
}

// ══════════════════════════════════════════════════════════════
//  CARD BUILDER
// ══════════════════════════════════════════════════════════════
function buildCard({ number, back = false, w = 68, h = 102, extraClasses = [] }) {
  const card = document.createElement('div');
  card.className = ['card', ...extraClasses].join(' ');
  card.style.width = w + 'px'; card.style.height = h + 'px';

  if (back) {
    const face = document.createElement('div');
    face.className = 'card-back';
    const orbSz = Math.round(w * 0.72);
    const orb   = document.createElement('div');
    orb.className = 'card-back-orb';
    orb.style.cssText = `width:${orbSz}px;height:${orbSz}px;top:45%;left:50%;transform:translate(-50%,-50%);position:absolute`;
    face.appendChild(orb);
    const txt = document.createElement('div');
    txt.className = 'card-back-txt'; txt.textContent = 'THE MIND';
    face.appendChild(txt);
    card.appendChild(face);
  } else {
    const face = document.createElement('div');
    face.className = 'card-face';
    const burstSz = Math.round(w * 0.82);
    const burst   = document.createElement('div');
    burst.className = 'card-burst';
    burst.style.width = burstSz + 'px'; burst.style.height = burstSz + 'px';
    face.appendChild(burst);
    const numEl = document.createElement('div');
    numEl.className = 'card-num';
    numEl.style.fontSize = w <= 42 ? '1.05rem' : w <= 55 ? '1.45rem' : w <= 70 ? '1.9rem' : '2.5rem';
    const inner = document.createElement('span');
    inner.className = 'card-num-inner'; inner.textContent = number;
    numEl.appendChild(inner);
    face.appendChild(numEl);
    const cfs = Math.max(7, Math.round(w * 0.12)) + 'px';
    const tl  = document.createElement('div');
    tl.className = 'card-corner tl'; tl.style.fontSize = cfs; tl.textContent = number;
    face.appendChild(tl);
    const br  = document.createElement('div');
    br.className = 'card-corner br'; br.style.fontSize = cfs; br.textContent = number;
    face.appendChild(br);
    card.appendChild(face);
  }
  return card;
}

// ══════════════════════════════════════════════════════════════
//  SEAT POSITIONS
// ══════════════════════════════════════════════════════════════
const SEATS = { 1:['top'], 2:['top-left','top-right'], 3:['top-left','top','top-right'],
  4:['top-left','top','top-right','left'], 5:['top-left','top','top-right','left','right'] };

function renderSeats(state) {
  document.querySelectorAll('.seat').forEach(el => el.remove());
  const opponents = state.players.filter(p => p.id !== socket.id);
  const positions = SEATS[Math.min(opponents.length, 5)] || [];
  opponents.forEach((p, idx) => {
    const pos  = positions[idx] || 'top';
    const seat = document.createElement('div');
    seat.className = 'seat'; seat.dataset.pos = pos;
    if (p.connected === false) seat.classList.add('disconnected');
    const nameEl = document.createElement('div');
    nameEl.className = 'seat-name';
    nameEl.innerHTML =
      (p.connected === false ? '<span style="color:var(--danger)">● </span>' : '') +
      escHtml(p.name) +
      (state.starVotes.includes(p.id)  ? ' <span class="voted-star-icon">★</span>' : '') +
      (state.readyVotes.includes(p.id) ? ' <span class="ready-icon">✓</span>'      : '');
    const cardsEl = document.createElement('div');
    cardsEl.className = 'seat-cards';
    const count = p.cardCount || 0;
    for (let i = 0; i < Math.min(count, 5); i++) {
      const fc = buildCard({ back: true, w: 38, h: 57 });
      fc.classList.add('fd-card'); cardsEl.appendChild(fc);
    }
    if (count > 0) {
      const badge = document.createElement('div');
      badge.className = 'fd-badge'; badge.textContent = count; cardsEl.appendChild(badge);
    } else {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:.65rem;color:var(--muted);font-style:italic';
      empty.textContent = 'done'; cardsEl.appendChild(empty);
    }
    if (pos.startsWith('bottom')) { seat.appendChild(cardsEl); seat.appendChild(nameEl); }
    else                          { seat.appendChild(nameEl);  seat.appendChild(cardsEl); }
    $('g-table').appendChild(seat);
  });
}

// ══════════════════════════════════════════════════════════════
//  RENDER PILE
// ══════════════════════════════════════════════════════════════
function renderPile(state) {
  const slot = $('pile-top-card'), lbl = $('pile-lbl'), cnt = $('pile-cnt');
  slot.innerHTML = '';
  const played = state.playedCards || [];
  if (!played.length) { lbl.textContent = 'Waiting for first card…'; cnt.textContent = ''; return; }
  const last    = played[played.length - 1];
  const topCard = buildCard({ number: last.card, w: 78, h: 117 });
  if (played.length > prevPlayedCount) topCard.classList.add('flash');
  slot.appendChild(topCard);
  lbl.textContent = `${last.playerName}${last.star ? ' ⭐' : last.forced ? ' 💀' : ''}`;
  cnt.textContent = played.length > 1 ? `${played.length} cards played` : '';
}

// ══════════════════════════════════════════════════════════════
//  RENDER HAND
// ══════════════════════════════════════════════════════════════
function renderHand() {
  const container = $('g-hand'), hint = $('play-hint');
  container.innerHTML = '';
  if (!myHand || !myHand.length) { hint.textContent = 'No cards remaining'; return; }
  // responsive card width
  const isMobile = window.innerWidth <= 600;
  const cardW = isMobile ? 52 : 60;
  const cardH = Math.round(cardW * 1.5);
  myHand.forEach((card, idx) => {
    const classes = ['playable'];
    if (idx === 0)             classes.push('is-lowest');
    if (card === selectedCard) classes.push('selected');
    const el = buildCard({ number: card, w: cardW, h: cardH, extraClasses: classes });
    el.addEventListener('click', () => onCardClick(card));
    container.appendChild(el);
  });
  hint.textContent = selectedCard !== null ? `▲ Tap ${selectedCard}. again to confirm` : 'Green burst = your lowest card';
}

// ══════════════════════════════════════════════════════════════
//  APPLY STATE
// ══════════════════════════════════════════════════════════════
function applyState(state) {
  switch (state.phase) {
    case 'lobby':         applyLobby(state);        break;
    case 'playing':       applyPlaying(state);       break;
    case 'paused':        applyPaused(state);        break;
    case 'levelComplete': applyLevelComplete(state); break;
    case 'gameOver':      applyGameOver();           break;
    case 'won':           applyWon();                break;
  }
}

function applyLobby(state) {
  showScreen('lobby'); setOverlay(null);
  $('lobby-code').textContent          = state.roomCode;
  $('lobby-level-display').textContent = state.startLevel;
  $('lobby-level-val').textContent     = state.startLevel;
  pendingStartLevel = state.startLevel;
  $('lobby-level-controls').style.display = isHost ? 'block' : 'none';
  $('lobby-host-controls').style.display  = isHost ? 'block' : 'none';
  const startBtn = $('btn-start');
  startBtn.disabled    = state.players.length < 2;
  startBtn.textContent = state.players.length < 2
    ? `Waiting for players… (${state.players.length}/2 min)`
    : `✦ Start Game (${state.players.length} players)`;
  const list = $('lobby-players'); list.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div'); chip.className = 'player-chip';
    chip.innerHTML =
      `<div class="p-dot${p.connected === false ? ' off' : ''}"></div>` +
      (p.id === state.hostId ? '<span title="host">👑</span>' : '') +
      `<span>${escHtml(p.name)}${p.id === socket.id ? ' (you)' : ''}</span>`;
    list.appendChild(chip);
  });
}

function applyPlaying(state) {
  showScreen('game'); setOverlay(null); clearCountdown(); clearLevelTimer();
  $('g-level').textContent = state.level;
  $('g-lives').textContent = state.lives;
  $('g-stars').textContent = state.stars;
  const myVoted = state.starVotes.includes(socket.id);
  const starBtn = $('btn-star');
  starBtn.disabled    = myVoted || state.stars <= 0;
  starBtn.textContent = state.stars <= 0 ? '★ No Stars' : myVoted ? '★ Voted…' : '★ Throw Star';
  const vbar = $('star-vote-bar');
  if (state.starVotes.length > 0) {
    vbar.style.display = 'block';
    vbar.textContent = `★ ${state.starVotes.length}/${state.players.length} voting to throw a star — needs all players`;
  } else { vbar.style.display = 'none'; }
  renderSeats(state);
  renderPile(state);
  prevPlayedCount = (state.playedCards || []).length;
  renderHand();
}

function applyPaused(state) {
  showScreen('game'); applyPlaying(state); setOverlay('pause');
  $('pause-sub').textContent = `${state.pausedFor} disconnected. Reconnecting…`;
  startCountdown(30);
}

function applyLevelComplete(state) {
  showScreen('game'); applyPlaying(state); setOverlay('level'); clearCountdown();
  $('lc-title').textContent = `Level ${state.level} Clear! 🌟`;
  const bonus = [];
  if ([3,6,9].includes(state.level + 1)) bonus.push('+1 life');
  if ([5,10].includes(state.level + 1))  bonus.push('+1 star');
  $('lc-sub').textContent = bonus.length ? `Next level bonus: ${bonus.join(', ')}!` : 'You read each other perfectly.';
  const myReady = state.readyVotes.includes(socket.id);
  $('btn-ready').disabled    = myReady;
  $('btn-ready').textContent = myReady ? '✓ Waiting for others…' : '✓ Ready for Next';
  $('ready-status').textContent = `${state.readyVotes.length}/${state.players.length} ready`;
  startLevelTimer(60);
}

function applyGameOver() { showScreen('game'); setOverlay('gameover'); clearCountdown(); clearLevelTimer(); }
function applyWon()       { showScreen('game'); setOverlay('won');      clearCountdown(); clearLevelTimer(); }

// ══════════════════════════════════════════════════════════════
//  CARD EVENTS
// ══════════════════════════════════════════════════════════════
function handleCardEvent(evt) {
  switch (evt.type) {
    case 'life_lost':
      showWrongCardPopup(evt);
      log(`💀 Wrong card! ${evt.lives} live${evt.lives !== 1 ? 's' : ''} remaining.`, 'danger');
      if (evt.lowerCards?.length) {
        const who = evt.lowerCards.map(c => `${c.playerName} (${c.card}.)`).join(', ');
        log(`Discarded lower cards — ${who}`, 'danger');
      }
      break;
    case 'star_vote_update':
      log(`★ ${evt.votes}/${evt.needed} voted to use a throwing star`, 'star');
      break;
    case 'star_used': {
      const rev = evt.lowestCards.map(c => `${c.playerName}: ${c.card}.`).join(', ');
      log(`★ Star used! Revealed — ${rev}`, 'star');
      break;
    }
    case 'star_vote_failed':
      log('★ No throwing stars remaining!', 'danger');
      break;
  }
}

// ══════════════════════════════════════════════════════════════
//  CARD CLICK
// ══════════════════════════════════════════════════════════════
function onCardClick(card) {
  if (!gameState || gameState.phase !== 'playing') return;
  if (selectedCard === card) {
    socket.emit('play_card', { card });
    log(`You played ${card}.`, 'play');
    selectedCard = null;
  } else { selectedCard = card; }
  renderHand();
}

// ══════════════════════════════════════════════════════════════
//  TIMERS
// ══════════════════════════════════════════════════════════════
function startCountdown(secs) {
  clearCountdown();
  let rem = secs; $('countdown').textContent = rem;
  countdownInterval = setInterval(() => { $('countdown').textContent = --rem; if (rem <= 0) clearCountdown(); }, 1000);
}
function clearCountdown() { if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; } }

function startLevelTimer(secs) {
  clearLevelTimer();
  let rem = secs; $('lc-timer-secs').textContent = rem; $('lc-timer').style.display = 'block';
  levelTimerInterval = setInterval(() => {
    $('lc-timer-secs').textContent = --rem;
    if (rem <= 0) { clearLevelTimer(); if (!$('btn-ready').disabled) $('btn-ready').click(); }
  }, 1000);
}
function clearLevelTimer() { if (levelTimerInterval) { clearInterval(levelTimerInterval); levelTimerInterval = null; } }

// ══════════════════════════════════════════════════════════════
//  SOCKET
// ══════════════════════════════════════════════════════════════
function connectSocket() {
  socket = io();
  socket.on('connect', () => console.log('connected', socket.id));
  socket.on('error', ({ msg }) => { $('join-error').textContent = msg; $('start-error').textContent = msg; });

  socket.on('room_created', ({ roomCode }) => {
    myRoomCode = roomCode; isHost = true;
    resetChatAndLog();      // ← reset on new room
    showScreen('lobby');
  });
  socket.on('room_joined', ({ roomCode }) => {
    myRoomCode = roomCode;
    resetChatAndLog();      // ← reset on join
    showScreen('lobby');
  });

  socket.on('your_hand', (hand) => {
    myHand = hand;
    if (hand.length > 0) log(`Cards dealt — you have: ${hand.map(n => n + '.').join(', ')}`, 'system');
    renderHand();
  });

  socket.on('room_update', (state) => {
    const prevPhase  = gameState?.phase;
    const prevPlayed = gameState?.playedCards?.length ?? 0;
    gameState = state; isHost = state.hostId === socket.id;

    if (prevPhase !== state.phase) {
      if      (state.phase === 'playing' && prevPhase === 'lobby')        log(`— Level ${state.level} begins. ${state.players.length} players. —`, 'system');
      else if (state.phase === 'levelComplete')                           log(`— Level ${state.level} complete! —`, 'success');
      else if (state.phase === 'paused')                                  log(`— ${state.pausedFor} disconnected. Paused 30s. —`, 'system');
      else if (state.phase === 'playing' && prevPhase === 'paused')       log('— Game resumed. —', 'system');
      else if (state.phase === 'playing' && prevPhase === 'levelComplete')log(`— Level ${state.level} begins. —`, 'system');
      else if (state.phase === 'gameOver')                                log('— Game over. Out of lives. —', 'danger');
      else if (state.phase === 'won')                                     log('— All levels complete. ONE MIND. —', 'success');
    }

    if (state.phase === 'playing' && (state.playedCards?.length ?? 0) > prevPlayed) {
      const last = state.playedCards[state.playedCards.length - 1];
      if (last && last.playerId !== socket.id && !last.forced && !last.star)
        log(`${last.playerName} played ${last.card}.`, 'play');
    }

    applyState(state);
  });

  socket.on('card_event', handleCardEvent);
  socket.on('chat_msg', ({ name, text, ts }) =>
    appendChatMsg({ name, text, ts, isMe: name === myName }));
}

// ══════════════════════════════════════════════════════════════
//  LEVEL SELECTORS
// ══════════════════════════════════════════════════════════════
function updateChooseLevel(d) {
  chooseLevelVal = Math.min(12, Math.max(1, chooseLevelVal + d));
  $('level-display').textContent = chooseLevelVal;
}
$('level-up').addEventListener('click',   () => updateChooseLevel(1));
$('level-down').addEventListener('click', () => updateChooseLevel(-1));
$('lobby-level-up').addEventListener('click', () => {
  pendingStartLevel = Math.min(12, pendingStartLevel + 1);
  $('lobby-level-val').textContent = $('lobby-level-display').textContent = pendingStartLevel;
  socket.emit('set_start_level', { level: pendingStartLevel });
});
$('lobby-level-down').addEventListener('click', () => {
  pendingStartLevel = Math.max(1, pendingStartLevel - 1);
  $('lobby-level-val').textContent = $('lobby-level-display').textContent = pendingStartLevel;
  socket.emit('set_start_level', { level: pendingStartLevel });
});

// ══════════════════════════════════════════════════════════════
//  ACTIONS
// ══════════════════════════════════════════════════════════════
$('btn-enter').addEventListener('click', () => {
  const name = $('landing-name').value.trim();
  if (!name) { $('landing-name').focus(); return; }
  myName = name; connectSocket(); showScreen('choose');
});
$('landing-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-enter').click(); });
$('btn-create').addEventListener('click', () => socket.emit('create_room', { name: myName, startLevel: chooseLevelVal }));
$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  $('join-error').textContent = '';
  if (code.length !== 4) { $('join-error').textContent = 'Enter a 4-letter code.'; return; }
  socket.emit('join_room', { name: myName, roomCode: code });
});
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
$('lobby-code').addEventListener('click', () => navigator.clipboard.writeText($('lobby-code').textContent).catch(() => {}));
$('btn-start').addEventListener('click', () => { $('start-error').textContent = ''; socket.emit('start_game'); });
$('btn-star').addEventListener('click', () => { socket.emit('vote_star'); log('★ You voted to throw a star', 'star'); });
$('btn-ready').addEventListener('click', () => {
  socket.emit('ready_next');
  $('btn-ready').disabled = true; $('btn-ready').textContent = '✓ Waiting for others…';
});
$('btn-exit').addEventListener('click', () => { if (!confirm('Exit to main menu?')) return; resetAndGoHome(); });
$('btn-exit-level').addEventListener('click', () => { if (!confirm('Exit to main menu?')) return; resetAndGoHome(); });

function resetAndGoHome() {
  myHand = []; gameState = null; myRoomCode = null; isHost = false; selectedCard = null;
  clearLevelTimer(); clearCountdown();
  if (socket) { socket.disconnect(); socket = null; }
  showScreen('landing'); setOverlay(null);
}
$('btn-play-again').addEventListener('click',     resetAndGoHome);
$('btn-play-again-won').addEventListener('click', resetAndGoHome);

// chat
$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
$('mob-chat-send').addEventListener('click', sendChat);
$('mob-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// mobile nav tabs
document.querySelectorAll('.mob-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const panelId = tab.dataset.panel;
    if (activeMobPanel === panelId) { closeMobPanel(); }
    else { openMobPanel(panelId === 'none' ? null : panelId); }
  });
});
$('mob-chat-close').addEventListener('click', closeMobPanel);
$('mob-log-close').addEventListener('click',  closeMobPanel);

// re-render hand on resize (card size changes)
window.addEventListener('resize', () => { if (gameState?.phase === 'playing') renderHand(); });
