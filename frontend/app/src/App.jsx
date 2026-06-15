import { useEffect, useRef, useState } from "react";
import logoImage from "../assets/logo.png";
import Login from "./pages/auth/Login.jsx";
import Privacy from "./pages/auth/Privacy.jsx";
import Register from "./pages/auth/Register.jsx";
import Terms from "./pages/auth/Terms.jsx";
import FightLobby from "./pages/fight/FightLobby.jsx";
import Lobby from "./pages/lobby/Lobby.jsx";
import "./pages/auth/auth.css";
import "./pages/fight/fight.css";
import "./pages/lobby/lobby.css";

const GAME_RATIO = 800 / 600;

function calcResolution() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw / vh > GAME_RATIO) { const h = vh; return { w: Math.round(h * GAME_RATIO), h }; }
  const w = vw;
  return { w, h: Math.round(w / GAME_RATIO) };
}

function normalizeUser(rawUser) {
  if (!rawUser) return null;
  return {
    id:        rawUser.id        ?? rawUser.user_id   ?? null,
    username:  rawUser.username  ?? "",
    email:     rawUser.email     ?? "",
    avatarUrl: rawUser.avatar_url ?? "/avatars/default.png",
    role:      rawUser.role      ?? "user",
  };
}

function AuthHeader({ title, subtitle }) {
  return (
    <>
      <div className="auth-brandmark">
        <img src={logoImage} alt="Enuma Fighter logo" className="auth-brandmark-image" />
      </div>
      <p className="auth-eyebrow">ft_transcendence</p>
      <h1 className="auth-title">{title}</h1>
      {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
    </>
  );
}

function LegalFooter({ onPrivacy, onTerms }) {
  return (
    <div className="legal-footer">
      <button type="button" className="auth-link" onClick={onPrivacy}>Privacy Policy</button>
      <span className="legal-separator">|</span>
      <button type="button" className="auth-link" onClick={onTerms}>Terms of Service</button>
    </div>
  );
}

function AuthGate({ view, onChangeView, onLogin, onPrivacy, onTerms }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <AuthHeader title="Sign in to play" />
        <div className="auth-tabs">
          <button type="button"
            className={view === "login" ? "auth-tab auth-tab-active" : "auth-tab"}
            onClick={() => onChangeView("login")}>Login</button>
          <button type="button"
            className={view === "register" ? "auth-tab auth-tab-active" : "auth-tab"}
            onClick={() => onChangeView("register")}>Register</button>
        </div>
        {view === "login"
          ? <Login    onLogin={onLogin} onSwitchToRegister={() => onChangeView("register")} />
          : <Register onLogin={onLogin} onSwitchToLogin={() => onChangeView("login")} />}
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} />
      </div>
    </div>
  );
}

function LoadingScreen({ onPrivacy, onTerms }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <AuthHeader
          title="Checking session"
          subtitle={<>The app is asking the backend whether the <code>sid</code> cookie is still valid.</>}
        />
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} />
      </div>
    </div>
  );
}

// ── GameShell ──────────────────────────────────────────────────────────────────
// Stays mounted for the entire authenticated session so Emscripten never
// re-initialises (doing so crashes preMainLoop). inLobby=true hides the
// canvas behind the lobby overlay without unmounting it.

