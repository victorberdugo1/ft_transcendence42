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
const tournamentBrackets  = new Map();
const resolvedSessions    = new Set();

let matchPersistenceSchemaReady = null;
let nextClientId     = 1;
let nextSessionId    = 1;
let frameId          = 0;
let confirmedStageId = -1;

const XP_PER_WIN        = 100;
const TOURNAMENT_WIN_XP = 500;
const FIGHT_START_DELAY_MS            = 5000; // default (1v1)
const FIGHT_START_DELAY_TRAINING_MS   = 4000;
const FIGHT_START_DELAY_TOURNAMENT_MS = 8000;

function levelExprForXp(sqlExpr) {
    return `GREATEST(1, FLOOR((SQRT(1 + 8 * ((${sqlExpr})::numeric / ${XP_PER_WIN}.0)) - 1) / 2)::int)`;
}

const tournamentRoom = {
    players:      [],
    started:      false,
    tournamentId: null,
    maxPlayers:   8,
};

const _lobbyJoinOrder = [];

async function ensureMatchPersistenceSchema() {
    if (!matchPersistenceSchemaReady) {
        matchPersistenceSchemaReady = (async () => {
            await db.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS player1_char_id VARCHAR(20)`);
            await db.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS player2_char_id VARCHAR(20)`);
            await db.query(
                `CREATE TABLE IF NOT EXISTS match_stat_writes (
                    match_id   INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
                    written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`
            );
        })().catch(err => {
            matchPersistenceSchemaReady = null;
            throw err;
        });
    }
    return matchPersistenceSchemaReady;
}

function addToLobbyQueue(cid) {
    if (!_lobbyJoinOrder.includes(cid)) _lobbyJoinOrder.push(cid);
}

function removeFromLobbyQueue(cid) {
    const idx = _lobbyJoinOrder.indexOf(cid);
    if (idx !== -1) _lobbyJoinOrder.splice(idx, 1);
}

function getLobbyQueue() {
    const _tournamentDbIds = new Set(tournamentRoom.players.map(e => e.dbUserId));
    return _lobbyJoinOrder.filter(cid =>
        players[cid]?.dbUserId != null &&
        !playerSession.has(cid) &&
        players[cid]?._seekingMatch !== false &&
        !_tournamentDbIds.has(players[cid].dbUserId)
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

    const usedChars  = new Set([selectorCharId]);
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
        const a = CHARACTER_ASSETS[charId] ?? CHARACTER_ASSETS.def;
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

function createSession(mode, playerIds, extra = {}) {
    const id      = String(nextSessionId++);
    const session = {
        id, mode,
        playerIds:      new Set(playerIds),
        eliminated:     new Set(),
        dbUserIds:      {},
        charIds:        {},
        tournamentId:   null, round: null, matchDbId: null,
        startedAt:      new Date(), finished: false,
        loserDbId:      null, loserStocks: 0, playerFlags: {},
        eliminationLog: [],
        fightStarted:   false,
        ...extra,
    };
    for (const cid of playerIds) {
        session.playerFlags[cid] = { tookDamage: false, completedCombo: false };
        playerSession.set(cid, id);
        removeFromLobbyQueue(cid);
        const p = players[cid];
        session.dbUserIds[cid] = p?.dbUserId ?? null;
        session.charIds[cid]   = p?.charId ?? playerCharSelected.get(cid) ?? null;
        if (p) p.stocks = p._initialStocks ?? 3;
    }

    if (extra.tournamentId) {
        tournamentBrackets.set(extra.tournamentId, {
            totalPlayers:   playerIds.length,
            eliminationLog: [],
            finalized:      false,
            sessionId:      id,
        });
    }

    gameSessions.set(id, session);
    return session;
}

function armFightStartTimer(session, delayMs = FIGHT_START_DELAY_MS) {
    setTimeout(() => {
        if (session && !session.finished) session.fightStarted = true;
    }, delayMs);
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

    const botIds = clientIds.filter(cid => players[cid]?.isCpu);

    const session = createSession('tournament', clientIds, { tournamentId, round: 1, stageId,
        ...(botIds.length > 0 ? { botIds } : {}) });

    for (const spec of Object.values(spectators)) {
        if (spec.watchingSession !== null) continue;
        setSpectatorSession(spec, session.id);
        if (spec.ws.readyState === WebSocket.OPEN) {
            spec.ws.send(JSON.stringify({ type: 'spectator_session_changed', watchingSession: session.id, activeSessions: listActiveSessions() }));
            sendStateToSpectator(spec);
        }
    }

    // Bots are created directly inside the tournament session (fillTournamentBots →
    // createCpuPlayer), so they never go through the lobby char_select flow that
    // normally triggers buildCharSelectAck. Without this, clients never receive
    // texCfg/texSets/animBase for bot clientIds and their textures never load.
    // One char_select_ack scoped to this session covers every clientId in
    // session.playerIds (humans + bots) in its `players` map, so a single
    // emission is enough — no need to repeat it per bot.
    if (botIds.length > 0) {
        const firstBotId   = botIds[0];
        const firstBotChar = players[firstBotId]?.charId ?? playerCharSelected.get(firstBotId) ?? 'def';
        const botsAck = buildCharSelectAck(firstBotChar, firstBotId, stageId, session);
        broadcastToSession(session, botsAck);
    }

    broadcastToSession(session, {
        type: 'match_start', mode: 'tournament', sessionId: session.id,
        tournamentId, round: 1, countdown: true, stageId,
        players: clientIds,
    });
    armFightStartTimer(session, FIGHT_START_DELAY_TOURNAMENT_MS);

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
        cpuId:          cpuIds[0],
        stageId,
        humanId:        humanClientId,
        cpusEliminated: new Set(),
    });
    for (const cpu of cpus) cpu.stocks = 3;
    armFightStartTimer(session, FIGHT_START_DELAY_TRAINING_MS);
    broadcastToSession(session, {
        type: 'match_start', mode: 'training', sessionId: session.id,
        countdown: true, cpuIds, cpuId: cpuIds[0], stageId,
    });
    console.log(`[GAME] Training started: session ${session.id} — player ${humanClientId} vs CPUs [${cpuCharIds.join(', ')}] stage=${stageId}`);
    return session;
}

