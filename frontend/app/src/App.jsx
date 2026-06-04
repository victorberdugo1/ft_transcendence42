import { useEffect, useRef, useState } from "react";
import Login from "./Login.jsx";
import Register from "./Register.jsx";
import "./auth.css";

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

function AuthGate({ view, onChangeView, onLogin }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">Sign in to play</h1>


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
      </div>
    </div>
  );
}

function GameShell({ user, onLogout }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("Conectando...");
  const [visible, setVisible] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);

  useEffect(() => {
    const { w, h } = calcResolution();
    window._canvasWidth = w;
    window._canvasHeight = h;

    window.Module = {
      canvas: canvasRef.current,
      locateFile: (path) => `/${path}`,
      onRuntimeInitialized: () => setStatus("Juego cargado"),
    };

    const script = document.createElement("script");
    script.src = "/game.js";
    script.async = false;
    script.onload = () => setStatus("Juego inicializado");
    script.onerror = () => setStatus("Error cargando game.js");
    document.body.appendChild(script);
    // sendStageSelect está definido en ws-client.js y maneja tanto la
    // confirmación local como el envío al servidor vía WebSocket.
    const poll = setInterval(() => {
      if (window._isSpectator && window._myClientId > 0) {
        setVisible(true);
        clearInterval(poll);
        return;
      }

      const id = window._myClientId;
      if (id <= 0) return;

      const state = window._gameState;
      if (!state || !state.players || !state.players[id]) return;

      setVisible(true);
      clearInterval(poll);
    }, 50);

    const onResize = () => {
      const { w, h } = calcResolution();
      window._canvasWidth = w;
      window._canvasHeight = h;
    };

    window.addEventListener("resize", onResize);

    return () => {
      clearInterval(poll);
      window.removeEventListener("resize", onResize);
      script.parentNode?.removeChild(script);
    };
  }, []);

  async function handleLogoutClick() {
    setLogoutLoading(true);

    try {
      await fetch("/api/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setLogoutLoading(false);
      onLogout();
    }
  }

  return (
    <div className="game-page">
      <div className="game-toolbar">
        <div className="game-user">
          <span className="game-user-label">Playing as</span>
          <strong>{user.username || user.email || "user"}</strong>
        </div>

        <button
          type="button"
          className="logout-button"
          onClick={handleLogoutClick}
          disabled={logoutLoading}
        >
          {logoutLoading ? "Logging out..." : "Logout"}
        </button>
      </div>

      <div className="game-frame">
        <canvas
          ref={canvasRef}
          id="canvas"
          className="game-canvas"
          style={{ opacity: visible ? 1 : 0 }}
        />
      </div>

      <div className="game-status">{status}</div>
    </div>
  );
}

export default function App() {
  const [authStatus, setAuthStatus] = useState("loading");
  const [authView, setAuthView] = useState("login");
  const [user, setUser] = useState(null);

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
            }
            return;
          }

          throw new Error(`Session check failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setUser(normalizeUser(data.user));
          setAuthStatus("authenticated");
        }
      } catch (error) {
        console.error("[auth] /api/me failed:", error);

        if (!cancelled) {
          setUser(null);
          setAuthStatus("guest");
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleAuthSuccess(rawUser) {
    setUser(normalizeUser(rawUser));
    setAuthStatus("authenticated");
  }

  function handleLogout() {
    setUser(null);
    setAuthStatus("guest");
    setAuthView("login");
  }

  if (authStatus === "loading") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p className="auth-eyebrow">ft_transcendence</p>
          <h1 className="auth-title">Checking session</h1>
          <p className="auth-subtitle">
            The app is asking the backend whether the <code>sid</code> cookie is
            still valid.
          </p>
        </div>
      </div>
    );
  }

  if (authStatus !== "authenticated" || !user) {
    return (
      <AuthGate
        view={authView}
        onChangeView={setAuthView}
        onLogin={handleAuthSuccess}
      />
    );
  }

  return <GameShell user={user} onLogout={handleLogout} />;
}
