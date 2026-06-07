'use strict';

const WebSocket = require('ws');
const db        = require('../db');

const {
    TICK_RATE, TICK_DT, GHOST_TTL,
    GROUND_Y, MOVE_SPEED, DASH_SPEED, ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    MAX_PLAYERS, STAGE_LAYOUTS, CHARACTER_DEFS, CHARACTER_ASSETS, CHAR_IDS,
} = require('./constants');

const {
    tickBlock, tickDash, tickMovement, tickAttack,
    tickPhysics, tickCollisions, tickPlatforms, tickAnimations,
} = require('./physics');

let checkAndGrantAchievements = async () => {};
let updateStatsAfterMatch     = async () => {};
try { ({ checkAndGrantAchievements } = require('./achievements')); } catch { }
try { ({ updateStatsAfterMatch }     = require('./stats'));        } catch { }

const { createCpuPlayer, tickCpu } = require('./ai');

// ─── State ────────────────────────────────────────────────────────────────────

const players             = {};
const spectators          = {};
const lastState           = {};
const gameSessions        = new Map();
const playerSession       = new Map();
const playerCharSelected  = new Map();
const hitstopBySession    = {};
const spectatorsBySession = new Map();

let nextClientId  = 1;
let nextSessionId = 1;
let frameId       = 0;
let tournamentWaitingWinners = {};
let confirmedStageId = -1;
let DEBUG_AUTO_MATCH = true;

// ─── Lobby join order ─────────────────────────────────────────────────────────
// Tracks the order in which authenticated players entered the lobby (pressed
// "Find match" / "Join").  This determines host assignment and pair formation
// independently of clientId, which reflects connection order and can differ
// when a player reconnects after a match.
//
// Lifecycle:
//   • addToLobbyQueue(clientId)    — called when a player enters the lobby pool
//   • removeFromLobbyQueue(cid)    — called on disconnect / session start
//   • getLobbyQueue()              — returns a copy of the ordered array
//
// IMPORTANT: pairs are formed in queue order (slot 0+1, 2+3 …).  The FIRST
// player in each pair is the host (chooses stage).  This is independent of
// clientId ordering.
const _lobbyJoinOrder = [];   // ordered array of clientIds

function addToLobbyQueue(cid) {
    if (!_lobbyJoinOrder.includes(cid)) _lobbyJoinOrder.push(cid);
}
function removeFromLobbyQueue(cid) {
    const idx = _lobbyJoinOrder.indexOf(cid);
    if (idx !== -1) _lobbyJoinOrder.splice(idx, 1);
}
function getLobbyQueue() {
    // Return only players that are still alive (not yet matched) and authenticated.
    return _lobbyJoinOrder.filter(cid => players[cid]?.dbUserId != null && !playerSession.has(cid));
}

// ─── Spectator helpers ────────────────────────────────────────────────────────

function setSpectatorSession(spec, newSessionId) {
    const old = spec.watchingSession;
    if (old === newSessionId) return;
    if (old != null) {
        const s = spectatorsBySession.get(old);
        if (s) { s.delete(spec.id); if (s.size === 0) spectatorsBySession.delete(old); }
    }
    spec.watchingSession = newSessionId;
    if (newSessionId != null) {
        if (!spectatorsBySession.has(newSessionId)) spectatorsBySession.set(newSessionId, new Set());
        spectatorsBySession.get(newSessionId).add(spec.id);
    }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcastToSession(session, msg) {
    const raw = JSON.stringify(msg);
    for (const cid of session.playerIds) {
        const p = players[cid];
        if (p?.ws?.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession === session.id && spec.ws.readyState === WebSocket.OPEN)
            spec.ws.send(raw);
    }
}

function broadcastToAll(msg) {
    const raw = JSON.stringify(msg);
    for (const p    of Object.values(players))    if (p.ws?.readyState    === WebSocket.OPEN) p.ws.send(raw);
    for (const spec of Object.values(spectators)) if (spec.ws?.readyState === WebSocket.OPEN) spec.ws.send(raw);
}

// ─── Player snapshot ──────────────────────────────────────────────────────────

function buildPlayerSnapshot(p) {
    return {
        id:           p.id,
        charId:       p.charId ?? null,
        username:     p.username ?? null,
        x:            Math.round(p.x * 1000) / 1000,
        y:            Math.round(p.y * 1000) / 1000,
        rotation:     p.facing === -1 ? Math.PI : 0,
        animation:    p.animation,
        onGround:     p.onGround,
        stocks:       p.stocks,
        respawning:   p.respawning,
        crouching:    p.crouching,
        hitId:        p.hitId,
        jumpId:       p.jumpId,
        voltage:      Math.round(p.voltage * 10) / 10,
        voltageMaxed: p.voltageMaxed,
        blocking:     p.blocking,
    };
}

function broadcastState() {
    // Build a per-session snapshot so each player only receives state for their own session.
    const sessionSnapshots = new Map(); // sessionId -> JSON string

    for (const p of Object.values(players)) {
        if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

        const sid = playerSession.get(p.id);
        if (!sid) {
            // Lobby player (no session yet) — send only themselves.
            const solo = {};
            solo[p.id] = buildPlayerSnapshot(p);
            p.ws.send(JSON.stringify({ type: 'state', frameId: ++frameId, players: solo }));
            continue;
        }

        if (!sessionSnapshots.has(sid)) {
            const session = gameSessions.get(sid);
            const snapshot = {};
            if (session) {
                for (const cid of session.playerIds) {
                    const sp = players[cid];
                    if (sp) snapshot[cid] = buildPlayerSnapshot(sp);
                }
            }
            sessionSnapshots.set(sid, JSON.stringify({ type: 'state', frameId: ++frameId, players: snapshot }));
        }

        p.ws.send(sessionSnapshots.get(sid));
    }
}

function sendStateToSpectator(spec) {
    if (!spec.ws || spec.ws.readyState !== WebSocket.OPEN) return;

    let sessionIds = null;
    if (spec.watchingSession) {
        const sess = gameSessions.get(spec.watchingSession);
        if (sess) {
            sessionIds = new Set(sess.playerIds);
        } else {
            setSpectatorSession(spec, null);
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: null }));
        }
    }

    const snapshot = {};
    for (const [id, p] of Object.entries(players)) {
        if (sessionIds && !sessionIds.has(Number(id))) continue;
        snapshot[id] = buildPlayerSnapshot(p);
    }
    spec.ws.send(JSON.stringify({ type: 'state', frameId: ++frameId, players: snapshot }));
}