function GameShell({ user, gameMode, gameOpts, inLobby, onBackToLobby, grace, onRegisterBack }) {
  const canvasRef = useRef(null);
  const scriptRef = useRef(null);
  const [visible,       setVisible]       = useState(false);
  const [status,        setStatus]        = useState("Connecting\u2026");
  const [sessionErr,    setSessionErr]    = useState("");
  // True while we are in SSS pre-match and the pair partner just left.
  const [pairDissolved, setPairDissolved] = useState(false);
  // Tracks whether match_start has fired — used to lock Back during SSS.
  // Also kept as a ref so event-listener closures read the current value.
  const [matchStarted,  setMatchStarted]  = useState(false);
  const matchStartedRef = useRef(false);

  // LEAVE-PERMISSION STATE MACHINE:
  //   idle/lobby (paired=false, leaveLocked=false) -> "Back to lobby" enabled, instant leave
  //   SSS/countdown (paired=true, leaveLocked=true) -> "Back to lobby" DISABLED, server rejects leave
  //   fight live (paired=true, leaveLocked=false)   -> "Back to lobby" enabled, leave = forfeit/grace
  //   post-match (paired=false)                     -> normal post-match behavior
  //
  // `paired` mirrors playerSession.has(clientId) server-side; set true at
  // match_start (pairing moment), cleared at match_finished/leave_ack(paired:false).
  // `leaveLocked` mirrors session.fightStarted===false server-side; set true
  // at match_start, cleared by a client-side timer matching COUNTDOWN_MS
  // (3000ms, must match session.js COUNTDOWN_MS) OR by an authoritative
  // 'stage_confirmed'-driven fight-start signal if available.
  const [paired, setPaired] = useState(false);
  const pairedRef = useRef(false);

  const [leaveLocked, setLeaveLocked] = useState(false);
  const leaveLockTimerRef = useRef(null);
  const leaveLockedRef = useRef(false);
  useEffect(() => { leaveLockedRef.current = leaveLocked; }, [leaveLocked]);

  const COUNTDOWN_MS = 3000; // must match session.js COUNTDOWN_MS

  // True while we're waiting for the server's leave_ack before navigating
  // away — prevents double-clicks / premature re-entry into matchmaking.
  const [leaveAckPending, setLeaveAckPending] = useState(false);
  const leaveAckPendingRef = useRef(false);
  useEffect(() => { leaveAckPendingRef.current = leaveAckPending; }, [leaveAckPending]);

  function handleBackToLobby() {
    // PRE-MATCH SSS/COUNTDOWN LOCK: a pair has formed but the fight hasn't
    // gone live yet. The button should already be disabled in this state,
    // but guard programmatic callers (browser-back handler, error screen
    // button) too — the server would reject this anyway (leave_ack
    // {rejected:true, reason:'pre_match_locked'}), so no-op here.
    if (pairedRef.current && leaveLockedRef.current &&
        gameMode !== "training" && gameMode !== "spectate" &&
        !window._isSpectator && !window._eliminatedFromSession) {
      console.warn('[UI] Back to lobby ignored — match setup in progress (SSS/countdown)');
      return;
    }

    // AUTHORITATIVE GUARD (Issue 2): if the backend currently has us paired
    // into an active session, do not navigate away optimistically. Send
    // 'leave' and WAIT for the server's leave_ack — the ack handler (in the
    // effect below) performs the actual navigation/cleanup once the server
    // confirms whether we're free (paired:false) or now in a forfeit grace
    // (paired:true, graced:true). This guarantees the UI never shows "back in
    // lobby" while the backend still holds our slot in playerSession.
    const isPairedNow = pairedRef.current &&
      gameMode !== "training" && gameMode !== "spectate" &&
      !window._isSpectator && !window._eliminatedFromSession;

    try {
      if (window._ws?.readyState === 1) {
        window._ws.send(JSON.stringify({ type: "leave" }));
      }
    } catch (_) {}

    if (isPairedNow) {
      // Defer everything else until leave_ack arrives.
      setLeaveAckPending(true);
      window._leaveCleanupPending = {
        gameMode, eliminatedFromSession: !!window._eliminatedFromSession,
      };
      return;
    }

    _performBackToLobbyCleanup();
  }

  // Extracted so the leave_ack handler can invoke the same cleanup once the
  // server confirms our 'leave' request (for the paired case), without
  // duplicating all the per-gameMode branching above.
  function _performBackToLobbyCleanup() {
    // If the player was eliminated and is watching as a forced spectator,
    // stamp matchmakingSafeAt now so the lobby cooldown shows even if they
    // leave before match_finished arrives.
    if (window._eliminatedFromSession) {
      try {
        const existing = parseInt(sessionStorage.getItem("matchmakingSafeAt") ?? "0", 10);
        const proposed = Date.now() + 9000;
        if (proposed > existing) sessionStorage.setItem("matchmakingSafeAt", String(proposed));
      } catch (_) {}
    }

    // Training: kill WS, wipe all state, reload so WASM runtime is fully reset.
    // Order: _matchSession=null first (suppresses beforeunload dialog — player chose
    // to leave, no need to warn) → _programmaticReload=true → _manualReconnect=true
    // → close WS → clear storage → reload.
    if (gameMode === "training") {
      window._matchSession       = null;   // must be before reload() to skip beforeunload dialog
      window._programmaticReload = true;   // explicit suppress — no dialog for voluntary exit
      window._manualReconnect    = true;
      window._pendingTraining    = null;
      window._pendingGameMode    = "versus";
      try { window._ws?.close(); } catch (_) {}
      try {
        ["clientId", "charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
          .forEach(k => sessionStorage.removeItem(k));
        window._myClientId = -1;
        sessionStorage.setItem("postTrainingReload", "1");
      } catch (_) {}
      window.location.reload();
      return;
    }

    // Spectate (voluntary) OR forcibly eliminated spectator: full reload so WASM and WS
    // are clean. For eliminated players gameMode is still "versus"/"tournament" — detect
    // the spectator state via _isSpectator or _eliminatedFromSession. A reload is always
    // correct here because the WASM canvas has stale state from the match that just ended.
    if (gameMode === "spectate" || window._isSpectator || window._eliminatedFromSession) {
      window._manualReconnect    = true;
      window._pendingGameMode    = "versus";
      window._programmaticReload = true;  // suppress beforeunload dialog
      window._playerChoseToLeave = true;  // belt-and-suspenders for eliminated spectators
      try { window._ws?.close(); } catch (_) {}
      try {
        ["clientId", "charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
          .forEach(k => sessionStorage.removeItem(k));
        window._myClientId = -1;
      } catch (_) {}
      window.location.reload();
      return;
    }

    // Versus / tournament: keep WS open and WASM alive — only reset UI/match state.
    Object.assign(window, {
      _isSpectator: false, _spectatorMode: null, _matchSession: null,
      _victoryActive: false, _victoryConsumed: true, _hitstopState: null,
      _countdownStart: null, _countdownDone: false,
      _confirmedStageId: undefined, _isHost: undefined,
      _charSelectData: null, _charSelectConfirmed: false,
      _gameState: { players: {} },
      _eliminatedFromSession: null,
    });
    try {
      ["charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
        .forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}

    setPaired(false);
    pairedRef.current = false;
    setLeaveAckPending(false);
    setVisible(false);
    setStatus("Connecting\u2026");
    onBackToLobby();
  }

  // Register handleBackToLobby so the browser-back handler in App can call it.
  // This is the only way to get the full cleanup without prop-drilling everywhere.
  useEffect(() => {
    if (typeof onRegisterBack === "function") onRegisterBack(handleBackToLobby);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount once: init canvas + load game.js + resize listener
  useEffect(() => {
    const { w, h } = calcResolution();
    window._canvasWidth  = w;
    window._canvasHeight = h;
    window._pendingGameMode = gameMode;
    window._pendingGameOpts = gameOpts ?? {};
    window.Module = { canvas: canvasRef.current, locateFile: (p) => `/${p}` };

    if (!scriptRef.current) {
      const script = document.createElement("script");
      script.src   = "/game.js";
      script.async = false;
      document.body.appendChild(script);
      scriptRef.current = script;
    }

    const onResize = () => {
      const { w, h } = calcResolution();
      window._canvasWidth = w; window._canvasHeight = h;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When transitioning lobby → game, send join/rejoin
  useEffect(() => {
    if (inLobby) return;

    window._pendingGameMode = gameMode;
    window._pendingGameOpts = gameOpts ?? {};
    setVisible(false);
    setStatus("Connecting\u2026");
    setMatchStarted(false);
    matchStartedRef.current = false;
    setPairDissolved(false);

    // Always wipe confirmedStageId when entering a new match so WASM doesn't
    // load the stage from a previous session. This is the primary guard against
    // the "wrong camera / corrupted stage" bug after automatic match ejection.
    try {
      sessionStorage.removeItem('confirmedStageId');
      sessionStorage.removeItem('gameState');
    } catch (_) {}
    window._confirmedStageId = undefined;
    window._matchEnded       = false;

    // Training needs a fully clean WS connection so the server doesn't detect
    // a duplicate slot and kick us. reconnectWS closes the current WS, wipes
    // sessionStorage, and reconnects; connectWS reads _pendingGameMode on the
    // new 'open' event and sends 'join'.
    if (gameMode === "training") {
      window._pendingGameMode = "training";
      window._pendingGameOpts = gameOpts ?? {};
      window._pendingTraining = gameOpts ?? { cpuCharIds: ["eld"], stageId: 0 };
      if (typeof window.reconnectWS === "function") window.reconnectWS();
      return;
    }

    // Spectate: also needs a clean WS connection to enter the spectator pool fresh.
    if (gameMode === "spectate") {
      window._pendingGameMode = "spectate";
      window._pendingGameOpts = gameOpts ?? {};
      if (typeof window.reconnectWS === "function") window.reconnectWS();
      return;
    }

    function sendIntent() {
      const savedId = sessionStorage.getItem("clientId");
      if (savedId && gameMode !== "spectate") {
        try {
          sessionStorage.removeItem("gameState");
          sessionStorage.removeItem("confirmedStageId");
        } catch (_) {}
        Object.assign(window, {
          _matchSession: null, _victoryActive: false, _victoryConsumed: true,
          _hitstopState: null, _countdownStart: null, _countdownDone: false,
        });
        window._ws.send(JSON.stringify({ type: "rejoin", clientId: parseInt(savedId, 10), seekingMatch: gameMode === "versus" }));
      } else if (gameMode === "spectate") {
        window._ws.send(JSON.stringify({ type: "watch", sessionId: gameOpts?.sessionId ?? null }));
      } else if (gameMode === "tournament") {
        window._pendingTournament = true;
        window._ws.send(JSON.stringify({ type: "join", seekingMatch: false }));
      } else {
        window._ws.send(JSON.stringify({ type: "join" }));
      }
    }

    if (window._ws?.readyState === 1) {
      sendIntent();
      return;
    }

    const timer = setInterval(() => {
      if (window._ws?.readyState === 1) {
        clearInterval(timer);
        sendIntent();
      }
    }, 50);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inLobby, gameMode, gameOpts]);

  // Poll until the game state confirms we are in-game
  useEffect(() => {
    if (inLobby) return;

    const poll = setInterval(() => {
      if (window._isSpectator && window._myClientId > 0) {
        setVisible(true); setStatus(""); clearInterval(poll); return;
      }
      const id = window._myClientId;
      if (id > 0 && window._gameState?.players?.[id]) {
        setVisible(true); setStatus(""); clearInterval(poll);
      }
    }, 50);

    const onStart    = () => {
      setStatus(""); setMatchStarted(true); matchStartedRef.current = true; setPairDissolved(false);
      // AUTHORITATIVE (Issue 2/3): the backend just paired us into a session
      // (match_start is broadcast at the moment createSession/playerSession.set
      // happens server-side, BEFORE char/stage select). From this point until
      // the fight goes live, "Back to lobby" must be disabled — leaving now
      // would break the opponent's match setup, and the server rejects it too
      // (session.fightStarted === false -> leave_ack {rejected:true}).
      setPaired(true);
      pairedRef.current = true;
      setLeaveLocked(true);
      leaveLockedRef.current = true;

      // Unlock once the fight goes live. Mirrors session.js armFightStartTimer
      // (COUNTDOWN_MS after match_start). If a 'fight_live'/authoritative
      // server signal exists it would clear this earlier via onFightLive
      // below; this timer is the guaranteed fallback so the button never
      // stays stuck disabled due to a missed/duplicate event.
      if (leaveLockTimerRef.current) clearTimeout(leaveLockTimerRef.current);
      leaveLockTimerRef.current = setTimeout(() => {
        setLeaveLocked(false);
        leaveLockedRef.current = false;
      }, COUNTDOWN_MS + 200); // small buffer over server-side COUNTDOWN_MS
    };
    const onSpectate = () => { setVisible(true); setStatus(""); };

    // Track whether we entered as a voluntary spectator using the spectator_mode
    // event. We CANNOT read window._isSpectator inside onMatchFinished because
    // ws-client resets it to false BEFORE dispatching match_finished.
    let enteredAsVoluntarySpectator = false;
    const onSpectateMode = (e) => {
      setVisible(true);
      setStatus("");
      // eliminated flag means the server forced us into spectator — not voluntary
      enteredAsVoluntarySpectator = !(e.detail?.eliminated);
    };

    // Voluntary spectator: when the match ends ws-client does NOT reload.
    // Without this the spectator is stuck on "Connecting…" forever.
    // We wait 2s so the victory animation plays, then do a full spectate cleanup
    // (handleBackToLobby spectate path → close WS → reload → land on fightLobby clean).
    let matchFinishedTimer = null;
    const onMatchFinished = () => {
      // Match is over — we're no longer "paired" in the abandon-prevention
      // sense, regardless of mode.
      setPaired(false);
      pairedRef.current = false;
      setLeaveLocked(false);
      leaveLockedRef.current = false;
      if (leaveLockTimerRef.current) { clearTimeout(leaveLockTimerRef.current); leaveLockTimerRef.current = null; }
      if (enteredAsVoluntarySpectator) {
        matchFinishedTimer = setTimeout(() => {
          window._programmaticReload = true;  // suppress beforeunload dialog on this reload
          window._playerChoseToLeave = true;
          handleBackToLobby();
        }, 2000);
      }
    };

    // Fallback for eliminated-spectator: ws-client normally reloads via
    // match_finished, but if _victoryState.winner is null at that moment
    // the reload never fires. victory_spectator arrives earlier and is reliable.
    let victorySpectatorTimer = null;
    const onVictorySpectator = () => {
      if (!enteredAsVoluntarySpectator) {
        victorySpectatorTimer = setTimeout(() => {
          window._programmaticReload = true;  // suppress beforeunload — automatic clean exit
          window._playerChoseToLeave = true;
          handleBackToLobby();
        }, 5000);
      }
    };

    const onPairDissolved = () => {
      if (!matchStartedRef.current) setPairDissolved(true);
    };

    // Server's authoritative response to our 'leave' request.
    // - paired:false -> we were never paired (lobby/SSS); safe to navigate now
    //   if we were waiting on this (leaveAckPending), or no-op otherwise.
    // - paired:true, graced:true -> a 5s forfeit grace just started for us.
    //   We still navigate back to the lobby UI (the player explicitly asked
    //   to leave and the backend will forfeit them after the grace), but we
    //   mark ourselves unpaired immediately since we are leaving regardless.
    const onLeaveAck = (e) => {
      const detail = e.detail || {};
      if (detail.rejected) {
        // Server rejected the leave (still in SSS/countdown — race with the
        // client-side leaveLocked timer). Stay put, re-lock the UI.
        setLeaveAckPending(false);
        setLeaveLocked(true);
        leaveLockedRef.current = true;
        console.warn('[UI] leave rejected by server:', detail.reason);
        return;
      }
      setPaired(false);
      pairedRef.current = false;
      if (leaveAckPendingRef.current) {
        _performBackToLobbyCleanup();
      }
    };

    // If OUR OWN grace expires (we forfeited without ever completing leave_ack
    // round trip — e.g. tab was closed and reopened), make sure 'paired'
    // reflects reality on next mount via the ref; nothing to do visually here
    // since this component will likely remount, but keep state consistent.
    const onGraceExpiredSelf = (e) => {
      if (e.detail?.clientId === (window._myClientId ?? -1)) {
        setPaired(false);
        pairedRef.current = false;
      }
    };

    window.addEventListener("match_start",       onStart);
    window.addEventListener("spectator_mode",    onSpectateMode);
    window.addEventListener("match_finished",    onMatchFinished);
    window.addEventListener("victory_spectator", onVictorySpectator);
    window.addEventListener("pair_dissolved",    onPairDissolved);
    window.addEventListener("leave_ack",         onLeaveAck);
    window.addEventListener("leave_grace_expired", onGraceExpiredSelf);

    return () => {
      clearInterval(poll);
      clearTimeout(matchFinishedTimer);
      clearTimeout(victorySpectatorTimer);
      if (leaveLockTimerRef.current) { clearTimeout(leaveLockTimerRef.current); leaveLockTimerRef.current = null; }
      window.removeEventListener("match_start",       onStart);
      window.removeEventListener("spectator_mode",    onSpectateMode);
      window.removeEventListener("match_finished",    onMatchFinished);
      window.removeEventListener("victory_spectator", onVictorySpectator);
      window.removeEventListener("pair_dissolved",    onPairDissolved);
      window.removeEventListener("leave_ack",         onLeaveAck);
      window.removeEventListener("leave_grace_expired", onGraceExpiredSelf);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inLobby]);

  const modeLabel = {
    versus: "Playing as", training: "Training vs AI",
    tournament: "Tournament", spectate: "Spectating",
  };

  return (
    <div
      className="game-page"
      style={inLobby ? { visibility: "hidden", pointerEvents: "none" } : undefined}
    >
      <div className="game-toolbar">
        {gameMode !== "tournament" && (
          <button
            type="button"
            className="logout-button"
            onClick={handleBackToLobby}
            disabled={
              !!(grace && grace.clientId !== (window._myClientId ?? -1)) ||
              !!window._victoryActive ||
              // Lock during SSS pre-match in versus — clicking Back here
              // dissolves the pair and leaves the partner stuck with no opponent.
              // The button re-enables once match_start fires (matchStarted=true).
              (!matchStarted && gameMode === "versus")
            }
            title={
              window._victoryActive
                ? "Victory animation in progress…"
                : grace && grace.clientId !== (window._myClientId ?? -1)
                  ? "Your rival has a few seconds to reconnect..."
                  : !matchStarted && gameMode === "versus"
                    ? "Waiting for a match…"
                    : undefined
            }
          >
            Back to lobby
          </button>
        )}
        <div className="game-user">
          <span className="game-user-label">{modeLabel[gameMode] ?? "Playing as"}</span>
          <strong>{user.username || user.email || "user"}</strong>
        </div>
      </div>

      {status && <div className="game-status-overlay"><p>{status}</p></div>}
      {pairDissolved && !matchStarted && (
        <div className="game-status-overlay">
          <p>⚠️ Your partner left — select stage and character again</p>
        </div>
      )}
      {sessionErr && (
        <div className="game-status-overlay game-status-error">
          <p>{sessionErr}</p>
          <button type="button" className="auth-link" onClick={handleBackToLobby}>
            Back to lobby
          </button>
        </div>
      )}

      <div className="game-frame">
        <canvas
          ref={canvasRef}
          id="canvas"
          className="game-canvas"
          style={{ opacity: visible ? 1 : 0 }}
        />
      </div>
    </div>
  );
}

// ── GraceBanner ────────────────────────────────────────────────────────────────

function GraceBanner({ grace, myClientId, onRejoin }) {
  const [secsLeft, setSecsLeft] = useState(null);
  const [defeated, setDefeated] = useState(false);

  useEffect(() => {
    if (!grace) { setSecsLeft(null); setDefeated(false); return; }

    let intervalId = 0;

    function tick() {
      const ms   = grace.expiresAt - Date.now();
      const secs = Math.max(0, Math.ceil(ms / 1000));
      setSecsLeft(secs);

      if (secs === 0 && grace.clientId === myClientId) {
        clearInterval(intervalId);
        setDefeated(true);
        // Wait for the server's 5s grace timer to fully expire and clean up
        // the old slot before reloading.
        setTimeout(() => {
          try {
            ["clientId", "charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
              .forEach(k => sessionStorage.removeItem(k));
            sessionStorage.setItem("matchmakingSafeAt", String(Date.now() + 6500));
          } catch (_) {}
          window.location.reload();
        }, 6000);
      }
    }

    tick();
    intervalId = window.setInterval(tick, 250);
    return () => clearInterval(intervalId);
  }, [grace, myClientId]);

  if (defeated) {
    return (
      <div className="grace-defeat-screen">
        <div className="grace-defeat-icon">💀</div>
        <div className="grace-defeat-title">Defeat</div>
        <div className="grace-defeat-copy">Returning to the lobby…</div>
      </div>
    );
  }

  if (!grace || secsLeft === null || secsLeft === 0) return null;

  const isMe = grace.clientId === myClientId;

  return (
    <div className={secsLeft <= 2 ? "grace-banner grace-banner-danger" : "grace-banner"}>
      <span>
        {isMe
          ? `You have ${secsLeft}s to return to the fight or lose the match.`
          : `Your rival has ${secsLeft}s to reconnect\u2026`}
      </span>
      {isMe && (
        <button type="button" className="grace-rejoin-button" onClick={onRejoin}>
          Rejoin fight
        </button>
      )}
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [authStatus,    setAuthStatus]    = useState("loading");
  const [authView,      setAuthView]      = useState("login");
  const [user,          setUser]          = useState(null);
  const [page,          setPage]          = useState("auth");
  const [legalBackPage, setLegalBackPage] = useState("auth");
  const [gameMode,      setGameMode]      = useState("versus");
  const [gameOpts,      setGameOpts]      = useState({});
  const [grace,         setGrace]         = useState(null);

  // Ref used by the browser-back handler so it can call GameShell's cleanup
  // without a stale closure.
  const backToLobbyRef   = useRef(null);
  const pageRef          = useRef(page);
  const authStatusRef    = useRef(authStatus);
  const legalBackPageRef = useRef(legalBackPage);

  useEffect(() => { pageRef.current = page; },          [page]);
  useEffect(() => { authStatusRef.current = authStatus; }, [authStatus]);
  useEffect(() => { legalBackPageRef.current = legalBackPage; }, [legalBackPage]);

  // ── Browser back guard ──────────────────────────────────────────────────────
  // Keep browser history inside the SPA so Chrome does not jump to old ports.
  useEffect(() => {
    const historyState = { enumaHistoryGuard: true };
    window.history.replaceState(historyState, "", window.location.href);
    window.history.pushState(historyState, "", window.location.href);

    function handleBrowserBack() {
      const currentPage = pageRef.current;

      if (currentPage === "game") {
        // CRITICAL: must run GameShell's full cleanup (sends leave, wipes state,
        // handles training/spectate reloads). Never just setPage() here.
        if (typeof backToLobbyRef.current === "function") {
          backToLobbyRef.current();
        } else {
          // Fallback if GameShell hasn't registered yet (should not happen).
          setPage("fightLobby");
        }
      } else if (currentPage === "fightLobby") {
        // Must send WS leave in case the player was in the versus queue or
        // had joined a tournament room. Without this the server keeps the slot.
        _cleanupMatchState();
        setPage("lobby");
      } else if (currentPage === "privacy" || currentPage === "terms") {
        setPage(legalBackPageRef.current || "lobby");
      } else if (authStatusRef.current === "authenticated") {
        setPage("lobby");
      }

      window.history.pushState(historyState, "", window.location.href);
    }

    window.addEventListener("popstate", handleBrowserBack);
    return () => window.removeEventListener("popstate", handleBrowserBack);
  }, []);

  // ── Session check on mount ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function checkSession() {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) { setUser(null); setAuthStatus("guest"); setPage("auth"); }
          return;
        }
        const data = await res.json();
        if (!cancelled) { setUser(normalizeUser(data.user)); setAuthStatus("authenticated"); setPage("lobby"); }
      } catch (e) {
        console.error("[auth] /api/me failed:", e);
        if (!cancelled) { setUser(null); setAuthStatus("guest"); setPage("auth"); }
      }
    }
    checkSession();
    return () => { cancelled = true; };
  }, []);

  // ── Leave-grace WS events ───────────────────────────────────────────────────
  useEffect(() => {
    function onGrace(e)  { setGrace(e.detail); }
    function clearGrace(){ setGrace(null); }
    window.addEventListener("leave_grace",         onGrace);
    window.addEventListener("leave_grace_expired", clearGrace);
    window.addEventListener("player_reconnected",  clearGrace);
    return () => {
      window.removeEventListener("leave_grace",         onGrace);
      window.removeEventListener("leave_grace_expired", clearGrace);
      window.removeEventListener("player_reconnected",  clearGrace);
    };
  }, []);

  // ── Kicked-resume handler ───────────────────────────────────────────────────
  // ws-client dispatches ws_kicked_resume when the user clicks "Continuar aquí"
  // on the kicked overlay. At that point ws-client has already reset all window
  // globals and is about to call connectWS(). We reset the React-side state and
  // navigate to fightLobby so the user lands on a clean mode selector instead of
  // a stale game canvas or an invisible GameShell in the wrong mode.
  useEffect(() => {
    function onKickedResume() {
      setGrace(null);
      setGameMode("versus");
      setGameOpts({});
      // Navigate: if currently in game go to fightLobby, otherwise lobby.
      // Using the ref so we read the current page without a stale closure.
      const cur = pageRef.current;
      if (cur === "game" || cur === "fightLobby") {
        setPage("fightLobby");
      }
      // If already on lobby/fightLobby no navigation needed — the WS will
      // reconnect and send a fresh join automatically.
    }
    window.addEventListener("ws_kicked_resume", onKickedResume);
    return () => window.removeEventListener("ws_kicked_resume", onKickedResume);
  }, []);

  // ── Empty-stage ejection ────────────────────────────────────────────────────
  // ws-client dispatches ws_lobby_ejected when the server sends `init` (lobby
  // placement, no active session) but the client UI is still on page="game".
  // This happens after a forfeit grace expiry, a stale rejoin, or any path where
  // the server puts the player back in the lobby pool without a match_finished.
  // Result without this: the WASM stage renders completely empty — no players,
  // no countdown, no match — and the player is stuck with no way out except F5.
  // Fix: navigate to fightLobby and wipe all match state so the UI is clean.
  useEffect(() => {
    function onLobbyEjected() {
      const cur = pageRef.current;
      if (cur !== "game") return;   // only act when visibly in the game view
      _cleanupMatchState();
      setGrace(null);
      setGameMode("versus");
      setGameOpts({});
      setPage("fightLobby");
      console.log("[App] ws_lobby_ejected: navigating from game → fightLobby (empty stage avoided)");
    }
    window.addEventListener("ws_lobby_ejected", onLobbyEjected);
    return () => window.removeEventListener("ws_lobby_ejected", onLobbyEjected);
  }, []);

  // ── match_finished safety net (App level) ───────────────────────────────────
  // GameShell's onMatchFinished listener is only active when inLobby=false
  // (page="game"). If match_finished arrives while the player is on fightLobby
  // or lobby (inLobby=true — e.g. they pressed "Back" just before the server
  // resolved the session), ws-client already handles the reload for the normal
  // cases. But if shouldReload was false AND the player is in page="game" with
  // an empty stage (victoryState=null, not spectator), they'd be stuck.
  // This listener ensures that if match_finished fires while page="game", we
  // always escape to fightLobby as a backstop regardless of reload logic.
  useEffect(() => {
    function onMatchFinishedApp() {
      const cur = pageRef.current;
      // ws-client already called window.location.reload() for shouldReload cases.
      // We only need to act if the page is still "game" after a short tick
      // (i.e. reload wasn't triggered). Use rAF to yield first.
      requestAnimationFrame(() => {
        if (pageRef.current !== "game") return;
        // If we're still here, reload didn't fire (voluntary spectator path or
        // edge-case empty session). Force navigate to fightLobby.
        _cleanupMatchState();
        setGrace(null);
        setGameMode("versus");
        setGameOpts({});
        setPage("fightLobby");
        console.log("[App] match_finished backstop: navigating game → fightLobby");
      });
    }
    window.addEventListener("match_finished", onMatchFinishedApp);
    return () => window.removeEventListener("match_finished", onMatchFinishedApp);
  }, []);

  // ── Navigation helpers ──────────────────────────────────────────────────────
  function openPrivacy(from) { setLegalBackPage(from); setPage("privacy"); }
  function openTerms(from)   { setLegalBackPage(from); setPage("terms");   }

  function handleAuthSuccess(rawUser) {
    setUser(normalizeUser(rawUser));
    setAuthStatus("authenticated");
    if (typeof window.reconnectWS === "function") window.reconnectWS();
    setPage("lobby");
  }

  async function handleLogout() {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "include" });
    } catch (_) {}
    setUser(null);
    setAuthStatus("guest");
    setAuthView("login");
    // Clean matchmaking cooldown so it does not bleed into the next login.
    try { sessionStorage.removeItem("matchmakingSafeAt"); } catch (_) {}
    setPage("auth");
    // Reconnect WS so the old authenticated socket is closed and replaced
    // with an unauthenticated one. Without this the server keeps the slot open.
    if (typeof window.reconnectWS === "function") window.reconnectWS();
  }

  function handleEnterGame(mode, opts = {}) {
    setGameMode(mode);
    setGameOpts(opts);
    setGrace(null);
    setPage("game");
  }

  // Player clicks "Rejoin fight" from the GraceBanner
  function handleRejoinFight() {
    setGrace(null);
    setPage("game");
  }

  // "Go back" from FightLobby → Lobby (the decorative hub page).
  // When GameShell IS mounted (gameActive=true) we must call handleBackToLobby
  // so it can clean up state before we navigate. When it is NOT mounted yet
  // (user navigated directly to fightLobby without ever entering game) a simple
  // setPage is enough.
  function handleBackFromFightLobby() {
    // Blocked while an opponent grace is active — server still owns the session.
    if (grace) return;

    if (typeof backToLobbyRef.current === "function") {
      // GameShell is mounted — run the full cleanup. It calls onBackToLobby()
      // which sets page="fightLobby"; we override that to go all the way to "lobby".
      // We swap onBackToLobby temporarily for this one call.
      const originalOnBack = backToLobbyRef.current;
      // Patch: call handleBackToLobby but land on "lobby" not "fightLobby".
      // Since handleBackToLobby calls onBackToLobby() which is () => setPage("fightLobby"),
      // we need a different approach: do the cleanup inline and then go to "lobby".
      _cleanupMatchState();
      setPage("lobby");
    } else {
      setPage("lobby");
    }
  }

  // Shared cleanup used by handleBackFromFightLobby and handleBrowserBack when
  // navigating away from fightLobby or game. Covers the versus/tournament path.
  // Training and spectate go through GameShell's handleBackToLobby which always
  // triggers window.location.reload() — but _pendingTraining is cleared here too
  // as belt-and-suspenders in case of a timing edge case.
  function _cleanupMatchState() {
    try {
      if (window._ws?.readyState === 1) {
        window._ws.send(JSON.stringify({ type: "leave" }));
      }
    } catch (_) {}

    if (window._eliminatedFromSession) {
      try {
        const existing = parseInt(sessionStorage.getItem("matchmakingSafeAt") ?? "0", 10);
        const proposed = Date.now() + 9000;
        if (proposed > existing) sessionStorage.setItem("matchmakingSafeAt", String(proposed));
      } catch (_) {}
    }

    Object.assign(window, {
      _isSpectator: false, _spectatorMode: null, _matchSession: null,
      _victoryActive: false, _victoryConsumed: true, _hitstopState: null,
      _countdownStart: null, _countdownDone: false,
      _confirmedStageId: undefined, _isHost: undefined,
      _charSelectData: null, _charSelectConfirmed: false,
      _gameState: { players: {} },
      _eliminatedFromSession: null,
      // Clear pending intents so the next GameShell effect doesn't fire stale joins
      _pendingTournament: false,
      _pendingTraining: null,
    });
    try {
      ["charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
        .forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (authStatus === "loading") {
    return (
      <LoadingScreen
        onPrivacy={() => openPrivacy("loading")}
        onTerms={() => openTerms("loading")}
      />
    );
  }

  if (page === "privacy") return <Privacy onBack={() => setPage(legalBackPage)} />;
  if (page === "terms")   return <Terms   onBack={() => setPage(legalBackPage)} />;

  if (authStatus !== "authenticated" || !user) {
    return (
      <AuthGate
        view={authView}
        onChangeView={setAuthView}
        onLogin={handleAuthSuccess}
        onPrivacy={() => openPrivacy("auth")}
        onTerms={() => openTerms("auth")}
      />
    );
  }

  // GameShell MUST stay mounted across lobby / fightLobby / game pages so the
  // Emscripten WASM module is never torn down (re-initialising it crashes mainLoop).
  // It is hidden (visibility:hidden) whenever page !== "game".
  const gameActive = page === "lobby" || page === "fightLobby" || page === "game";
  const myClientId = window._myClientId ?? -1;

  return (
    <>
      {/* GameShell is always mounted once the user is authenticated */}
      {gameActive && (
        <GameShell
          user={user}
          gameMode={gameMode}
          gameOpts={gameOpts}
          inLobby={page !== "game"}
          onBackToLobby={() => setPage("fightLobby")}
          grace={grace}
          onRegisterBack={(fn) => { backToLobbyRef.current = fn; }}
        />
      )}

      {/* GraceBanner must be visible in BOTH game and fightLobby pages because
          the leave_grace event fires while the player is in the game view, and the
          countdown keeps ticking when they return to fightLobby. */}
      {(page === "game" || page === "fightLobby") && (
        <GraceBanner
          grace={grace}
          myClientId={myClientId}
          onRejoin={handleRejoinFight}
        />
      )}

      {/* Decorative hub: the pretty "main menu" page */}
      {page === "lobby" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10 }}>
          <Lobby
            user={user}
            onPlay={() => setPage("fightLobby")}
            onLogout={handleLogout}
          />
        </div>
      )}

      {/* FightLobby: mode selector (versus / training / tournament / spectate) */}
      {page === "fightLobby" && (
        <div className="fight-lobby-overlay" style={{ position: "fixed", inset: 0, zIndex: 10 }}>
          <FightLobby
            user={user}
            onEnterGame={handleEnterGame}
            onBack={handleBackFromFightLobby}
            onLogout={handleLogout}
            onPrivacy={() => openPrivacy("fightLobby")}
            onTerms={() => openTerms("fightLobby")}
            graceActive={!!(grace && grace.clientId === myClientId)}
          />
        </div>
      )}
    </>
  );
}
