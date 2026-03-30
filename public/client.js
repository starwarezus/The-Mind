'use strict';

// ── STATE ──────────────────────────────────────────────────────────────
let socket;
let myName = '';
let myHand = [];
let gameState = null;
let myRoomCode = null;
let isHost = false;
let selectedCard = null;
let countdownInterval = null;
let pendingStartLevel = 1;

// ── DOM HELPERS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = ['landing','choose','lobby','game'];
function showScreen(name) {
  screens.forEach(s => $('screen-' + s).classList.toggle('hidden', s !== name));
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

function setOverlay(name) {
  ['pause','level','gameover','won'].forEach(n =>
    $('overlay-' + n).classList.toggle('hidden', n !== name)
  );
}

// ── SOCKET SETUP ───────────────────────────────────────────────────────
function connectSocket() {
  socket = io();

  socket.on('connect', () => console.log('connected', socket.id));

  socket.on('error', ({ msg }) => {
    toast(msg, 'danger');
    $('join-error').textContent = msg;
    $('start-error').textContent = msg;
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
    renderHand();
  });

  socket.on('room_update', (state) => {
    gameState = state;
    isHost = state.hostId === socket.id;
    applyState(state);
  });

  socket.on('card_event', (evt) => {
    handleCardEvent(evt);
  });
}

// ── APPLY STATE ────────────────────────────────────────────────────────
function applyState(state) {
  switch (state.phase) {
    case 'lobby':        applyLobby(state);        break;
    case 'playing':      applyPlaying(state);       break;
    case 'paused':       applyPaused(state);        break;
    case 'levelComplete':applyLevelComplete(state); break;
    case 'gameOver':     applyGameOver(state);      break;
    case 'won':          applyWon(state);           break;
  }
}

function applyLobby(state) {
  showScreen('lobby');
  setOverlay(null);

  $('lobby-code').textContent = state.roomCode;

  // Level display
  $('lobby-level-display').textContent = state.startLevel;
  $('lobby-level-val').textContent = state.startLevel;
  pendingStartLevel = state.startLevel;

  if (isHost) {
    $('lobby-level-controls').style.display = 'block';
    $('lobby-host-controls').style.display = 'block';
  } else {
    $('lobby-level-controls').style.display = 'none';
    $('lobby-host-controls').style.display = state.hostId === socket.id ? 'block' : 'none';
  }

  const startBtn = $('btn-start');
  startBtn.disabled = state.players.length < 2;
  startBtn.textContent = state.players.length < 2
    ? `Waiting for players… (${state.players.length}/2 min)`
    : `🚀 Start Game (${state.players.length} players)`;

  // Players
  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    const isMe = p.id === socket.id;
    const hostBadge = p.id === state.hostId ? '<span class="crown">👑</span>' : '';
    const dot = `<div class="player-dot${p.connected === false ? ' offline' : ''}"></div>`;
    chip.innerHTML = `${dot}${hostBadge}<span>${p.name}${isMe ? ' (you)' : ''}</span>`;
    list.appendChild(chip);
  });
}

function applyPlaying(state) {
  showScreen('game');
  setOverlay(null);
  clearCountdown();

  // Stats
  $('g-level').textContent = state.level;
  $('g-lives').textContent = state.lives;
  $('g-stars').textContent = state.stars;

  // Players
  renderGamePlayers(state);

  // Pile
  renderPile(state);

  // Star vote status
  const myVoted = state.starVotes.includes(socket.id);
  $('btn-star').disabled = myVoted || state.stars <= 0;
  $('btn-star').textContent = state.stars <= 0 ? '⭐ No Stars Left' : myVoted ? '⭐ Vote Cast…' : '⭐ Throw Star';
  $('star-vote-status').textContent = state.starVotes.length > 0
    ? `${state.starVotes.length}/${state.players.length} voted to use a star`
    : '';

  renderHand();
}

function applyPaused(state) {
  showScreen('game');
  applyPlaying(state); // render game state underneath
  setOverlay('pause');
  $('pause-sub').textContent = `${state.pausedFor} disconnected. Reconnecting in…`;
  startCountdown(30);
}

function applyLevelComplete(state) {
  showScreen('game');
  applyPlaying(state);
  setOverlay('level');
  clearCountdown();
  $('level-complete-title').textContent = `Level ${state.level} Clear! 🎉`;

  const myReady = state.readyVotes.includes(socket.id);
  $('btn-ready').disabled = myReady;
  $('btn-ready').textContent = myReady ? '✅ Waiting for others…' : '✅ I\'m Ready!';
  $('ready-status').textContent = `${state.readyVotes.length}/${state.players.length} ready`;

  // Bonus text
  const bonus = [];
  if ([3,6,9].includes(state.level + 1)) bonus.push('+1 life');
  if ([5,10].includes(state.level + 1)) bonus.push('+1 star');
  $('level-complete-sub').textContent = bonus.length
    ? `Next level: ${bonus.join(', ')}! 🎁`
    : 'Get ready for the next level!';
}

function applyGameOver(state) {
  showScreen('game');
  setOverlay('gameover');
  clearCountdown();
}

function applyWon(state) {
  showScreen('game');
  setOverlay('won');
  clearCountdown();
}

// ── RENDER HELPERS ─────────────────────────────────────────────────────
function renderGamePlayers(state) {
  const container = $('g-players');
  container.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    const votedStar = state.starVotes.includes(p.id);
    const ready = state.readyVotes.includes(p.id);
    chip.className = 'game-player-chip' + (votedStar ? ' voted-star' : '') + (ready ? ' ready' : '');
    const isMe = p.id === socket.id;
    const connDot = p.connected === false ? '🔴 ' : '';
    chip.innerHTML = `${connDot}${p.name}${isMe ? ' (you)' : ''} <span class="card-count-badge">${p.cardCount}</span>`;
    container.appendChild(chip);
  });
}