// ─── Spectator stream (15 Hz) ─────────────────────────────────────────────────

let spectatorFrameId = 0;

function tickSpectators() {
    const specList = Object.values(spectators);
    if (specList.length === 0) return;

    const cache = new Map();

    for (const spec of specList) {
        if (!spec.ws || spec.ws.readyState !== WebSocket.OPEN) continue;
        const sid = spec.watchingSession;
        let raw;

        if (sid) {
            if (!cache.has(sid)) {
                const sess = gameSessions.get(sid);
                if (!sess) {
                    cache.set(sid, null);
                    setSpectatorSession(spec, null);
                    if (spec.ws.readyState === WebSocket.OPEN)
                        spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: null, activeSessions: listActiveSessions() }));
                } else {
                    const snapshot = {};
                    for (const cid of sess.playerIds) {
                        const p = players[cid] ?? players[String(cid)];
                        if (p) snapshot[cid] = buildPlayerSnapshot(p);
                    }
                    cache.set(sid, JSON.stringify({ type: 'state_spectator', frameId: ++spectatorFrameId, players: snapshot }));
                }
            }
            raw = cache.get(sid);
        }

        if (!raw) {
            if (!cache.has('__global__')) {
                const snapshot = {};
                for (const [id, p] of Object.entries(players)) snapshot[id] = buildPlayerSnapshot(p);
                const payload = Object.keys(snapshot).length > 0
                    ? JSON.stringify({ type: 'state_spectator', frameId: ++spectatorFrameId, players: snapshot })
                    : null;
                cache.set('__global__', payload);
            }
            raw = cache.get('__global__');
        }

        if (raw) spec.ws.send(raw);
    }
}

setInterval(tickSpectators, 1000 / 15);

// ─── Session listings ─────────────────────────────────────────────────────────

function listActiveSessions() {
    return [...gameSessions.entries()]
        .filter(([, sess]) => !sess.finished)
        .map(([id, sess]) => ({
        sessionId:    id,
        mode:         sess.mode,
        tournamentId: sess.tournamentId ?? null,
        round:        sess.round ?? null,
        playerIds:    [...sess.playerIds],
        startedAt:    sess.startedAt,
        spectators:   spectatorsBySession.get(id)?.size ?? 0,
    }));
}

// ─── Character selection ──────────────────────────────────────────────────────