// ── fillTournamentBots ────────────────────────────────────────────────────────
// Pads `humanClientIds` up to MAX_TOURNAMENT_PLAYERS (8) with CPU bots that
// use the default character (eld) and default assets.  Returns the full array
// of clientIds (humans first, then bots) to be passed to startTournament.
const MAX_TOURNAMENT_PLAYERS = 8;

function fillTournamentBots(humanClientIds) {
    const botsNeeded = MAX_TOURNAMENT_PLAYERS - humanClientIds.length;
    if (botsNeeded <= 0) return humanClientIds;

    const botIds = [];
    for (let i = 0; i < botsNeeded; i++) {
        // Tournament bots always use the 'def' (Default) character —
        // neutral stats, default textures and animations, never selectable by humans.
        // They also only get 1 stock (vs. 3 for humans), so they're eliminated
        // on their first loss instead of surviving like a real opponent.
        const bot = createCpuPlayer('def', CHARACTER_DEFS, GROUND_Y);
        bot.stocks         = 1;
        bot._initialStocks = 1;
        players[bot.id]  = bot;
        playerCharSelected.set(bot.id, bot.charId);
        botIds.push(bot.id);
        console.log(`[TOURNAMENT-BOTS] created bot id=${bot.id} charId=${bot.charId} stocks=${bot.stocks}`);
    }

    return [...humanClientIds, ...botIds];
}

