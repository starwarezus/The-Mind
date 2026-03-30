'use strict';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(players, level) {
  const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  let idx = 0;
  for (const p of players) {
    p.hand = deck.slice(idx, idx + level).sort((a, b) => a - b);
    idx += level;
  }
}

function livesForLevel(startLevel) {
  // Base lives: start with 3, gain 1 at levels 3, 6, 9
  return 3;
}

function starsForLevel(startLevel) {
  return 1;
}

function createGame(roomCode, hostId, startLevel) {
  return {
    roomCode,
    hostId,
    phase: 'lobby',
    startLevel: startLevel || 1,
    level: startLevel || 1,
    lives: 3,
    stars: 1,
    players: [],
    playedCards: [],
    starVotes: [],
    readyVotes: [],
    pausedFor: null,       // socketId of disconnected player
    pauseTimeout: null,
  };
}

// Returns { ok, lostLife, lowerCards }
function validatePlay(gameState, playerId, card) {
  const lowerCards = [];
  for (const p of gameState.players) {
    if (p.id === playerId) continue;
    for (const c of p.hand) {
      if (c < card) lowerCards.push({ playerId: p.id, playerName: p.name, card: c });
    }
  }
  return {
    ok: lowerCards.length === 0,
    lowerCards,
  };
}

// Apply a card play to game state. Returns event to broadcast.
function applyCardPlay(gameState, playerId, card) {
  const player = gameState.players.find(p => p.id === playerId);
  if (!player) return null;
  if (!player.hand.includes(card)) return null;

  // Remove card from hand
  player.hand = player.hand.filter(c => c !== card);
  gameState.playedCards.push({ playerId, playerName: player.name, card });

  const { ok, lowerCards } = validatePlay({ ...gameState, playedCards: gameState.playedCards }, playerId, card);

  if (!ok) {
    // Lose a life, discard all lower cards
    gameState.lives -= 1;
    for (const { playerId: pid, card: c } of lowerCards) {
      const p = gameState.players.find(x => x.id === pid);
      if (p) p.hand = p.hand.filter(x => x !== c);
      gameState.playedCards.push({ playerId: pid, playerName: p?.name, card: c, forced: true });
    }
    return { type: 'life_lost', lives: gameState.lives, lowerCards };
  }

  return { type: 'card_played', ok: true };
}

function checkLevelComplete(gameState) {
  return gameState.players.every(p => p.hand.length === 0);
}

function checkGameOver(gameState) {
  return gameState.lives <= 0;
}

function applyStarVote(gameState, playerId) {
  if (gameState.starVotes.includes(playerId)) return null;
  gameState.starVotes.push(playerId);

  const allVoted = gameState.players.every(p => gameState.starVotes.includes(p.id));
  if (!allVoted) return { type: 'star_vote_update', votes: gameState.starVotes.length, needed: gameState.players.length };

  if (gameState.stars <= 0) {
    gameState.starVotes = [];
    return { type: 'star_vote_failed', reason: 'no_stars' };
  }

  // Use the star — reveal and remove lowest card from each player
  const lowestCards = [];
  for (const p of gameState.players) {
    if (p.hand.length > 0) {
      const lowest = p.hand[0];
      lowestCards.push({ playerId: p.id, playerName: p.name, card: lowest });
      p.hand = p.hand.slice(1);
      gameState.playedCards.push({ playerId: p.id, playerName: p.name, card: lowest, star: true });
    }
  }
  gameState.stars -= 1;
  gameState.starVotes = [];
  return { type: 'star_used', lowestCards, starsLeft: gameState.stars };
}

function advanceLevel(gameState) {
  gameState.level += 1;
  gameState.playedCards = [];
  gameState.starVotes = [];
  gameState.readyVotes = [];

  // Bonus lives/stars at certain levels
  if ([3, 6, 9].includes(gameState.level)) gameState.lives = Math.min(gameState.lives + 1, 5);
  if ([5, 10].includes(gameState.level)) gameState.stars = Math.min(gameState.stars + 1, 3);

  dealCards(gameState.players, gameState.level);
  gameState.phase = 'playing';
}

function publicState(gameState) {
  return {
    roomCode: gameState.roomCode,
    hostId: gameState.hostId,
    phase: gameState.phase,
    level: gameState.level,
    startLevel: gameState.startLevel,
    lives: gameState.lives,
    stars: gameState.stars,
    players: gameState.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      connected: p.connected !== false,
    })),
    playedCards: gameState.playedCards,
    starVotes: gameState.starVotes,
    readyVotes: gameState.readyVotes,
    pausedFor: gameState.pausedFor,
  };
}

module.exports = { createGame, dealCards, applyCardPlay, applyStarVote, advanceLevel, checkLevelComplete, checkGameOver, publicState, livesForLevel, starsForLevel };