// session (optional): if provided, only players within that session are included
// in the ack payload. Without it, all lobby players are included (legacy path).
function buildCharSelectAck(selectorCharId, selectorClientId, stageId, session = null) {
    // Scoped player list: session peers, or lobby players (no session), or all as fallback.
    let playerIds;
    if (session) {
        playerIds = [...session.playerIds];
    } else {
        // Lobby: only players not yet assigned to any session.
        const lobbyIds = Object.keys(players).map(Number).filter(id => !playerSession.has(id));
        // Always include the selector even if they just got a session assigned.
        if (!lobbyIds.includes(selectorClientId)) lobbyIds.push(selectorClientId);
        playerIds = lobbyIds;
    }

    const usedChars = new Set([selectorCharId]);
    const playersOut = {};

    for (let i = 0; i < Math.min(playerIds.length, 8); i++) {
        const cid    = playerIds[i];
        const charId = cid === selectorClientId ? selectorCharId : (playerCharSelected.get(cid) ?? null);
        if (charId) usedChars.add(charId);
        playersOut[i] = { clientId: cid, charId };
    }

    let altIdx = 0;
    for (let i = 0; i < Math.min(playerIds.length, 8); i++) {
        if (!playersOut[i].charId) {
            while (altIdx < CHAR_IDS.length && usedChars.has(CHAR_IDS[altIdx])) altIdx++;
            const charId = CHAR_IDS[altIdx % CHAR_IDS.length];
            usedChars.add(charId);
            altIdx++;
            playersOut[i].charId = charId;
        }
        const { clientId: cid, charId } = playersOut[i];
        const a = CHARACTER_ASSETS[charId] ?? CHARACTER_ASSETS.eld;
        playersOut[i] = { clientId: cid, charId, texCfg: a.texCfg, texSets: a.texSets, animBase: a.animBase };
    }

    return { type: 'char_select_ack', charId: selectorCharId, selectorClient: selectorClientId, stageId, players: playersOut };
}

function sendAllCharSelectsTo(ws) {
    for (const [cid, charId] of playerCharSelected.entries()) {
        const ack = buildCharSelectAck(charId, cid, 0);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
    }
}

// ─── Player factory ───────────────────────────────────────────────────────────

function createPlayer(id, saved, ws) {
    const onGround = saved ? (saved.onGround ?? true) : true;
    const side     = Object.keys(players).length % 2 === 0 ? -1 : 1;
    const initX    = saved ? saved.x : side * (1.5 + Math.random() * 1.5);

    return {
        id,
        dbUserId:        null,
        x:               initX,
        y:               saved ? saved.y : GROUND_Y,
        vx: 0, vy: 0, kbx: 0, kby: 0,
        onGround,
        jumpsLeft:       onGround ? 2 : 1,
        facing:          initX >= 0 ? -1 : 1,
        dashing: false, dashTimer: 0, dashDir: 0,
        dashCooldown: 0, dashEndWindow: 0,
        attacking: false, attackTimer: 0, attackCooldown: 0,
        comboStep: 0, comboWindow: 0, _isDashAttack: false,
        hitId: 0, hitTargets: new Set(), jumpId: 0,
        crouching: false, animation: 'idle', animTimer: 0,
        stocks:          3,
        prevSessionId:   saved?.sessionId ?? null,
        respawning: false, respawnTimer: 0,
        voltage: 0, voltageMaxed: false,
        blocking: false, blockLockout: 0, blockHoldTicks: 0,
        prevY: 0, charId: null,
        moveSpeed: MOVE_SPEED, dashSpeed: DASH_SPEED,
        attackKnockback: 14.0, attackRange: ATTACK_RANGE,
        input: { moveX: 0, jump: false, attack: false, dash: false, dashDir: 0, crouch: false, block: false, dashAttack: false },
        ws,
    };
}

// ─── Session factory ──────────────────────────────────────────────────────────

function createSession(mode, playerIds, extra = {}) {
    const id      = String(nextSessionId++);
    const session = {
        id, mode,
        playerIds:    new Set(playerIds),
        eliminated:   new Set(),
        tournamentId: null, round: null, matchDbId: null,
        startedAt:    new Date(), finished: false,
        loserDbId: null, loserStocks: 0, playerFlags: {},
        ...extra,
    };
    for (const cid of playerIds) {
        session.playerFlags[cid] = { tookDamage: false, completedCombo: false };
        playerSession.set(cid, id);
        removeFromLobbyQueue(cid);   // leaving lobby — no longer waiting for a pair
        const p = players[cid];
        if (p) p.stocks = 3;
    }
    gameSessions.set(id, session);
    return session;
}

// ─── Match modes ──────────────────────────────────────────────────────────────

function startBrawl(clientIds) {
    const session = createSession('brawl', clientIds);
    broadcastToSession(session, { type: 'match_start', mode: 'brawl', sessionId: session.id, players: clientIds, countdown: true });
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== null) continue;
        setSpectatorSession(spec, session.id);
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: session.id, activeSessions: listActiveSessions() }));
            sendStateToSpectator(spec);
        }
    }
    console.log(`[GAME] Brawl started: session ${session.id} — ${clientIds.length} players`);
    return session;
}

function startDuel(clientId1, clientId2) {
    const session = createSession('1v1', [clientId1, clientId2]);
    // The host (lowest clientId) may have selected a stage before the session existed.
    // Transfer _pendingStageId from either player to the session so spectators get the right stage.
    for (const cid of [clientId1, clientId2]) {
        const p = players[cid];
        if (p?._pendingStageId !== undefined) {
            session.stageId = p._pendingStageId;
            delete p._pendingStageId;
            break;
        }
    }
    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: session.id, countdown: true, stageId: session.stageId ?? -1 });
    console.log(`[GAME] 1v1 started: session ${session.id} — ${clientId1} vs ${clientId2}`);
    return session;
}

