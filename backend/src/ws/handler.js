'use strict';

const WebSocket = require('ws');
const db        = require('../db');
const { SESSION_COOKIE } = require('../auth');

const {
    players, spectators, spectatorsBySession, lastState,
    gameSessions, playerSession, playerCharSelected,
    broadcastState, broadcastToSession, broadcastToAll,
    sendStateToSpectator, listActiveSessions,
    buildCharSelectAck, sendAllCharSelectsTo,
    createPlayer, startDuel, startTournament, tryAutoMatch,
    handleElimination, resolveMatchWinner, getLastWatchedSession,
    addToLobbyQueue, removeFromLobbyQueue, getLobbyQueue,
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS,
    tournamentRoom,
} = require('../game/session');

const gameSession = require('../game/session');

// --- Lobby reconnect grace ---
// When a lobby player's WS closes (F5, network blip), we delay the
// removeFromLobbyQueue + notifyNewLobbyHost calls by LOBBY_GRACE_MS.
// If a rejoin arrives within that window we cancel the timer silently,
// preserving the player's queue position and sparing their partner from a
// spurious stage_reset.
const LOBBY_GRACE_MS = 3000;
const lobbyReconnectGrace = new Map(); // clientId -> { timer, savedState }

// ─── WebSocket server setup ───────────────────────────────────────────────────

function setupWebSocket(server, wss) {
    server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        else socket.destroy();
    });
    wss.on('connection', onConnection);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Apply character stats from def onto a player object.
function applyCharDef(p, charId) {
    const def = CHARACTER_DEFS[charId] ?? CHARACTER_DEFS.eld;
    p.charId          = charId;
    p.moveSpeed       = def.moveSpeed;
    p.dashSpeed       = def.dashSpeed;
    p.attackKnockback = def.attackKnockback;
    p.attackRange     = def.attackRange;
}

// Copy input fields from a raw message onto a player.
function applyInput(p, msg) {
    p.input.moveX      = msg.moveX      ?? 0;
    p.input.jump       = !!msg.jump;
    p.input.attack     = !!msg.attack;
    p.input.dash       = !!msg.dash;
    p.input.dashDir    = msg.dashDir    ?? 0;
    p.input.crouch     = !!msg.crouch;
    p.input.block      = !!msg.block;
    p.input.dashAttack = !!msg.dashAttack;
}

// Broadcast host_status to every connected player.
function broadcastHostStatus() {
    // Host election is per-session: the lowest authenticated clientId within
    // each session (or the lobby) is that group's host for stage/char selection.
    // Players in different sessions must not share host state.

    // Group players by their current session (null = lobby).
    const groups = new Map(); // sessionId|null -> [clientId, ...]
    for (const [pid, pl] of Object.entries(players)) {
        if (pl.dbUserId == null) continue;   // unauthenticated — skip
        const sid = playerSession.get(Number(pid)) ?? null;
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid).push(Number(pid));
    }

    // Pre-compute lobby pair assignments using JOIN-TIME ORDER (lobbyJoinOrder),
    // not clientId order.  This ensures the first player to press "Find match"
    // is the host of their pair regardless of connection sequence.
    // A solo player waiting for a partner gets isHost=false until their partner arrives.
    const _lobbyIds = getLobbyQueue();  // already filtered to unmatched authenticated players
    const _lobbyHostSet = new Set();
    for (let _i = 0; _i + 1 < _lobbyIds.length; _i += 2) {
        _lobbyHostSet.add(_lobbyIds[_i]); // first-in-pair (join order) is host
    }

    for (const [, pl] of Object.entries(players)) {
        if (!pl.ws || pl.ws.readyState !== WebSocket.OPEN) continue;
        const sid = playerSession.get(pl.id) ?? null;
        let isHost;
        if (sid === null) {
            // Tournament waiting room players (_seekingMatch===false, not in lobby
            // queue) still need isHost:true so the SSS activates and they can pick
            // a character before the bracket starts.
            if (pl._seekingMatch === false) {
                isHost = true;
            } else {
                // Lobby: only the lower id of a complete pair is host.
                isHost = _lobbyHostSet.has(pl.id);
            }
        } else {
            // In-session: standard min-id host within the session group.
            const group = groups.get(sid) ?? [];
            const minId = group.length ? Math.min(...group) : pl.id;
            isHost = pl.id === minId;
        }
        pl.ws.send(JSON.stringify({ type: 'host_status', isHost }));
    }
}

// After a lobby player leaves, promote the new head of each pair to host and
// send them stage_reset so they can pick a stage fresh.
function notifyNewLobbyHost() {
    const q = getLobbyQueue();
    // Even indices are hosts of their respective pairs.
    for (let i = 0; i < q.length; i += 2) {
        const hostId = q[i];
        const pl = players[hostId];
        if (!pl?.ws || pl.ws.readyState !== 1 /* OPEN */) continue;
        // If this host has no pending stage yet, send stage_reset so SSS activates.
        if (pl._pendingStageId === undefined) {
            pl.ws.send(JSON.stringify({ type: 'stage_reset' }));
        }
    }
    broadcastHostStatus();
}

// Kick any existing player/spectator that already has this dbUserId.
// Called right before registering the new connection so there is never
// more than one active WS slot per account.
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
        // Clean up the old slot immediately so close handler finds nothing to process
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

