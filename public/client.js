'use strict';

// ══════════════════════════════════════════════════════════════
//  STARFIELD
// ══════════════════════════════════════════════════════════════
(function initStars() {
  const canvas = document.getElementById('stars-canvas');
  const ctx = canvas.getContext('2d');
  let stars = [];
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  function makeStars(n) {
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.2 + 0.2,
      a: Math.random(),
      speed: Math.random() * 0.004 + 0.001,
    }));
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      s.a += s.speed;
      ctx.globalAlpha = (Math.sin(s.a) * 0.5 + 0.5) * 0.8 + 0.1;
      ctx.fillStyle = '#c8e0ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  resize();
  makeStars(200);
  draw();
  window.addEventListener('resize', () => { resize(); makeStars(200); });
})();

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
let socket;
let myName = '';
let myHand = [];
let gameState = null;
let myRoomCode = null;
let isHost = false;
let selectedCard = null;
let countdownInterval = null;
let pendingStartLevel = 1;
let chooseLevelVal = 1;

// ══════════════════════════════════════════════════════════════
//  DOM HELPERS
// ══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const screens = ['landing', 'choose', 'lobby', 'game'];
function showScreen(name) {
  screens.forEach(s => $('screen-' + s).classList.toggle('hidden', s !== name));
}
function setOverlay(name) {
  ['pause', 'level', 'gameover', 'won'].forEach(n =>
    $('overlay-' + n).classList.toggle('hidden', n !== name)
  );
}

// ══════════════════════════════════════════════════════════════
//  EVENT LOG  (replaces toasts in game screen)
// ══════════════════════════════════════════════════════════════
function log(msg, type = 'info') {
  const el = $('log-entries');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = `${msg}<span class="log-ts">${ts}</span>`;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
  // keep max 80 entries
  while (el.children.length > 80) el.removeChild(el.firstChild);
}

// Pre-game toasts (outside game screen — used for errors on lobby/choose screens)
function toast(msg) {
  // quick inline alert-style under buttons
  console.warn('[toast]', msg);
}

// ══════════════════════════════════════════════════════════════
//  CARD BUILDER
// ══════════════════════════════════════════════════════════════
function buildCard({ number, back = false, width, height, classes = [] }) {
  const w = width || 60;
  const h = height || 90;
  const card = document.createElement('div');
  card.className = ['card', ...classes].join(' ');
  card.style.width = w + 'px';
  card.style.height = h + 'px';

  if (back) {
    const face = document.createElement('div');
    face.className = 'card-back';
    face.style.width = '100%'; face.style.height = '100%';
    const orb = document.createElement('div');
    orb.className = 'card-back-orb';
    orb.style.cssText = `width:70%;height:70%;top:45%;left:50%;transform:translate(-50%,-50%);position:absolute`;
    face.appendChild(orb);
    const txt = document.createElement('div');
    txt.className = 'card-back-txt';
    txt.textContent = 'The Mind';
    face.appendChild(txt);
    card.appendChild(face);
  } else {
    const face = document.createElement('div');
    face.className = 'card-face';
    face.style.width = '100%'; face.style.height = '100%';

    const orbSize = Math.round(w * 0.75);
    const orb = document.createElement('div');
    orb.className = 'card-orb';
    orb.style.cssText = `width:${orbSize}px;height:${orbSize}px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)`;
    face.appendChild(orb);

    const numEl = document.createElement('div');
    numEl.className = 'card-num';
    numEl.style.fontSize = w < 50 ? '1.1rem' : w > 70 ? '2rem' : '1.5rem';
    numEl.textContent = number;
    face.appendChild(numEl);

    const fontSize = Math.max(7, Math.round(w * 0.13)) + 'px';
    const tl = document.createElement('div');
    tl.className = 'card-corner tl';
    tl.style.fontSize = fontSize;
    tl.textContent = number;
    face.appendChild(tl);

    const br = document.createElement('div');
    br.className = 'card-corner br';
    br.style.fontSize = fontSize;
    br.textContent = number;
    face.appendChild(br);

    card.appendChild(face);
  }
  return card;
}

// ══════════════════════════════════════════════════════════════
//  SEAT POSITIONS (for 1–5 opponents)
// ══════════════════════════════════════════════════════════════
const SEAT_POSITIONS = {
  1: ['top'],
  2: ['top-left', 'top-right'],
  3: ['top-left', 'top', 'top-right'],
  4: ['top-left', 'top', 'top-right', 'left'],
  5: ['top-left', 'top', 'top-right', 'left', 'right'],
};