async function startTournamentMatch(clientId1, clientId2, tournamentId, round) {
    const session = createSession('tournament', [clientId1, clientId2], { tournamentId, round });
    broadcastToSession(session, { type: 'match_start', mode: 'tournament', sessionId: session.id, tournamentId, round });
    return session;
}

async function startTournament(clientIds, creatorDbId) {
    if (clientIds.length < 2) throw new Error('Need at least 2 players for a tournament');

    const { rows } = await db.query(
        `INSERT INTO tournaments (name, status, created_by) VALUES ($1, 'ongoing', $2) RETURNING id`,
        [`Tournament #${nextSessionId}`, creatorDbId]
    );
    const tournamentId = rows[0].id;

    const dbUserIds = clientIds.map(cid => players[cid]?.dbUserId).filter(Boolean);
    if (dbUserIds.length) {
        const placeholders = dbUserIds.map((_, i) => `($1, $${i + 2})`).join(', ');
        await db.query(
            `INSERT INTO tournament_players (tournament_id, user_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
            [tournamentId, ...dbUserIds]
        );
    }

    const shuffled = [...clientIds].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
        const sess = await startTournamentMatch(shuffled[i], shuffled[i + 1], tournamentId, 1);
        console.log(`[TOURNAMENT] Round 1: ${shuffled[i]} vs ${shuffled[i + 1]} → session ${sess.id}`);
    }
    return tournamentId;
}

function startTraining(humanClientId, cpuCharIds = ['eld'], stageId = 0) {
    // cpuCharIds: array of 1-4 character ids e.g. ['eld', 'hil']
    const cpus = cpuCharIds.map(charId => {
        const cpu = createCpuPlayer(charId, CHARACTER_DEFS, GROUND_Y);
        players[cpu.id] = cpu;
        playerCharSelected.set(cpu.id, charId);
        return cpu;
    });
    const allIds = [humanClientId, ...cpus.map(c => c.id)];
    const cpuIds = cpus.map(c => c.id);
    // Use mode 'training' so handleElimination doesn't apply 1v1 win logic.
    // Victory is resolved manually: human eliminated = loss, all CPUs eliminated = win.
    const session = createSession('training', allIds, {
        isCpuSession: true,
        cpuIds,
        cpuId: cpuIds[0],   // legacy single-cpu field kept for compatibility
        stageId,
        humanId: humanClientId,
        cpusEliminated: new Set(),
    });
    for (const cpu of cpus) cpu.stocks = 3;
    broadcastToSession(session, {
        type: 'match_start', mode: 'training', sessionId: session.id,
        countdown: true, cpuIds, cpuId: cpuIds[0], stageId,
    });
    console.log(`[GAME] Training started: session ${session.id} — player ${humanClientId} vs CPUs [${cpuCharIds.join(', ')}] stage=${stageId}`);
    return session;
}

// ─── Auto-match ───────────────────────────────────────────────────────────────

function tryAutoMatch() {
    if (!DEBUG_AUTO_MATCH) return;

    // Build a set of all clientIds that are already inside an active (non-finished) session.
    // This guards against playerSession being momentarily out of sync (e.g. right after
    // cleanupSession deletes the mapping but before the player object is fully reset).
    const busyIds = new Set();
    for (const sess of gameSessions.values()) {
        if (!sess.finished) {
            for (const cid of sess.playerIds) busyIds.add(cid);
        }
    }

    // Only authenticated human players who have selected a character and are not already in a session.
    // Players with dbUserId === null are browsers connected without a login and must be ignored.
    // Use getLobbyQueue() (join-time order) so host assignment is stable regardless of clientId.
    const eligible = getLobbyQueue().filter(cid =>
        !players[cid]?.isCpu &&
        !busyIds.has(cid) &&
        playerCharSelected.has(cid)
    );

    // Pair them into closed 1v1 duels two at a time (queue order: slot 0+1, 2+3 …).
    // The host (even slot) must have confirmed a stage (_pendingStageId set) before
    // their pair can be matched.  If the host hasn't chosen yet the pair waits.
    for (let i = 0; i + 1 < eligible.length; i += 2) {
        const hostId  = eligible[i];
        const guestId = eligible[i + 1];
        const host    = players[hostId];
        if (!host || host._pendingStageId === undefined) {
            // Host hasn't selected stage yet — skip this pair but keep scanning
            // in case a later pair (different host) is ready.
            console.log(`[AUTO-MATCH] waiting for host ${hostId} to select stage`);
            continue;
        }
        const sess = startDuel(hostId, guestId);
        console.log(`[AUTO-MATCH] 1v1 session ${sess.id} — ${hostId} vs ${guestId}`);
    }
}

// ─── Elimination & match resolution ──────────────────────────────────────────

function handleElimination(loser) {
    const sessionId = playerSession.get(loser.id);
    const session   = sessionId ? gameSessions.get(sessionId) : null;

    if (session?.pendingWinner?.winnerId === loser.id) {
        session.pendingWinner.resolveAfterRespawn = true;
        return true;
    }

    if (session) {
        session.eliminated.add(loser.id);
        session.loserDbId   = loser.dbUserId ?? null;
        session.loserStocks = loser.stocks ?? 0;
    }

    const { id: eliminatedId, dbUserId: eliminatedDbId, ws: eliminatedWs } = loser;

    // In 1v1 and tournament modes, check if this elimination decides the match
    // (only 1 player remains = winner found).  In that case do NOT convert the
    // loser into a spectator: resolveMatchWinner will broadcast victory/match_end/
    // match_finished to everyone still in the session (including the loser), and
    // cleanupSession will restore both players to the lobby pool.
    // For brawl (multiple players) we still convert mid-game eliminations to
    // spectators so they can watch the rest of the match.
    const remaining = session
        ? [...session.playerIds].filter(id => !session.eliminated.has(id))
        : [];

    // ── Training mode: special elimination logic ─────────────────────────────
    if (session?.mode === 'training') {
        const isHuman = eliminatedId === session.humanId;
        if (!isHuman) {
            // A CPU was eliminated — track it but keep fighting
            if (session.cpusEliminated) session.cpusEliminated.add(eliminatedId);
            delete players[eliminatedId];
            playerSession.delete(eliminatedId);
            broadcastState();
            broadcastToAll({ type: 'player_eliminated', clientId: eliminatedId });
            // Check if ALL cpus are now eliminated → human wins
            const allCpusDead = session.cpuIds.every(cid => session.cpusEliminated.has(cid));
            if (allCpusDead) {
                session.pendingWinner = { winnerId: session.humanId, loserId: eliminatedId };
            }
        } else {
            // Human eliminated → loss. Pick any surviving CPU as nominal winner.
            const survivingCpu = session.cpuIds.find(cid => !session.cpusEliminated.has(cid)) ?? session.cpuId;
            broadcastState();
            broadcastToAll({ type: 'player_eliminated', clientId: eliminatedId });
            session.pendingWinner = { winnerId: survivingCpu, loserId: eliminatedId };
        }
        return;
    }

    const isDecidingElimination = remaining.length === 1 &&
        (session?.mode === '1v1' || session?.mode === 'tournament');

    if (!isDecidingElimination) {
        // Brawl mid-game elimination (or no session): move player to spectator pool.
        delete players[eliminatedId];
        playerSession.delete(eliminatedId);

        if (eliminatedWs?.readyState === WebSocket.OPEN) {
            const newSpec = {
                id: eliminatedId, dbUserId: eliminatedDbId, ws: eliminatedWs,
                watchingSession: null, mode: 'overflow', dbRowId: null, eliminated: true,
            };
            spectators[eliminatedId] = newSpec;
            setSpectatorSession(newSpec, sessionId ?? null);
            eliminatedWs.send(JSON.stringify({
                type: 'spectator_mode', clientId: eliminatedId, mode: 'overflow',
                watchingSession: sessionId ?? null, activeSessions: listActiveSessions(), eliminated: true,
            }));
        }
    }
    // For a deciding 1v1/tournament elimination the player object stays intact
    // in `players` so resolveMatchWinner/cleanupSession can handle cleanup and
    // the client receives the normal victory → match_finished → lobby flow.

    broadcastState();
    broadcastToAll({ type: 'player_eliminated', clientId: eliminatedId });

    if (!session) return;

    if (remaining.length === 1) {
        session.pendingWinner = { winnerId: remaining[0], loserId: eliminatedId };
    } else if (remaining.length === 0) {
        session.finished = true;
        broadcastToSession(session, { type: 'match_end', winner: null, loser: eliminatedId, matchId: null, mode: session.mode });
        setTimeout(() => gameSessions.delete(session.id), 6000);
    }
}

function cleanupSession(session, winnerClientId) {
    // Mark the exact time the session was cleaned up. The entry stays in gameSessions
    // for CLEANUP_LINGER_MS so that a rejoin arriving within that window can detect
    // "battle is over" and send match_finished instead of re-entering a zombie session.
    const CLEANUP_LINGER_MS = 8000;
    session.finished  = true;
    session.cleanedAt = Date.now();
    setTimeout(() => gameSessions.delete(session.id), CLEANUP_LINGER_MS);
    delete hitstopBySession[session.id];

    // Reset stage only if no other active sessions remain
    if ([...gameSessions.values()].every(s => s.finished)) confirmedStageId = -1;

    // Reset and return BOTH winner and loser to the lobby pool.
    // In 1v1/tournament the loser was kept in `players` (not converted to spectator)
    // so they receive the normal match_finished flow and then the client rejoins lobby.
    // We must clean up their session mapping here so tryAutoMatch doesn't see them
    // as still in-game.
    for (const cid of session.playerIds) {
        const p = players[cid];
        if (!p) continue;
        playerSession.delete(cid);
        playerCharSelected.delete(cid);
        p.stocks        = 3;
        p.voltage       = 0;
        p.voltageMaxed  = false;
        p.attacking     = false;
        p.dashing       = false;
        p.blocking      = false;
        p.crouching     = false;
        p.hitTargets    = new Set();
        p.kbx = 0; p.kby = 0; p.vx = 0; p.vy = 0;
        p.animation     = 'idle';
        p.animTimer     = 0;
    }

    const nextSession = [...gameSessions.values()].find(s => !s.finished)?.id ?? null;
    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== session.id) continue;
        setSpectatorSession(spec, nextSession);
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: nextSession, activeSessions: listActiveSessions() }));
            if (nextSession) sendStateToSpectator(spec);
        }
    }
    tryAutoMatch();
}

async function resolveMatchWinner(session, winnerClientId, loserClientId) {
    session.finished = true;

    const winner     = players[winnerClientId];
    const winnerDbId = winner?.dbUserId ?? null;
    const loserDbId  = session.loserDbId ?? null;
    const loserStocks = session.loserStocks ?? 0;

    broadcastToSession(session, { type: 'victory', winner: winnerClientId, loser: loserClientId, reloadRequired: true });

    if (session.isCpuSession) {
        broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: null, mode: session.mode });
        setTimeout(() => {
            broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
            cleanupSession(session, winnerClientId);
        }, 6000);
        return;
    }

    try {
        const { rows } = await db.query(
            `INSERT INTO matches (player1_id, player2_id, winner_id, score1, score2, game_type)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [winnerDbId, loserDbId, winnerDbId,
             winner?.stocks ?? 0, loserStocks,
             session.mode === 'tournament' ? 'tournament' : 'brawler']
        );
        session.matchDbId = rows[0].id;

        if (session.tournamentId && session.matchDbId) {
            await db.query(
                `INSERT INTO tournament_matches (tournament_id, match_id, round) VALUES ($1, $2, $3)`,
                [session.tournamentId, session.matchDbId, session.round]
            );
        }

        await updateStatsAfterMatch({ db, winnerDbId, loserDbId, matchId: session.matchDbId, startedAt: session.startedAt, winnerStocks: winner?.stocks ?? 0, loserStocks });

        await Promise.all([
            winnerDbId ? db.query(
                `UPDATE user_stats SET wins = wins + 1, xp = xp + 100,
                 level = GREATEST(level, FLOOR(SQRT((xp + 100) / 50.0))::int), updated_at = NOW()
                 WHERE user_id = $1`,
                [winnerDbId]
            ) : Promise.resolve(),
            loserDbId ? db.query(
                `UPDATE user_stats SET losses = losses + 1, updated_at = NOW() WHERE user_id = $1`,
                [loserDbId]
            ) : Promise.resolve(),
        ]);

        if (winnerDbId) {
            await checkAndGrantAchievements(winnerDbId, {
                tookDamage:      session.playerFlags?.[winnerClientId]?.tookDamage    ?? true,
                completedCombo:  session.playerFlags?.[winnerClientId]?.completedCombo ?? false,
                durationS:       Math.round((Date.now() - session.startedAt) / 1000),
                winnerStocks:    winner?.stocks ?? 0,
                isTournamentWin: session.mode === 'tournament',
            });
        }
    } catch (err) {
        console.error('[GAME] DB write error on match resolve:', err.message);
    }

    broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: session.matchDbId, mode: session.mode });

    if (session.mode === 'tournament') advanceTournament(session.tournamentId, winnerClientId);

    setTimeout(() => {
        broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
        cleanupSession(session, winnerClientId);
    }, 6000);
}

