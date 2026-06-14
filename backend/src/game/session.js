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

const players             = {};
const spectators          = {};
const lastState           = {};
const gameSessions        = new Map();
const playerSession       = new Map();
const playerCharSelected  = new Map();
const hitstopBySession    = {};
const spectatorsBySession = new Map();

let nextClientId     = 1;
let nextSessionId    = 1;
let frameId          = 0;
let confirmedStageId = -1;

const tournamentRoom = {
    players:      [],
    started:      false,
    tournamentId: null,
    maxPlayers:   8,
};

// tournamentId -> { totalPlayers, eliminationLog: [{clientId, dbUserId, stocks, placement}], finalized: bool }
const tournamentBrackets = new Map();

// Set of session.id values that have ALREADY had resolveMatchWinner / stat
// writes applied — guards against any double-invocation path (disconnect +
// tick + grace-expiry all racing on the same session).
const resolvedSessions = new Set();

const _lobbyJoinOrder = [];

function addToLobbyQueue(cid) {
    if (!_lobbyJoinOrder.includes(cid)) _lobbyJoinOrder.push(cid);
}

function removeFromLobbyQueue(cid) {
    const idx = _lobbyJoinOrder.indexOf(cid);
    if (idx !== -1) _lobbyJoinOrder.splice(idx, 1);
}