function renderSeats(state) {
  // Remove old seats
  document.querySelectorAll('.seat').forEach(el => el.remove());

  const opponents = state.players.filter(p => p.id !== socket.id);
  const positions = SEAT_POSITIONS[Math.min(opponents.length, 5)] || [];

  opponents.forEach((p, idx) => {
    const pos = positions[idx] || 'top';
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.dataset.pos = pos;
    if (p.connected === false) seat.classList.add('disconnected');

    // name row
    const nameEl = document.createElement('div');
    nameEl.className = 'seat-name';
    const votedStar = state.starVotes.includes(p.id);
    const isReady = state.readyVotes.includes(p.id);
    nameEl.innerHTML =
      (p.connected === false ? '<span style="color:var(--danger)">●</span>' : '') +
      p.name +
      (votedStar ? ' <span class="voted-star-icon">★</span>' : '') +
      (isReady   ? ' <span class="ready-icon">✓</span>'      : '');

    // face-down cards
    const cardsEl = document.createElement('div');
    cardsEl.className = 'seat-cards';
    cardsEl.style.position = 'relative';

    const count = p.cardCount || 0;
    const showCards = Math.min(count, 4); // show up to 4 stacked backs
    for (let i = 0; i < showCards; i++) {
      const fdCard = buildCard({ back: true, width: 38, height: 57 });
      fdCard.classList.add('fd-card');
      cardsEl.appendChild(fdCard);
    }

    if (count > 0) {
      const badge = document.createElement('div');
      badge.className = 'fd-badge';
      badge.textContent = count;
      cardsEl.appendChild(badge);
    } else {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:.65rem;color:var(--muted);font-style:italic';
      empty.textContent = 'no cards';
      cardsEl.appendChild(empty);
    }

    // ordering: name above for top positions, below for bottom
    if (pos.startsWith('bottom')) {
      seat.appendChild(cardsEl);
      seat.appendChild(nameEl);
    } else {
      seat.appendChild(nameEl);
      seat.appendChild(cardsEl);
    }

    $('g-table').appendChild(seat);
  });
}

// ══════════════════════════════════════════════════════════════
//  RENDER PILE
// ══════════════════════════════════════════════════════════════
function renderPile(state) {
  const pileTop = $('pile-top-card');
  const lbl = $('pile-lbl');
  const cnt = $('pile-cnt');
  pileTop.innerHTML = '';

  if (!state.playedCards || state.playedCards.length === 0) {
    lbl.textContent = 'Waiting for first card…';
    cnt.textContent = '';
    return;
  }
  const last = state.playedCards[state.playedCards.length - 1];
  const cardEl = buildCard({ number: last.card, width: 70, height: 105 });
  cardEl.classList.add('flash');
  pileTop.appendChild(cardEl);

  const flag = last.star ? ' ★' : last.forced ? ' ✗' : '';
  lbl.textContent = `${last.playerName}${flag}`;
  cnt.textContent = `${state.playedCards.length} card${state.playedCards.length > 1 ? 's' : ''} played`;
}

// ══════════════════════════════════════════════════════════════
//  RENDER HAND
// ══════════════════════════════════════════════════════════════
function renderHand() {
  const container = $('g-hand');
  const hint = $('play-hint');
  container.innerHTML = '';

  if (!myHand || myHand.length === 0) {
    hint.textContent = '';
    return;
  }

  myHand.forEach((num, idx) => {
    const classes = ['playable'];
    if (idx === 0)       classes.push('is-lowest');
    if (num === selectedCard) classes.push('selected');

    const card = buildCard({ number: num, width: 60, height: 90, classes });
    card.addEventListener('click', () => onCardClick(num));
    container.appendChild(card);
  });

  if (selectedCard !== null) {
    hint.textContent = `Tap ${selectedCard} again to play it`;
  } else if (myHand.length > 0) {
    hint.textContent = 'Green glow = your lowest card';
  } else {
    hint.textContent = '';
  }
}

// ══════════════════════════════════════════════════════════════
//  APPLY STATE
// ══════════════════════════════════════════════════════════════
function applyState(state) {
  switch (state.phase) {
    case 'lobby':         applyLobby(state);         break;
    case 'playing':       applyPlaying(state);        break;
    case 'paused':        applyPaused(state);         break;
    case 'levelComplete': applyLevelComplete(state);  break;
    case 'gameOver':      applyGameOver(state);       break;
    case 'won':           applyWon(state);            break;
  }
}

function applyLobby(state) {
  showScreen('lobby');
  setOverlay(null);
  $('lobby-code').textContent = state.roomCode;
  $('lobby-level-display').textContent = state.startLevel;
  $('lobby-level-val').textContent = state.startLevel;
  pendingStartLevel = state.startLevel;

  if (isHost) {
    $('lobby-level-controls').style.display = 'block';
    $('lobby-host-controls').style.display = 'block';
  } else {
    $('lobby-level-controls').style.display = 'none';
    $('lobby-host-controls').style.display = 'none';
  }

  const startBtn = $('btn-start');
  startBtn.disabled = state.players.length < 2;
  startBtn.textContent = state.players.length < 2
    ? `Waiting for players… (${state.players.length}/2 min)`
    : `✦ Start Game — ${state.players.length} Players`;

  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    const isMe = p.id === socket.id;
    const crown = p.id === state.hostId ? '👑 ' : '';
    chip.innerHTML = `<div class="p-dot${p.connected === false ? ' off' : ''}"></div>${crown}${p.name}${isMe ? ' <em style="color:var(--muted)">(you)</em>' : ''}`;
    list.appendChild(chip);
  });
}