async function advanceTournament(tournamentId, newWinnerId) {
    if (!tournamentWaitingWinners[tournamentId]) tournamentWaitingWinners[tournamentId] = [];
    tournamentWaitingWinners[tournamentId].push(newWinnerId);
    const waiting = tournamentWaitingWinners[tournamentId];

    if (waiting.length < 2) {
        broadcastToAll({ type: 'tournament_waiting', tournamentId, waitingCount: waiting.length });
        return;
    }

    const { rows } = await db.query(
        `SELECT MAX(round) AS max_round FROM tournament_matches WHERE tournament_id = $1`,
        [tournamentId]
    );
    const nextRound = (rows[0].max_round ?? 0) + 1;

    while (waiting.length >= 2) {
        const [a, b] = waiting.splice(0, 2);
        const sess = await startTournamentMatch(a, b, tournamentId, nextRound);
        console.log(`[TOURNAMENT] Round ${nextRound}: ${a} vs ${b} → session ${sess.id}`);
    }

    if (waiting.length === 1) {
        await finalizeTournament(tournamentId, waiting.splice(0, 1)[0]);
    }
}

async function finalizeTournament(tournamentId, championClientId) {
    const champion = players[championClientId];
    try {
        await db.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [tournamentId]);
        if (champion?.dbUserId) {
            await db.query(
                `UPDATE user_stats SET xp = xp + 500,
                 level = GREATEST(level, FLOOR(SQRT((xp + 500) / 50))::int), updated_at = NOW()
                 WHERE user_id = $1`,
                [champion.dbUserId]
            );
        }
    } catch (err) {
        console.error('[TOURNAMENT] finalize error:', err.message);
    }
    broadcastToAll({ type: 'tournament_end', tournamentId, champion: championClientId, championDbId: champion?.dbUserId ?? null });
    delete tournamentWaitingWinners[tournamentId];
    console.log(`[TOURNAMENT] ${tournamentId} finished — champion: ${championClientId}`);
}

