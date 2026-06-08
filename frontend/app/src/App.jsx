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

  if (vw / vh > GAME_RATIO) {
    const h = vh;
    return { w: Math.round(h * GAME_RATIO), h };
  }

  const w = vw;
  return { w, h: Math.round(w / GAME_RATIO) };
}

// The backend does not always use the same key for the user id.
// login/register use `id` and `/api/me` uses `user_id`.
function normalizeUser(rawUser) {
  if (!rawUser) return null;

  return {
    id: rawUser.id ?? rawUser.user_id ?? null,
    username: rawUser.username ?? "",
    email: rawUser.email ?? "",
    avatarUrl: rawUser.avatar_url ?? "/avatars/default.png",
    role: rawUser.role ?? "user",
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
      <button type="button" className="auth-link" onClick={onPrivacy}>
        Privacy Policy
      </button>
      <span className="legal-separator">|</span>
      <button type="button" className="auth-link" onClick={onTerms}>
        Terms of Service
      </button>
    </div>
  );
}

function AuthGate({ view, onChangeView, onLogin, onPrivacy, onTerms }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <AuthHeader title="Sign in to play" />

        <div className="auth-tabs">
          <button
            type="button"
            className={view === "login" ? "auth-tab auth-tab-active" : "auth-tab"}
            onClick={() => onChangeView("login")}
          >
            Login
          </button>
          <button
            type="button"
            className={view === "register" ? "auth-tab auth-tab-active" : "auth-tab"}
            onClick={() => onChangeView("register")}
          >
            Register
          </button>
        </div>

        {view === "login" ? (
          <Login onLogin={onLogin} onSwitchToRegister={() => onChangeView("register")} />
        ) : (
          <Register onLogin={onLogin} onSwitchToLogin={() => onChangeView("login")} />
        )}

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
          subtitle={
            <>
              The app is asking the backend whether the <code>sid</code> cookie is
              still valid.
            </>
          }
        />

        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} />
      </div>
    </div>
  );
}

