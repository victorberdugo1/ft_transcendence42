import { useEffect, useRef, useState } from "react";
import Login    from "./Login.jsx";
import Lobby    from "./Lobby.jsx";
import Privacy  from "./Privacy.jsx";
import Register from "./Register.jsx";
import Terms    from "./Terms.jsx";
import "./auth.css";

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
        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">Sign in to play</h1>
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
        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">Checking session</h1>
        <p className="auth-subtitle">Verifying your <code>sid</code> cookie with the server…</p>
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} />
      </div>
    </div>
  );
}

// ── GameShell ──────────────────────────────────────────────────────────────────
// Stays mounted for the entire authenticated session so Emscripten never
// re-initialises (doing so crashes preMainLoop). inLobby=true hides the
// canvas behind the lobby overlay without unmounting it.

function GameShell({ user, gameMode, gameOpts, inLobby, onBackToLobby, grace }) {
  const canvasRef   = useRef(null);
  const scriptRef   = useRef(null);
  const [visible,    setVisible]    = useState(false);
  const [status,     setStatus]     = useState("Connecting\u2026");
  const [sessionErr, setSessionErr] = useState("");

  function handleBackToLobby() {
    try {
      if (window._ws?.readyState === 1) {
        window._ws.send(JSON.stringify({ type: "leave" }));
      }
    } catch (_) {}

    // If the player was eliminated and is watching as a forced spectator,
    // stamp matchmakingSafeAt now so the lobby cooldown shows even if they
    // leave before match_finished arrives (which is what triggers the stamp
    // in the normal path). 9s gives the server time to finish cleanupSession.
    if (window._eliminatedFromSession) {
      try {
        const existing = parseInt(sessionStorage.getItem('matchmakingSafeAt') ?? '0', 10);
        const proposed = Date.now() + 9000;
        if (proposed > existing) sessionStorage.setItem('matchmakingSafeAt', String(proposed));
      } catch (_) {}
    }

    // Training sessions: kill the WS immediately (prevents ws-client from
    // writing a fresh clientId to sessionStorage after we clear it), wipe all
    // state, then reload so the WASM runtime is fully reset.
    // Order is critical: _manualReconnect=true → close WS → clear storage → reload.
    if (gameMode === "training") {
      window._manualReconnect = true;
      window._pendingTraining = null;
      window._pendingGameMode = "versus";
      try { window._ws?.close(); } catch (_) {}
      try {
        ['clientId', 'charSelectData', 'pendingCharSelect', 'watchSession', 'gameState', 'confirmedStageId']
          .forEach(k => sessionStorage.removeItem(k));
        window._myClientId = -1;
        sessionStorage.setItem('postTrainingReload', '1');
      } catch (_) {}
      window.location.reload();
      return;
    }

    // Keep WS open and WASM alive — only reset UI/match state.
    Object.assign(window, {
      _isSpectator: false, _spectatorMode: null, _matchSession: null,
      _victoryActive: false, _victoryConsumed: true, _hitstopState: null,
      _countdownStart: null, _countdownDone: false,
      _confirmedStageId: undefined, _isHost: undefined,
      _charSelectData: null, _charSelectConfirmed: false,
      _gameState: { players: {} },
      _eliminatedFromSession: null,
    });

    const keysToRemove = ["charSelectData","pendingCharSelect","watchSession","gameState","confirmedStageId"];
    try { keysToRemove.forEach(k => sessionStorage.removeItem(k)); } catch (_) {}
    setVisible(false);
    setStatus("Connecting\u2026");
    onBackToLobby();
  }

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
  }, []);

  // When transitioning lobby → game, send join/rejoin
  useEffect(() => {
    if (inLobby) return;
    window._pendingGameMode = gameMode;
    window._pendingGameOpts = gameOpts ?? {};
    setVisible(false);
    setStatus("Connecting\u2026");
    setSessionErr("");

    // Training needs a fully clean WS connection so the server doesn't detect
    // a duplicate slot (same dbUserId already in the lobby pool) and kick us.
    // reconnectWS closes the current WS, wipes sessionStorage, and reconnects;
    // connectWS reads _pendingGameMode on the new 'open' event and sends 'join'.
    if (gameMode === "training") {
      window._pendingGameMode = "training";
      window._pendingGameOpts = gameOpts ?? {};
      window._pendingTraining = gameOpts ?? { cpuCharIds: ["eld"], stageId: 0 };
      if (typeof window.reconnectWS === "function") window.reconnectWS();
      return;
    }

    function sendIntent() {
      const savedId = sessionStorage.getItem("clientId");
      if (savedId) {
        try { sessionStorage.removeItem("gameState"); sessionStorage.removeItem("confirmedStageId"); } catch (_) {}
        Object.assign(window, { _matchSession: null, _victoryActive: false, _victoryConsumed: true, _hitstopState: null, _countdownStart: null, _countdownDone: false });
        window._ws.send(JSON.stringify({ type: "rejoin", clientId: parseInt(savedId, 10) }));
      } else if (gameMode === "spectate") {
        window._ws.send(JSON.stringify({ type: "watch", sessionId: gameOpts?.sessionId ?? null }));
      } else {
        window._pendingTournament = gameMode === "tournament";
        window._ws.send(JSON.stringify({ type: "join" }));
      }
    }

    if (window._ws?.readyState === 1) { sendIntent(); }
    else {
      const t = setInterval(() => { if (window._ws?.readyState === 1) { clearInterval(t); sendIntent(); } }, 50);
    }
  }, [inLobby, gameMode]);

  // Poll for clientId visible in game state
  useEffect(() => {
    if (inLobby) return;
    const poll = setInterval(() => {
      if (window._isSpectator && window._myClientId > 0) { setVisible(true); setStatus(""); clearInterval(poll); return; }
      const id = window._myClientId;
      if (id > 0 && window._gameState?.players?.[id]) { setVisible(true); setStatus(""); clearInterval(poll); }
    }, 50);
    const onStart    = () => setStatus("");
    const onSpectate = () => { setVisible(true); setStatus(""); };
    window.addEventListener("match_start",    onStart);
    window.addEventListener("spectator_mode", onSpectate);
    return () => {
      clearInterval(poll);
      window.removeEventListener("match_start",    onStart);
      window.removeEventListener("spectator_mode", onSpectate);
    };
  }, [inLobby]);

  const modeLabel = { versus: "Playing vs", training: "Training vs AI", tournament: "Tournament", spectate: "Spectating" };

  return (
    <div className="game-page" style={inLobby ? { visibility: "hidden", pointerEvents: "none" } : undefined}>
      <div className="game-toolbar">
        <div className="game-user">
          <span className="game-user-label">{modeLabel[gameMode] ?? "Playing as"}</span>
          <strong>{user.username || user.email || "user"}</strong>
        </div>
        <button type="button" className="logout-button" onClick={handleBackToLobby}
          disabled={!!(grace && grace.clientId !== (window._myClientId ?? -1))}
          title={grace && grace.clientId !== (window._myClientId ?? -1) ? "Tu rival tiene unos segundos para volver…" : undefined}
        >
          ← Lobby
        </button>
      </div>
      {status && <div className="game-status-overlay"><p>{status}</p></div>}
      {sessionErr && (
        <div className="game-status-overlay game-status-error">
          <p>{sessionErr}</p>
          <button type="button" className="auth-link" onClick={handleBackToLobby}>Back to lobby</button>
        </div>
      )}
      <div className="game-frame">
        <canvas ref={canvasRef} id="canvas" className="game-canvas" style={{ opacity: visible ? 1 : 0 }} />
      </div>
    </div>
  );
}