async function getLastWatchedSession(dbUserId) {
    if (!dbUserId) return null;
    try {
        const { rows } = await db.query(
            `SELECT session_id FROM spectators WHERE user_id = $1 AND session_id <> 'lobby'
             ORDER BY joined_at DESC LIMIT 1`,
            [dbUserId]
        );
        return rows[0]?.session_id ?? null;
    } catch (err) {
        console.error('[SPECTATOR] restore session error:', err.message);
        return null;
    }
}

// ─── Respawn ──────────────────────────────────────────────────────────────────

function tickRespawn() {
    for (const p of Object.values(players)) {
        if (!p.respawning) continue;
        p.respawnTimer -= TICK_DT;
        if (p.respawnTimer > 0) continue;
        Object.assign(p, {
            respawning: false,
            x:  (Math.random() - 0.5) * 4,
            y:  2.0,
            vx: 0, vy: 0, kbx: 0, kby: 0,
            jumpsLeft: 2, onGround: false,
            animation: 'idle', voltage: 0,
        });
    }
}

// ─── Hit context ──────────────────────────────────────────────────────────────

const hitCtx = {
    get players()          { return players; },
    get playerSession()    { return playerSession; },
    get gameSessions()     { return gameSessions; },
    get hitstopBySession() { return hitstopBySession; },
    broadcastToSession,
    WebSocket,
    onHit(attackerClientId, targetClientId) {
        const sess = gameSessions.get(playerSession.get(attackerClientId));
        if (sess?.playerFlags?.[targetClientId]) sess.playerFlags[targetClientId].tookDamage = true;
    },
    onCombo3(attackerClientId) {
        const sess = gameSessions.get(playerSession.get(attackerClientId));
        if (sess?.playerFlags?.[attackerClientId]) sess.playerFlags[attackerClientId].completedCombo = true;
    },
};

