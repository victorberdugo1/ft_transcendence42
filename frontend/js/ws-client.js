// NOTE: window._ globals are part of the ABI with main.c (Emscripten/EM_JS).
// Do NOT rename: _myClientId, _isSpectator, _gameState, _gameConfig,
// _victoryActive, _victoryConsumed, _victoryIsWinner, _victoryWinner,
// _overlayReady, _hitstopState, _countdownStart, _countdownDone,
// _canvasWidth, _canvasHeight.
// React-only (safe to rename with a coordinated PR):
// _spectatorMode, _matchSession, _lastMatchResult, _tournamentResult,
// _eliminatedFromSession, _charSelectData, _charSelectConfirmed.

(function restoreLastState() {
    try {
        const saved = sessionStorage.getItem('gameState');
        window._gameState = saved ? JSON.parse(saved) : { players: {} };
    } catch {
        window._gameState = { players: {} };
    }
})();

window._myClientId     = -1;
window._ws             = null;
window._charSelectData = null;

const ACTION_KEY     = 'Space';
const ACTION_KEY_ALT = 'KeyG';
const DASH_TAP_MS    = 300;
const DASH_ATTACK_MS = 200;
const ACTION_HOLD_MS = 350;
const DASH_KEYS      = new Set(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD']);

const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

const EMPTY_FRAME  = Object.freeze({ jump: false, attack: false, dash: false, dashDir: 0, dashAttack: false });
const frameEvents  = { ...EMPTY_FRAME };

let actionDownAt = 0;
let actionFired  = false;
let lastTap      = { code: '', time: 0 };
let dashEndTime  = 0;

const isActionKey = code => code === ACTION_KEY || code === ACTION_KEY_ALT;

window.addEventListener('keydown', e => {
    if (e.repeat || !isActionKey(e.code)) return;
    actionDownAt = Date.now();
    actionFired  = false;
});

window.addEventListener('keyup', e => {
    if (!isActionKey(e.code)) return;
    if (!actionFired && Date.now() - actionDownAt < ACTION_HOLD_MS) {
        const sinceDash = Date.now() - dashEndTime;
        if (dashEndTime > 0 && sinceDash < DASH_ATTACK_MS) {
            frameEvents.dashAttack = true;
            dashEndTime = 0;
        } else {
            frameEvents.attack = true;
        }
    }
    actionFired = false;
});

window.addEventListener('keydown', e => {
    if (e.repeat || !DASH_KEYS.has(e.code)) return;
    const now = Date.now();
    if (e.code === lastTap.code && now - lastTap.time < DASH_TAP_MS) {
        frameEvents.dash    = true;
        frameEvents.dashDir = (e.code === 'ArrowRight' || e.code === 'KeyD') ? 1 : -1;
        dashEndTime = now + 120;
    }
    lastTap = { code: e.code, time: now };
});

window.addEventListener('keydown', e => {
    if (!e.repeat && (e.code === 'KeyW' || e.code === 'ArrowUp')) frameEvents.jump = true;
});

setInterval(() => {
    if (window._myClientId === -1) { Object.assign(frameEvents, EMPTY_FRAME); return; }

    sendInput({
        moveX:      (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0),
        jump:       frameEvents.jump,
        attack:     frameEvents.attack,
        dash:       frameEvents.dash,
        dashDir:    frameEvents.dashDir,
        crouch:     !!(keys['KeyS'] || keys['ArrowDown']),
        block:      !!(keys[ACTION_KEY] || keys[ACTION_KEY_ALT]),
        dashAttack: frameEvents.dashAttack,
    });

    Object.assign(frameEvents, EMPTY_FRAME);
}, 1000 / 60);

function _sssClear() {
    try {
        sessionStorage.removeItem('charSelectData');
        sessionStorage.removeItem('pendingCharSelect');
    } catch (_) {}
}

function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws       = new WebSocket(`${protocol}//${location.host}/ws`);
    window._ws     = ws;

    function setStatus(text) {
        const el = document.getElementById('status');
        if (el) el.textContent = text;
    }

    ws.addEventListener('open', () => {
        setStatus('⬤ Connected');
        const savedId = sessionStorage.getItem('clientId');

        Object.assign(window, {
            _gameState:              { type: 'state', frameId: 0, players: {} },
            _isSpectator:            false,
            _spectatorMode:          null,
            _eliminatedFromSession:  null,
            _confirmedStageId:       undefined,
            _isHost:                 undefined,
            _charSelectConfirmed:    false,
        });
        try { sessionStorage.removeItem('confirmedStageId'); } catch (_) {}

        if (!savedId) {
            window._charSelectData = null;
            _sssClear();
        } else {
            try {
                const saved = sessionStorage.getItem('charSelectData');
                window._charSelectData = saved ? JSON.parse(saved) : null;
                window._charSelectConfirmed = !!saved;
            } catch {
                window._charSelectData = null;
            }

            const _pcs = sessionStorage.getItem('pendingCharSelect');
            if (_pcs) {
                try {
                    const { charId, charIdx, stageId } = JSON.parse(_pcs);
                    setTimeout(() => {
                        if (!window._isSpectator && window._ws?.readyState === WebSocket.OPEN)
                            sendCharSelect(charId, charIdx ?? 0, stageId ?? 0);
                    }, 300);
                } catch {}
            }
        }

        // ── Mode-aware join ───────────────────────────────────────────────
        // window._pendingGameMode is set by App.jsx / GameShell before game.js loads.
        // Values: "versus" | "training" | "tournament" | "spectate"
        const mode = window._pendingGameMode ?? 'versus';
        const opts = window._pendingGameOpts ?? {};

        if (savedId) {
            // Rejoin: send our clientId and let the server decide what state we're in.
            // Do NOT clear _matchSession or _victoryConsumed here — if the server still
            // has us in a grace period it will immediately send leave_grace, and App.jsx
            // needs page="game" + _matchSession intact so GraceBanner renders.
            // State is cleared on init / match_finished / match_end / grace expiry.
            ws.send(JSON.stringify({ type: 'rejoin', clientId: parseInt(savedId, 10) }));
        } else if (mode === 'spectate') {
            // Enter as voluntary spectator, optionally targeting a specific session.
            ws.send(JSON.stringify({ type: 'watch', sessionId: opts.sessionId ?? null }));
        } else if (mode === 'training') {
            // Join as player; GameShell will POST /api/training once we have a clientId.
            window._pendingTraining = opts.cpuCharId ?? 'eld';
            ws.send(JSON.stringify({ type: 'join' }));
        } else {
            // versus / tournament — join the player pool and wait for a match.
            window._pendingTournament = (mode === 'tournament');
            ws.send(JSON.stringify({ type: 'join' }));
        }
    });

    ws.addEventListener('message', ({ data }) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'kicked') {
            // Server closed this slot because the same account reconnected in
            // another tab/window. Block auto-reconnect and show a clear notice
            // so the user knows why the screen went dark.
            window._manualReconnect = true;
            window._kicked = true;
            try {
                ['clientId', 'charSelectData', 'pendingCharSelect', 'watchSession', 'gameState', 'confirmedStageId']
                    .forEach(k => sessionStorage.removeItem(k));
            } catch {}

            // ── Show a non-dismissible overlay ────────────────────────────
            // This replaces the silent black screen. The user can click the
            // button to take over the session from the other tab.
            const reason = msg.reason ?? 'logged_in_elsewhere';
            const reasonText = reason === 'reconnected_in_another_tab'
                ? 'Tu sesión fue retomada en otra pestaña.'
                : 'Tu sesión fue abierta en otro lugar.';

            let overlay = document.getElementById('_kicked_overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = '_kicked_overlay';
                Object.assign(overlay.style, {
                    position: 'fixed', inset: '0', zIndex: '99999',
                    background: 'rgba(0,0,0,0.85)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'sans-serif', color: '#fff', gap: '16px',
                    textAlign: 'center', padding: '24px',
                });
                document.body.appendChild(overlay);
            }
            overlay.innerHTML = `
                <div style="font-size:2rem">⚠️</div>
                <div style="font-size:1.2rem;font-weight:bold">Sesión desconectada</div>
                <div style="font-size:0.95rem;opacity:0.8;max-width:340px">${reasonText}</div>
                <button id="_kicked_resume_btn" style="
                    margin-top:8px;padding:10px 28px;font-size:1rem;font-weight:bold;
                    background:#4f8ef7;color:#fff;border:none;border-radius:8px;cursor:pointer;
                ">Continuar aquí</button>
                <div style="font-size:0.8rem;opacity:0.5">La otra pestaña ya no está activa.</div>
            `;
            document.getElementById('_kicked_resume_btn')?.addEventListener('click', () => {
                overlay.remove();
                // Clear kicked flag and reconnect from THIS tab, taking over the slot
                window._kicked = false;
                window._manualReconnect = false;
                connectWS();
            });

            window.dispatchEvent(new CustomEvent('ws_kicked', { detail: { reason } }));
            return;
        }

        if (msg.type === 'init') {
            const savedId = sessionStorage.getItem('clientId');
            if (savedId && Number(savedId) !== msg.clientId) {
                console.log(`[WS] init: clientId remapped ${savedId} → ${msg.clientId} (server redirected to existing slot)`);
            }
            window._myClientId = msg.clientId;
            window._gameConfig = msg.config;
            window._isSpectator = false;
            sessionStorage.setItem('clientId', msg.clientId);

            // init = server placed us in the lobby pool (no active session).
            // Safe to clear any stale match state now.
            try {
                sessionStorage.removeItem('gameState');
                sessionStorage.removeItem('confirmedStageId');
            } catch (_) {}
            Object.assign(window, {
                _matchSession:    null,
                _victoryActive:   false,
                _victoryConsumed: true,
                _hitstopState:    null,
                _countdownStart:  null,
                _countdownDone:   false,
            });

            // ── Post-join mode actions ─────────────────────────────────────
            // Training: POST /api/training now that we have a clientId
            if (window._pendingTraining) {
                const cpuCharId = window._pendingTraining;
                window._pendingTraining = null;
                fetch('/api/training', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ clientId: msg.clientId, cpuCharId }),
                }).then(r => r.json()).then(d => {
                    if (d.error) console.error('[WS] training start error:', d.error);
                    else console.log('[WS] training session started:', d.sessionId);
                }).catch(e => console.error('[WS] training fetch error:', e));
            }
            // Tournament: POST /api/tournament is handled server-side by tryAutoMatch;
            // the join message already put us in the player pool.

        } else if (msg.type === 'char_select_ack') {
            window._charSelectData = msg;
            if (msg.selectorClient === window._myClientId) {
                window._charSelectConfirmed = true;
                try { sessionStorage.setItem('charSelectData', JSON.stringify(msg)); } catch {}
            }
            window.dispatchEvent(new CustomEvent('char_select_ack', { detail: msg }));

        } else if (msg.type === 'spectator_mode') {
            window._myClientId          = msg.clientId;
            window._isSpectator         = true;
            window._charSelectData      = null;
            window._charSelectConfirmed = false;
            _sssClear();
            if (msg.config) window._gameConfig = msg.config;
            window._spectatorMode = {
                mode:            msg.mode,
                watchingSession: msg.watchingSession,
                activeSessions:  msg.activeSessions,
                eliminated:      msg.eliminated ?? false,
            };
            if (msg.eliminated) window._eliminatedFromSession = msg.watchingSession ?? null;
            sessionStorage.setItem('clientId', msg.clientId);
            if (!window._gameState?.players) window._gameState = { type: 'state', frameId: 0, players: {} };
            window.dispatchEvent(new CustomEvent('spectator_mode', { detail: window._spectatorMode }));
            if (!msg.watchingSession) _spectatorAutoWatch();

        } else if (msg.type === 'spectator_session_changed') {
            if (window._spectatorMode) {
                window._spectatorMode.watchingSession = msg.watchingSession;
                if (msg.activeSessions) window._spectatorMode.activeSessions = msg.activeSessions;
            }
            sessionStorage.setItem('watchSession', msg.watchingSession ?? '');
            if (!msg.watchingSession) {
                _spectatorAutoWatch();
            } else {
                clearTimeout(window._spectatorAutoWatchTimer);
                window._spectatorAutoWatchTimer = null;
            }
            window.dispatchEvent(new CustomEvent('spectator_session_changed', { detail: msg }));

        } else if (msg.type === 'hitstop') {
            const shakeTable = typeof HITSTOP_SHAKE !== 'undefined'
                ? HITSTOP_SHAKE
                : { micro: 0.012, light: 0.028, medium: 0.055, heavy: 0.10, ultra: 0.18 };
            const shakeAmt = shakeTable[msg.tier] ?? 0.02;
            const existing = window._hitstopState;
            if (!existing || msg.frames > existing.framesLeft) {
                window._hitstopState = {
                    framesLeft: msg.frames, tier: msg.tier, shakeAmt,
                    attackerId: msg.attackerId, targetId: msg.targetId, startFrames: msg.frames,
                };
            }
            window.dispatchEvent(new CustomEvent('hitstop', { detail: window._hitstopState }));

        } else if (msg.type === 'stage_confirmed') {
            window._confirmedStageId = msg.stageId | 0;
            try { sessionStorage.setItem('confirmedStageId', String(msg.stageId | 0)); } catch (_) {}

        } else if (msg.type === 'stage_reset') {
            window._confirmedStageId = undefined;
            window._isHost = undefined;
            try {
                sessionStorage.removeItem('confirmedStageId');
                _sssClear();
            } catch (_) {}

        } else if (msg.type === 'host_status') {
            window._isHost = !!msg.isHost;

        } else if (msg.type === 'state') {
            window._gameState = msg;
            if (window._victoryActive && window._victoryWinner >= 0) {
                const wp = window._gameState.players[window._victoryWinner];
                if (wp?.onGround) { wp.animation = 'victory'; wp.frozen = true; }
            }
            const now = Date.now();
            if (!window._lastGameStateSave || now - window._lastGameStateSave > 1000) {
                try { sessionStorage.setItem('gameState', JSON.stringify(msg)); } catch {}
                window._lastGameStateSave = now;
            }

        } else if (msg.type === 'match_start') {
            // Guard: if the server tells us which players are in this session,
            // only process it as our own match if we are actually one of them.
            // Spectators receive 'spectator_match_sync' instead (see handler.js),
            // but this is a belt-and-suspenders check for any edge case.
            if (Array.isArray(msg.players) && msg.players.length > 0 &&
                !msg.players.includes(window._myClientId) &&
                window._myClientId !== -1) {
                // We are not a participant — ignore as a player match_start.
                console.warn('[WS] match_start ignored: not in player list', msg.players, 'myId=', window._myClientId);
                return;
            }
            window._victoryState = null;
            window._victoryConsumed = false;
            window._hitstopState = null;
            window._matchSession = {
                sessionId:    msg.sessionId,
                mode:         msg.mode,
                tournamentId: msg.tournamentId ?? null,
                round:        msg.round ?? null,
                stageId:      msg.stageId ?? -1,
            };
            // Confirm the stage for this session so the renderer uses the right layout.
            if (msg.stageId !== undefined && msg.stageId >= 0) {
                window._confirmedStageId = msg.stageId;
                try { sessionStorage.setItem('confirmedStageId', String(msg.stageId)); } catch (_) {}
                window.dispatchEvent(new CustomEvent('stage_confirmed', { detail: { stageId: msg.stageId } }));
            }
            if (msg.countdown) {
                window._countdownStart = performance.now();
                window._countdownDone  = false;
            } else {
                window._countdownStart = null;
                window._countdownDone  = true;
            }
            window.dispatchEvent(new CustomEvent('match_start', { detail: window._matchSession }));

        } else if (msg.type === 'spectator_match_sync') {
            // Synthetic match_start sent only to spectators joining a live session.
            // Sets up _matchSession for the renderer without affecting player state.
            window._matchSession = {
                sessionId:    msg.sessionId,
                mode:         msg.mode,
                tournamentId: msg.tournamentId ?? null,
                round:        msg.round ?? null,
            };
            window._countdownStart = null;
            window._countdownDone  = true;
            window.dispatchEvent(new CustomEvent('match_start', { detail: { ...window._matchSession, spectatorSync: true } }));

        } else if (msg.type === 'victory') {
            const isWinner = !window._isSpectator && msg.winner === window._myClientId;
            window._victoryWinner   = msg.winner | 0;
            window._victoryIsWinner = isWinner;
            window._victoryActive   = true;
            window._victoryConsumed = false;
            window._victoryState = {
                winner: msg.winner, loser: msg.loser, isWinner,
                reloadRequired: msg.reloadRequired ?? true,
            };
            if (window._isSpectator && window._eliminatedFromSession) {
                window.dispatchEvent(new CustomEvent('victory_spectator', { detail: {
                    winner: msg.winner, loser: msg.loser, isWinner: false, spectating: true,
                }}));
            }
            setTimeout(() => {
                window._overlayReady = true;
                window.dispatchEvent(new CustomEvent('victory', { detail: window._victoryState }));
            }, window._victoryOverlayDelayMs ?? 3000);

        } else if (msg.type === 'match_finished') {
            try {
                ['clientId', 'charSelectData', 'pendingCharSelect', 'watchSession', 'gameState', 'confirmedStageId']
                    .forEach(k => sessionStorage.removeItem(k));
            } catch {}
            Object.assign(window, {
                _myClientId:          -1,
                _charSelectData:      null,
                _charSelectConfirmed: false,
                _victoryConsumed:     true,
                _confirmedStageId:    undefined,
                _isHost:              undefined,
            });
            window.dispatchEvent(new CustomEvent('match_finished', { detail: { sessionId: msg.sessionId } }));

            // Reload the page so the WASM/Emscripten runtime is fully reset and
            // the player lands cleanly on the lobby. Only reload when there was a
            // proper winner/loser (victoryState set), not for training sessions or
            // spectators who were never in the fight.
            if (window._victoryState?.winner != null && !window._isSpectator) {
                try {
                    // cleanupSession already ran, but give a small buffer for any
                    // in-flight DB writes before the lobby allows matchmaking.
                    sessionStorage.setItem('matchmakingSafeAt', String(Date.now() + 2500));
                } catch (_) {}
                window.location.reload();
            }

        } else if (msg.type === 'match_end') {
            window._lastMatchResult = {
                winner: msg.winner, loser: msg.loser,
                isWinner: msg.winner === window._myClientId, matchId: msg.matchId,
            };
            window._eliminatedFromSession = null;
            window._matchSession          = null;
            window.dispatchEvent(new CustomEvent('match_end', { detail: window._lastMatchResult }));

        } else if (msg.type === 'state_spectator') {
            window._gameState = msg;

        } else if (msg.type === 'leave_grace') {
            // Server started a 5-second grace period for a player who left mid-match.
            // Store it and fire a CustomEvent so the lobby overlay can show the countdown.
            window._leaveGrace = { clientId: msg.clientId, expiresAt: msg.expiresAt, sessionId: msg.sessionId };
            window.dispatchEvent(new CustomEvent('leave_grace', { detail: window._leaveGrace }));

        } else if (msg.type === 'leave_grace_expired') {
            window._leaveGrace = null;
            window.dispatchEvent(new CustomEvent('leave_grace_expired', { detail: msg }));

        } else if (['player_eliminated', 'tournament_waiting', 'tournament_end', 'players_joined', 'player_disconnected', 'player_reconnected'].includes(msg.type)) {
            if (msg.type === 'tournament_end') window._tournamentResult = msg;
            if (msg.type === 'player_reconnected') window._leaveGrace = null;
            window.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));

        } else {
            console.warn('[WS] unhandled message type:', msg.type, msg);
        }
    });

    ws.addEventListener('close', () => {
        window._myClientId    = -1;
        window._isSpectator   = false;
        window._spectatorMode = null;
        if (!window._manualReconnect) {
            setTimeout(connectWS, 2000);
        }
        window._manualReconnect = false;
    });

    ws.addEventListener('error', err => { console.error('[WS] Error:', err); ws.close(); });
}
connectWS();

