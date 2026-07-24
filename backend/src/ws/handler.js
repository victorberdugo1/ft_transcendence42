'use strict';

const WebSocket = require('ws');
const db        = require('../db');
const { SESSION_COOKIE } = require('../auth');

const {
    players, spectators, spectatorsBySession, lastState,
    gameSessions, playerSession, playerCharSelected,
    broadcastState, broadcastToSession, broadcastToAll,
    sendStateToSpectator, listActiveSessions, buildSessionSnapshot,
    buildCharSelectAck, sendAllCharSelectsTo,
    createPlayer, startDuel, startTournament, tryAutoMatch,
    fillTournamentBots,
    handleElimination, resolveMatchWinner, getLastWatchedSession,
    addToLobbyQueue, removeFromLobbyQueue, getLobbyQueue,
    resetTournamentRoom, resolveTournamentGraceExpiry,
    tournamentBrackets,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS,
    tournamentRoom,
} = require('../game/session');

const gameSession = require('../game/session');

const LOBBY_GRACE_MS = 3000;
const lobbyReconnectGrace = new Map();

function liveWsForEntry(entry) {
    for (const [, p] of Object.entries(players)) {
        if (p.dbUserId === entry.dbUserId && p.ws?.readyState === WebSocket.OPEN) return p.ws;
    }
    return null;
}

// Removes a player from the pre-tournament lobby room by dbUserId (if present)
// and notifies the remaining room members of the updated player list.
// No-op if the tournament has already started or the player isn't in the room.
function removeFromTournamentRoom(dbUserId) {
    if (tournamentRoom.started) return;
    const idx = tournamentRoom.players.findIndex(p => p.dbUserId === dbUserId);
    if (idx === -1) return;
    tournamentRoom.players.splice(idx, 1);

    const roomMsg = JSON.stringify({
        type: 'tournament_room_update',
        players:      tournamentRoom.players,
        started:      tournamentRoom.started,
        tournamentId: tournamentRoom.tournamentId,
        maxPlayers:   tournamentRoom.maxPlayers,
    });
    for (const entry of tournamentRoom.players) {
        const ws = liveWsForEntry(entry);
        if (ws) ws.send(roomMsg);
    }
    console.log(`[TOURNAMENT-ROOM] ${dbUserId} removed — ${tournamentRoom.players.length}/${tournamentRoom.maxPlayers}`);
}

const HEARTBEAT_INTERVAL_MS = 20000;

function setupWebSocket(server, wss) {
    server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        else socket.destroy();
    });
    wss.on('connection', onConnection);

    // Without this, a connection that dies without a clean TCP close (wifi
    // switch, laptop sleep, phone screen lock, a NAT dropping an idle socket)
    // stays `readyState === OPEN` forever: no 'close' event ever fires, so
    // none of the grace/forfeit/cleanup logic below ever runs for that
    // player, and match_end/match_finished get broadcast into the void.
    // Pinging and terminating unresponsive sockets forces a real 'close'
    // event, routing dead connections into the existing disconnect handling.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, HEARTBEAT_INTERVAL_MS);
    wss.on('close', () => clearInterval(heartbeat));
}

function applyCharDef(p, charId) {
    const def = CHARACTER_DEFS[charId] ?? CHARACTER_DEFS.def;
    p.charId          = charId;
    p.moveSpeed       = def.moveSpeed;
    p.dashSpeed       = def.dashSpeed;
    p.attackKnockback = def.attackKnockback;
    p.attackRange     = def.attackRange;
}

// Clamps a client-supplied axis value to a finite number in [-1, 1].
// Guards physics.js (which multiplies this directly into velocity and feeds
// it to Math.sign) against NaN/Infinity/strings/huge values from malformed
// or malicious 'input' messages.
function sanitizeAxis(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n > 1) return 1;
    if (n < -1) return -1;
    return n;
}

function applyInput(p, msg) {
    p.input.moveX      = sanitizeAxis(msg.moveX);
    p.input.jump       = !!msg.jump;
    p.input.attack     = !!msg.attack;
    p.input.dash       = !!msg.dash;
    p.input.dashDir    = sanitizeAxis(msg.dashDir);
    p.input.crouch     = !!msg.crouch;
    p.input.block      = !!msg.block;
    p.input.dashAttack = !!msg.dashAttack;
}

function broadcastHostStatus() {
    const groups = new Map();
    for (const [pid, pl] of Object.entries(players)) {
        if (pl.dbUserId == null) continue;
        const sid = playerSession.get(Number(pid)) ?? null;
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid).push(Number(pid));
    }

    const _lobbyIds     = getLobbyQueue();
    const _lobbyHostSet = new Set();
    for (let _i = 0; _i + 1 < _lobbyIds.length; _i += 2) {
        _lobbyHostSet.add(_lobbyIds[_i]);
    }

    for (const [, pl] of Object.entries(players)) {
        if (!pl.ws || pl.ws.readyState !== WebSocket.OPEN) continue;
        const sid = playerSession.get(pl.id) ?? null;
        let isHost;
        if (sid === null) {
            if (pl._seekingMatch === false) {
                isHost = true;
            } else {
                isHost = _lobbyHostSet.has(pl.id);
            }
        } else {
            const group = groups.get(sid) ?? [];
            const minId = group.length ? Math.min(...group) : pl.id;
            isHost = pl.id === minId;
        }
        pl.ws.send(JSON.stringify({ type: 'host_status', isHost }));
    }
}

function notifyNewLobbyHost() {
    const q = getLobbyQueue();
    for (let i = 0; i < q.length; i += 2) {
        const hostId = q[i];
        const pl = players[hostId];
        if (!pl?.ws || pl.ws.readyState !== 1) continue;
        delete pl._pendingStageId;
        pl.ws.send(JSON.stringify({ type: 'stage_reset' }));
    }
    broadcastHostStatus();
}

function notifyPairPartner(leavingClientId) {
    const q = getLobbyQueue();
    const idx = q.indexOf(leavingClientId);
    if (idx === -1) return;
    const partnerIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (partnerIdx < 0 || partnerIdx >= q.length) return;
    const partnerId = q[partnerIdx];
    const partner   = players[partnerId];
    if (!partner?.ws || partner.ws.readyState !== 1) return;
    delete partner._pendingStageId;
    partner.ws.send(JSON.stringify({ type: 'pair_dissolved' }));
    partner.ws.send(JSON.stringify({ type: 'stage_reset' }));
    console.log(`[PAIR] notified partner ${partnerId} that ${leavingClientId} left`);
}

function kickDuplicateDbUser(incomingClientId, incomingDbUserId) {
    if (!incomingDbUserId) return;

    for (const [pid, pl] of Object.entries(players)) {
        if (Number(pid) === incomingClientId) continue;
        if (pl.dbUserId !== incomingDbUserId) continue;

        console.log(`[WS] Kicking duplicate player slot ${pid} for dbUserId ${incomingDbUserId}`);
        try {
            pl.ws?.send(JSON.stringify({ type: 'kicked', reason: 'logged_in_elsewhere' }));
            pl.ws?.close(4001, 'Duplicate session');
        } catch {}
        const kickedSid = playerSession.get(Number(pid));
        if (kickedSid) {
            const kickedSess = gameSessions.get(kickedSid);
            if (kickedSess?.pendingEliminations?.[Number(pid)]) {
                clearTimeout(kickedSess.pendingEliminations[Number(pid)]);
                delete kickedSess.pendingEliminations[Number(pid)];
            }
        }
        delete players[pid];
        playerSession.delete(Number(pid));
        playerCharSelected.delete(Number(pid));
        delete lastState[Number(pid)];
    }

    for (const [sid, spec] of Object.entries(spectators)) {
        if (Number(sid) === incomingClientId) continue;
        if (spec.dbUserId !== incomingDbUserId) continue;

        console.log(`[WS] Kicking duplicate spectator slot ${sid} for dbUserId ${incomingDbUserId}`);
        try {
            spec.ws?.send(JSON.stringify({ type: 'kicked', reason: 'logged_in_elsewhere' }));
            spec.ws?.close(4001, 'Duplicate session');
        } catch {}
        delete spectators[sid];
    }
}