// ─── Game tick (60 Hz) ────────────────────────────────────────────────────────

const _frozenIds        = new Set();
const _hitstopFrozenIds = new Set();

function tick() {
    _frozenIds.clear();
    for (const [cid, sid] of playerSession.entries()) {
        if (gameSessions.get(sid)?.finished) _frozenIds.add(cid);
    }

    const _pendingWinnerIds = new Set();
    for (const session of gameSessions.values()) {
        if (session.pendingWinner) _pendingWinnerIds.add(session.pendingWinner.winnerId);
    }

    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    tickRespawn();

    // ── Per-session physics: players from different sessions must never interact ──
    for (const session of gameSessions.values()) {
        if (session.finished) continue;

        // Build the set of players alive in this session this tick.
        const sessPlayers = [...session.playerIds]
            .map(cid => players[cid])
            .filter(p => p && !p.respawning && !_frozenIds.has(p.id));

        const hs = hitstopBySession[session.id];
        const hitstopActive = hs && hs.framesLeft > 0;

        // Build the session-scoped player map once (attack targets must stay within session).
        const sessionPlayersMap = {};
        for (const sp of sessPlayers) sessionPlayersMap[sp.id] = sp;

        for (const p of sessPlayers) {
            if (_pendingWinnerIds.has(p.id)) {
                p.input.moveX = 0; p.input.jump = false; p.input.attack = false;
                p.input.dash  = false; p.input.dashAttack = false; p.input.block = false;
            }
            const { moveX, jump, attack, dash, dashDir, crouch, block, dashAttack } = p.input;
            p.input.jump = p.input.attack = p.input.dash = p.input.dashAttack = false;
            tickBlock(p, moveX, attack, dash, dashAttack, block, crouch);
            tickDash(p, dash, dashDir, moveX, block, crouch);
            tickMovement(p, moveX, jump, crouch);
            tickAttack(p, attack, dashAttack, crouch, sessionPlayersMap, hitCtx);
        }

        // Hitstop freeze for this session
        if (hitstopActive) {
            hitstopBySession[session.id].framesLeft--;
            if (hitstopBySession[session.id].framesLeft <= 0) delete hitstopBySession[session.id];
            // Skip physics/collision for frozen session this frame
            continue;
        }

        const platforms = session.stageId !== undefined
            ? (STAGE_LAYOUTS[session.stageId] ?? STAGE_LAYOUTS[0])
            : (STAGE_LAYOUTS[confirmedStageId] ?? STAGE_LAYOUTS[0]);

        tickPhysics(sessPlayers);
        tickCollisions(sessPlayers);
        tickPlatforms(sessPlayers, handleElimination, platforms);
    }

    // Animations run for all non-frozen players regardless of session
    const aliveForAnim = Object.values(players).filter(p => !_frozenIds.has(p.id));
    tickAnimations(aliveForAnim);

    // Clean up any remaining zero-frame hitstop entries
    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    for (const session of gameSessions.values()) {
        if (!session.isCpuSession || session.finished) continue;
        // Support both single cpuId (legacy) and multi-cpu cpuIds array (training)
        const cpuIdList = session.cpuIds ?? [session.cpuId];
        const humanTarget = [...session.playerIds]
            .filter(id => !cpuIdList.includes(id) && players[id] && !players[id].respawning)
            .map(id => players[id])[0] ?? null;
        for (const cid of cpuIdList) {
            const cpu = players[cid];
            if (cpu) tickCpu(cpu, humanTarget);
        }
    }

    for (const session of gameSessions.values()) {
        if (!session.pendingWinner) continue;
        const { winnerId, loserId, resolveAfterRespawn } = session.pendingWinner;
        const winner = players[winnerId];
        if (!winner) {
            session.pendingWinner = null;
            resolveMatchWinner(session, winnerId, loserId);
        } else if (winner.onGround) {
            if (resolveAfterRespawn && winner.respawning) continue;
            Object.assign(winner, { animation: winner.isCpu ? 'victory' : 'idle', animTimer: 0, attacking: false, dashing: false, blocking: false, crouching: false });
            session.pendingWinner = null;
            resolveMatchWinner(session, winnerId, loserId);
        }
    }

    broadcastState();
}