window.reconnectWS = function () {
    window._manualReconnect = true;
    window._myClientId    = -1;
    window._isSpectator   = false;
    window._spectatorMode = null;
    try {
        ['clientId', 'charSelectData', 'pendingCharSelect', 'watchSession', 'gameState', 'confirmedStageId']
            .forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}
    if (window._ws) { try { window._ws.close(); } catch (_) {} }
    setTimeout(connectWS, 80);
};

function sendInput(frame) {
    if (!window._ws || window._ws.readyState !== WebSocket.OPEN) return;
    if (window._isSpectator || window._victoryActive) return;
    if (window._countdownStart && !window._countdownDone) return;

    window._ws.send(JSON.stringify({
        type:       'input',
        moveX:      frame.moveX,
        jump:       frame.jump       ? 1 : 0,
        attack:     frame.attack     ? 1 : 0,
        dash:       frame.dash       ? 1 : 0,
        dashDir:    frame.dashDir    ?? 0,
        crouch:     frame.crouch     ? 1 : 0,
        block:      frame.block      ? 1 : 0,
        dashAttack: frame.dashAttack ? 1 : 0,
    }));
}

window._sendInput = (moveX, jump, attack, dash, dashDir, crouch, block, dashAttack) =>
    sendInput({ moveX, jump, attack, dash, dashDir, crouch, block, dashAttack });