function tryAutoMatch() {
    const busyIds = new Set();
    for (const sess of gameSessions.values()) {
        if (!sess.finished) for (const cid of sess.playerIds) busyIds.add(cid);
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

function recordTournamentElimination(session, clientId, dbUserId, stocks) {
    if (!session || session.mode !== 'tournament') return;
    const bracket = tournamentBrackets.get(session.tournamentId);
    if (!bracket) return;
    if (!bracket.eliminationLog) bracket.eliminationLog = [];
    bracket.eliminationLog.push({ clientId, dbUserId, stocks });
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

        // Bots have no WebSocket — skip spectator promotion entirely.
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

    if ([...gameSessions.values()].every(s => s.finished)) confirmedStageId = -1;

    for (const cid of session.playerIds) {
        playerSession.delete(cid);
        playerCharSelected.delete(cid);
        const p = players[cid];
        if (p) {
            delete p._pendingStageId;
            p.stocks       = 3;
            p.voltage      = 0;
            p.voltageMaxed = false;
            p.attacking    = false;
            p.dashing      = false;
            p.blocking     = false;
            p.crouching    = false;
            p.hitTargets   = new Set();
            p.kbx = 0; p.kby = 0; p.vx = 0; p.vy = 0;
            p.animation    = 'idle';
            p.animTimer    = 0;
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
    if (resolvedSessions.has(session.id)) {
        console.log(`[GAME] resolveMatchWinner: session ${session.id} already resolved — skipping duplicate call`);
        return;
    }
    resolvedSessions.add(session.id);
    session.finished = true;

    const winner       = players[winnerClientId];
    const winnerDbId   = winner?.dbUserId ?? null;
    const winnerStocks = winner?.stocks ?? 0;
    const loserDbId    = session.loserDbId ?? null;
    const loserStocks  = session.loserStocks ?? 0;
    const winnerCharId = session.charIds?.[winnerClientId] ?? players[winnerClientId]?.charId ?? playerCharSelected.get(winnerClientId) ?? null;
    const loserCharId  = session.charIds?.[loserClientId]  ?? players[loserClientId]?.charId  ?? playerCharSelected.get(loserClientId)  ?? null;

    broadcastToSession(session, { type: 'victory', winner: winnerClientId, loser: loserClientId, reloadRequired: true });

    // isCpuSession = pure training match — skip DB writes and go straight to cleanup.
    // Bot-padded tournaments (botIds) are NOT isCpuSession and must go through the
    // full resolve path so finalizeTournament is called and humans see match_end.
    if (session.isCpuSession) {
        broadcastToSession(session, { type: 'match_end', winner: winnerClientId, loser: loserClientId, matchId: null, mode: session.mode });
        setTimeout(() => {
            broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
            cleanupSession(session, winnerClientId);
        }, 6000);
        return;
    }

    try {
        await ensureMatchPersistenceSchema();

        const { rows } = await db.query(
            `INSERT INTO matches (player1_id, player2_id, winner_id, score1, score2, game_type, player1_char_id, player2_char_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [winnerDbId, loserDbId, winnerDbId,
             winnerStocks, loserStocks,
             session.mode === 'tournament' ? 'tournament' : 'brawler',
             winnerCharId, loserCharId]
        );
        session.matchDbId = rows[0].id;

        if (session.tournamentId && session.matchDbId) {
            await db.query(
                `INSERT INTO tournament_matches (tournament_id, match_id, round) VALUES ($1, $2, $3)`,
                [session.tournamentId, session.matchDbId, session.round]
            );
        }

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

            await Promise.all([
                winnerDbId ? db.query(
                    `UPDATE user_stats SET wins = wins + 1, xp = xp + ${XP_PER_WIN},
                     level = ${levelExprForXp(`xp + ${XP_PER_WIN}`)}, updated_at = NOW()
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
        recordTournamentElimination(session, loserClientId, loserDbId, loserStocks);
        await finalizeTournament(session.tournamentId, winnerClientId, winnerDbId, winnerStocks);
    }

    setTimeout(() => {
        broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
        cleanupSession(session, winnerClientId);
    }, 6000);
}

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
                `UPDATE user_stats SET xp = xp + ${TOURNAMENT_WIN_XP},
                 level = ${levelExprForXp(`xp + ${TOURNAMENT_WIN_XP}`)}, updated_at = NOW()
                 WHERE user_id = $1`,
                [championDbId]
            );
        }

        const log          = bracket?.eliminationLog ?? [];
        const totalPlayers = bracket?.totalPlayers ?? (log.length + 1);

        for (let i = 0; i < log.length; i++) {
            log[i].placement = totalPlayers - i;
        }

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
                if (rowCount === 0) continue;

                if (row.dbUserId) {
                    if (row.placement !== 1) {
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

        const hs            = hitstopBySession[session.id];
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
        if (session.finished) continue;
        // Tick CPU players: training sessions (isCpuSession) AND tournament sessions
        // that were padded with bots (botIds present).
        const hasCpus = session.isCpuSession || (session.botIds && session.botIds.length > 0);
        if (!hasCpus) continue;
        // Bots must not move or attack during the countdown — wait for fightStarted,
        // exactly the same gate the physics tick already imposes on human inputs.
        if (!session.fightStarted) continue;
        const cpuIdList = session.cpuIds ?? session.botIds ?? [session.cpuId];
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

        const humanIds  = [...session.playerIds].filter(cid => !players[cid]?.isCpu);
        const connected = humanIds.filter(cid => players[cid]?.ws?.readyState === WebSocket.OPEN);

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
                if (session.tournamentId) {
                    tournamentBrackets.delete(session.tournamentId);
                    if (tournamentRoom.tournamentId === session.tournamentId) {
                        resetTournamentRoom(true);
                    }
                }
            }

            // All humans are gone (eliminated or disconnected). Previously this
            // declared the last surviving bot as tournament champion; now the
            // tournament simply ends with no winner and the session is closed,
            // regardless of how many bots are still alive.
            if (!session._soloGuardFired && !hasPendingGrace) {
                const remaining   = [...session.playerIds].filter(id => !session.eliminated.has(id));
                const humanAlive  = remaining.filter(id => !players[id]?.isCpu);
                if (humanAlive.length === 0) {
                    session._soloGuardFired = true;
                    session.finished = true;
                    console.log(`[SOLO-GUARD] tournament session ${session.id}: no humans left (${remaining.length} bot(s) remaining) — ending tournament with no winner`);
                    broadcastToSession(session, { type: 'match_end', winner: null, loser: null, matchId: null, mode: session.mode });
                    broadcastToAll({ type: 'tournament_end', tournamentId: session.tournamentId, champion: null, championDbId: null });
                    if (session.tournamentId) {
                        db.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [session.tournamentId])
                            .catch(err => console.error('[TOURNAMENT] no-winner finalize error:', err.message));
                        tournamentBrackets.delete(session.tournamentId);
                    }
                    setTimeout(() => {
                        broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
                        cleanupSession(session, null);
                    }, 200);
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

function disconnectPlayer(dbUserId, wsToEvict) {
    if (!dbUserId) return;
    console.log(`[AUTH] disconnectPlayer called for dbUserId=${dbUserId}, players=${Object.keys(players).length}, spectators=${Object.keys(spectators).length}`);
    // Margen de seguridad: no cerrar un WS que se conectó hace menos de 1 segundo.
    // Evita el race condition donde el endpoint HTTP de login llama disconnectPlayer
    // justo después de que un nuevo WS tomó el slot para una sesión de training.
    const EVICT_MIN_AGE_MS = 1000;
    const now = Date.now();
    for (const [cid, p] of Object.entries(players)) {
        if (p.dbUserId === dbUserId) {
            if (wsToEvict && p.ws !== wsToEvict) {
                console.log(`[AUTH] disconnectPlayer: skipping clientId=${cid} — ws already replaced (new connection took over)`);
                return;
            }
            const wsAge = p.ws?._connectedAt ? (now - p.ws._connectedAt) : Infinity;
            if (wsAge < EVICT_MIN_AGE_MS) {
                console.log(`[AUTH] disconnectPlayer: skipping clientId=${cid} — ws is only ${wsAge}ms old (race condition guard)`);
                return;
            }
            console.log(`[AUTH] closing WS for player clientId=${cid} readyState=${p.ws?.readyState}`);
            if (p.ws?.readyState === 1) p.ws.close(1000, 'logout');
            return;
        }
    }
    for (const [cid, spec] of Object.entries(spectators)) {
        if (spec.dbUserId === dbUserId) {
            if (wsToEvict && spec.ws !== wsToEvict) {
                console.log(`[AUTH] disconnectPlayer: skipping spectator clientId=${cid} — ws already replaced`);
                return;
            }
            const wsAge = spec.ws?._connectedAt ? (now - spec.ws._connectedAt) : Infinity;
            if (wsAge < EVICT_MIN_AGE_MS) {
                console.log(`[AUTH] disconnectPlayer: skipping spectator clientId=${cid} — ws is only ${wsAge}ms old (race condition guard)`);
                return;
            }
            console.log(`[AUTH] closing WS for spectator clientId=${cid} readyState=${spec.ws?.readyState}`);
            if (spec.ws?.readyState === 1) spec.ws.close(1000, 'logout');
            return;
        }
    }
    console.log(`[AUTH] disconnectPlayer: no active WS found for dbUserId=${dbUserId}`);
}

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

function resolveTournamentGraceExpiry(session, clientId, fallbackDbId) {
    if (!session.pendingEliminations) session.pendingEliminations = {};
    delete session.pendingEliminations[clientId];

    if (session.finished) return;

    const p2            = players[clientId];
    const leavingDbId   = p2?.dbUserId ?? session.dbUserIds?.[clientId] ?? fallbackDbId ?? null;
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
        const onlyId = remaining[0];
        if (session.mode === 'tournament' && players[onlyId]?.isCpu) {
            session.finished = true;
            console.log(`[SOLO-GUARD] tournament session ${session.id}: last human left, only bot ${onlyId} remains — ending tournament with no winner`);
            broadcastToSession(session, { type: 'match_end', winner: null, loser: clientId, matchId: null, mode: session.mode });
            broadcastToAll({ type: 'tournament_end', tournamentId: session.tournamentId, champion: null, championDbId: null });
            if (session.tournamentId) {
                db.query(`UPDATE tournaments SET status = 'finished' WHERE id = $1`, [session.tournamentId])
                    .catch(err => console.error('[TOURNAMENT] no-winner finalize error:', err.message));
                tournamentBrackets.delete(session.tournamentId);
            }
            setTimeout(() => {
                broadcastToSession(session, { type: 'match_finished', sessionId: session.id });
                cleanupSession(session, null);
            }, 200);
        } else {
            resolveMatchWinner(session, onlyId, clientId);
        }
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
    fillTournamentBots,
    tryAutoMatch, handleElimination, resolveMatchWinner, cleanupSession, getLastWatchedSession,
    addToLobbyQueue, removeFromLobbyQueue, getLobbyQueue,
    disconnectPlayer,
    resetTournamentRoom, resolveTournamentGraceExpiry,
    tournamentRoom,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS, CHARACTER_ASSETS,
};