function applyPlaying(state) {
  showScreen('game');
  setOverlay(null);
  clearCountdown();

  $('g-level').textContent = state.level;
  $('g-lives').textContent = state.lives;
  $('g-stars').textContent = state.stars;

  renderSeats(state);
  renderPile(state);

  // star button
  const myVoted = state.starVotes.includes(socket.id);
  $('btn-star').disabled = myVoted || state.stars <= 0;
  $('btn-star').textContent = state.stars <= 0 ? '★ No Stars' : myVoted ? '★ Voted…' : '★ Throw Star';

  const voteBar = $('star-vote-bar');
  if (state.starVotes.length > 0) {
    voteBar.style.display = 'block';
    voteBar.textContent = `★ ${state.starVotes.length}/${state.players.length} players want to throw a star`;
  } else {
    voteBar.style.display = 'none';
  }

  renderHand();
}

function applyPaused(state) {
  applyPlaying(state);
  setOverlay('pause');
  $('pause-sub').textContent = `${state.pausedFor} disconnected. Waiting to reconnect…`;
  startCountdown(30);
}

function applyLevelComplete(state) {
  applyPlaying(state);
  setOverlay('level');
  clearCountdown();
  $('lc-title').textContent = `Level ${state.level} Clear! 🌟`;

  const bonus = [];
  if ([3, 6, 9].includes(state.level + 1)) bonus.push('+1 life');
  if ([5, 10].includes(state.level + 1))   bonus.push('+1 star');
  $('lc-sub').textContent = bonus.length
    ? `Bonus on next level: ${bonus.join(', ')}! 🎁`
    : 'You read each other perfectly.';

  const myReady = state.readyVotes.includes(socket.id);
  $('btn-ready').disabled = myReady;
  $('btn-ready').textContent = myReady ? '✓ Waiting for others…' : '✓ Ready for Next';
  $('ready-status').textContent = `${state.readyVotes.length}/${state.players.length} ready`;
}

function applyGameOver(state) {
  showScreen('game');
  setOverlay('gameover');
  clearCountdown();
  log('💀 Game over — you ran out of lives.', 'danger');
}

function applyWon(state) {
  showScreen('game');
  setOverlay('won');
  clearCountdown();
  log('🧠 You conquered all levels! ONE MIND!', 'success');
}

// ══════════════════════════════════════════════════════════════
//  CARD EVENTS → LOG
// ══════════════════════════════════════════════════════════════
function handleCardEvent(evt) {
  switch (evt.type) {
    case 'card_played':
      // logged by room_update render — no extra needed
      break;
    case 'life_lost':
      log(`💀 Wrong card! Lost a life — ${evt.lives} remaining.`, 'danger');
      if (evt.lowerCards?.length) {
        const details = evt.lowerCards.map(c => `${c.playerName} had ${c.card}`).join(', ');
        log(`Discarded lower cards: ${details}`, 'danger');
      }
      break;
    case 'star_vote_update':
      log(`★ ${evt.votes}/${evt.needed} players want to throw a star`, 'star');
      break;
    case 'star_used':
      const revealed = evt.lowestCards.map(c => `${c.playerName}: ${c.card}`).join(', ');
      log(`★ Star used! Lowest cards discarded — ${revealed}`, 'star');
      break;
    case 'star_vote_failed':
      log('★ No stars remaining!', 'danger');
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
    log(`You played ${card}`, 'info');
    selectedCard = null;
    renderHand();
  } else {
    selectedCard = card;
    renderHand();
  }
}

// ══════════════════════════════════════════════════════════════
//  COUNTDOWN
// ══════════════════════════════════════════════════════════════
function startCountdown(secs) {
  clearCountdown();
  let rem = secs;
  $('countdown').textContent = rem;
  countdownInterval = setInterval(() => {
    rem--;
    $('countdown').textContent = rem;
    if (rem <= 0) clearCountdown();
  }, 1000);
}
function clearCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

