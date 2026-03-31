'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  createGame, dealCards, applyCardPlay, applyStarVote,
  advanceLevel, checkLevelComplete, checkGameOver, publicState
} = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// rooms: Map<roomCode, gameState>
const rooms = new Map();
// socketToRoom: Map<socketId, { roomCode, playerName }>
const socketToRoom = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function broadcast(roomCode) {
  const game = rooms.get(roomCode);
  if (!game) return;
  io.to(roomCode).emit('room_update', publicState(game));
}

function sendHand(socket, game) {
  const player = game.players.find(p => p.id === socket.id);
  if (player) socket.emit('your_hand', player.hand);
}

function broadcastHands(game) {
  for (const p of game.players) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('your_hand', p.hand);
  }
}

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ── CREATE ROOM ──────────────────────────────────────────────
  socket.on('create_room', ({ name, startLevel }) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    const game = createGame(code, socket.id, parseInt(startLevel) || 1);
    game.players.push({ id: socket.id, name: name.trim().slice(0, 20), hand: [], connected: true });
    rooms.set(code, game);
    socketToRoom.set(socket.id, { roomCode: code });
    socket.join(code);
    socket.emit('room_created', { roomCode: code });
    broadcast(code);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────
  socket.on('join_room', ({ name, roomCode }) => {
    const code = roomCode.toUpperCase().trim();
    const game = rooms.get(code);
    if (!game) return socket.emit('error', { msg: 'Room not found.' });
    if (game.players.length >= 6) return socket.emit('error', { msg: 'Room is full (max 6 players).' });

    // Check if reconnecting
    const existing = game.players.find(p => p.name === name.trim() && p.connected === false);
    if (existing) {
      // Reconnect
      const oldTimeout = game.reconnectTimeouts?.get(existing.id);
      if (oldTimeout) clearTimeout(oldTimeout);
      existing.id = socket.id;
      existing.connected = true;
      if (game.pausedFor === existing.name) {
        game.pausedFor = null;
        if (game.phase === 'paused') game.phase = 'playing';
      }
      socketToRoom.set(socket.id, { roomCode: code });
      socket.join(code);
      socket.emit('room_joined', { roomCode: code });
      sendHand(socket, game);
      broadcast(code);
      return;
    }

    if (game.phase !== 'lobby') return socket.emit('error', { msg: 'Game already in progress.' });

    game.players.push({ id: socket.id, name: name.trim().slice(0, 20), hand: [], connected: true });
    socketToRoom.set(socket.id, { roomCode: code });
    socket.join(code);
    socket.emit('room_joined', { roomCode: code });
    broadcast(code);
  });

  // ── START GAME ───────────────────────────────────────────────
  socket.on('start_game', () => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.roomCode);
    if (!game || game.hostId !== socket.id) return;
    if (game.players.length < 2) return socket.emit('error', { msg: 'Need at least 2 players.' });

    game.phase = 'playing';
    dealCards(game.players, game.level);
    broadcast(info.roomCode);
    broadcastHands(game);
  });

  // ── PLAY CARD ────────────────────────────────────────────────
  socket.on('play_card', ({ card }) => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.roomCode);
    if (!game || game.phase !== 'playing') return;

    const result = applyCardPlay(game, socket.id, card);
    if (!result) return;

    io.to(info.roomCode).emit('card_event', result);

    if (checkGameOver(game)) {
      game.phase = 'gameOver';
      broadcast(info.roomCode);
      return;
    }

    if (checkLevelComplete(game)) {
      game.phase = 'levelComplete';
      broadcast(info.roomCode);
      return;
    }

    broadcast(info.roomCode);
    broadcastHands(game);
  });

  // ── VOTE STAR ────────────────────────────────────────────────
  socket.on('vote_star', () => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.roomCode);
    if (!game || game.phase !== 'playing') return;

    const result = applyStarVote(game, socket.id);
    if (!result) return;

    io.to(info.roomCode).emit('card_event', result);

    if (result.type === 'star_used') {
      if (checkLevelComplete(game)) {
        game.phase = 'levelComplete';
      }
      broadcast(info.roomCode);
      broadcastHands(game);
    } else {
      broadcast(info.roomCode);
    }
  });

  // ── READY NEXT LEVEL ─────────────────────────────────────────
  socket.on('ready_next', () => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.roomCode);
    if (!game || game.phase !== 'levelComplete') return;

    if (!game.readyVotes.includes(socket.id)) game.readyVotes.push(socket.id);

    if (game.readyVotes.length >= game.players.length) {
      if (game.level >= 12) {
        game.phase = 'won';
        broadcast(info.roomCode);
        return;
      }
      advanceLevel(game);
      broadcast(info.roomCode);
      broadcastHands(game);
    } else {
      broadcast(info.roomCode);
    }
  });

  // ── CHANGE START LEVEL (host only, in lobby) ─────────────────
  socket.on('set_start_level', ({ level }) => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.roomCode);
    if (!game || game.hostId !== socket.id || game.phase !== 'lobby') return;
    game.startLevel = Math.min(Math.max(parseInt(level) || 1, 1), 12);
    game.level = game.startLevel;
    broadcast(info.roomCode);
  });

  // ── CHAT ─────────────────────────────────────────────────────
  socket.on('chat_msg', ({ text }) => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const game = rooms.get(info.roomCode);
    if (!game) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;
    const clean = String(text).trim().slice(0, 200);
    if (!clean) return;
    io.to(info.roomCode).emit('chat_msg', {
      name: player.name,
      text: clean,
      ts: Date.now(),
    });
  });

  // ── DISCONNECT ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    socketToRoom.delete(socket.id);

    const game = rooms.get(info.roomCode);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    player.connected = false;

    if (game.phase === 'playing') {
      game.phase = 'paused';
      game.pausedFor = player.name;

      const timeout = setTimeout(() => {
        // Remove the player
        game.players = game.players.filter(p => p.id !== socket.id);
        game.starVotes = game.starVotes.filter(id => id !== socket.id);
        game.readyVotes = game.readyVotes.filter(id => id !== socket.id);
        game.pausedFor = null;

        if (game.players.length < 2) {
          game.phase = 'gameOver';
        } else {
          game.phase = 'playing';
          // Check if level is now complete
          if (checkLevelComplete(game)) game.phase = 'levelComplete';
        }
        broadcast(info.roomCode);
        broadcastHands(game);
      }, 30000);

      if (!game.reconnectTimeouts) game.reconnectTimeouts = new Map();
      game.reconnectTimeouts.set(socket.id, timeout);
    } else if (game.phase === 'lobby') {
      game.players = game.players.filter(p => p.id !== socket.id);
      // Reassign host if needed
      if (game.hostId === socket.id && game.players.length > 0) {
        game.hostId = game.players[0].id;
      }
      if (game.players.length === 0) {
        rooms.delete(info.roomCode);
        return;
      }
    }

    broadcast(info.roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`The Mind server running on port ${PORT}`));
