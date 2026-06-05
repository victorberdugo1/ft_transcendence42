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
    MAX_PLAYERS, GHOST_TTL,
    ATTACK_RANGE, ATTACK_RANGE_Y, DASH_ATTACK_RANGE_X,
    CHAR_IDS, CHARACTER_DEFS,
} = require('../game/session');

const gameSession = require('../game/session');

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

    for (const [, pl] of Object.entries(players)) {
        if (!pl.ws || pl.ws.readyState !== WebSocket.OPEN) continue;
        const sid   = playerSession.get(pl.id) ?? null;
        const group = groups.get(sid) ?? [];
        const minId = group.length ? Math.min(...group) : pl.id;
        pl.ws.send(JSON.stringify({ type: 'host_status', isHost: pl.id === minId }));
    }
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
    const session = sid ? gameSessions.get(sid) : null;
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

        // If any lobby peer has already picked a stage, mirror it so the
        // new joiner doesn't see a stale "no stage" state.
        let lobbyStage = -1;
        for (const [, pl] of Object.entries(players)) {
            if (pl.id === clientId) continue;
            if (playerSession.has(pl.id)) continue;   // skip in-session
            if (pl._pendingStageId !== undefined) { lobbyStage = pl._pendingStageId; break; }
        }
        if (lobbyStage >= 0) {
            ws.send(JSON.stringify({ type: 'stage_confirmed', stageId: lobbyStage }));
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
                    [dbUserId, watchingSession ?? 'lobby', tournamentId, specMode]
                );
                current.dbRowId = dbRows[0]?.id ?? null;
            } catch (err) {
                console.error('[SPECTATOR] DB insert error:', err.message);
            }
        } else {
            db.query(
                `UPDATE spectators SET session_id = $1, tournament_id = $2, mode = $3 WHERE id = $4`,
                [watchingSession ?? 'lobby', tournamentId, specMode, current.dbRowId]
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
            ws.send(JSON.stringify({
                type: 'spectator_match_sync',
                mode: session.mode,
                sessionId: session.id,
                players: [...session.playerIds],
                countdown: false,   // no countdown — game is already live
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

    async function promoteToPlayer(initialMsg = null) {
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

        isSpectator = false;
        mode = 'player';

        sendWelcomeToPlayer(ws, clientId);

        if (initialMsg?.type === 'input') applyInput(players[clientId], initialMsg);

        broadcastState();
        console.log(`[SERVER] Player ${clientId} connected (${Object.keys(players).length}/${MAX_PLAYERS})`);
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
                        isSpectator = false; mode = 'player';
                        sendWelcomeToPlayer(ws, clientId);
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
                    await promoteToPlayer(null);
                    return;
                }
            }

            if (clientId === null) clientId = gameSession.nextClientId++;
            await promoteToPlayer(null);
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
                        if (savedSession && gameSessions.has(savedSession) && !playerSession.has(clientId))
                            playerSession.set(clientId, savedSession);
                        sendWelcomeToPlayer(ws, clientId);
                        return;
                    }
                    if (spectators[clientId]) {
                        spectators[clientId].ws = ws;
                        spectators[clientId].dbUserId = dbUserId;
                        isSpectator = true; mode = spectators[clientId].mode;
                        sendSpectatorWelcome(mode, spectators[clientId].watchingSession);
                        return;
                    }
                    // Ghost state: fall through to promoteToPlayer with the corrected clientId
                    const ghostState = lastState[clientId];
                    if (ghostState) {
                        clearTimeout(ghostState.timer);
                        delete lastState[clientId];
                    }
                    await promoteToPlayer(null);
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
                if (savedSession && gameSessions.has(savedSession) && !playerSession.has(clientId))
                    playerSession.set(clientId, savedSession);
                sendWelcomeToPlayer(ws, clientId);
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
                if (!sessStillActive) {
                    playerCharSelected.delete(clientId);
                    await promoteToPlayer(null);
                } else {
                    await ensureSpectatorReady(ghostState.mode ?? 'overflow', watchSess, { eliminated: ghostState.eliminated ?? false });
                }
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
                console.log(`[SERVER] Spectator ${clientId} left voluntarily`);
                return;
            }
            if (!players[clientId]) return;

            const leavingSession = playerSession.get(clientId)
                ? gameSessions.get(playerSession.get(clientId))
                : null;

            // ── Not in an active match: just remove from pool ─────────────────
            if (!leavingSession || leavingSession.finished) {
                const lp = players[clientId];
                delete players[clientId];
                playerSession.delete(clientId);
                if (lastState[clientId]?.timer) clearTimeout(lastState[clientId].timer);
                lastState[clientId] = {
                    x: lp?.x, y: lp?.y, onGround: lp?.onGround, stocks: lp?.stocks,
                    dbUserId: lp?.dbUserId ?? null, sessionId: null,
                    timer: setTimeout(() => { delete lastState[clientId]; playerCharSelected.delete(clientId); }, GHOST_TTL),
                };
                broadcastState();
                console.log(`[SERVER] Player ${clientId} left voluntarily (lobby)`);
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
                // Lobby — store as pending on the player object until a session is created.
                const p = players[clientId];
                if (p) p._pendingStageId = stageId;
                gameSession.confirmedStageId = stageId;
                // Confirm to all lobby players (no session yet) so their UI unblocks.
                const out = JSON.stringify({ type: 'stage_confirmed', stageId });
                for (const [, pl] of Object.entries(players)) {
                    if (playerSession.has(pl.id)) continue;   // skip in-session players
                    if (pl.ws?.readyState === WebSocket.OPEN) pl.ws.send(out);
                }
                console.log(`[STAGE_SELECT] client=${clientId} lobby stage=${stageId} (pending, broadcast to lobby)`);
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
                // Lobby: player hasn't been matched yet — send to lobby players only
                // (those also without a session) and to the sender themselves.
                for (const [, pl] of Object.entries(players)) {
                    if (playerSession.has(pl.id)) continue;   // skip in-session players
                    if (pl.ws?.readyState === WebSocket.OPEN) pl.ws.send(ack);
                }
            }
            console.log(`[CHAR_SELECT] client=${clientId} char=${charId}`);
            tryAutoMatch();
        }
    });

    // ── Close handler ─────────────────────────────────────────────────────────
    ws.on('close', async () => {
        if (clientId === null) return;

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
            // Disconnected from lobby (no active session) — save state so they
            // keep their selected character if they reconnect quickly.
            lastState[clientId] = {
                x: p.x, y: p.y, onGround: p.onGround, stocks: p.stocks,
                dbUserId:  disconnectedDbUserId,
                sessionId: null,
                timer: setTimeout(() => {
                    delete lastState[clientId];
                    playerCharSelected.delete(clientId);
                }, GHOST_TTL),
            };
        }

        console.log(`[SERVER] Player ${clientId} disconnected`);
        broadcastState();
    });

    ws.on('error', () => ws.close());
}

module.exports = { setupWebSocket };