function sendSessionSync(ws, clientId, session) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const serverNow = Date.now();
    if (!session || session.finished) {
        ws.send(JSON.stringify({
            type: 'session_sync',
            active: false,
            clientId,
            serverNow,
        }));
        return;
    }

    const startsAt = session.startsAt ?? serverNow;
    const phase = session.fightStarted || serverNow >= startsAt
        ? 'fighting'
        : 'countdown';

    ws.send(JSON.stringify({
        type: 'session_sync',
        active: true,
        clientId,
        serverNow,
        phase,
        sessionId: session.id,
        mode: session.mode,
        tournamentId: session.tournamentId ?? null,
        round: session.round ?? null,
        stageId: session.stageId ?? -1,
        players: [...session.playerIds],
        startsAt,
        state: {
            type: 'state',
            frameId: 0,
            players: buildSessionSnapshot(session),
        },
    }));
}

function sendWelcomeToPlayer(ws, clientId) {
    ws.send(JSON.stringify({
        type: 'init', clientId,
        config: {
            attackRange:     players[clientId]?.attackRange ?? ATTACK_RANGE,
            attackRangeY:    ATTACK_RANGE_Y,
            dashAttackRange: DASH_ATTACK_RANGE_X,
        },
    }));

    const sid     = playerSession.get(clientId) ?? null;
    let   session = sid ? gameSessions.get(sid) : null;

    if (session?.finished) {
        playerSession.delete(clientId);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'match_finished', sessionId: sid }));
        }
        console.log(`[WS] sendWelcomeToPlayer: client ${clientId} had finished session ${sid} — redirecting to lobby`);
        session = null;
    }

    if (session) {
        for (const [cid, charId] of playerCharSelected.entries()) {
            if (!session.playerIds.has(cid)) continue;
            const ack = buildCharSelectAck(charId, cid, 0);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
        }
        const stageId = session.stageId ?? -1;
        ws.send(JSON.stringify(stageId >= 0
            ? { type: 'stage_confirmed', stageId }
            : { type: 'stage_reset' }
        ));
    } else {
        sendAllCharSelectsTo(ws);

        const _lobbyQueue = getLobbyQueue();
        const _myIdx      = _lobbyQueue.indexOf(clientId);
        const _pairIdx    = _myIdx >= 0 ? (_myIdx % 2 === 0 ? _myIdx + 1 : _myIdx - 1) : -1;
        const _partnerId  = (_pairIdx >= 0 && _pairIdx < _lobbyQueue.length) ? _lobbyQueue[_pairIdx] : -1;
        const _partnerPl  = _partnerId >= 0 ? players[_partnerId] : null;
        const _pairStage  = _partnerPl?._pendingStageId ?? -1;
        if (_pairStage >= 0) {
            ws.send(JSON.stringify({ type: 'stage_confirmed', stageId: _pairStage }));
        } else {
            ws.send(JSON.stringify({ type: 'stage_reset' }));
        }
    }

    broadcastHostStatus();
    const savedChar = playerCharSelected.get(clientId);
    if (savedChar) ws.send(JSON.stringify(buildCharSelectAck(savedChar, clientId, 0)));

    sendSessionSync(ws, clientId, session);

    // If this player is already in the tournament room, send them the current
    // room state immediately so the frontend doesn't need a round-trip join.
    const _roomEntry = tournamentRoom.players.find(e => e.dbUserId === players[clientId]?.dbUserId);
    if (_roomEntry) {
        const _activeTournSess = tournamentRoom.tournamentId
            ? [...gameSessions.values()].find(
                s => s.tournamentId === tournamentRoom.tournamentId && !s.finished
              )
            : null;
        if (!_activeTournSess && tournamentRoom.started) {
            // Tournament is over — evict the player from the stale room entry
            // so they don't get stuck waiting for a finished tournament.
            const _evictIdx = tournamentRoom.players.findIndex(e => e.dbUserId === players[clientId]?.dbUserId);
            if (_evictIdx !== -1) tournamentRoom.players.splice(_evictIdx, 1);
            console.log(`[TOURNAMENT-ROOM] evicted stale entry for dbUserId ${players[clientId]?.dbUserId} on welcome`);
            // Tell the client it is no longer in a tournament room so that
            // ModeTournament clears inTournamentRoom from sessionStorage and
            // doesn't attempt tournament_join again on the next reload.
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type:         'tournament_room_update',
                    players:      [],
                    started:      false,
                    tournamentId: null,
                    maxPlayers:   tournamentRoom.maxPlayers,
                    leftRoom:     true,
                }));
            }
        } else {
            ws.send(JSON.stringify({
                type:         'tournament_room_update',
                players:      tournamentRoom.players,
                started:      tournamentRoom.started,
                tournamentId: tournamentRoom.tournamentId,
                maxPlayers:   tournamentRoom.maxPlayers,
                welcome:      true,   // server-confirmed: this player is in the room
            }));
        }
    }
}

function resolveGraceExpiry(session, clientId, fallbackDbId) {
    delete session.pendingEliminations[clientId];
    if (playerSession.get(clientId) !== session.id) {
        console.log(`[SERVER] Ignored stale grace expiry for client ${clientId} from session ${session.id}`);
        return;
    }
    const p2          = players[clientId];
    const leavingDbId = p2?.dbUserId ?? fallbackDbId;
    delete players[clientId];
    playerSession.delete(clientId);
    playerCharSelected.delete(clientId);
    delete lastState[clientId];

    if (!session.finished) {
        session.eliminated.add(clientId);
        session.loserDbId   = leavingDbId;
        session.loserStocks = p2?.stocks ?? 0;
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
                gameSession.cleanupSession(session, null);
            }, 6000);
        }
    }
    broadcastState();
}