// Send the standard post-join messages to a player's websocket.
function sendWelcomeToPlayer(ws, clientId) {
    ws.send(JSON.stringify({
        type: 'init', clientId,
        config: {
            attackRange:     players[clientId]?.attackRange ?? ATTACK_RANGE,
            attackRangeY:    ATTACK_RANGE_Y,
            dashAttackRange: DASH_ATTACK_RANGE_X,
        },
    }));

    // Send only the char selects for players in the same session (or lobby peers).
    const sid     = playerSession.get(clientId) ?? null;
    let   session = sid ? gameSessions.get(sid) : null;

    // ── Finished-session guard ────────────────────────────────────────────────
    // If the session the player is mapped to has already resolved (battle over),
    // clean up the stale mapping and redirect the player to the lobby.
    // This happens when a player rejoins during the ~8s linger window after
    // cleanupSession runs but before the Map entry is finally deleted.
    if (session?.finished) {
        playerSession.delete(clientId);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'match_finished', sessionId: sid }));
        }
        console.log(`[WS] sendWelcomeToPlayer: client ${clientId} had finished session ${sid} — redirecting to lobby`);
        session = null;
    }

    if (session) {
        // In-session: send chars of session peers only.
        for (const [cid, charId] of playerCharSelected.entries()) {
            if (!session.playerIds.has(cid)) continue;
            const ack = buildCharSelectAck(charId, cid, 0);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
        }
        // Use the stage confirmed for this session.
        const stageId = session.stageId ?? -1;
        ws.send(JSON.stringify(stageId >= 0
            ? { type: 'stage_confirmed', stageId }
            : { type: 'stage_reset' }
        ));
    } else {
        // Lobby: no session yet. Send chars of other lobby players and the
        // stage already chosen by whoever is waiting (if any).
        sendAllCharSelectsTo(ws);

        // Find the stage already chosen by this player's natural pair-partner.
        // Use getLobbyQueue() (join-time order) so pairs are stable.
        // Only the pair-partner's _pendingStageId is relevant — stages from other
        // pairs must not bleed across.
        const _lobbyQueue = getLobbyQueue();
        const _myIdx      = _lobbyQueue.indexOf(clientId);
        // Pair index: even slot is host, odd slot is guest.
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
}

// ─── Connection handler ───────────────────────────────────────────────────────