window._spectatorAutoWatchTimer = null;

function _spectatorAutoWatch() {
    if (window._spectatorMode?.watchingSession) return;
    clearTimeout(window._spectatorAutoWatchTimer);

    async function attempt() {
        if (window._spectatorMode?.watchingSession || !window._isSpectator) return;
        try {
            const { sessions } = await fetchActiveSessions();
            if (sessions?.length > 0) { watchSession(sessions[0].sessionId); return; }
        } catch {}
        window._spectatorAutoWatchTimer = setTimeout(attempt, 1000);
    }

    window._spectatorAutoWatchTimer = setTimeout(attempt, 500);
}

window._spectatorAutoWatch = _spectatorAutoWatch;

function watchSession(sessionId) {
    if (window._ws?.readyState === WebSocket.OPEN)
        window._ws.send(JSON.stringify({ type: 'watch', sessionId: sessionId ?? null }));
}
window.watchSession = watchSession;

async function fetchActiveSessions() {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`fetchActiveSessions: ${res.status}`);
    return res.json();
}
window.fetchActiveSessions = fetchActiveSessions;

function sendStageSelect(stageId) {
    window._confirmedStageId = stageId | 0;
    try { sessionStorage.setItem('confirmedStageId', String(stageId | 0)); } catch (_) {}
    if (window._ws?.readyState === WebSocket.OPEN)
        window._ws.send(JSON.stringify({ type: 'stage_select', stageId: stageId | 0 }));
}
window.sendStageSelect = sendStageSelect;

function sendCharSelect(charId, charIdx, stageId) {
    if (window._ws?.readyState === WebSocket.OPEN)
        window._ws.send(JSON.stringify({ type: 'char_select', charId, charIdx: charIdx ?? 0, stageId: stageId ?? 0 }));
}
window.sendCharSelect = sendCharSelect;

function getCharSelectData() { return window._charSelectData ?? null; }
window.getCharSelectData = getCharSelectData;

function clearCharSelectData() {
    window._charSelectData      = null;
    window._charSelectConfirmed = false;
    _sssClear();
}
window.clearCharSelectData = clearCharSelectData;