setInterval(tick, 1000 / TICK_RATE);

// ─── Exports ──────────────────────────────────────────────────────────────────

// ─── Force-disconnect a user by dbUserId (called on logout) ──────────────────

function disconnectPlayer(dbUserId) {
    if (!dbUserId) return;
    console.log(`[AUTH] disconnectPlayer called for dbUserId=${dbUserId}, players=${Object.keys(players).length}, spectators=${Object.keys(spectators).length}`);
    // Find in players
    for (const [cid, p] of Object.entries(players)) {
        if (p.dbUserId === dbUserId) {
            console.log(`[AUTH] closing WS for player clientId=${cid} readyState=${p.ws?.readyState}`);
            if (p.ws?.readyState === 1 /* OPEN */) p.ws.close(1000, 'logout');
            return;
        }
    }
    // Find in spectators
    for (const [cid, spec] of Object.entries(spectators)) {
        if (spec.dbUserId === dbUserId) {
            console.log(`[AUTH] closing WS for spectator clientId=${cid} readyState=${spec.ws?.readyState}`);
            if (spec.ws?.readyState === 1) spec.ws.close(1000, 'logout');
            return;
        }
    }
    console.log(`[AUTH] disconnectPlayer: no active WS found for dbUserId=${dbUserId}`);
}

module.exports = {
    players, spectators, spectatorsBySession, lastState,
    gameSessions, playerSession, playerCharSelected, hitstopBySession,
    get nextClientId()      { return nextClientId; },
    set nextClientId(v)     { nextClientId = v; },
    get nextSessionId()     { return nextSessionId; },
    get confirmedStageId()  { return confirmedStageId; },
    set confirmedStageId(v) { confirmedStageId = v; },
    broadcastToSession, broadcastToAll, broadcastState, sendStateToSpectator,
    listActiveSessions, buildCharSelectAck, sendAllCharSelectsTo,
    createPlayer, startBrawl, startDuel, startTournament, startTraining,
    tryAutoMatch, handleElimination, resolveMatchWinner, cleanupSession, getLastWatchedSession,
    addToLobbyQueue, removeFromLobbyQueue, getLobbyQueue,
    disconnectPlayer,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS, CHARACTER_ASSETS,
};