// ══════════════════════════════════════════════════════════════
//  SOCKET
// ══════════════════════════════════════════════════════════════
function connectSocket() {
  socket = io();
  socket.on('connect', () => console.log('connected', socket.id));

  socket.on('error', ({ msg }) => {
    $('join-error').textContent = msg;
    $('start-error').textContent = msg;
    log('⚠ ' + msg, 'danger');
  });

  socket.on('room_created', ({ roomCode }) => {
    myRoomCode = roomCode;
    isHost = true;
    showScreen('lobby');
  });

  socket.on('room_joined', ({ roomCode }) => {
    myRoomCode = roomCode;
    showScreen('lobby');
  });

  socket.on('your_hand', (hand) => {
    myHand = hand;
    if (hand.length > 0) log(`You received ${hand.length} card${hand.length > 1 ? 's' : ''}: ${hand.join(', ')}`, 'system');
    renderHand();
  });

  socket.on('room_update', (state) => {
    const prevPhase = gameState?.phase;
    gameState = state;
    isHost = state.hostId === socket.id;

    // Log phase transitions
    if (prevPhase !== state.phase) {
      if (state.phase === 'playing' && prevPhase === 'lobby') {
        log(`✦ Level ${state.level} started — good luck!`, 'success');
      } else if (state.phase === 'levelComplete') {
        log(`🌟 Level ${state.level} complete!`, 'success');
      } else if (state.phase === 'paused') {
        log(`⏸ Game paused — ${state.pausedFor} disconnected`, 'system');
      } else if (state.phase === 'playing' && prevPhase === 'paused') {
        log(`▶ Game resumed`, 'system');
      } else if (state.phase === 'playing' && prevPhase === 'levelComplete') {
        log(`✦ Level ${state.level} started!`, 'success');
      }
    }

    // Log when someone plays (detect new played cards)
    if (state.playedCards?.length && prevPhase === 'playing' && state.phase === 'playing') {
      const last = state.playedCards[state.playedCards.length - 1];
      if (last && last.playerId !== socket.id && !last.forced && !last.star) {
        log(`${last.playerName} played ${last.card}`, 'info');
      }
    }

    applyState(state);
  });

  socket.on('card_event', handleCardEvent);
}

// ══════════════════════════════════════════════════════════════
//  LEVEL SELECTORS
// ══════════════════════════════════════════════════════════════
function updateChooseLevel(d) {
  chooseLevelVal = Math.min(12, Math.max(1, chooseLevelVal + d));
  $('level-display').textContent = chooseLevelVal;
}
$('level-up').addEventListener('click', () => updateChooseLevel(1));
$('level-down').addEventListener('click', () => updateChooseLevel(-1));

$('lobby-level-up').addEventListener('click', () => {
  pendingStartLevel = Math.min(12, pendingStartLevel + 1);
  $('lobby-level-val').textContent = pendingStartLevel;
  $('lobby-level-display').textContent = pendingStartLevel;
  socket.emit('set_start_level', { level: pendingStartLevel });
});
$('lobby-level-down').addEventListener('click', () => {
  pendingStartLevel = Math.max(1, pendingStartLevel - 1);
  $('lobby-level-val').textContent = pendingStartLevel;
  $('lobby-level-display').textContent = pendingStartLevel;
  socket.emit('set_start_level', { level: pendingStartLevel });
});

// ══════════════════════════════════════════════════════════════
//  SCREEN ACTIONS
// ══════════════════════════════════════════════════════════════
$('btn-enter').addEventListener('click', () => {
  const name = $('landing-name').value.trim();
  if (!name) { $('landing-name').focus(); return; }
  myName = name;
  connectSocket();
  showScreen('choose');
});
$('landing-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-enter').click(); });

$('btn-create').addEventListener('click', () => {
  socket.emit('create_room', { name: myName, startLevel: chooseLevelVal });
});

$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  $('join-error').textContent = '';
  if (code.length !== 4) { $('join-error').textContent = 'Enter a 4-letter code.'; return; }
  socket.emit('join_room', { name: myName, roomCode: code });
});
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });

$('lobby-code').addEventListener('click', () => {
  navigator.clipboard.writeText($('lobby-code').textContent)
    .then(() => log('Room code copied to clipboard', 'system'));
});

$('btn-start').addEventListener('click', () => {
  $('start-error').textContent = '';
  socket.emit('start_game');
});

$('btn-star').addEventListener('click', () => {
  socket.emit('vote_star');
  log('★ You voted to throw a star', 'star');
});

$('btn-ready').addEventListener('click', () => {
  socket.emit('ready_next');
  $('btn-ready').disabled = true;
  $('btn-ready').textContent = '✓ Waiting for others…';
  log('You are ready for the next level', 'system');
});

function playAgain() {
  myHand = []; gameState = null; myRoomCode = null;
  isHost = false; selectedCard = null;
  if (socket) socket.disconnect();
  showScreen('landing');
  setOverlay(null);
}
$('btn-play-again').addEventListener('click', playAgain);
$('btn-play-again-won').addEventListener('click', playAgain);