async function onConnection(ws, req) {
    let clientId         = null;
    let dbUserId         = null;
    let isSpectator      = false;
    let mode             = null;

    // Resolve session from cookie.
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

    // ── Spectator helpers ─────────────────────────────────────────────────────

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
        // config is piggybacked onto spectator_mode so the client can initialise
        // game constants without receiving an `init` message (which flips
        // _isSpectator = false and silently promotes the spectator to player).
        ws.send(JSON.stringify({
            type: 'spectator_mode', clientId, mode: specMode,
            watchingSession, activeSessions: listActiveSessions(),
            config: {
                attackRange:     ATTACK_RANGE,
                attackRangeY:    ATTACK_RANGE_Y,
                dashAttackRange: DASH_ATTACK_RANGE_X,
            },
        }));

        // Replay only the char selects for the players in the watched session.
        // Sending all players' chars would load wrong assets when multiple sessions run.
        const session = watchingSession ? gameSessions.get(watchingSession) : null;
        if (session) {
            const sessionPlayerIds = new Set(session.playerIds);
            for (const [cid, charId] of playerCharSelected.entries()) {
                if (!sessionPlayerIds.has(cid)) continue;
                const ack = gameSession.buildCharSelectAck(charId, cid, 0);
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
            }
            // Use the stage that was confirmed when this session started.
            // session.stageId is set by the host's stage_select message.
            // Fall back to the server-wide confirmedStageId for sessions started
            // before stage selection was persisted per-session.
            const stageId = session.stageId ?? gameSession.confirmedStageId ?? -1;
            if (stageId >= 0) {
                ws.send(JSON.stringify({ type: 'stage_confirmed', stageId }));
            } else {
                ws.send(JSON.stringify({ type: 'stage_reset' }));
            }
        } else {
            // Lobby spectator: no session to mirror, just reset.
            ws.send(JSON.stringify({ type: 'stage_reset' }));
        }

        // If the session is already running, send a synthetic match_start so
        // the client renderer starts its loop. Without this, spectators joining
        // mid-match stay stuck on the "waiting" screen forever.
        // NOTE: use type 'spectator_match_sync' (not 'match_start') so the client
        // does not treat this as joining the session as a player.
        if (session && !session.finished) {
            const _syncStageId = session.stageId ?? gameSession.confirmedStageId ?? -1;
            ws.send(JSON.stringify({
                type: 'spectator_match_sync',
                mode: session.mode,
                sessionId: session.id,
                players: [...session.playerIds],
                countdown: false,   // no countdown — game is already live
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
            // Use the full welcome (spectator_mode + chars + stage) instead of the
            // lighter spectator_session_changed, so the canvas loads the right assets
            // when the spectator switches from one session to another.
            sendSpectatorWelcome(specMode, watchingSession);
        }
    }

    // ── Player promotion ──────────────────────────────────────────────────────

    async function promoteToPlayer(initialMsg = null, seekingMatch = true) {
        if (clientId == null) clientId = gameSession.nextClientId++;
        if (players[clientId]) return;

        // No hard cap on player pool; tryAutoMatch pairs them into 1v1 sessions.

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

        kickDuplicateDbUser(clientId, dbUserId);

        players[clientId] = createPlayer(clientId, saved, ws);
        players[clientId].dbUserId = dbUserId;
        if (dbUserId) {
            db.query('SELECT username FROM users WHERE id = $1', [dbUserId])
              .then(r => { if (players[clientId] && r.rows[0]) players[clientId].username = r.rows[0].username; })
              .catch(() => {});
        }
        delete lastState[clientId];

        const restoredChar = playerCharSelected.get(clientId);
        if (restoredChar) applyCharDef(players[clientId], restoredChar);

        // Restore pending stage selection so a rejoining host can still be matched.
        const restoredStageId = lastState[clientId]?.pendingStageId ?? saved?.pendingStageId;
        if (restoredStageId !== undefined && players[clientId])
            players[clientId]._pendingStageId = restoredStageId;

        isSpectator = false;
        mode = 'player';

        // Only add to the lobby matchmaking queue if this player is actively seeking
        // a match (seekingMatch=true). Players joining for training (seekingMatch=false)
        // must not enter the queue — they are not waiting for a versus opponent.
        // addToLobbyQueue is idempotent: join paths already called it for versus/tournament,
        // so this only adds players arriving via rejoin paths.
        // Players in an active session are NOT added — they are in-game, not waiting.
        if (seekingMatch && !playerSession.has(clientId)) addToLobbyQueue(clientId);

        // Stamp the flag on the player object so char_select / stage_select handlers
        // can also skip matchmaking for training-only joins.
        if (players[clientId]) players[clientId]._seekingMatch = seekingMatch;

        sendWelcomeToPlayer(ws, clientId);

        if (initialMsg?.type === 'input') applyInput(players[clientId], initialMsg);

        broadcastState();
        console.log(`[SERVER] Player ${clientId} connected (${Object.keys(players).length}/${MAX_PLAYERS})`);
        // Trigger matchmaking only if this player is actively seeking a match AND
        // is fully ready (char + stage confirmed). Training joins must never auto-pair.
        const _rejoinPlayer = players[clientId];
        if (seekingMatch && playerCharSelected.has(clientId) && _rejoinPlayer?._pendingStageId !== undefined)
            tryAutoMatch();
    }

    // autoSpectatorTimer removed: clients always send join/rejoin/watch on ws.open.

    // ── Message handler ───────────────────────────────────────────────────────
    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }


        if (msg.type === 'join') {
            // ── dbUserId-first: if this user already has a slot, reuse it ──
            // Handles the case where a user opens a fresh tab (no sessionStorage
            // clientId) while already connected in another tab or mid-match.
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
                    // If the existing slot has an active grace-period timer (player
                    // left mid-match and the server hasn't resolved it yet), do NOT
                    // reuse that slot — let the timer fire and resolve the forfeit
                    // on its own. Give this reconnection a brand-new clientId so
                    // there is no conflict. The grace timer references the old clientId
                    // and will clean itself up correctly.
                    let graceActive = false;
                    for (const [, sess] of gameSessions.entries()) {
                        if (sess.pendingEliminations?.[existingClientId]) { graceActive = true; break; }
                    }
                    if (graceActive) {
                        console.log(`[WS] join: slot ${existingClientId} has active grace timer — assigning fresh clientId`);
                        clientId = gameSession.nextClientId++;
                        if (msg.seekingMatch !== false) addToLobbyQueue(clientId);   // only if actively seeking a match
                        await promoteToPlayer(null, msg.seekingMatch !== false);
                        return;
                    }

                    // Kick the old WS for that slot (may still be the first tab open)
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
                        // Only trigger matchmaking if this join is actively seeking a match
                        // AND the player has char+stage ready. Training re-joins (seekingMatch=false)
                        // must NOT auto-pair with someone waiting in the lobby.
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
                    // Ghost state (disconnected, grace period active)
                    const ghostState = lastState[clientId];
                    if (ghostState) { clearTimeout(ghostState.timer); delete lastState[clientId]; }
                    if (msg.seekingMatch !== false) addToLobbyQueue(clientId);   // only if actively seeking a match
                    await promoteToPlayer(null, msg.seekingMatch !== false);
                    return;
                }
            }

            if (clientId === null) clientId = gameSession.nextClientId++;
            if (msg.seekingMatch !== false) addToLobbyQueue(clientId);   // only if actively seeking a match
            await promoteToPlayer(null, msg.seekingMatch !== false);
            return;
        }

        if (msg.type === 'rejoin' && msg.clientId) {
            const requestedId = msg.clientId;

            // ── Primary lookup: find existing slot by dbUserId ─────────────
            // If this authenticated user already has an active slot (player or
            // spectator), redirect to THAT slot regardless of the clientId hint
            // the browser sent. This is the key fix for "same user, two tabs":
            // tab B sends its own sessionStorage clientId, but we ignore it and
            // reuse the slot that already belongs to this dbUserId.
            if (dbUserId) {
                let existingClientId = null;

                // Search active players first (most likely during a match)
                for (const [pid, pl] of Object.entries(players)) {
                    if (pl.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                }
                // Then ghost/lastState (disconnected but grace period still running)
                if (existingClientId === null) {
                    for (const [pid, gs] of Object.entries(lastState)) {
                        if (gs.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }
                // Then spectators
                if (existingClientId === null) {
                    for (const [pid, spec] of Object.entries(spectators)) {
                        if (spec.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }
                // Then lobby reconnect grace (player just disconnected, grace window active)
                if (existingClientId === null) {
                    for (const [pid, gr] of lobbyReconnectGrace.entries()) {
                        if (gr.snapshot.dbUserId === dbUserId) { existingClientId = Number(pid); break; }
                    }
                }

                if (existingClientId !== null && existingClientId !== requestedId) {
                    // There is an existing slot for this user that differs from the
                    // clientId hint. Kick the old WS connection if it is still open
                    // (second tab trying to reconnect while first tab is still live).
                    const oldPlayer = players[existingClientId];
                    const oldSpec   = spectators[existingClientId];
                    const oldWs     = oldPlayer?.ws ?? oldSpec?.ws;
                    if (oldWs && oldWs.readyState === WebSocket.OPEN) {
                        try {
                            oldWs.send(JSON.stringify({ type: 'kicked', reason: 'reconnected_in_another_tab' }));
                            oldWs.close(4001, 'Reconnected elsewhere');
                        } catch {}
                    }
                    // Redirect this new connection to the real slot
                    console.log(`[WS] rejoin: dbUserId ${dbUserId} redirected from hint ${requestedId} → existing slot ${existingClientId}`);
                    // Fall through with existingClientId as the effective requestedId
                    // by re-routing into the rejoin logic below using the correct id.
                    clientId = existingClientId;
                    if (clientId >= gameSession.nextClientId) gameSession.nextClientId = clientId + 1;

                    // Cancel any pending grace-period elimination for this slot
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
                    // Ghost state / lobby-grace: fall through to promoteToPlayer with corrected clientId.
                    // Cancel any lobby reconnect grace for this slot first.
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

            // ── Security: verify the slot belongs to this dbUserId ─────────
            // A rejoin is legitimate only if:
            //   (a) the slot has no dbUserId yet (anonymous player reconnecting), OR
            //   (b) the slot's dbUserId matches the cookie-resolved dbUserId.
            // This prevents tab B from stealing tab A's slot and also prevents
            // an unauthenticated client from hijacking an authenticated slot.
            const slotDbUserId =
                players[requestedId]?.dbUserId ??
                spectators[requestedId]?.dbUserId ??
                lastState[requestedId]?.dbUserId ??
                lobbyReconnectGrace.get(requestedId)?.snapshot?.dbUserId ??
                null;

            const ownershipOk =
                slotDbUserId === null ||          // anonymous slot — anyone may claim
                slotDbUserId === dbUserId;        // slot belongs to this account

            if (!ownershipOk) {
                // The requesting cookie does not match the slot owner.
                // Reject the rejoin and let the client join fresh instead.
                console.warn(`[WS] rejoin rejected: slot ${requestedId} owned by dbUserId ${slotDbUserId}, requester is ${dbUserId}`);
                clientId = gameSession.nextClientId++;
                await promoteToPlayer(null);
                return;
            }

            // ── Kick any OTHER slot already using this dbUserId ────────────
            // This handles: same user opens a second tab and both try to rejoin.
            // We allow the most-recent connection (this one) and boot the old one.
            kickDuplicateDbUser(requestedId, dbUserId);

            // ── Resume pending grace-period cancelation ────────────────────
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
                players[clientId].ws = ws;
                players[clientId].dbUserId = dbUserId ?? players[clientId].dbUserId;
                isSpectator = false; mode = 'player';
                const savedSession = lastState[clientId]?.sessionId ?? null;
                if (savedSession && gameSessions.has(savedSession) && !gameSessions.get(savedSession).finished && !playerSession.has(clientId))
                    playerSession.set(clientId, savedSession);
                // Restore lobby queue membership without changing queue position.
                // A player who hits F5 while waiting for a 1v1 match must rejoin at
                // their ORIGINAL position so their host/guest role and pair partner
                // are unchanged.  addToLobbyQueue is already idempotent (no-op if
                // already present), so we just call it -- never removeFromLobbyQueue
                // here, which would move them to the tail and break the pairing.
                // Skip for training-only players (_seekingMatch=false).
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
                // An eliminated player who disconnected from spectator view must
                // always re-enter as a fresh player, regardless of whether the
                // finished session is still in its linger window. Sending them
                // back into spectator_mode here is the zombie-spectator bug.
                if (!sessStillActive || ghostState.eliminated) {
                    playerCharSelected.delete(clientId);
                    await promoteToPlayer(null);
                } else {
                    await ensureSpectatorReady(ghostState.mode ?? 'overflow', watchSess, { eliminated: ghostState.eliminated ?? false });
                }
                return;
            }

            // ── Lobby reconnect grace: player hit F5 while waiting for a 1v1 ──
            // The close handler started a grace timer instead of removing from queue.
            // Cancel it now and restore the player slot at the SAME queue position.
            if (lobbyReconnectGrace.has(clientId)) {
                const gr = lobbyReconnectGrace.get(clientId);
                clearTimeout(gr.timer);
                lobbyReconnectGrace.delete(clientId);
                console.log(`[WS] rejoin: cancelled lobby grace for slot ${clientId} -- restoring slot in place`);
                // The player is still in the lobby queue (grace didn't fire yet).
                // Restore _seekingMatch from the snapshot so promoteToPlayer preserves it.
                await promoteToPlayer(null, gr.snapshot.seekingMatch !== false);
                return;
            }

            await promoteToPlayer(null);
            return;
        }

        if (msg.type === 'watch') {
            // If the client had a previous player slot (prevClientId sent by ws-client),
            // clean it up now so it doesn't linger in the player pool.
            const prevId = msg.prevClientId ? parseInt(msg.prevClientId, 10) : null;
            if (prevId && prevId !== clientId) {
                if (players[prevId]) {
                    // Remove from player pool; leave any in-session logic to the close handler
                    // (the WS for prevId is already gone — this is just a stale slot cleanup).
                    delete players[prevId];
                    playerSession.delete(prevId);
                    playerCharSelected.delete(prevId);
                    delete lastState[prevId];
                    console.log(`[WS] watch: cleaned up stale player slot ${prevId}`);
                }
            }

            if (clientId == null) clientId = gameSession.nextClientId++;

            // If this clientId was previously a player, remove it from the player pool
            // before entering spectators so the slot is not double-counted.
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
            // Validate DB-restored session is still active in memory
            const watchingSession = (_rawSession && gameSessions.has(_rawSession) && !gameSessions.get(_rawSession).finished)
                ? _rawSession
                : null;

            // ensureSpectatorReady registers the spectator AND calls sendSpectatorWelcome
            // for new spectators. For already-registered spectators the else-branch runs.
            await ensureSpectatorReady('voluntary', watchingSession ?? null);
            return;
        }

        if (msg.type === 'leave') {
            // ── Spectator: clean up immediately ──────────────────────────────
            if (spectators[clientId]) {
                const spec = spectators[clientId];
                if (spec.dbRowId) {
                    db.query('UPDATE spectators SET left_at = NOW() WHERE id = $1', [spec.dbRowId])
                      .catch(() => {});
                }
                delete spectators[clientId];
                // If this was an eliminated player-turned-spectator, also wipe
                // lastState and playerCharSelected so the slot doesn't get
                // re-entered as a zombie spectator on the next rejoin.
                if (spec.eliminated) {
                    if (lastState[clientId]?.timer) clearTimeout(lastState[clientId].timer);
                    delete lastState[clientId];
                    playerCharSelected.delete(clientId);
                }
                console.log(`[SERVER] Spectator ${clientId} left voluntarily${spec.eliminated ? ' (was eliminated)' : ''}`);
                return;
            }
            if (!players[clientId]) return;

            const leavingSession = playerSession.get(clientId)
                ? gameSessions.get(playerSession.get(clientId))
                : null;

            // ── Not in an active match: just remove from pool ─────────────────
            if (!leavingSession || leavingSession.finished) {
                removeFromLobbyQueue(clientId);
                const lp = players[clientId];
                delete players[clientId];
                playerSession.delete(clientId);
                if (lastState[clientId]?.timer) clearTimeout(lastState[clientId].timer);
                lastState[clientId] = {
                    x: lp?.x, y: lp?.y, onGround: lp?.onGround, stocks: lp?.stocks,
                    dbUserId: lp?.dbUserId ?? null, sessionId: null,
                    pendingStageId: lp?._pendingStageId,   // preserve host stage across leave/rejoin
                    timer: setTimeout(() => { delete lastState[clientId]; playerCharSelected.delete(clientId); }, GHOST_TTL),
                };
                notifyNewLobbyHost();  // promote next host if queue shifted
                broadcastState();
                console.log(`[SERVER] Player ${clientId} left voluntarily (lobby)`);
                return;
            }

            // ── Training session: end immediately, no grace period ────────────
            // There is no opponent to wait for — CPUs vanish with the session.
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
                return;
            }

            // ── In an active match: start 5-second grace period ───────────────
            if (!leavingSession.pendingEliminations) leavingSession.pendingEliminations = {};
            if (leavingSession.pendingEliminations[clientId]) {
                clearTimeout(leavingSession.pendingEliminations[clientId]);
            }

            const GRACE_MS  = 5000;
            const expiresAt = Date.now() + GRACE_MS;

            // Freeze the leaving player's inputs so they don't keep moving.
            const lp = players[clientId];
            if (lp) {
                lp.input.moveX = 0; lp.input.jump = false; lp.input.attack = false;
                lp.input.dash  = false; lp.input.dashAttack = false; lp.input.block = false;
            }

            // Notify both players (and spectators) about the grace window.
            broadcastToSession(leavingSession, { type: 'leave_grace', clientId, expiresAt, sessionId: leavingSession.id });
            console.log(`[SERVER] Player ${clientId} left mid-match — grace period started (${GRACE_MS}ms)`);

            leavingSession.pendingEliminations[clientId] = setTimeout(() => {
                delete leavingSession.pendingEliminations[clientId];
                const p2          = players[clientId];
                const leavingDbId = p2?.dbUserId ?? null;
                delete players[clientId];
                playerSession.delete(clientId);
                playerCharSelected.delete(clientId);
                delete lastState[clientId];

                if (!leavingSession.finished) {
                    leavingSession.eliminated.add(clientId);
                    leavingSession.loserDbId   = leavingDbId;
                    leavingSession.loserStocks = p2?.stocks ?? 0;
                    broadcastToAll({ type: 'player_eliminated', clientId });
                    broadcastToSession(leavingSession, { type: 'leave_grace_expired', clientId });
                    const remaining = [...leavingSession.playerIds].filter(id => !leavingSession.eliminated.has(id));
                    if (remaining.length === 1) {
                        resolveMatchWinner(leavingSession, remaining[0], clientId);
                    } else if (remaining.length === 0) {
                        leavingSession.finished = true;
                        broadcastToSession(leavingSession, { type: 'match_end', winner: null, loser: clientId, matchId: null, mode: leavingSession.mode });
                        setTimeout(() => gameSessions.delete(leavingSession.id), 6000);
                    }
                }
                broadcastState();
                console.log(`[SERVER] Player ${clientId} grace expired — forfeit`);
            }, GRACE_MS);

            return;
        }

        // ── Tournament waiting room ───────────────────────────────────────────
        if (msg.type === 'tournament_join') {
            if (!dbUserId) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'not_authenticated' }));
                return;
            }
            if (tournamentRoom.started) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'already_started' }));
                return;
            }
            if (tournamentRoom.players.length >= tournamentRoom.maxPlayers) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'room_full' }));
                return;
            }
            const alreadyIn = tournamentRoom.players.some(p => p.dbUserId === dbUserId);
            if (!alreadyIn) {
                // Resolve username: prefer already-loaded player object, fall back to DB query.
                let username = players[clientId]?.username ?? null;
                if (!username && dbUserId) {
                    try {
                        const { rows: uRows } = await db.query('SELECT username FROM users WHERE id = $1', [dbUserId]);
                        username = uRows[0]?.username ?? null;
                        if (players[clientId]) players[clientId].username = username;
                    } catch (_) {}
                }
                tournamentRoom.players.push({ clientId, dbUserId, username });
            }
            const roomMsg = JSON.stringify({
                type: 'tournament_room_update',
                players:    tournamentRoom.players,
                started:    tournamentRoom.started,
                tournamentId: tournamentRoom.tournamentId,
                maxPlayers: tournamentRoom.maxPlayers,
            });
            for (const entry of tournamentRoom.players) {
                const pl = players[entry.clientId];
                if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(roomMsg);
            }
            console.log(`[TOURNAMENT-ROOM] ${dbUserId} joined — ${tournamentRoom.players.length}/${tournamentRoom.maxPlayers}`);
            return;
        }

        if (msg.type === 'tournament_leave') {
            if (!dbUserId) return;
            const idx = tournamentRoom.players.findIndex(p => p.dbUserId === dbUserId);
            if (idx === -1) return;
            tournamentRoom.players.splice(idx, 1);
            if (players[clientId]?.ws?.readyState === WebSocket.OPEN) {
                players[clientId].ws.send(JSON.stringify({
                    type: 'tournament_room_update',
                    players:    tournamentRoom.players,
                    started:    tournamentRoom.started,
                    tournamentId: tournamentRoom.tournamentId,
                    maxPlayers: tournamentRoom.maxPlayers,
                    leftRoom: true,
                }));
            }
            const roomMsgLeave = JSON.stringify({
                type: 'tournament_room_update',
                players:    tournamentRoom.players,
                started:    tournamentRoom.started,
                tournamentId: tournamentRoom.tournamentId,
                maxPlayers: tournamentRoom.maxPlayers,
            });
            for (const entry of tournamentRoom.players) {
                const pl = players[entry.clientId];
                if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(roomMsgLeave);
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
            // Resolve current clientIds by dbUserId (handles reconnections where clientId may have changed).
            const participantIds = [];
            for (const entry of tournamentRoom.players) {
                // Find the live player slot for this dbUserId
                let liveCid = null;
                for (const [pid, pl] of Object.entries(players)) {
                    if (pl.dbUserId === entry.dbUserId && pl.ws?.readyState === WebSocket.OPEN) {
                        liveCid = Number(pid); break;
                    }
                }
                if (liveCid !== null) participantIds.push(liveCid);
            }
            if (participantIds.length < 2) {
                if (players[clientId]?.ws?.readyState === WebSocket.OPEN)
                    players[clientId].ws.send(JSON.stringify({ type: 'tournament_room_error', reason: 'not_enough_players' }));
                return;
            }
            tournamentRoom.started = true;
            try {
                const tournamentId = await startTournament(participantIds, dbUserId);
                tournamentRoom.tournamentId = tournamentId;
                const startedMsg = JSON.stringify({
                    type: 'tournament_started',
                    tournamentId,
                    playerIds: participantIds,
                });
                for (const entry of tournamentRoom.players) {
                    const pl = players[entry.clientId];
                    if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(startedMsg);
                }
                console.log(`[TOURNAMENT-ROOM] Launched tournament ${tournamentId} with ${participantIds.length} players`);
                // Reset room after 30s so it can be reused
                setTimeout(() => {
                    tournamentRoom.players    = [];
                    tournamentRoom.started    = false;
                    tournamentRoom.tournamentId = null;
                }, 30000);
            } catch (err) {
                console.error('[TOURNAMENT-ROOM] launch error:', err.message);
                tournamentRoom.started = false;
                const errMsg = JSON.stringify({ type: 'tournament_room_error', reason: 'launch_failed' });
                for (const entry of tournamentRoom.players) {
                    const pl = players[entry.clientId];
                    if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(errMsg);
                }
            }
            return;
        }

        if (msg.type === 'input') {
            if (spectators[clientId]) return;
            if (!players[clientId]) { await promoteToPlayer(msg); return; }
            applyInput(players[clientId], msg);
            return;
        }

        if (spectators[clientId] && msg.type === 'spectator_ping') {
            sendStateToSpectator(spectators[clientId]);
        }

        if (msg.type === 'stage_select') {
            if (spectators[clientId]) return;
            const stageId = (msg.stageId ?? 0) | 0;

            // Only the pair-host may send stage_select.
            // In-session: lowest id in the session. In lobby: lowest id in the pair (even slot).
            {
                const _senderSid = playerSession.get(clientId) ?? null;
                let _isHost;
                if (_senderSid) {
                    const _sess = gameSessions.get(_senderSid);
                    const _sessIds = _sess ? [..._sess.playerIds].filter(id => players[id]?.dbUserId != null) : [];
                    _isHost = _sessIds.length ? clientId === Math.min(..._sessIds) : true;
                } else {
                    // Tournament waiting room players (_seekingMatch=false) are not
                    // in the lobby queue but ARE allowed to select stage — it will be
                    // stored in _pendingStageId and used when their bracket match starts.
                    if (players[clientId]?._seekingMatch === false) {
                        const p = players[clientId];
                        if (p) p._pendingStageId = stageId;
                        // Confirm stage only to this player (no pair partner yet).
                        if (ws.readyState === WebSocket.OPEN)
                            ws.send(JSON.stringify({ type: 'stage_confirmed', stageId }));
                        console.log(`[STAGE_SELECT] tournament client=${clientId} stage=${stageId}`);
                        return;
                    }
                    const _lobbyQ = getLobbyQueue();  // join-time order
                    const _idx = _lobbyQ.indexOf(clientId);
                    // Host is the first player in the queue (idx 0, 2, 4…).
                    // A solo host (no partner yet) can still select stage — they just
                    // broadcast only to themselves until a partner joins.
                    _isHost = _idx >= 0 && _idx % 2 === 0;
                }
                if (!_isHost) {
                    console.log(`[STAGE_SELECT] ignored: client=${clientId} is not pair-host`);
                    return;
                }
            }

            // Persist on the player's own session (or as a pending value before matchmaking).
            const senderSessionId = playerSession.get(clientId);
            const senderSession   = senderSessionId ? gameSessions.get(senderSessionId) : null;

            if (senderSession) {
                // In a live session — confirm only within this session + its spectators.
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
                // Lobby — store stage on the host player object.
                // Only broadcast to the host's natural pair-partner (the player they will
                // be matched with by tryAutoMatch: authenticated, no session, sorted by id).
                // This prevents stage selections from crossing between concurrent pairs.
                const p = players[clientId];
                if (p) p._pendingStageId = stageId;

                // Find the natural pair for this host: all lobby players sorted by id,
                // the host is at some even index 2k, their partner is at 2k+1.
                const lobbyQueue = getLobbyQueue();  // join-time order
                const hostIdx = lobbyQueue.indexOf(clientId);
                // hostIdx should be even (they are the host of their pair).
                // Their partner is at hostIdx+1 (or nobody if queue is odd).
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
                // Stage confirmed in lobby: try to pair now.
                // Both players must have char + stage confirmed to be matched.
                tryAutoMatch();
            }
            return;
        }

        if (msg.type === 'char_select') {
            // Spectators must not participate in char selection or trigger matchmaking.
            if (spectators[clientId]) return;
            const charId  = CHAR_IDS.includes(msg.charId) ? msg.charId : 'eld';
            const stageId = (msg.stageId ?? 0) | 0;
            const p = players[clientId];
            if (p) applyCharDef(p, charId);
            playerCharSelected.set(clientId, charId);

            // Broadcast char_select_ack only to peers in the same session (or lobby).
            const senderSid     = playerSession.get(clientId) ?? null;
            const senderSession = senderSid ? gameSessions.get(senderSid) : null;

            // Build an ack scoped to only the relevant players.
            const ack = JSON.stringify(buildCharSelectAck(charId, clientId, stageId, senderSession));

            if (senderSession) {
                // In-session: tell only the two fighters + spectators of this session.
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
                // Lobby: send to lobby players (seeking match) AND tournament waiting
                // room players (_seekingMatch:false, no session) so they all see
                // each other's character selections before the bracket starts.
                for (const [, pl] of Object.entries(players)) {
                    if (playerSession.has(pl.id)) continue;   // skip in-session players
                    if (pl.ws?.readyState === WebSocket.OPEN) pl.ws.send(ack);
                }
            }
            console.log(`[CHAR_SELECT] client=${clientId} char=${charId}`);
            // Trigger matchmaking in lobby: covers the common case where the host
            // already selected a stage but the guest hadn't chosen a char yet.
            // tryAutoMatch is idempotent and checks all preconditions internally.
            // Skip if this player joined for training only (_seekingMatch=false).
            if (!senderSession && players[clientId]?._seekingMatch !== false) tryAutoMatch();
        }
    });

    // ── Close handler ─────────────────────────────────────────────────────────
    ws.on('close', async () => {
        if (clientId === null) return;

        // If the slot was already reused by a newer connection (e.g. page reload),
        // the current ws is stale — ignore this close to avoid corrupting the new slot.
        const currentPlayerWs   = players[clientId]?.ws;
        const currentSpectatorWs = spectators[clientId]?.ws;
        if ((currentPlayerWs && currentPlayerWs !== ws) ||
            (currentSpectatorWs && currentSpectatorWs !== ws && !players[clientId])) {
            console.log(`[WS] close ignored for stale ws on slot ${clientId}`);
            return;
        }

        // Remove from tournament waiting room if the player disconnects before launch.
        if (!tournamentRoom.started && dbUserId) {
            const tIdx = tournamentRoom.players.findIndex(p => p.dbUserId === dbUserId);
            if (tIdx !== -1) {
                tournamentRoom.players.splice(tIdx, 1);
                const roomMsg = JSON.stringify({
                    type: 'tournament_room_update',
                    players:    tournamentRoom.players,
                    started:    tournamentRoom.started,
                    tournamentId: tournamentRoom.tournamentId,
                    maxPlayers: tournamentRoom.maxPlayers,
                });
                for (const entry of tournamentRoom.players) {
                    const pl = players[entry.clientId];
                    if (pl?.ws?.readyState === WebSocket.OPEN) pl.ws.send(roomMsg);
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

        const p = players[clientId];
        const disconnectedDbUserId  = p.dbUserId ?? null;
        const disconnectedSessionId = playerSession.get(clientId);
        const disconnectedSession   = disconnectedSessionId ? gameSessions.get(disconnectedSessionId) : null;

        delete players[clientId];
        playerSession.delete(clientId);

        if (disconnectedSession && !disconnectedSession.finished) {
            // ── Training session: end immediately on disconnect, no grace ─────
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
                // Fall through to the broadcastState + log at end of close handler
                // is skipped by the early return above in the leave path, but here
                // we already called broadcastState so just return.
                return;
            }

            // ── Disconnect during active fight = grace period (same as 'leave') ──
            // Give the player 5 s to reconnect (F5, network blip, etc.) before
            // forfeiting.  If a grace timer is already running from a prior 'leave'
            // message we leave it untouched — it will fire on its own schedule.
            if (!disconnectedSession.pendingEliminations) disconnectedSession.pendingEliminations = {};

            if (disconnectedSession.pendingEliminations[clientId]) {
                // Grace already ticking (player pressed ← Lobby then immediately
                // closed the tab).  Nothing extra to do — existing timer handles it.
                console.log(`[SERVER] Player ${clientId} disconnected mid-match — grace already running`);
            } else if (disconnectedSession.pendingWinner) {
                // Winner decided at the same frame as the disconnect — resolve now.
                const { winnerId, loserId } = disconnectedSession.pendingWinner;
                disconnectedSession.pendingWinner = null;
                resolveMatchWinner(disconnectedSession, winnerId, loserId ?? clientId);
                playerCharSelected.delete(clientId);
            } else {
                const GRACE_MS  = 5000;
                const expiresAt = Date.now() + GRACE_MS;

                // Keep the player object alive (ws is gone but state is still needed
                // for a potential rejoin).  Re-add to players map without a live ws.
                players[clientId] = p;
                p.ws = null;
                playerSession.set(clientId, disconnectedSessionId);

                // Freeze inputs so the ghost character stands still.
                p.input.moveX = 0; p.input.jump = false; p.input.attack = false;
                p.input.dash  = false; p.input.dashAttack = false; p.input.block = false;

                broadcastToSession(disconnectedSession, {
                    type: 'leave_grace', clientId, expiresAt,
                    sessionId: disconnectedSession.id,
                });
                console.log(`[SERVER] Player ${clientId} disconnected mid-match — grace period started (${GRACE_MS}ms)`);

                disconnectedSession.pendingEliminations[clientId] = setTimeout(() => {
                    delete disconnectedSession.pendingEliminations[clientId];
                    const p2          = players[clientId];
                    const leavingDbId = p2?.dbUserId ?? disconnectedDbUserId;
                    delete players[clientId];
                    playerSession.delete(clientId);
                    playerCharSelected.delete(clientId);
                    delete lastState[clientId];

                    if (!disconnectedSession.finished) {
                        disconnectedSession.eliminated.add(clientId);
                        disconnectedSession.loserDbId   = leavingDbId;
                        disconnectedSession.loserStocks = p2?.stocks ?? 0;
                        broadcastToAll({ type: 'player_eliminated', clientId });
                        broadcastToSession(disconnectedSession, { type: 'leave_grace_expired', clientId });
                        const remaining = [...disconnectedSession.playerIds]
                            .filter(id => !disconnectedSession.eliminated.has(id));
                        if (remaining.length === 1) {
                            resolveMatchWinner(disconnectedSession, remaining[0], clientId);
                        } else if (remaining.length === 0) {
                            disconnectedSession.finished = true;
                            broadcastToSession(disconnectedSession, {
                                type: 'match_end', winner: null, loser: clientId,
                                matchId: null, mode: disconnectedSession.mode,
                            });
                            setTimeout(() => gameSessions.delete(disconnectedSession.id), 6000);
                        }
                    }
                    broadcastState();
                    console.log(`[SERVER] Player ${clientId} disconnect-grace expired — forfeit`);
                }, GRACE_MS);
            }
        } else {
            // Disconnected from lobby (no active session).
            // Give the player LOBBY_GRACE_MS to reconnect (F5, network blip) before
            // removing them from the queue and notifying their partner.  If they
            // rejoin within the grace window the timer is cancelled and their queue
            // position is preserved -- their partner never sees a spurious stage_reset.
            const _graceCid      = clientId;
            const _graceStageId  = p._pendingStageId;
            const _graceDbUserId = disconnectedDbUserId;
            const _graceSeek     = p._seekingMatch !== false;
            const _graceSnap     = {
                x: p.x, y: p.y, onGround: p.onGround, stocks: p.stocks,
                dbUserId: _graceDbUserId, pendingStageId: _graceStageId,
                seekingMatch: _graceSeek,
            };

            // Cancel any pre-existing grace for this slot (double-close guard).
            if (lobbyReconnectGrace.has(_graceCid)) {
                clearTimeout(lobbyReconnectGrace.get(_graceCid).timer);
                lobbyReconnectGrace.delete(_graceCid);
            }

            const _graceTimer = setTimeout(() => {
                lobbyReconnectGrace.delete(_graceCid);
                // Player did not reconnect in time -- commit the removal.
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