function getLobbyQueue() {
    return _lobbyJoinOrder.filter(cid =>
        players[cid]?.dbUserId != null &&
        !playerSession.has(cid) &&
        players[cid]?._seekingMatch !== false
    );
}

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
    const sessionSnapshots = new Map();

    for (const p of Object.values(players)) {
        if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

        const sid = playerSession.get(p.id);
        if (!sid) {
            const solo = {};
            solo[p.id] = buildPlayerSnapshot(p);
            p.ws.send(JSON.stringify({ type: 'state', frameId: ++frameId, players: solo }));
            continue;
        }

        if (!sessionSnapshots.has(sid)) {
            const session  = gameSessions.get(sid);
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

function buildCharSelectAck(selectorCharId, selectorClientId, stageId, session = null) {
    let playerIds;
    if (session) {
        playerIds = [...session.playerIds];
    } else {
        const lobbyIds = Object.keys(players).map(Number).filter(id => !playerSession.has(id));
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
        if (playerSession.has(cid)) continue;
        const ack = buildCharSelectAck(charId, cid, 0);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
    }
}

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

const COUNTDOWN_MS = 3000; // must match client-side countdown duration

function createSession(mode, playerIds, extra = {}) {
    const id      = String(nextSessionId++);
    const session = {
        id, mode,
        playerIds:    new Set(playerIds),
        eliminated:   new Set(),
        // Snapshot of dbUserId per clientId at session-creation time. This is
        // the AUTHORITATIVE identity record for stat writes — never re-read
        // players[cid].dbUserId later, since the player object may be deleted
        // (disconnect) before async stat-writing code runs.
        dbUserIds:    {},
        tournamentId: null, round: null, matchDbId: null,
        startedAt:    new Date(), finished: false,
        loserDbId: null, loserStocks: 0, playerFlags: {},
        // Ordered log of eliminations for this session: { clientId, dbUserId, stocks, placement }
        eliminationLog: [],
        // false during pre-match SSS/countdown, true once the fight is live.
        // Drives leave-permission gating (Issue: leave allowed before pairing
        // and during the live fight, BLOCKED during SSS/countdown).
        fightStarted: false,
        ...extra,
    };
    for (const cid of playerIds) {
        session.playerFlags[cid] = { tookDamage: false, completedCombo: false };
        const p = players[cid];
        session.dbUserIds[cid] = p?.dbUserId ?? null;
        playerSession.set(cid, id);
        removeFromLobbyQueue(cid);
        if (p) p.stocks = 3;
    }

    if (extra.tournamentId) {
        tournamentBrackets.set(extra.tournamentId, {
            totalPlayers: playerIds.length,
            eliminationLog: [],
            finalized: false,
            sessionId: id,
        });
    }

    gameSessions.set(id, session);
    return session;
}

// Called whenever a reconnect causes a player's clientId to change while they
// were already part of an active session (e.g. tournamentRoom remapped
// clientId for a dbUserId, or a 'join'/'rejoin' path assigns a fresh slot).
// Keeps session.playerIds, playerSession, session.dbUserIds, session.eliminated,
// session.playerFlags, session.pendingEliminations, and session.pendingWinner
// all referencing the SAME (new) clientId, so broadcasts/elimination checks
// never operate on a stale id.
function remapSessionPlayerId(oldCid, newCid) {
    if (oldCid === newCid) return;
    const sid = playerSession.get(oldCid);
    if (!sid) return;
    const session = gameSessions.get(sid);
    if (!session) { playerSession.delete(oldCid); return; }

    if (session.playerIds.has(oldCid)) {
        session.playerIds.delete(oldCid);
        session.playerIds.add(newCid);
    }
    if (session.eliminated.has(oldCid)) {
        session.eliminated.delete(oldCid);
        session.eliminated.add(newCid);
    }
    if (session.playerFlags?.[oldCid]) {
        session.playerFlags[newCid] = session.playerFlags[oldCid];
        delete session.playerFlags[oldCid];
    }
    if (session.dbUserIds && oldCid in session.dbUserIds) {
        session.dbUserIds[newCid] = session.dbUserIds[oldCid];
        delete session.dbUserIds[oldCid];
    }
    if (session.pendingEliminations?.[oldCid]) {
        session.pendingEliminations[newCid] = session.pendingEliminations[oldCid];
        delete session.pendingEliminations[oldCid];
    }
    if (session.pendingWinner) {
        if (session.pendingWinner.winnerId === oldCid) session.pendingWinner.winnerId = newCid;
        if (session.pendingWinner.loserId  === oldCid) session.pendingWinner.loserId  = newCid;
    }
    if (session.cpuIds) session.cpuIds = session.cpuIds.map(c => c === oldCid ? newCid : c);
    if (session.cpuId === oldCid) session.cpuId = newCid;
    if (session.humanId === oldCid) session.humanId = newCid;
    if (session.cpusEliminated?.has(oldCid)) {
        session.cpusEliminated.delete(oldCid);
        session.cpusEliminated.add(newCid);
    }

    playerSession.delete(oldCid);
    playerSession.set(newCid, sid);

    const sb = spectatorsBySession.get(sid);
    if (sb?.has(oldCid)) { sb.delete(oldCid); sb.add(newCid); }

    if (hitstopBySession[sid]) {
        const hs = hitstopBySession[sid];
        if (hs.attackerId === oldCid) hs.attackerId = newCid;
        if (hs.targetId   === oldCid) hs.targetId   = newCid;
    }

    console.log(`[REMAP] session ${sid}: clientId ${oldCid} -> ${newCid}`);
}

// Marks the session as "fight live" after the client-side countdown elapses.
// Used to gate leave permissions: leave is BLOCKED from pairing until this
// fires (SSS + countdown), then ALLOWED again once the fight is running.
function armFightStartTimer(session) {
    setTimeout(() => {
        if (!gameSessions.has(session.id)) return;
        if (session.finished) return;
        session.fightStarted = true;
        console.log(`[GAME] session ${session.id}: fight live — leave now permitted (forfeit)`);
    }, COUNTDOWN_MS);
}

function startBrawl(clientIds) {
    const session = createSession('brawl', clientIds);
    broadcastToSession(session, { type: 'match_start', mode: 'brawl', sessionId: session.id, players: clientIds, countdown: true });
    armFightStartTimer(session);
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
    for (const cid of [clientId1, clientId2]) {
        const p = players[cid];
        if (p?._pendingStageId !== undefined) {
            session.stageId = p._pendingStageId;
            delete p._pendingStageId;
            break;
        }
    }
    broadcastToSession(session, { type: 'match_start', mode: '1v1', sessionId: session.id, countdown: true, stageId: session.stageId ?? -1, players: [clientId1, clientId2] });
    armFightStartTimer(session);
    console.log(`[GAME] 1v1 started: session ${session.id} — ${clientId1} vs ${clientId2}`);
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

    let stageId = Math.floor(Math.random() * STAGE_LAYOUTS.length);
    for (const cid of clientIds) {
        const p = players[cid];
        if (p?._pendingStageId !== undefined) { stageId = p._pendingStageId; delete p._pendingStageId; break; }
    }

    const session = createSession('tournament', clientIds, { tournamentId, round: 1, stageId });

    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== null) continue;
        setSpectatorSession(spec, session.id);
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: session.id, activeSessions: listActiveSessions() }));
            sendStateToSpectator(spec);
        }
    }

    broadcastToSession(session, {
        type: 'match_start', mode: 'tournament', sessionId: session.id,
        tournamentId, round: 1, countdown: true, stageId,
        players: clientIds,
    });
    armFightStartTimer(session);

    console.log(`[TOURNAMENT] Survivor started: id=${tournamentId} session=${session.id} — ${clientIds.length} players stage=${stageId}`);
    return tournamentId;
}