function GameShell({ user, gameMode, gameOpts, inLobby, onBackToLobby, grace }) {
  const canvasRef = useRef(null);
  const scriptRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [sessionErr] = useState("");

  function handleBackToLobby() {
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

    if (gameMode === "training") {
      window._manualReconnect = true;
      window._pendingTraining = null;
      window._pendingGameMode = "versus";
      try {
        window._ws?.close();
      } catch (_) {}
      try {
        ["clientId", "charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
          .forEach((key) => sessionStorage.removeItem(key));
        window._myClientId = -1;
        sessionStorage.setItem("postTrainingReload", "1");
      } catch (_) {}
      window.location.reload();
      return;
    }

    if (gameMode === "spectate") {
      window._manualReconnect = true;
      window._pendingGameMode = "versus";
      try {
        window._ws?.close();
      } catch (_) {}
      try {
        ["clientId", "charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
          .forEach((key) => sessionStorage.removeItem(key));
        window._myClientId = -1;
      } catch (_) {}
      window.location.reload();
      return;
    }

    Object.assign(window, {
      _isSpectator: false,
      _spectatorMode: null,
      _matchSession: null,
      _victoryActive: false,
      _victoryConsumed: true,
      _hitstopState: null,
      _countdownStart: null,
      _countdownDone: false,
      _confirmedStageId: undefined,
      _isHost: undefined,
      _charSelectData: null,
      _charSelectConfirmed: false,
      _gameState: { players: {} },
      _eliminatedFromSession: null,
    });

    try {
      ["charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
        .forEach((key) => sessionStorage.removeItem(key));
    } catch (_) {}

    setVisible(false);
    setStatus("Connecting...");
    onBackToLobby();
  }

  useEffect(() => {
    const { w, h } = calcResolution();
    window._canvasWidth = w;
    window._canvasHeight = h;
    window._pendingGameMode = gameMode;
    window._pendingGameOpts = gameOpts ?? {};
    window.Module = { canvas: canvasRef.current, locateFile: (path) => `/${path}` };

    if (!scriptRef.current) {
      const script = document.createElement("script");
      script.src = "/game.js";
      script.async = false;
      document.body.appendChild(script);
      scriptRef.current = script;
    }

    const onResize = () => {
      const { w, h } = calcResolution();
      window._canvasWidth = w;
      window._canvasHeight = h;
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (inLobby) return;

    window._pendingGameMode = gameMode;
    window._pendingGameOpts = gameOpts ?? {};
    setVisible(false);
    setStatus("Connecting...");

    if (gameMode === "training") {
      window._pendingGameMode = "training";
      window._pendingGameOpts = gameOpts ?? {};
      window._pendingTraining = gameOpts ?? { cpuCharIds: ["eld"], stageId: 0 };
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
          _matchSession: null,
          _victoryActive: false,
          _victoryConsumed: true,
          _hitstopState: null,
          _countdownStart: null,
          _countdownDone: false,
        });
        window._ws.send(JSON.stringify({ type: "rejoin", clientId: parseInt(savedId, 10) }));
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
  }, [inLobby, gameMode, gameOpts]);

  useEffect(() => {
    if (inLobby) return;

    const poll = setInterval(() => {
      if (window._isSpectator && window._myClientId > 0) {
        setVisible(true);
        setStatus("");
        clearInterval(poll);
        return;
      }

      const id = window._myClientId;
      if (id > 0 && window._gameState?.players?.[id]) {
        setVisible(true);
        setStatus("");
        clearInterval(poll);
      }
    }, 50);

    const onStart = () => setStatus("");
    const onSpectate = () => {
      setVisible(true);
      setStatus("");
    };

    window.addEventListener("match_start", onStart);
    window.addEventListener("spectator_mode", onSpectate);

    return () => {
      clearInterval(poll);
      window.removeEventListener("match_start", onStart);
      window.removeEventListener("spectator_mode", onSpectate);
    };
  }, [inLobby]);

  const modeLabel = {
    versus: "Playing as",
    training: "Training vs AI",
    tournament: "Tournament",
    spectate: "Spectating",
  };

  return (
    <div
      className="game-page"
      style={inLobby ? { visibility: "hidden", pointerEvents: "none" } : undefined}
    >
      <div className="game-toolbar">
        <div className="game-user">
          <span className="game-user-label">{modeLabel[gameMode] ?? "Playing as"}</span>
          <strong>{user.username || user.email || "user"}</strong>
        </div>
        <button
          type="button"
          className="logout-button"
          onClick={handleBackToLobby}
          disabled={!!(grace && grace.clientId !== (window._myClientId ?? -1))}
          title={
            grace && grace.clientId !== (window._myClientId ?? -1)
              ? "Tu rival tiene unos segundos para volver..."
              : undefined
          }
        >
          Back to lobby
        </button>
      </div>

      {status && <div className="game-status-overlay"><p>{status}</p></div>}
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

function GraceBanner({ grace, myClientId, onRejoin }) {
  const [secsLeft, setSecsLeft] = useState(null);
  const [defeated, setDefeated] = useState(false);

  useEffect(() => {
    if (!grace) {
      setSecsLeft(null);
      setDefeated(false);
      return;
    }

    let intervalId = 0;

    function tick() {
      const ms = grace.expiresAt - Date.now();
      const secs = Math.max(0, Math.ceil(ms / 1000));
      setSecsLeft(secs);

      if (secs === 0 && grace.clientId === myClientId) {
        clearInterval(intervalId);
        setDefeated(true);
        setTimeout(() => {
          try {
            ["clientId", "charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
              .forEach((key) => sessionStorage.removeItem(key));
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
        <div className="grace-defeat-icon">X</div>
        <div className="grace-defeat-title">Defeat</div>
        <div className="grace-defeat-copy">Returning to the lobby...</div>
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
          : `Your rival has ${secsLeft}s to reconnect...`}
      </span>
      {isMe && (
        <button type="button" className="grace-rejoin-button" onClick={onRejoin}>
          Rejoin fight
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [authStatus, setAuthStatus] = useState("loading");
  const [authView, setAuthView] = useState("login");
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("auth");
  const [legalBackPage, setLegalBackPage] = useState("auth");
  const [gameMode, setGameMode] = useState("versus");
  const [gameOpts, setGameOpts] = useState({});
  const [grace, setGrace] = useState(null);
  const pageRef = useRef(page);
  const authStatusRef = useRef(authStatus);
  const legalBackPageRef = useRef(legalBackPage);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    authStatusRef.current = authStatus;
  }, [authStatus]);

  useEffect(() => {
    legalBackPageRef.current = legalBackPage;
  }, [legalBackPage]);

  useEffect(() => {
    const historyState = { enumaHistoryGuard: true };

    // Keep browser back inside the SPA so Chrome does not jump to old localhost ports.
    window.history.replaceState(historyState, "", window.location.href);
    window.history.pushState(historyState, "", window.location.href);

    function handleBrowserBack() {
      const currentPage = pageRef.current;

      if (currentPage === "game") {
        setPage("fightLobby");
      } else if (currentPage === "fightLobby") {
        setPage("lobby");
      } else if (currentPage === "privacy" || currentPage === "terms") {
        setPage(legalBackPageRef.current || "lobby");
      } else if (authStatusRef.current === "authenticated") {
        setPage("lobby");
      }

      window.history.pushState(historyState, "", window.location.href);
    }

    window.addEventListener("popstate", handleBrowserBack);

    return () => {
      window.removeEventListener("popstate", handleBrowserBack);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        // `credentials: include` is required.
        // Without it, the browser does not send the HttpOnly `sid` cookie.
        const response = await fetch("/api/me", {
          credentials: "include",
        });

        if (!response.ok) {
          if (response.status === 401) {
            if (!cancelled) {
              setUser(null);
              setAuthStatus("guest");
              setPage("auth");
            }
            return;
          }

          throw new Error(`Session check failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setUser(normalizeUser(data.user));
          setAuthStatus("authenticated");
          setPage("lobby");
        }
      } catch (error) {
        console.error("[auth] /api/me failed:", error);

        if (!cancelled) {
          setUser(null);
          setAuthStatus("guest");
          setPage("auth");
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleGrace(event) {
      setGrace(event.detail);
    }

    function clearGrace() {
      setGrace(null);
    }

    window.addEventListener("leave_grace", handleGrace);
    window.addEventListener("leave_grace_expired", clearGrace);
    window.addEventListener("player_reconnected", clearGrace);

    return () => {
      window.removeEventListener("leave_grace", handleGrace);
      window.removeEventListener("leave_grace_expired", clearGrace);
      window.removeEventListener("player_reconnected", clearGrace);
    };
  }, []);

  function openPrivacy(fromPage) {
    setLegalBackPage(fromPage);
    setPage("privacy");
  }

  function openTerms(fromPage) {
    setLegalBackPage(fromPage);
    setPage("terms");
  }

  function handleAuthSuccess(rawUser) {
    setUser(normalizeUser(rawUser));
    setAuthStatus("authenticated");
    setPage("lobby");
  }

  async function handleLogout() {
    await fetch("/api/logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});

    setUser(null);
    setAuthStatus("guest");
    setAuthView("login");
    setPage("auth");
  }

  function handleEnterGame(mode, opts = {}) {
    setGameMode(mode);
    setGameOpts(opts);
    setGrace(null);
    setPage("game");
  }

  function handleRejoinFight() {
    setGrace(null);
    setPage("game");
  }

  if (authStatus === "loading") {
    return (
      <LoadingScreen
        onPrivacy={() => openPrivacy("loading")}
        onTerms={() => openTerms("loading")}
      />
    );
  }

  if (page === "privacy") {
    return <Privacy onBack={() => setPage(legalBackPage)} />;
  }

  if (page === "terms") {
    return <Terms onBack={() => setPage(legalBackPage)} />;
  }

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

  const gameActive = page === "fightLobby" || page === "game";
  const myClientId = window._myClientId ?? -1;

  return (
    <>
      {gameActive && (
        <GameShell
          user={user}
          gameMode={gameMode}
          gameOpts={gameOpts}
          inLobby={page === "fightLobby"}
          onBackToLobby={() => setPage("fightLobby")}
          grace={grace}
        />
      )}

      {page === "lobby" && (
        <Lobby user={user} onPlay={() => setPage("fightLobby")} onLogout={handleLogout} />
      )}

      {page === "fightLobby" && (
        <div className="fight-lobby-overlay">
          <GraceBanner grace={grace} myClientId={myClientId} onRejoin={handleRejoinFight} />
          <FightLobby
            user={user}
            onEnterGame={handleEnterGame}
            onBack={() => setPage("lobby")}
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