// ── Grace countdown banner ────────────────────────────────────────────────────

function GraceBanner({ grace, myClientId, onRejoin }) {
  const [secsLeft,  setSecsLeft]  = useState(null);
  const [defeated,  setDefeated]  = useState(false);

  useEffect(() => {
    if (!grace) { setSecsLeft(null); setDefeated(false); return; }
    function tick() {
      const ms = grace.expiresAt - Date.now();
      const secs = Math.max(0, Math.ceil(ms / 1000));
      setSecsLeft(secs);
      if (secs === 0 && grace.clientId === myClientId) {
        clearInterval(id);
        setDefeated(true);
        // Wait for the server's 5s grace timer to fully expire and clean up
        // the old slot before reloading, so the new join doesn't conflict.
        setTimeout(() => {
          try {
            ['clientId', 'charSelectData', 'pendingCharSelect', 'watchSession', 'gameState', 'confirmedStageId']
              .forEach(k => sessionStorage.removeItem(k));
            // Tell the lobby to block matchmaking until the server has fully
            // cleaned up the old slot (resolveMatchWinner takes another 6s).
            sessionStorage.setItem('matchmakingSafeAt', String(Date.now() + 6500));
          } catch (_) {}
          window.location.reload();
        }, 6000);
      }
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [grace]);

  // Defeat screen — shown while we wait for the reload
  if (defeated) {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.82)",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        fontFamily: "sans-serif", color: "#fff", gap: "12px",
      }}>
        <div style={{ fontSize: "3rem" }}>💀</div>
        <div style={{ fontSize: "1.6rem", fontWeight: "bold" }}>¡Derrota!</div>
        <div style={{ fontSize: "0.95rem", opacity: 0.7 }}>Volviendo al lobby…</div>
      </div>
    );
  }

  if (!grace || secsLeft === null || secsLeft === 0) return null;

  const isMe = grace.clientId === myClientId;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
      background: secsLeft <= 2 ? "#c0392b" : "#e67e22",
      color: "#fff", textAlign: "center", padding: "12px 16px",
      fontFamily: "sans-serif", fontWeight: "bold", fontSize: "1rem",
      display: "flex", alignItems: "center", justifyContent: "center", gap: "16px",
    }}>
      <span>
        {isMe
          ? `⚔️ ¡Tienes ${secsLeft}s para volver a la pelea o perderás!`
          : `⏳ Tu rival tiene ${secsLeft}s para volver…`}
      </span>
      {isMe && (
        <button
          onClick={onRejoin}
          style={{
            background: "#fff", color: "#e67e22", border: "none",
            borderRadius: "6px", padding: "6px 18px", fontWeight: "bold",
            cursor: "pointer", fontSize: "0.95rem",
          }}
        >
          ¡Volver a luchar!
        </button>
      )}
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [page,          setPage]          = useState("loading");
  const [authView,      setAuthView]      = useState("login");
  const [user,          setUser]          = useState(null);
  const [legalBackPage, setLegalBackPage] = useState("auth");
  const [gameMode,      setGameMode]      = useState("versus");
  const [gameOpts,      setGameOpts]      = useState({});
  const [grace,         setGrace]         = useState(null); // leave_grace state

  useEffect(() => {
    let cancelled = false;
    async function checkSession() {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        if (!res.ok) { if (!cancelled) { setUser(null); setPage("auth"); } return; }
        const data = await res.json();
        if (!cancelled) { setUser(normalizeUser(data.user)); setPage("lobby"); }
      } catch (e) {
        console.error("[auth] /api/me failed:", e);
        if (!cancelled) { setUser(null); setPage("auth"); }
      }
    }
    checkSession();
    return () => { cancelled = true; };
  }, []);

  // Listen for leave_grace WS events from ws-client
  useEffect(() => {
    function onGrace(e)   { setGrace(e.detail); }
    function onExpired()  { setGrace(null); }
    function onReconn()   { setGrace(null); }
    window.addEventListener("leave_grace",         onGrace);
    window.addEventListener("leave_grace_expired", onExpired);
    window.addEventListener("player_reconnected",  onReconn);
    return () => {
      window.removeEventListener("leave_grace",         onGrace);
      window.removeEventListener("leave_grace_expired", onExpired);
      window.removeEventListener("player_reconnected",  onReconn);
    };
  }, []);

  function openPrivacy(from) { setLegalBackPage(from); setPage("privacy"); }
  function openTerms(from)   { setLegalBackPage(from); setPage("terms");   }

  function handleAuthSuccess(rawUser) {
    setUser(normalizeUser(rawUser));
    if (typeof window.reconnectWS === "function") window.reconnectWS();
    setPage("lobby");
  }

  function handleLogout() {
    setUser(null); setAuthView("login"); setPage("auth");
    if (typeof window.reconnectWS === "function") window.reconnectWS();
  }

  function handleEnterGame(mode, opts = {}) {
    setGameMode(mode);
    setGameOpts(opts);
    setGrace(null);
    setPage("game");
  }

  // Player clicks "¡Volver a luchar!" — go back to game immediately
  function handleRejoinFight() {
    setGrace(null);
    setPage("game");
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (page === "loading") {
    return <LoadingScreen onPrivacy={() => openPrivacy("loading")} onTerms={() => openTerms("loading")} />;
  }
  if (page === "privacy") return <Privacy onBack={() => setPage(legalBackPage)} />;
  if (page === "terms")   return <Terms   onBack={() => setPage(legalBackPage)} />;

  if (page === "auth" || !user) {
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

  const myClientId = window._myClientId ?? -1;

  // GameShell is ALWAYS mounted once the user is authenticated so the Emscripten
  // WASM module is never torn down (re-initialising it crashes the mainLoop).
  // The lobby is rendered as a fixed overlay on top of the hidden canvas.
  const gameActive = page === "lobby" || page === "game";

  return (
    <>
      {gameActive && (
        <GameShell
          user={user}
          gameMode={gameMode}
          gameOpts={gameOpts}
          inLobby={page === "lobby"}
          onBackToLobby={() => setPage("lobby")}
          grace={grace}
        />
      )}

      {page === "lobby" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10 }}>
          <GraceBanner
            grace={grace}
            myClientId={myClientId}
            onRejoin={handleRejoinFight}
          />
          <Lobby
            user={user}
            onEnterGame={handleEnterGame}
            onLogout={handleLogout}
            onPrivacy={() => openPrivacy("lobby")}
            onTerms={() => openTerms("lobby")}
            graceActive={!!(grace && grace.clientId === (window._myClientId ?? -1))}
          />
        </div>
      )}
    </>
  );
}