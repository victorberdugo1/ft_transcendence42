'use strict';

const WebSocket = require('ws');
const gameSession = require('../game/session');

function isWsOpen(ws) {
  return ws?.readyState === WebSocket.OPEN;
}

function touchPresence(map, userId, next) {
  if (!userId) return;
  const current = map.get(userId) ?? { state: 'offline', online: false, label: 'Offline' };
  map.set(userId, { ...current, ...next });
}

function resolvePlayerState(clientId, dbUserId) {
  const { playerSession, gameSessions, tournamentRoom } = gameSession;
  const sessionId = playerSession.get(clientId) ?? null;
  const session = sessionId ? gameSessions.get(sessionId) : null;

  if (sessionId && session) {
    return {
      state: 'in_match',
      online: true,
      label: session.mode === 'tournament' ? 'In tournament match' : 'In match',
      sessionId,
      mode: session.mode ?? null,
    };
  }

  if (tournamentRoom.players.some((entry) => entry.dbUserId === dbUserId)) {
    return {
      state: 'in_tournament_room',
      online: true,
      label: 'In tournament room',
      sessionId: null,
      mode: 'tournament',
    };
  }

  return {
    state: 'in_lobby',
    online: true,
    label: 'In lobby',
    sessionId: null,
    mode: null,
  };
}

function resolveSpectatorState(spectator) {
  if (spectator.watchingSession) {
    return {
      state: 'spectating',
      online: true,
      label: 'Spectating',
      sessionId: spectator.watchingSession,
      mode: spectator.mode ?? null,
    };
  }

  return {
    state: 'online',
    online: true,
    label: 'Online',
    sessionId: null,
    mode: spectator.mode ?? null,
  };
}

function getLivePresenceMap() {
  const map = new Map();
  const { players, spectators } = gameSession;

  for (const player of Object.values(players)) {
    if (!player?.dbUserId || !isWsOpen(player.ws)) continue;
    touchPresence(map, player.dbUserId, resolvePlayerState(player.id, player.dbUserId));
  }

  for (const spectator of Object.values(spectators)) {
    if (!spectator?.dbUserId || !isWsOpen(spectator.ws)) continue;
    touchPresence(map, spectator.dbUserId, resolveSpectatorState(spectator));
  }

  return map;
}

function getPresenceForUser(userId, fallbackOnline = false) {
  const live = getLivePresenceMap().get(userId);
  if (live) return live;
  if (fallbackOnline) {
    return {
      state: 'online',
      online: true,
      label: 'Online',
      sessionId: null,
      mode: null,
    };
  }
  return {
    state: 'offline',
    online: false,
    label: 'Offline',
    sessionId: null,
    mode: null,
  };
}

module.exports = {
  getLivePresenceMap,
  getPresenceForUser,
};