async function onConnection(ws, req) {
    ws._connectedAt = Date.now();   // timestamp para que disconnectPlayer no mate WS recientes
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let clientId    = null;
    let dbUserId    = null;
    let isSpectator = false;
    let mode        = null;

    try {
        const cookieHeader = req.headers.cookie || '';
        let token = null;
        for (const part of cookieHeader.split(';')) {
            const [k, v] = part.trim().split('=');
            if (k === SESSION_COOKIE) { token = v; break; }
        }
        if (token) {
            const { rows } = await db.query(
                `SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()`,
                [token]
            );
            if (rows.length) dbUserId = rows[0].user_id;
        }
    } catch (err) {
        console.error('[WS] session resolve error:', err.message);
    }

    async function insertOrUpdateSpectatorRow(specMode, watchingSession) {
        const current = spectators[clientId];
        if (!current) return;
        const tournamentId = watchingSession ? (gameSessions.get(watchingSession)?.tournamentId ?? null) : null;
        if (!current.dbRowId) {
            try {
                const { rows: dbRows } = await db.query(
                    `INSERT INTO spectators (user_id, session_id, tournament_id, mode)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [dbUserId, watchingSession ?? null, tournamentId, specMode]
                );
                current.dbRowId = dbRows[0]?.id ?? null;
            } catch (err) {
                console.error('[SPECTATOR] DB insert error:', err.message);
            }
        } else {
            db.query(
                `UPDATE spectators SET session_id = $1, tournament_id = $2, mode = $3 WHERE id = $4`,
                [watchingSession ?? null, tournamentId, specMode, current.dbRowId]
            ).catch(err => console.error('[SPECTATOR] DB update error:', err.message));
        }
    }

    function sendSpectatorWelcome(specMode, watchingSession) {
        if (!spectators[clientId]) return;
        ws.send(JSON.stringify({
            type: 'spectator_mode', clientId, mode: specMode,
            watchingSession, activeSessions: listActiveSessions(),
            config: {
                attackRange:     ATTACK_RANGE,
                attackRangeY:    ATTACK_RANGE_Y,
                dashAttackRange: DASH_ATTACK_RANGE_X,
            },
        }));

        const session = watchingSession ? gameSessions.get(watchingSession) : null;
        if (session) {
            const sessionPlayerIds = new Set(session.playerIds);
            for (const [cid, charId] of playerCharSelected.entries()) {
                if (!sessionPlayerIds.has(cid)) continue;
                const ack = gameSession.buildCharSelectAck(charId, cid, 0);
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
            }
            const stageId = session.stageId ?? gameSession.confirmedStageId ?? -1;
            if (stageId >= 0) {
                ws.send(JSON.stringify({ type: 'stage_confirmed', stageId }));
            } else {
                ws.send(JSON.stringify({ type: 'stage_reset' }));
            }
        } else {
            ws.send(JSON.stringify({ type: 'stage_reset' }));
        }

        if (session && !session.finished) {
            const _syncStageId = session.stageId ?? gameSession.confirmedStageId ?? -1;
            const _serverNow = Date.now();
            ws.send(JSON.stringify({
                type: 'spectator_match_sync',
                mode: session.mode,
                sessionId: session.id,
                players: [...session.playerIds],
                countdown: !session.fightStarted && _serverNow < (session.startsAt ?? _serverNow),
                serverNow: _serverNow,
                startsAt: session.startsAt ?? _serverNow,
                stageId: _syncStageId >= 0 ? _syncStageId : undefined,
            }));
        }

        sendStateToSpectator(spectators[clientId]);
    }

    async function ensureSpectatorReady(specMode = 'overflow', watchingSession = null, extraFlags = {}) {
        if (clientId === null) clientId = gameSession.nextClientId++;
        if (!spectators[clientId]) {
            spectators[clientId] = {
                id: clientId, dbUserId, ws, watchingSession, mode: specMode,
                dbRowId: null, eliminated: extraFlags.eliminated ?? false,
            };
            isSpectator = true;
            mode = specMode;
            await insertOrUpdateSpectatorRow(specMode, watchingSession);
            sendSpectatorWelcome(specMode, watchingSession);
            console.log(`[SPECTATOR] Client ${clientId} connected as ${specMode}` + (watchingSession ? ` watching ${watchingSession}` : ' (lobby)'));
        } else {
            spectators[clientId].watchingSession = watchingSession;
            spectators[clientId].mode = specMode;
            if (extraFlags.eliminated) spectators[clientId].eliminated = true;
            isSpectator = true;
            mode = specMode;
            await insertOrUpdateSpectatorRow(specMode, watchingSession);
            sendSpectatorWelcome(specMode, watchingSession);
        }
    }

    async function promoteToPlayer(initialMsg = null, seekingMatch = true) {
        if (clientId == null) clientId = gameSession.nextClientId++;
        if (players[clientId]) return;

        if (spectators[clientId]) {
            const spec = spectators[clientId];
            if (spec.dbRowId) {
                db.query(`UPDATE spectators SET left_at = NOW() WHERE id = $1`, [spec.dbRowId])
                  .catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
            }
            delete spectators[clientId];
        }

        const saved = lastState[clientId];
        if (saved) clearTimeout(saved.timer);

        if (saved?.spectator) {
            delete lastState[clientId];
            const watchSess = saved.watchingSession ?? null;
            const sessStillActive = watchSess && gameSessions.has(watchSess) && !gameSessions.get(watchSess).finished;
            if (!sessStillActive && watchSess) {
                playerCharSelected.delete(clientId);
            } else {
                const resolvedSess = sessStillActive
                    ? watchSess
                    : (gameSessions.size > 0 ? gameSessions.keys().next().value : null);
                await ensureSpectatorReady(saved.mode ?? 'overflow', resolvedSess, { eliminated: saved.eliminated ?? false });
                return;
            }
        }

        // Server at capacity: redirect to spectator overflow instead of
        // growing `players` unboundedly (that object is iterated every tick
        // at 60 Hz by the physics/broadcast loop for every connected client).
        if (Object.keys(players).length >= MAX_PLAYERS) {
            console.warn(`[SERVER] Player cap reached (${MAX_PLAYERS}) — redirecting client ${clientId} to spectator overflow`);
            await ensureSpectatorReady('overflow', null);
            return;
        }

        kickDuplicateDbUser(clientId, dbUserId);

        players[clientId] = createPlayer(clientId, saved, ws);
        players[clientId].dbUserId = dbUserId;
        if (dbUserId) {
            db.query('SELECT username FROM users WHERE id = $1', [dbUserId])
              .then(r => { if (players[clientId] && r.rows[0]) players[clientId].username = r.rows[0].username; })
              .catch(() => {});
        }
        delete lastState[clientId];

        if (dbUserId) {
            const _roomEntry = tournamentRoom.players.find(e => e.dbUserId === dbUserId);
            if (_roomEntry && _roomEntry.clientId !== clientId) {
                console.log(`[TOURNAMENT-ROOM] updated clientId for dbUserId ${dbUserId}: ${_roomEntry.clientId} \u2192 ${clientId}`);
                _roomEntry.clientId = clientId;
            }
        }

        const restoredChar = playerCharSelected.get(clientId);
        if (restoredChar) applyCharDef(players[clientId], restoredChar);

        const restoredStageId = lastState[clientId]?.pendingStageId ?? saved?.pendingStageId;
        if (restoredStageId !== undefined && players[clientId])
            players[clientId]._pendingStageId = restoredStageId;

        isSpectator = false;
        mode = 'player';

        if (seekingMatch && !playerSession.has(clientId)) addToLobbyQueue(clientId);

        if (players[clientId]) players[clientId]._seekingMatch = seekingMatch;

        sendWelcomeToPlayer(ws, clientId);

        if (initialMsg?.type === 'input') applyInput(players[clientId], initialMsg);

        broadcastState();
        console.log(`[SERVER] Player ${clientId} connected (${Object.keys(players).length}/${MAX_PLAYERS})`);
        const _rejoinPlayer = players[clientId];
        if (seekingMatch && playerCharSelected.has(clientId) && _rejoinPlayer?._pendingStageId !== undefined)
            tryAutoMatch();
    }

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        // Registrar cuándo llegó el primer mensaje de este WS.
        // disconnectPlayer usa este timestamp para no cerrar conexiones recientes
        // (evita matar un WS nuevo que tomó el slot justo antes de que el
        // endpoint HTTP de login procesara su llamada a disconnectPlayer).
        if (!ws._firstMsgAt) ws._firstMsgAt = Date.now();

        if (msg.type === 'session_sync_request') {
            if (clientId === null || spectators[clientId]) return;
            const sid = playerSession.get(clientId) ?? null;
            const session = sid ? gameSessions.get(sid) : null;
            // Never allow a client to use this recovery path to inspect another
            // session. The optional id only protects against a stale HTTP reply.
            if (msg.sessionId != null && String(msg.sessionId) !== String(sid)) {
                sendSessionSync(ws, clientId, null);
                return;
            }
            sendSessionSync(ws, clientId, session);
            return;
        }

        if (msg.type === 'join') {
            if (dbUserId) {
                let existingClientId = null;
                for (const [pid, pl] of Object.entries(players)) {
                    if (pl.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                }
                if (existingClientId === null) {
                    for (const [pid, gs] of Object.entries(lastState)) {
                        if (gs.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }
                if (existingClientId === null) {
                    for (const [pid, spec] of Object.entries(spectators)) {
                        if (spec.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }

                if (existingClientId !== null) {
                    let graceSession = null;
                    for (const [, sess] of gameSessions.entries()) {
                        if (sess.pendingEliminations?.[existingClientId]) { graceSession = sess; break; }
                    }
                    if (graceSession) {
                        clearTimeout(graceSession.pendingEliminations[existingClientId]);
                        delete graceSession.pendingEliminations[existingClientId];
                        clientId = existingClientId;
                        if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;
                        players[clientId].ws = ws;
                        players[clientId].dbUserId = dbUserId;
                        isSpectator = false; mode = 'player';
                        broadcastToSession(graceSession, { type: 'player_reconnected', clientId });
                        sendWelcomeToPlayer(ws, clientId);
                        console.log(`[WS] join: cancelled grace for slot ${clientId} — restored to session ${graceSession.id}`);
                        return;
                    }

                    const oldPlayer = players[existingClientId];
                    const oldSpec   = spectators[existingClientId];
                    const oldWs     = oldPlayer?.ws ?? oldSpec?.ws;
                    if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                        try {
                            oldWs.send(JSON.stringify({ type: 'kicked', reason: 'reconnected_in_another_tab' }));
                            oldWs.close(4001, 'Reconnected elsewhere');
                        } catch {}
                    }
                    console.log(`[WS] join: dbUserId ${dbUserId} has existing slot ${existingClientId}, reusing`);
                    clientId = existingClientId;
                    if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;

                    if (players[clientId]) {
                        players[clientId].ws = ws;
                        players[clientId].dbUserId = dbUserId;
                        players[clientId]._seekingMatch = (msg.seekingMatch !== false);
                        isSpectator = false; mode = 'player';
                        sendWelcomeToPlayer(ws, clientId);
                        if (msg.seekingMatch !== false &&
                            !playerSession.has(clientId) &&
                            playerCharSelected.has(clientId) &&
                            players[clientId]?._pendingStageId !== undefined)
                            tryAutoMatch();
                        return;
                    }
                    if (spectators[clientId]) {
                        spectators[clientId].ws = ws;
                        spectators[clientId].dbUserId = dbUserId;
                        isSpectator = true; mode = spectators[clientId].mode;
                        sendSpectatorWelcome(mode, spectators[clientId].watchingSession);
                        return;
                    }
                    const ghostState = lastState[clientId];
                    if (ghostState) { clearTimeout(ghostState.timer); delete lastState[clientId]; }
                    if (msg.seekingMatch !== false) addToLobbyQueue(clientId);
                    await promoteToPlayer(null, msg.seekingMatch !== false);
                    return;
                }
            }

            if (clientId === null) clientId = gameSession.nextClientId++;
            if (msg.seekingMatch !== false) addToLobbyQueue(clientId);
            await promoteToPlayer(null, msg.seekingMatch !== false);
            return;
        }

        if (msg.type === 'rejoin' && msg.clientId) {
            const requestedId = msg.clientId;

            if (dbUserId) {
                let existingClientId = null;

                for (const [pid, pl] of Object.entries(players)) {
                    if (pl.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                }
                if (existingClientId === null) {
                    for (const [pid, gs] of Object.entries(lastState)) {
                        if (gs.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }
                if (existingClientId === null) {
                    for (const [pid, spec] of Object.entries(spectators)) {
                        if (spec.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }
                if (existingClientId === null) {
                    for (const [pid, gr] of lobbyReconnectGrace.entries()) {
                        if (gr.snapshot.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }

                if (existingClientId !== null && existingClientId !== requestedId) {
                    const oldPlayer = players[existingClientId];
                    const oldSpec   = spectators[existingClientId];
                    const oldWs     = oldPlayer?.ws ?? oldSpec?.ws;
                    if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                        try {
                            oldWs.send(JSON.stringify({ type: 'kicked', reason: 'reconnected_in_another_tab' }));
                            oldWs.close(4001, 'Reconnected elsewhere');
                        } catch {}
                    }
                    console.log(`[WS] rejoin: dbUserId ${dbUserId} redirected from hint ${requestedId} → existing slot ${existingClientId}`);
                    clientId = existingClientId;
                    if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;

                    for (const [, sess] of gameSessions.entries()) {
                        if (sess.pendingEliminations?.[clientId]) {
                            clearTimeout(sess.pendingEliminations[clientId]);
                            delete sess.pendingEliminations[clientId];
                            broadcastToSession(sess, { type: 'player_reconnected', clientId });
                        }
                    }

                    if (players[clientId]) {
                        players[clientId].ws = ws;
                        players[clientId].dbUserId = dbUserId;
                        isSpectator = false; mode = 'player';
                        const savedSession = lastState[clientId]?.sessionId ?? null;
                        if (savedSession && gameSessions.has(savedSession) && !gameSessions.get(savedSession).finished && !playerSession.has(clientId))
                            playerSession.set(clientId, savedSession);
                        sendWelcomeToPlayer(ws, clientId);
                        if (!playerSession.has(clientId) &&
                            players[clientId]?._seekingMatch !== false &&
                            playerCharSelected.has(clientId) &&
                            players[clientId]?._pendingStageId !== undefined)
                            tryAutoMatch();
                        return;
                    }
                    if (lobbyReconnectGrace.has(clientId)) {
                        clearTimeout(lobbyReconnectGrace.get(clientId).timer);
                        lobbyReconnectGrace.delete(clientId);
                        console.log(`[WS] rejoin: cancelled lobby grace for slot ${clientId}`);
                    }
                    const ghostState = lastState[clientId];
                    if (ghostState) {
                        clearTimeout(ghostState.timer);
                        delete lastState[clientId];
                    }
                    const _graceSeekingMatch = players[clientId]?._seekingMatch ?? true;
                    await promoteToPlayer(null, _graceSeekingMatch);
                    return;
                }
            }

            const slotDbUserId =
                players[requestedId]?.dbUserId ??
                spectators[requestedId]?.dbUserId ??
                lastState[requestedId]?.dbUserId ??
                lobbyReconnectGrace.get(requestedId)?.snapshot?.dbUserId ??
                null;

            const ownershipOk =
                slotDbUserId === null ||
                slotDbUserId === dbUserId;

            if (!ownershipOk) {
                console.warn(`[WS] rejoin rejected: slot ${requestedId} owned by dbUserId ${slotDbUserId}, requester is ${dbUserId}`);
                clientId = gameSession.nextClientId++;
                await promoteToPlayer(null);
                return;
            }

            kickDuplicateDbUser(requestedId, dbUserId);

            for (const [, sess] of gameSessions.entries()) {
                if (sess.pendingEliminations?.[requestedId]) {
                    clearTimeout(sess.pendingEliminations[requestedId]);
                    delete sess.pendingEliminations[requestedId];
                    broadcastToSession(sess, { type: 'player_reconnected', clientId: requestedId });
                }
            }

            if (players[requestedId]) {
                clientId = requestedId;
                if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;
                const oldWs = players[clientId].ws;
                if (oldWs && oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
                    try {
                        oldWs.send(JSON.stringify({ type: 'kicked', reason: 'reconnected_in_another_tab' }));
                        oldWs.close(4001, 'Reconnected elsewhere');
                    } catch {}
                }
                players[clientId].ws = ws;
                players[clientId].dbUserId = dbUserId ?? players[clientId].dbUserId;
                isSpectator = false; mode = 'player';
                const savedSession = lastState[clientId]?.sessionId ?? null;
                if (savedSession && gameSessions.has(savedSession) && !gameSessions.get(savedSession).finished && !playerSession.has(clientId))
                    playerSession.set(clientId, savedSession);
                if (msg.seekingMatch === true && players[clientId]) {
                    players[clientId]._seekingMatch = true;
                }
                if (!playerSession.has(clientId) && players[clientId]?._seekingMatch !== false) {
                    addToLobbyQueue(clientId);
                }
                sendWelcomeToPlayer(ws, clientId);
                if (!playerSession.has(clientId) &&
                    players[clientId]?._seekingMatch !== false &&
                    playerCharSelected.has(clientId) &&
                    players[clientId]?._pendingStageId !== undefined)
                    tryAutoMatch();
                return;
            }

            if (spectators[requestedId]) {
                clientId = requestedId;
                if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;
                spectators[clientId].ws = ws;
                spectators[clientId].dbUserId = dbUserId ?? spectators[clientId].dbUserId;
                isSpectator = true; mode = spectators[clientId].mode;
                sendSpectatorWelcome(mode, spectators[clientId].watchingSession);
                return;
            }

            if (clientId !== null && clientId !== requestedId) {
                delete spectators[clientId];
                delete players[clientId];
            }
            clientId = requestedId;
            if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;

            const ghostState = lastState[clientId];
            if (ghostState?.spectator) {
                const watchSess = ghostState.watchingSession ?? null;
                const sessStillActive = watchSess && gameSessions.has(watchSess) && !gameSessions.get(watchSess).finished;
                clearTimeout(ghostState.timer);
                delete lastState[clientId];
                if (!sessStillActive || ghostState.eliminated) {
                    playerCharSelected.delete(clientId);
                    await promoteToPlayer(null);
                } else {
                    await ensureSpectatorReady(ghostState.mode ?? 'overflow', watchSess, { eliminated: ghostState.eliminated ?? false });
                }
                return;
            }

            if (lobbyReconnectGrace.has(clientId)) {
                const gr = lobbyReconnectGrace.get(clientId);
                clearTimeout(gr.timer);
                lobbyReconnectGrace.delete(clientId);
                console.log(`[WS] rejoin: cancelled lobby grace for slot ${clientId} -- restoring slot in place`);
                await promoteToPlayer(null, gr.snapshot.seekingMatch !== false);
                return;
            }

            await promoteToPlayer(null);
            return;
        }

        if (msg.type === 'watch') {
            const prevId = msg.prevClientId ? parseInt(msg.prevClientId, 10) : null;
            if (prevId && prevId !== clientId) {
                if (players[prevId]) {
                    delete players[prevId];
                    playerSession.delete(prevId);
                    playerCharSelected.delete(prevId);
                    delete lastState[prevId];
                    console.log(`[WS] watch: cleaned up stale player slot ${prevId}`);
                }
            }

            if (clientId == null) clientId = gameSession.nextClientId++;

            if (players[clientId]) {
                delete players[clientId];
                playerSession.delete(clientId);
                playerCharSelected.delete(clientId);
                delete lastState[clientId];
                console.log(`[WS] watch: moved client ${clientId} from players to spectators`);
            }

            const _rawSession = (msg.sessionId && gameSessions.get(msg.sessionId) && !gameSessions.get(msg.sessionId).finished)
                ? msg.sessionId
                : (msg.sessionId ? null : await getLastWatchedSession(dbUserId));
            const watchingSession = (_rawSession && gameSessions.has(_rawSession) && !gameSessions.get(_rawSession).finished)
                ? _rawSession
                : null;

            await ensureSpectatorReady('voluntary', watchingSession ?? null);
            return;
        }

        if (msg.type === 'leave') {
            if (spectators[clientId]) {
                const spec = spectators[clientId];
                if (spec.dbRowId) {
                    db.query('UPDATE spectators SET left_at = NOW() WHERE id = $1', [spec.dbRowId])
                      .catch(() => {});
                }
                delete spectators[clientId];
                if (spec.eliminated) {
                    if (lastState[clientId]?.timer) clearTimeout(lastState[clientId].timer);
                    delete lastState[clientId];
                    playerCharSelected.delete(clientId);
                }
                console.log(`[SERVER] Spectator ${clientId} left voluntarily${spec.eliminated ? ' (was eliminated)' : ''}`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'leave_ack', paired: false, graced: false }));
                }
                return;
            }
            if (!players[clientId]) return;

            const leavingSession = playerSession.get(clientId)
                ? gameSessions.get(playerSession.get(clientId))
                : null;

            if (!leavingSession || leavingSession.finished) {
                // LOBBY-PAIR GUARD: a real gameSession doesn't exist yet (we're
                // still pre-match_start), but stage_select may have already
                // paired this client with a partner by lobbyQueue adjacency
                // (see the stage_select lobby-branch above). If so, this leave
                // must be rejected exactly like the SSS/countdown guard below —
                // letting it through here breaks the partner mid char/stage
                // select and dissolves a pair the UI told them was locked.
                // This guard does NOT apply to ws 'close' (tab close / F5),
                // which is handled separately and is always allowed to drop
                // the pair immediately.
                const _lobbyQueueNow  = getLobbyQueue();
                const _myIdx2   = _lobbyQueueNow.indexOf(clientId);
                const _pairIdx2 = _myIdx2 >= 0 ? (_myIdx2 % 2 === 0 ? _myIdx2 + 1 : _myIdx2 - 1) : -1;
                const _hasLobbyPartner = _myIdx2 >= 0 &&
                    _pairIdx2 >= 0 && _pairIdx2 < _lobbyQueueNow.length;

                if (_hasLobbyPartner) {
                    console.log(`[SERVER] Player ${clientId} leave rejected — lobby pair in progress (stage/char select, no session yet)`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'leave_ack', paired: true, graced: false, rejected: true,
                            reason: 'pre_match_locked',
                        }));
                    }
                    return;
                }

                notifyPairPartner(clientId);
                removeFromLobbyQueue(clientId);

                // If this player had a tournament room entry and the
                // tournament hasn't started, drop it now too — covers the
                // "navigated away without pressing Leave room" path.
                if (dbUserId && !tournamentRoom.started) {
                    removeFromTournamentRoom(dbUserId);
                }

                const lp = players[clientId];
                delete players[clientId];
                playerSession.delete(clientId);
                if (lastState[clientId]?.timer) clearTimeout(lastState[clientId].timer);
                lastState[clientId] = {
                    x: lp?.x, y: lp?.y, onGround: lp?.onGround, stocks: lp?.stocks,
                    dbUserId: lp?.dbUserId ?? null, sessionId: null,
                    pendingStageId: lp?._pendingStageId,
                    timer: setTimeout(() => { delete lastState[clientId]; playerCharSelected.delete(clientId); }, GHOST_TTL),
                };
                notifyNewLobbyHost();
                broadcastState();
                console.log(`[SERVER] Player ${clientId} left voluntarily (lobby)`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'leave_ack', paired: false, graced: false }));
                }
                return;
            }

            if (leavingSession.mode === 'training') {
                const lp = players[clientId];
                delete players[clientId];
                playerSession.delete(clientId);
                playerCharSelected.delete(clientId);
                delete lastState[clientId];
                removeFromLobbyQueue(clientId);
                if (!leavingSession.finished) {
                    leavingSession.finished = true;
                    broadcastToSession(leavingSession, {
                        type: 'match_finished', sessionId: leavingSession.id,
                    });
                    gameSession.cleanupSession(leavingSession, null);
                }
                broadcastState();
                console.log(`[SERVER] Player ${clientId} left training session — ended immediately`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'leave_ack', paired: false, graced: false }));
                }
                return;
            }

            // SSS / COUNTDOWN PHASE GUARD: a pair has formed (leavingSession
            // exists, not finished, not training) but the fight hasn't gone
            // live yet (session.fightStarted === false). Leaving here would
            // break the opponent's match setup — reject outright. The client
            // should already have the leave button disabled during this
            // window; this is the server-side enforcement of the same rule.
            if (leavingSession.fightStarted === false) {
                console.log(`[SERVER] Player ${clientId} leave rejected — session ${leavingSession.id} still in SSS/countdown phase`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'leave_ack', paired: true, graced: false, rejected: true,
                        reason: 'pre_match_locked', sessionId: leavingSession.id,
                    }));
                }
                return;
            }

            if (!leavingSession.pendingEliminations) leavingSession.pendingEliminations = {};
            if (leavingSession.pendingEliminations[clientId]) {
                clearTimeout(leavingSession.pendingEliminations[clientId]);
            }

            const GRACE_MS  = 5000;
            const expiresAt = Date.now() + GRACE_MS;

            const lp = players[clientId];
            if (lp) {
                lp.input.moveX = 0; lp.input.jump = false; lp.input.attack = false;
                lp.input.dash  = false; lp.input.dashAttack = false; lp.input.block = false;
            }

            broadcastToSession(leavingSession, { type: 'leave_grace', clientId, expiresAt, sessionId: leavingSession.id });
            console.log(`[SERVER] Player ${clientId} left mid-match — grace period started (${GRACE_MS}ms)`);

            leavingSession.pendingEliminations[clientId] = setTimeout(() => {
                if (leavingSession.mode === 'tournament') {
                    resolveTournamentGraceExpiry(leavingSession, clientId, null);
                } else {
                    resolveGraceExpiry(leavingSession, clientId, null);
                }
                console.log(`[SERVER] Player ${clientId} grace expired — forfeit`);
            }, GRACE_MS);

            return;
        }

        // Player clicked "Rejoin fight" on their own leave-grace banner —
        // they never actually disconnected (same ws, same clientId), so the
        // 'rejoin' flow doesn't apply here. Just cancel our own pending
        // forfeit timer and tell the session we're back, mirroring the same
        // pendingEliminations cleanup used elsewhere (join/rejoin paths).
        if (msg.type === 'cancel_leave') {
            if (!players[clientId]) return;
            for (const [, sess] of gameSessions.entries()) {
                if (sess.pendingEliminations?.[clientId]) {
                    clearTimeout(sess.pendingEliminations[clientId]);
                    delete sess.pendingEliminations[clientId];
                    broadcastToSession(sess, { type: 'player_reconnected', clientId });
                    console.log(`[SERVER] Player ${clientId} cancelled their own leave-grace — rejoining fight`);
                }
            }
            return;
        }

        if (msg.type === 'tournament_join') {
            if (!dbUserId) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'not_authenticated' }));
                return;
            }
            if (!players[clientId]) {
                await promoteToPlayer(null, false);
            }
            if (tournamentRoom.started) {
                // If started but the tournament session is already finished/gone,
                // auto-reset the room and let the player join fresh.
                const activeTournSess = tournamentRoom.tournamentId
                    ? [...gameSession.gameSessions.values()].find(
                        s => s.tournamentId === tournamentRoom.tournamentId && !s.finished
                      )
                    : null;
                if (!activeTournSess) {
                    console.log(`[TOURNAMENT-ROOM] stale started=true detected on join — resetting room`);
                    tournamentRoom.players    = [];
                    tournamentRoom.started    = false;
                    tournamentRoom.tournamentId = null;
                    // fall through to normal join below
                } else {
                    if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                        players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'already_started' }));
                    return;
                }
            }
            if (tournamentRoom.players.length >= tournamentRoom.maxPlayers) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'room_full' }));
                return;
            }
            const alreadyIn = tournamentRoom.players.some(p => p.dbUserId === dbUserId);
            if (!alreadyIn) {
                let username = players[clientId]?.username ?? null;
                if (!username && dbUserId) {
                    try {
                        const { rows: uRows } = await db.query('SELECT username FROM users WHERE id = $1', [dbUserId]);
                        username = uRows[0]?.username ?? null;
                        if (players[clientId]) players[clientId].username = username;
                    } catch (_) {}
                }
                const _dupIdx = tournamentRoom.players.findIndex(p => p.dbUserId === dbUserId);
                if (_dupIdx === -1) {
                    tournamentRoom.players.push({ clientId, dbUserId, username });
                } else {
                    tournamentRoom.players[_dupIdx].clientId = clientId;
                }
            } else {
                const _existing = tournamentRoom.players.find(p => p.dbUserId === dbUserId);
                if (_existing) _existing.clientId = clientId;
            }
            const roomMsg = JSON.stringify({
                type: 'tournament_room_update',
                players:      tournamentRoom.players,
                started:      tournamentRoom.started,
                tournamentId: tournamentRoom.tournamentId,
                maxPlayers:   tournamentRoom.maxPlayers,
            });
            for (const entry of tournamentRoom.players) {
                const livePl = liveWsForEntry(entry);
                if (livePl) livePl.send(roomMsg);
            }
            console.log(`[TOURNAMENT-ROOM] ${dbUserId} joined — ${tournamentRoom.players.length}/${tournamentRoom.maxPlayers}`);
            return;
        }

        if (msg.type === 'tournament_leave') {
            if (!dbUserId) return;
            const idx = tournamentRoom.players.findIndex(p => p.dbUserId === dbUserId);
            if (idx === -1) return;
            tournamentRoom.players.splice(idx, 1);

            if (!players[clientId]) {
                await promoteToPlayer(null, true);
            }

            // Restore the player to normal lobby-seeking state.
            // They joined with seekingMatch:false — undo that so autoMatch works if they switch modes.
            if (players[clientId]) {
                players[clientId]._seekingMatch = true;
                if (!playerSession.has(clientId)) addToLobbyQueue(clientId);
            }

            const leaverWs = liveWsForEntry({ dbUserId });
            if (leaverWs) {
                leaverWs.send(JSON.stringify({
                    type: 'tournament_room_update',
                    players:      tournamentRoom.players,
                    started:      tournamentRoom.started,
                    tournamentId: tournamentRoom.tournamentId,
                    maxPlayers:   tournamentRoom.maxPlayers,
                    leftRoom:     true,
                }));
            }

            const roomMsgLeave = JSON.stringify({
                type: 'tournament_room_update',
                players:      tournamentRoom.players,
                started:      tournamentRoom.started,
                tournamentId: tournamentRoom.tournamentId,
                maxPlayers:   tournamentRoom.maxPlayers,
            });
            for (const entry of tournamentRoom.players) {
                const ws = liveWsForEntry(entry);
                if (ws) ws.send(roomMsgLeave);
            }
            console.log(`[TOURNAMENT-ROOM] ${dbUserId} left — ${tournamentRoom.players.length}/${tournamentRoom.maxPlayers}`);
            return;
        }

        if (msg.type === 'tournament_launch') {
            if (!dbUserId) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'not_authenticated' }));
                return;
            }
            if (!players[clientId]) {
                await promoteToPlayer(null, false);
            }
            if (tournamentRoom.started) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'already_started' }));
                return;
            }
            const inRoom = tournamentRoom.players.some(p => p.dbUserId === dbUserId);
            if (!inRoom) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'not_in_room' }));
                return;
            }
            const participantIds = [];
            for (const entry of tournamentRoom.players) {
                let liveCid = null;
                for (const [pid, pl] of Object.entries(players)) {
                    if (pl.dbUserId === entry.dbUserId && pl.ws?.readyState === WebSocket.OPEN) {
                        liveCid = Number(pid); break;
                    }
                }
                if (liveCid !== null) {
                    // Skip anyone already inside an active session (1v1/training).
                    // Pulling them in would silently orphan their current session.
                    const existingSid = playerSession.get(liveCid);
                    if (existingSid) {
                        const existingSess = gameSessions.get(existingSid);
                        if (existingSess && !existingSess.finished) {
                            console.log(`[TOURNAMENT-ROOM] launch: skipping cid=${liveCid} (dbUserId=${entry.dbUserId}) — already in active session ${existingSid}`);
                            continue;
                        }
                    }
                    participantIds.push(liveCid);
                    // Keep the room entry's clientId in sync with the live slot
                    // we're about to start the tournament with.
                    entry.clientId = liveCid;
                }
            }
            if (participantIds.length < 2) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'not_enough_players' }));
                return;
            }
            // Pad up to 8 with CPU bots using default character (eld).
            const allParticipantIds = fillTournamentBots(participantIds);
            const botCount = allParticipantIds.length - participantIds.length;
            if (botCount > 0) {
                console.log(`[TOURNAMENT-ROOM] Added ${botCount} bot(s) to fill the bracket to 8`);
            }
            tournamentRoom.started = true;
            try {
                const tournamentId = await startTournament(allParticipantIds, dbUserId);
                tournamentRoom.tournamentId = tournamentId;
                const startedMsg = JSON.stringify({
                    type: 'tournament_started',
                    tournamentId,
                    playerIds: allParticipantIds,
                    botIds: allParticipantIds.slice(participantIds.length),
                });
                for (const entry of tournamentRoom.players) {
                    const livePl = liveWsForEntry(entry);
                    if (livePl) livePl.send(startedMsg);
                }
                console.log(`[TOURNAMENT-ROOM] Launched tournament ${tournamentId} with ${participantIds.length} players`);
                function _scheduleRoomReset(attempt) {
                    setTimeout(() => {
                        const sess = [...gameSession.gameSessions.values()]
                            .find(s => s.tournamentId === tournamentId);
                        if (sess && !sess.finished) {
                            _scheduleRoomReset(attempt + 1);
                        } else {
                            tournamentRoom.players    = [];
                            tournamentRoom.started    = false;
                            tournamentRoom.tournamentId = null;
                            console.log(`[TOURNAMENT-ROOM] Room reset after tournament ${tournamentId} (attempt ${attempt})`);
                        }
                    }, attempt === 0 ? 30000 : 5000);
                }
                _scheduleRoomReset(0);
            } catch (err) {
                console.error('[TOURNAMENT-ROOM] launch error:', err.message);
                tournamentRoom.started = false;
                tournamentRoom.tournamentId = null;
                const errMsg = JSON.stringify({ type: 'tournament_room_error', reason: 'launch_failed' });
                for (const entry of tournamentRoom.players) {
                    const livePl = liveWsForEntry(entry);
                    if (livePl) livePl.send(errMsg);
                }
            }
            return;
        }

        if (msg.type === 'input') {
            if (clientId === null) return;
            if (spectators[clientId]) return;
            if (!players[clientId]) { await promoteToPlayer(msg); return; }
            const inputSessionId = playerSession.get(clientId);
            const inputSession = inputSessionId ? gameSessions.get(inputSessionId) : null;
            if (inputSession && !inputSession.fightStarted &&
                Date.now() < (inputSession.startsAt ?? Infinity)) {
                return;
            }
            applyInput(players[clientId], msg);
            return;
        }

        if (spectators[clientId] && msg.type === 'spectator_ping') {
            sendStateToSpectator(spectators[clientId]);
        }

        if (msg.type === 'stage_select') {
            if (clientId === null) return;
            if (spectators[clientId]) return;
            const stageId = (msg.stageId ?? 0) | 0;

            {
                const _senderSid = playerSession.get(clientId) ?? null;
                let _isHost;
                if (_senderSid) {
                    const _sess    = gameSessions.get(_senderSid);
                    const _sessIds = _sess ? [..._sess.playerIds].filter(id => players[id]?.dbUserId != null) : [];
                    _isHost = _sessIds.length ? clientId === Math.min(..._sessIds) : true;
                } else {
                    if (players[clientId]?._seekingMatch === false) {
                        const p = players[clientId];
                        if (p) p._pendingStageId = stageId;
                        if (ws.readyState === WebSocket.OPEN)
                            ws.send(JSON.stringify({ type: 'stage_confirmed', stageId }));
                        console.log(`[STAGE_SELECT] tournament client=${clientId} stage=${stageId}`);
                        return;
                    }
                    const _lobbyQ = getLobbyQueue();
                    const _idx    = _lobbyQ.indexOf(clientId);
                    _isHost = _idx >= 0 && _idx % 2 === 0;
                }
                if (!_isHost) {
                    console.log(`[STAGE_SELECT] ignored: client=${clientId} is not pair-host`);
                    return;
                }
            }

            const senderSessionId = playerSession.get(clientId);
            const senderSession   = senderSessionId ? gameSessions.get(senderSessionId) : null;

            if (senderSession) {
                senderSession.stageId = stageId;
                const out = JSON.stringify({ type: 'stage_confirmed', stageId });
                let sentCount = 0;
                for (const cid of senderSession.playerIds) {
                    const pl = players[cid];
                    if (pl?.ws?.readyState === WebSocket.OPEN) { pl.ws.send(out); sentCount++; }
                }
                const sessSpecs = spectatorsBySession.get(senderSessionId);
                if (sessSpecs) {
                    for (const sid of sessSpecs) {
                        const spec = spectators[sid];
                        if (spec?.ws?.readyState === WebSocket.OPEN) { spec.ws.send(out); sentCount++; }
                    }
                }
                console.log(`[STAGE_SELECT] client=${clientId} session=${senderSessionId} stage=${stageId} -> sent to ${sentCount} clients`);
            } else {
                const p = players[clientId];
                if (p) p._pendingStageId = stageId;

                const lobbyQueue = getLobbyQueue();
                const hostIdx    = lobbyQueue.indexOf(clientId);
                const partnerIds = new Set([clientId]);
                if (hostIdx >= 0 && hostIdx % 2 === 0 && hostIdx + 1 < lobbyQueue.length) {
                    partnerIds.add(lobbyQueue[hostIdx + 1]);
                }

                const out = JSON.stringify({ type: 'stage_confirmed', stageId });
                for (const id of partnerIds) {
                    const pl = players[id];
                    if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(out);
                }
                console.log(`[STAGE_SELECT] client=${clientId} lobby stage=${stageId} -> pair=${[...partnerIds].join(',')}`);
                tryAutoMatch();
            }
            return;
        }

        if (msg.type === 'char_select') {
            if (clientId === null) return;
            if (spectators[clientId]) return;
            const charId  = CHAR_IDS.includes(msg.charId) ? msg.charId : 'eld';
            const stageId = (msg.stageId ?? 0) | 0;
            const p = players[clientId];
            if (p) applyCharDef(p, charId);
            playerCharSelected.set(clientId, charId);

            const senderSid     = playerSession.get(clientId) ?? null;
            const senderSession = senderSid ? gameSessions.get(senderSid) : null;

            const ack = JSON.stringify(buildCharSelectAck(charId, clientId, stageId, senderSession));

            if (senderSession) {
                for (const cid of senderSession.playerIds) {
                    const pl = players[cid];
                    if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(ack);
                }
                const sessSpecs = spectatorsBySession.get(senderSid);
                if (sessSpecs) {
                    for (const sid of sessSpecs) {
                        const spec = spectators[sid];
                        if (spec?.ws?.readyState === WebSocket.OPEN) spec.ws.send(ack);
                    }
                }
            } else {
                for (const [, pl] of Object.entries(players)) {
                    if (playerSession.has(pl.id)) continue;
                    if (pl.ws?.readyState === WebSocket.OPEN) pl.ws.send(ack);
                }
            }
            console.log(`[CHAR_SELECT] client=${clientId} char=${charId}`);
            if (!senderSession && players[clientId]?._seekingMatch !== false) tryAutoMatch();
        }
    });

    ws.on('close', async () => {
        if (clientId === null) return;

        const currentPlayerWs    = players[clientId]?.ws;
        const currentSpectatorWs = spectators[clientId]?.ws;
        if ((currentPlayerWs && currentPlayerWs !== ws) ||
            (currentSpectatorWs && currentSpectatorWs !== ws && !players[clientId])) {
            console.log(`[WS] close ignored for stale ws on slot ${clientId}`);
            return;
        }

        if (!tournamentRoom.started && dbUserId) {
            const tIdx = tournamentRoom.players.findIndex(p => p.dbUserId === dbUserId);
            if (tIdx !== -1) {
                tournamentRoom.players.splice(tIdx, 1);
                const roomMsg = JSON.stringify({
                    type: 'tournament_room_update',
                    players:      tournamentRoom.players,
                    started:      tournamentRoom.started,
                    tournamentId: tournamentRoom.tournamentId,
                    maxPlayers:   tournamentRoom.maxPlayers,
                });
                for (const entry of tournamentRoom.players) {
                    const livePl = liveWsForEntry(entry);
                    if (livePl) livePl.send(roomMsg);
                }
                console.log(`[TOURNAMENT-ROOM] ${dbUserId} removed on disconnect — ${tournamentRoom.players.length}/${tournamentRoom.maxPlayers}`);
            }
        }

        if (spectators[clientId]) {
            const spec = spectators[clientId];
            if (spec.dbRowId) {
                db.query(`UPDATE spectators SET left_at = NOW() WHERE id = $1`, [spec.dbRowId])
                  .catch(err => console.error('[SPECTATOR] left_at update error:', err.message));
            }
            if (spec.eliminated || spec.mode === 'voluntary') {
                lastState[clientId] = {
                    spectator: true, eliminated: spec.eliminated ?? false,
                    watchingSession: spec.watchingSession ?? null, mode: spec.mode,
                    timer: setTimeout(() => {
                        delete lastState[clientId];
                        playerCharSelected.delete(clientId);
                    }, GHOST_TTL),
                };
            }
            delete spectators[clientId];
            console.log(`[SPECTATOR] Client ${clientId} disconnected`);
            return;
        }

        if (!players[clientId]) return;

        const p                    = players[clientId];
        const disconnectedDbUserId  = p.dbUserId ?? null;
        const disconnectedSessionId = playerSession.get(clientId);
        const disconnectedSession   = disconnectedSessionId ? gameSessions.get(disconnectedSessionId) : null;

        delete players[clientId];
        playerSession.delete(clientId);

        if (disconnectedSession && !disconnectedSession.finished) {
            if (disconnectedSession.mode === 'training') {
                playerCharSelected.delete(clientId);
                delete lastState[clientId];
                removeFromLobbyQueue(clientId);
                disconnectedSession.finished = true;
                broadcastToSession(disconnectedSession, {
                    type: 'match_finished', sessionId: disconnectedSession.id,
                });
                gameSession.cleanupSession(disconnectedSession, null);
                broadcastState();
                console.log(`[SERVER] Player ${clientId} disconnected from training — ended immediately`);
                return;
            }

            if (!disconnectedSession.pendingEliminations) disconnectedSession.pendingEliminations = {};

            if (disconnectedSession.pendingEliminations[clientId]) {
                console.log(`[SERVER] Player ${clientId} disconnected mid-match — grace already running`);
            } else if (disconnectedSession.pendingWinner) {
                const { winnerId, loserId } = disconnectedSession.pendingWinner;
                disconnectedSession.pendingWinner = null;
                resolveMatchWinner(disconnectedSession, winnerId, loserId ?? clientId);
                playerCharSelected.delete(clientId);
            } else if (disconnectedSession.mode === 'tournament') {
                resolveTournamentGraceExpiry(disconnectedSession, clientId, disconnectedDbUserId);
                console.log(`[SERVER] Player ${clientId} disconnected from tournament — immediate forfeit`);
            } else {
                // Was 1500ms — too short for a real reload/reconnect round trip
                // (WASM re-init + WS handshake routinely takes 2-5s), so an
                // accidental disconnect (wifi blip, F5) would forfeit the
                // match before rejoin could land. Matched to the voluntary
                // leave-mid-match grace (GRACE_MS = 5000 below) so accidental
                // and voluntary disconnects give the same window to return.
                const GRACE_MS  = 5000;
                const expiresAt = Date.now() + GRACE_MS;

                players[clientId] = p;
                p.ws = null;
                playerSession.set(clientId, disconnectedSessionId);

                p.input.moveX = 0; p.input.jump = false; p.input.attack = false;
                p.input.dash  = false; p.input.dashAttack = false; p.input.block = false;

                broadcastToSession(disconnectedSession, {
                    type: 'leave_grace', clientId, expiresAt,
                    sessionId: disconnectedSession.id,
                });
                console.log(`[SERVER] Player ${clientId} disconnected mid-match — grace period started (${GRACE_MS}ms)`);

                disconnectedSession.pendingEliminations[clientId] = setTimeout(() => {
                    resolveGraceExpiry(disconnectedSession, clientId, disconnectedDbUserId);
                    console.log(`[SERVER] Player ${clientId} disconnect-grace expired — forfeit`);
                }, GRACE_MS);
            }
        } else {
            const _graceCid      = clientId;
            const _graceStageId  = p._pendingStageId;
            const _graceDbUserId = disconnectedDbUserId;
            const _graceSeek     = p._seekingMatch !== false;
            const _graceSnap     = {
                x: p.x, y: p.y, onGround: p.onGround, stocks: p.stocks,
                dbUserId: _graceDbUserId, pendingStageId: _graceStageId,
                seekingMatch: _graceSeek,
            };

            if (lobbyReconnectGrace.has(_graceCid)) {
                clearTimeout(lobbyReconnectGrace.get(_graceCid).timer);
                lobbyReconnectGrace.delete(_graceCid);
            }

            const _graceTimer = setTimeout(() => {
                lobbyReconnectGrace.delete(_graceCid);
                const _revived = players[_graceCid];
                if (_revived?.ws && _revived.ws.readyState === WebSocket.OPEN) {
                    console.log(`[SERVER] Player ${_graceCid} lobby-grace skipped -- slot reclaimed by reconnect`);
                    return;
                }
                notifyPairPartner(_graceCid);
                removeFromLobbyQueue(_graceCid);
                if (_graceSeek) notifyNewLobbyHost();
                if (!lastState[_graceCid]) {
                    lastState[_graceCid] = {
                        x: _graceSnap.x, y: _graceSnap.y,
                        onGround: _graceSnap.onGround, stocks: _graceSnap.stocks,
                        dbUserId: _graceDbUserId, sessionId: null,
                        pendingStageId: _graceStageId,
                        timer: setTimeout(() => {
                            delete lastState[_graceCid];
                            playerCharSelected.delete(_graceCid);
                        }, GHOST_TTL),
                    };
                }
                console.log(`[SERVER] Player ${_graceCid} lobby-grace expired -- removed from queue`);
                broadcastState();
            }, LOBBY_GRACE_MS);

            lobbyReconnectGrace.set(_graceCid, { timer: _graceTimer, snapshot: _graceSnap });
            console.log(`[SERVER] Player ${_graceCid} lobby-grace started (${LOBBY_GRACE_MS}ms)`);
        }

        console.log(`[SERVER] Player ${clientId} disconnected`);
        broadcastState();
    });

    ws.on('error', () => ws.close());
}

module.exports = { setupWebSocket };