function startTraining(humanClientId, cpuCharIds = ['eld'], stageId = 0) {
    const cpus = cpuCharIds.map(charId => {
        const cpu = createCpuPlayer(charId, CHARACTER_DEFS, GROUND_Y);
        players[cpu.id] = cpu;
        playerCharSelected.set(cpu.id, charId);
        return cpu;
    });
    const allIds = [humanClientId, ...cpus.map(c => c.id)];
    const cpuIds = cpus.map(c => c.id);
    const session = createSession('training', allIds, {
        isCpuSession: true,
        cpuIds,
        cpuId: cpuIds[0],
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

function tryAutoMatch() {
    const busyIds = new Set();
    for (const sess of gameSessions.values()) {
        if (!sess.finished) {
            for (const cid of sess.playerIds) busyIds.add(cid);
        }
    }

    const eligible = getLobbyQueue().filter(cid =>
        !players[cid]?.isCpu &&
        !busyIds.has(cid) &&
        playerCharSelected.has(cid)
    );

    for (let i = 0; i + 1 < eligible.length; i += 2) {
        const hostId  = eligible[i];
        const guestId = eligible[i + 1];
        const host    = players[hostId];
        if (!host || host._pendingStageId === undefined) {
            console.log(`[AUTO-MATCH] waiting for host ${hostId} to select stage`);
            continue;
        }
        const sess = startDuel(hostId, guestId);
        console.log(`[AUTO-MATCH] 1v1 session ${sess.id} — ${hostId} vs ${guestId}`);
    }
}

function recordTournamentElimination(session, eliminatedId, eliminatedDbId, stocks) {
    if (session.mode !== 'tournament' || !session.tournamentId) return;
    const bracket = tournamentBrackets.get(session.tournamentId);
    if (!bracket) return;
    // Avoid duplicate entries for the same clientId (defensive against
    // double-invocation from disconnect + grace-expiry races).
    if (bracket.eliminationLog.some(e => e.clientId === eliminatedId)) return;
    const remainingAfter = session.playerIds.size - session.eliminated.size; // includes this elimination already applied by caller
    const placement = remainingAfter + 1; // e.g. if 0 remain after this, placement = 1 is reserved for champion (handled separately)
    bracket.eliminationLog.push({
        clientId:  eliminatedId,
        dbUserId:  eliminatedDbId ?? session.dbUserIds?.[eliminatedId] ?? null,
        stocks:    stocks ?? 0,
        placement, // higher number = eliminated earlier; champion gets placement 1 in finalizeTournament
    });
}

function handleElimination(loser) {
    const sessionId = playerSession.get(loser.id);
    const session   = sessionId ? gameSessions.get(sessionId) : null;

    if (session?.pendingWinner?.winnerId === loser.id) {
        session.pendingWinner.resolveAfterRespawn = true;
        return true;
    }

    if (session) {
        session.eliminated.add(loser.id);
        session.loserDbId   = loser.dbUserId ?? session.dbUserIds?.[loser.id] ?? null;
        session.loserStocks = loser.stocks ?? 0;
        if (!session.eliminationLog) session.eliminationLog = [];
        session.eliminationLog.push({
            clientId: loser.id,
            dbUserId: session.loserDbId,
            stocks:   session.loserStocks,
        });
        recordTournamentElimination(session, loser.id, session.loserDbId, session.loserStocks);
    }

    const { id: eliminatedId, dbUserId: eliminatedDbId, ws: eliminatedWs } = loser;

    const remaining = session
        ? [...session.playerIds].filter(id => !session.eliminated.has(id))
        : [];

    if (session?.mode === 'training') {
        const isHuman = eliminatedId === session.humanId;
        if (!isHuman) {
            if (session.cpusEliminated) session.cpusEliminated.add(eliminatedId);
            delete players[eliminatedId];
            playerSession.delete(eliminatedId);
            broadcastState();
            broadcastToSession(session, { type: 'player_eliminated', clientId: eliminatedId });
            const allCpusDead = session.cpuIds.every(cid => session.cpusEliminated.has(cid));
            if (allCpusDead) {
                session.pendingWinner = { winnerId: session.humanId, loserId: eliminatedId };
            }
        } else {
            const survivingCpu = session.cpuIds.find(cid => !session.cpusEliminated.has(cid)) ?? session.cpuId;
            broadcastState();
            broadcastToSession(session, { type: 'player_eliminated', clientId: eliminatedId });
            session.pendingWinner = { winnerId: survivingCpu, loserId: eliminatedId };
        }
        return;
    }

    const isDecidingElimination = remaining.length === 1 &&
        (session?.mode === '1v1' || session?.mode === 'tournament');

    if (!isDecidingElimination) {
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

    broadcastState();
    broadcastToAll({ type: 'player_eliminated', clientId: eliminatedId });

    if (!session) return;

    if (remaining.length === 1) {
        session.pendingWinner = { winnerId: remaining[0], loserId: eliminatedId };
    } else if (remaining.length === 0) {
        session.finished = true;
        broadcastToSession(session, { type: 'match_end', winner: null, loser: eliminatedId, matchId: null, mode: session.mode });
        setTimeout(() => {
            broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
            cleanupSession(session, null);
        }, 6000);
    }
}

function cleanupSession(session, winnerClientId) {
    const CLEANUP_LINGER_MS = 8000;
    session.finished  = true;
    session.cleanedAt = Date.now();
    setTimeout(() => {
        gameSessions.delete(session.id);
        resolvedSessions.delete(session.id);
    }, CLEANUP_LINGER_MS);
    delete hitstopBySession[session.id];

    // Only reset the global confirmedStageId fallback once NO sessions are
    // pending creation. Checking "every session is finished" is racy if a new
    // session is created in the same tick this one finishes (the new session
    // would already be in gameSessions as !finished, so the check below is
    // safe) — but to be extra defensive, only reset if this was genuinely the
    // last session AND no session.stageId is pending use.
    const stillActive = [...gameSessions.values()].some(s => !s.finished);
    if (!stillActive) confirmedStageId = -1;

    // If this was a tournament session that's being cleaned up WITHOUT having
    // gone through finalizeTournament (e.g. solo-guard ejection before any
    // fight), drop its bracket bookkeeping so it doesn't leak.
    if (session.tournamentId && tournamentBrackets.has(session.tournamentId)) {
        const bracket = tournamentBrackets.get(session.tournamentId);
        if (!bracket.finalized) tournamentBrackets.delete(session.tournamentId);
    }

    for (const cid of session.playerIds) {
        playerSession.delete(cid);
        playerCharSelected.delete(cid);
        const p = players[cid];
        if (p) {
            delete p._pendingStageId;
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
        const spec = spectators[cid];
        if (spec?.eliminated) {
            if (spec.dbRowId) {
                db.query('UPDATE spectators SET left_at = NOW() WHERE id = $1', [spec.dbRowId])
                  .catch(() => {});
            }
            delete spectators[cid];
            if (lastState[cid]?.timer) clearTimeout(lastState[cid].timer);
            delete lastState[cid];
        }
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
    // Idempotency guard: never run DB stat-writing logic twice for the same
    // session, no matter which code path (tick pendingWinner loop, disconnect
    // handler, grace-expiry handler) triggers resolution.
    if (resolvedSessions.has(session.id)) {
        console.log(`[GAME] resolveMatchWinner: session ${session.id} already resolved — skipping duplicate call`);
        return;
    }
    resolvedSessions.add(session.id);
    session.finished = true;

    // Resolve identity from the session-time snapshot FIRST — players[] may
    // already be deleted (disconnect-during-resolution race).
    const winner       = players[winnerClientId];
    const winnerDbId   = winner?.dbUserId ?? session.dbUserIds?.[winnerClientId] ?? null;
    const loserDbId    = session.loserDbId ?? session.dbUserIds?.[loserClientId] ?? null;
    const loserStocks  = session.loserStocks ?? 0;
    const winnerStocks = winner?.stocks ?? 0;

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
             winnerStocks, loserStocks,
             session.mode === 'tournament' ? 'tournament' : 'brawler']
        );
        session.matchDbId = rows[0].id;

        if (session.tournamentId && session.matchDbId) {
            await db.query(
                `INSERT INTO tournament_matches (tournament_id, match_id, round) VALUES ($1, $2, $3)`,
                [session.tournamentId, session.matchDbId, session.round]
            );
        }

        // Idempotency at the DB level too: claim this match_id before writing
        // stats. If the row already exists (shouldn't happen given the
        // resolvedSessions guard, but defends against process restarts mid-flow)
        // skip the stat increments entirely.
        const { rowCount: claimed } = await db.query(
            `INSERT INTO match_stat_writes (match_id) VALUES ($1) ON CONFLICT DO NOTHING`,
            [session.matchDbId]
        );

        if (claimed > 0) {
            try {
                await updateStatsAfterMatch({ db, winnerDbId, loserDbId, matchId: session.matchDbId, startedAt: session.startedAt, winnerStocks, loserStocks });
            } catch (err) {
                console.error('[GAME] updateStatsAfterMatch error (continuing with inline stats):', err.message);
            }

            // For 1v1 / brawl / training-vs-human matches, this is the single
            // source of truth for win/loss. For tournament mode, per-match
            // win/loss for the FINAL match is also written here; all OTHER
            // tournament eliminations are scored in finalizeTournament.
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
        } else {
            console.log(`[GAME] match ${session.matchDbId} stats already written — skipping`);
        }

        if (winnerDbId) {
            try {
                await checkAndGrantAchievements(winnerDbId, {
                    tookDamage:      session.playerFlags?.[winnerClientId]?.tookDamage    ?? true,
                    completedCombo:  session.playerFlags?.[winnerClientId]?.completedCombo ?? false,
                    durationS:       Math.round((Date.now() - session.startedAt) / 1000),
                    winnerStocks,
                    isTournamentWin: session.mode === 'tournament',
                });
            } catch (err) {
                console.error('[GAME] checkAndGrantAchievements error:', err.message);
            }
        }
    } catch (err) {
        console.error('[GAME] DB write error on match resolve:', err.message);
    }

    broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: session.matchDbId, mode: session.mode });

    if (session.mode === 'tournament') {
        // Record the LAST elimination (the runner-up, since the champion
        // never appears in eliminationLog) before finalizing, then finalize
        // using the session snapshot — never re-read players[] for identity.
        recordTournamentElimination(session, loserClientId, loserDbId, loserStocks);
        await finalizeTournament(session.tournamentId, winnerClientId, winnerDbId, winnerStocks);
    }

    setTimeout(() => {
        broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
        cleanupSession(session, winnerClientId);
    }, 6000);
}

// championDbId / championStocks are passed explicitly from resolveMatchWinner's
// session-time snapshot — NEVER re-read players[championClientId] here, since
// the champion's connection may have closed before this async function runs.
async function finalizeTournament(tournamentId, championClientId, championDbId = null, championStocks = 0) {
    const bracket = tournamentBrackets.get(tournamentId);

    if (bracket?.finalized) {
        console.log(`[TOURNAMENT] ${tournamentId} already finalized — skipping duplicate finalize`);
        return;
    }
    if (bracket) bracket.finalized = true;

    if (championDbId == null) {
        championDbId = players[championClientId]?.dbUserId ?? null;
    }

    try {
        await db.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [tournamentId]);

        if (championDbId) {
            await db.query(
                `UPDATE user_stats SET xp = xp + 500,
                 level = GREATEST(level, FLOOR(SQRT((xp + 500) / 50))::int), updated_at = NOW()
                 WHERE user_id = $1`,
                [championDbId]
            );
        }

        // ── Score every eliminated participant ──────────────────────────
        // bracket.eliminationLog contains one entry per eliminated player
        // (including the runner-up, appended just before this call). The
        // champion is NOT in eliminationLog. Every entry here gets a
        // tournament loss + a placement row; the champion gets a placement
        // row with placement=1 and a tournament win.
        const log = bracket?.eliminationLog ?? [];
        const totalPlayers = bracket?.totalPlayers ?? (log.length + 1);

        // Placement: champion = 1. Eliminations are pushed in elimination
        // order (earliest-eliminated first), so the LAST entry in log is the
        // runner-up (placement 2), and so on backwards.
        for (let i = 0; i < log.length; i++) {
            const entry = log[i];
            entry.placement = totalPlayers - i; // last entry -> placement 2, first entry -> placement totalPlayers
        }

        // Insert placement rows (idempotent via UNIQUE(tournament_id, user_id))
        const placementRows = [
            { dbUserId: championDbId, clientId: championClientId, placement: 1, stocks: championStocks },
            ...log.map(e => ({ dbUserId: e.dbUserId, clientId: e.clientId, placement: e.placement, stocks: e.stocks })),
        ];

        for (const row of placementRows) {
            try {
                const { rowCount } = await db.query(
                    `INSERT INTO tournament_placements
                        (tournament_id, user_id, client_id, placement, stocks_left, counted)
                     VALUES ($1, $2, $3, $4, $5, FALSE)
                     ON CONFLICT (tournament_id, user_id) DO NOTHING
                     RETURNING id`,
                    [tournamentId, row.dbUserId ?? null, row.clientId, row.placement, row.stocks ?? 0]
                );
                if (rowCount === 0) continue; // already recorded — skip stat write below

                if (row.dbUserId) {
                    if (row.placement === 1) {
                        // Champion's win was already counted via resolveMatchWinner's
                        // final-match winner update — do NOT double count here.
                    } else {
                        // Every eliminated participant gets a tournament loss.
                        await db.query(
                            `UPDATE user_stats SET losses = losses + 1, updated_at = NOW() WHERE user_id = $1`,
                            [row.dbUserId]
                        );
                    }
                    await db.query(
                        `UPDATE tournament_placements SET counted = TRUE WHERE tournament_id = $1 AND user_id = $2`,
                        [tournamentId, row.dbUserId]
                    );
                }
            } catch (err) {
                console.error(`[TOURNAMENT] placement write error for dbUserId=${row.dbUserId}:`, err.message);
            }
        }

        tournamentBrackets.delete(tournamentId);
    } catch (err) {
        console.error('[TOURNAMENT] finalize error:', err.message);
    }
    broadcastToAll({ type: 'tournament_end', tournamentId, champion: championClientId, championDbId: championDbId ?? null });
    console.log(`[TOURNAMENT] ${tournamentId} finished — champion: ${championClientId} (dbUserId=${championDbId})`);

    // Deterministically reset the shared waiting room now that this
    // tournament is done — no more polling/_scheduleRoomReset needed.
    if (tournamentRoom.tournamentId === tournamentId) {
        resetTournamentRoom(true);
    }
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

    for (const session of gameSessions.values()) {
        if (session.finished) continue;

        const sessPlayers = [...session.playerIds]
            .map(cid => players[cid])
            .filter(p => p && !p.respawning && !_frozenIds.has(p.id));

        const hs = hitstopBySession[session.id];
        const hitstopActive = hs && hs.framesLeft > 0;

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

        if (hitstopActive) {
            hitstopBySession[session.id].framesLeft--;
            if (hitstopBySession[session.id].framesLeft <= 0) delete hitstopBySession[session.id];
            continue;
        }

        const platforms = session.stageId !== undefined
            ? (STAGE_LAYOUTS[session.stageId] ?? STAGE_LAYOUTS[0])
            : (STAGE_LAYOUTS[confirmedStageId] ?? STAGE_LAYOUTS[0]);

        tickPhysics(sessPlayers);
        tickCollisions(sessPlayers);
        tickPlatforms(sessPlayers, handleElimination, platforms);
    }

    const aliveForAnim = Object.values(players).filter(p => !_frozenIds.has(p.id));
    tickAnimations(aliveForAnim);

    for (const [sessId, hs] of Object.entries(hitstopBySession)) {
        if (!hs || hs.framesLeft <= 0) delete hitstopBySession[sessId];
    }

    for (const session of gameSessions.values()) {
        if (!session.isCpuSession || session.finished) continue;
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
        if (session.finished) continue;
        if (session.mode !== '1v1' && session.mode !== 'tournament') continue;
        if (session.pendingWinner) continue;
        if (session._soloGuardFired) continue;
        if (Date.now() - session.startedAt.getTime() < 3000) continue;

        const humanIds = [...session.playerIds].filter(cid => !players[cid]?.isCpu);
        const connected = humanIds.filter(cid => {
            const p = players[cid];
            return p?.ws?.readyState === WebSocket.OPEN;
        });

        if (session.mode === '1v1') {
            if (connected.length === 1 && humanIds.length === 2) {
                session._soloGuardFired = true;
                const winnerId = connected[0];
                const loserId  = humanIds.find(id => id !== winnerId);
                console.log(`[SOLO-GUARD] 1v1 session ${session.id}: only ${winnerId} connected — resolving forfeit (loser ${loserId})`);
                if (loserId !== undefined) {
                    delete players[loserId];
                    playerSession.delete(loserId);
                    playerCharSelected.delete(loserId);
                }
                session.eliminated.add(loserId);
                resolveMatchWinner(session, winnerId, loserId);
            } else if (connected.length === 0 && humanIds.length >= 1) {
                session._soloGuardFired = true;
                session.finished = true;
                console.log(`[SOLO-GUARD] 1v1 session ${session.id}: no connected players — abandoning`);
                broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
                cleanupSession(session, null);
            }
        } else if (session.mode === 'tournament') {
            const hasPendingGrace = session.pendingEliminations &&
                Object.keys(session.pendingEliminations).length > 0;
            if (connected.length <= 1 && session.eliminated.size === 0 && !hasPendingGrace) {
                session._soloGuardFired = true;
                session.finished = true;
                console.log(`[SOLO-GUARD] tournament session ${session.id}: only ${connected.length} connected before any fight — ejecting to lobby`);
                broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
                const _ejSession = session;
                setTimeout(() => {
                    for (const cid of _ejSession.playerIds) {
                        const p = players[cid];
                        if (p?.ws?.readyState === WebSocket.OPEN) {
                            p.ws.send(JSON.stringify({ type: 'lobby_ejected', reason: 'solo_guard' }));
                        }
                    }
                }, 200);
                cleanupSession(session, null);
                // No finalizeTournament will run for an aborted tournament —
                // reset the shared room synchronously here instead.
                if (session.tournamentId) {
                    tournamentBrackets.delete(session.tournamentId);
                    if (tournamentRoom.tournamentId === session.tournamentId) {
                        resetTournamentRoom(true);
                    }
                }
            }
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

function disconnectPlayer(dbUserId) {
    if (!dbUserId) return;
    console.log(`[AUTH] disconnectPlayer called for dbUserId=${dbUserId}, players=${Object.keys(players).length}, spectators=${Object.keys(spectators).length}`);
    for (const [cid, p] of Object.entries(players)) {
        if (p.dbUserId === dbUserId) {
            console.log(`[AUTH] closing WS for player clientId=${cid} readyState=${p.ws?.readyState}`);
            if (p.ws?.readyState === 1) p.ws.close(1000, 'logout');
            return;
        }
    }
    for (const [cid, spec] of Object.entries(spectators)) {
        if (spec.dbUserId === dbUserId) {
            console.log(`[AUTH] closing WS for spectator clientId=${cid} readyState=${spec.ws?.readyState}`);
            if (spec.ws?.readyState === 1) spec.ws.close(1000, 'logout');
            return;
        }
    }
    console.log(`[AUTH] disconnectPlayer: no active WS found for dbUserId=${dbUserId}`);
}

// Deterministic, synchronous tournament-room reset. Replaces the previous
// polling _scheduleRoomReset. Called directly from finalizeTournament (normal
// completion) and from cleanupSession-adjacent code paths (abnormal
// termination — solo guard, all-disconnect).
//
// notify: when true, push a fresh tournament_room_update to anyone still
// referenced in tournamentRoom.players (best-effort — most will already have
// reloaded by this point).
function resetTournamentRoom(notify = true) {
    const stalePlayers = tournamentRoom.players;
    tournamentRoom.players      = [];
    tournamentRoom.started      = false;
    tournamentRoom.tournamentId = null;

    if (notify && stalePlayers.length) {
        const roomMsg = JSON.stringify({
            type: 'tournament_room_update',
            players: [], started: false, tournamentId: null,
            maxPlayers: tournamentRoom.maxPlayers,
            reset: true,
        });
        for (const entry of stalePlayers) {
            for (const [, pl] of Object.entries(players)) {
                if (pl.dbUserId === entry.dbUserId && pl.ws?.readyState === WebSocket.OPEN) {
                    pl.ws.send(roomMsg);
                    break;
                }
            }
        }
    }
    console.log('[TOURNAMENT-ROOM] reset (deterministic)');
}

// Tournament-mode disconnect/leave grace expiry. Mirrors the generic
// resolveGraceExpiry in handler.js but additionally records the elimination
// in the tournament bracket so loss-counting in finalizeTournament stays
// correct even when a player never reconnects.
function resolveTournamentGraceExpiry(session, clientId, fallbackDbId) {
    if (!session.pendingEliminations) session.pendingEliminations = {};
    delete session.pendingEliminations[clientId];

    if (session.finished) return;

    const p2          = players[clientId];
    const leavingDbId = p2?.dbUserId ?? session.dbUserIds?.[clientId] ?? fallbackDbId ?? null;
    const leavingStocks = p2?.stocks ?? 0;

    delete players[clientId];
    playerSession.delete(clientId);
    playerCharSelected.delete(clientId);
    delete lastState[clientId];

    session.eliminated.add(clientId);
    session.loserDbId   = leavingDbId;
    session.loserStocks = leavingStocks;
    if (!session.eliminationLog) session.eliminationLog = [];
    session.eliminationLog.push({ clientId, dbUserId: leavingDbId, stocks: leavingStocks });
    recordTournamentElimination(session, clientId, leavingDbId, leavingStocks);

    broadcastToSession(session, { type: 'player_eliminated', clientId });
    broadcastToSession(session, { type: 'leave_grace_expired', clientId });

    const remaining = [...session.playerIds].filter(id => !session.eliminated.has(id));
    if (remaining.length === 1) {
        resolveMatchWinner(session, remaining[0], clientId);
    } else if (remaining.length === 0) {
        session.finished = true;
        broadcastToSession(session, { type: 'match_end', winner: null, loser: clientId, matchId: null, mode: session.mode });
        setTimeout(() => {
            broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
            cleanupSession(session, null);
        }, 6000);
    }
    broadcastState();
}

module.exports = {
    players, spectators, spectatorsBySession, lastState,
    gameSessions, playerSession, playerCharSelected, hitstopBySession,
    tournamentBrackets, resolvedSessions,
    get nextClientId()      { return nextClientId; },
    set nextClientId(v)     { nextClientId = v; },
    get nextSessionId()     { return nextSessionId; },
    get confirmedStageId()  { return confirmedStageId; },
    broadcastToSession, broadcastToAll, broadcastState, sendStateToSpectator,
    listActiveSessions, buildCharSelectAck, sendAllCharSelectsTo,
    createPlayer, startBrawl, startDuel, startTournament, startTraining,
    tryAutoMatch, handleElimination, resolveMatchWinner, cleanupSession, getLastWatchedSession,
    addToLobbyQueue, removeFromLobbyQueue, getLobbyQueue,
    disconnectPlayer,
    remapSessionPlayerId, resetTournamentRoom, resolveTournamentGraceExpiry,
    tournamentRoom,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS, CHARACTER_ASSETS,
};