function renderPile(state) {
  if (!state.playedCards || state.playedCards.length === 0) {
    $('pile-empty').style.display = '';
    $('pile-stack').style.display = 'none';
    return;
  }
  $('pile-empty').style.display = 'none';
  $('pile-stack').style.display = '';
  const last = state.playedCards[state.playedCards.length - 1];
  $('pile-top').textContent = last.card;
  $('pile-label').textContent = `by ${last.playerName}${last.star ? ' ⭐' : last.forced ? ' 💀' : ''}`;
}

function renderHand() {
  const container = $('g-hand');
  const noCards = $('g-no-cards');
  container.innerHTML = '';
  if (!myHand || myHand.length === 0) {
    noCards.style.display = '';
    return;
  }
  noCards.style.display = 'none';
  myHand.forEach((card, idx) => {
    const el = document.createElement('div');
    el.className = 'hand-card' + (idx === 0 ? ' lowest' : '') + (card === selectedCard ? ' selected' : '');
    el.innerHTML = `${card}<span class="card-hint">PLAY</span>`;
    el.addEventListener('click', () => onCardClick(card));
    container.appendChild(el);
  });
}

// ── CARD EVENTS ────────────────────────────────────────────────────────
function handleCardEvent(evt) {
  switch (evt.type) {
    case 'card_played':
      toast('Card played!', 'success');
      break;
    case 'life_lost':
      toast(`💀 Wrong! Lost a life. ${evt.lives} remaining.`, 'danger');
      if (evt.lowerCards?.length) {
        const names = [...new Set(evt.lowerCards.map(c => c.playerName))].join(', ');
        setTimeout(() => toast(`${names} had lower cards — they're discarded.`, 'danger'), 600);
      }
      break;
    case 'star_vote_update':
      toast(`⭐ ${evt.votes}/${evt.needed} voted to use a star…`, 'star');
      break;
    case 'star_used':
      toast(`⭐ Star used! Lowest cards revealed.`, 'star');
      break;
    case 'star_vote_failed':
      toast('No stars left!', 'danger');
      break;
  }
}

// ── INTERACTIONS ───────────────────────────────────────────────────────
function onCardClick(card) {
  if (!gameState || gameState.phase !== 'playing') return;
  if (selectedCard === card) {
    // Second click = play
    socket.emit('play_card', { card });
    selectedCard = null;
    renderHand();
  } else {
    // First click = select (confirm)
    selectedCard = card;
    renderHand();
    toast(`Tap again to play ${card}`, 'info');
  }
}

// ── COUNTDOWN ──────────────────────────────────────────────────────────
function startCountdown(secs) {
  clearCountdown();
  let remaining = secs;
  $('countdown').textContent = remaining;
  countdownInterval = setInterval(() => {
    remaining--;
    $('countdown').textContent = remaining;
    if (remaining <= 0) clearCountdown();
  }, 1000);
}
function clearCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

// ── LEVEL SELECTOR (choose screen) ────────────────────────────────────
let chooseLevelVal = 1;
function updateChooseLevel(delta) {
  chooseLevelVal = Math.min(12, Math.max(1, chooseLevelVal + delta));
  $('level-display').textContent = chooseLevelVal;
}
$('level-up').addEventListener('click', () => updateChooseLevel(1));
$('level-down').addEventListener('click', () => updateChooseLevel(-1));

// ── LEVEL SELECTOR (lobby, host only) ─────────────────────────────────
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

// ── LANDING ────────────────────────────────────────────────────────────
$('btn-enter').addEventListener('click', () => {
  const name = $('landing-name').value.trim();
  if (!name) { toast('Please enter your name!', 'danger'); return; }
  myName = name;
  connectSocket();
  showScreen('choose');
});
$('landing-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-enter').click(); });

// ── CREATE ─────────────────────────────────────────────────────────────
$('btn-create').addEventListener('click', () => {
  socket.emit('create_room', { name: myName, startLevel: chooseLevelVal });
});

// ── JOIN ───────────────────────────────────────────────────────────────
$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) { $('join-error').textContent = 'Enter a 4-letter code.'; return; }
  $('join-error').textContent = '';
  socket.emit('join_room', { name: myName, roomCode: code });
});
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });

// ── LOBBY: COPY CODE ───────────────────────────────────────────────────
$('lobby-code').addEventListener('click', () => {
  const code = $('lobby-code').textContent;
  navigator.clipboard.writeText(code).then(() => toast('Room code copied!', 'success'));
});

// ── LOBBY: START ───────────────────────────────────────────────────────
$('btn-start').addEventListener('click', () => {
  $('start-error').textContent = '';
  socket.emit('start_game');
});

// ── GAME: STAR VOTE ────────────────────────────────────────────────────
$('btn-star').addEventListener('click', () => {
  socket.emit('vote_star');
});

// ── LEVEL COMPLETE: READY ──────────────────────────────────────────────
$('btn-ready').addEventListener('click', () => {
  socket.emit('ready_next');
  $('btn-ready').disabled = true;
  $('btn-ready').textContent = '✅ Waiting for others…';
});

// ── GAME OVER / WON: PLAY AGAIN ───────────────────────────────────────
function playAgain() {
  // Go back to landing to reset all state
  myHand = [];
  gameState = null;
  myRoomCode = null;
  isHost = false;
  selectedCard = null;
  if (socket) socket.disconnect();
  showScreen('landing');
  setOverlay(null);
}
$('btn-play-again').addEventListener('click', playAgain);
$('btn-play-again-won').addEventListener('click', playAgain);
