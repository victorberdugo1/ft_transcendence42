import { useEffect, useRef, useState } from "react";

// Character portrait paths (same as CHARACTER_ASSETS in constants.js)
const CHAR_PORTRAITS = {
  eld: "data/eldwin_portrait.jpg",
  hil: "data/hilda_portrait.jpg",
  qui: "data/quimbur_portrait.jpg",
  gab: "data/gabriel_portrait.jpg",
};
const CHAR_NAMES = { eld: "Eldwin", hil: "Hilda", qui: "Quimbur", gab: "Gabriel" };
const CHAR_IDS   = ["eld", "hil", "qui", "gab"];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Sub-views ──────────────────────────────────────────────────────────────────

function UserCard({ user, stats, onLogout, logoutLoading }) {
  const s = stats;
  const [avatarSrc, setAvatarSrc] = useState(user.avatarUrl || "/avatars/default.png");
  const avatarErrored = useRef(false);
  return (
    <div className="lobby-user">
      <img
        className="lobby-avatar"
        src={avatarSrc}
        alt={user.username}
        onError={() => {
          if (!avatarErrored.current) {
            avatarErrored.current = true;
            setAvatarSrc("/avatars/default.png");
          }
        }}
      />
      <div className="lobby-user-info">
        <strong className="lobby-username">{user.username}</strong>
        <span  className="lobby-email">{user.email}</span>
        {user.role !== "user" && <span className="lobby-role">{user.role}</span>}
      </div>
      {s && (
        <div className="lobby-mini-stats">
          <span><b>{s.wins ?? 0}</b> W</span>
          <span><b>{s.losses ?? 0}</b> L</span>
          <span>Lv <b>{s.level ?? 1}</b></span>
          <span><b>{s.xp ?? 0}</b> XP</span>
        </div>
      )}
      <button
        className="lobby-logout-link"
        type="button"
        onClick={onLogout}
        disabled={logoutLoading}
      >
        {logoutLoading ? "…" : "Log out"}
      </button>
    </div>
  );
}

// ── Mode: Versus ───────────────────────────────────────────────────────────────

function ModeVersus({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Play a live 1v1 against another connected player. Once you enter, you
        will be matched automatically when a second player joins.
      </p>
      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={() => onEnterGame("versus")}
        disabled={matchCooldown > 0 || graceActive}
      >
        {graceActive ? "Esperando…" : matchCooldown > 0 ? `Disponible en ${matchCooldown}s…` : "Find match"}
      </button>
    </div>
  );
}

// ── Mode: vs AI ────────────────────────────────────────────────────────────────

const STAGE_NAMES = ["Karnamru", "Surya", "Vayusvara", "Daat"];

function ModeAI({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const [selectedChars, setSelectedChars] = useState(["eld"]);
  const [stageId,       setStageId]       = useState(0);

  function toggleChar(id) {
    setSelectedChars(prev => {
      if (prev.includes(id)) {
        // Don't allow deselecting the last one
        if (prev.length === 1) return prev;
        return prev.filter(c => c !== id);
      }
      return [...prev, id];
    });
  }

  const enemyLabel = selectedChars.length === 1
    ? CHAR_NAMES[selectedChars[0]]
    : `${selectedChars.length} enemies`;

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Train against CPU opponents. Select 1 to 4 enemies and a stage.
      </p>

      <p className="lobby-section-label">Enemies (tap to toggle)</p>
      <div className="lobby-char-pick">
        {CHAR_IDS.map(id => (
          <button
            key={id}
            type="button"
            className={`lobby-char-btn ${selectedChars.includes(id) ? "lobby-char-active" : ""}`}
            onClick={() => toggleChar(id)}
          >
            <img
              src={CHAR_PORTRAITS[id]}
              alt={CHAR_NAMES[id]}
              onError={e => { e.currentTarget.style.display = "none"; }}
            />
            <span>{CHAR_NAMES[id]}</span>
            {selectedChars.includes(id) && <span className="lobby-char-check">✓</span>}
          </button>
        ))}
      </div>

      <p className="lobby-section-label">Stage</p>
      <div className="lobby-stage-pick">
        {STAGE_NAMES.map((name, idx) => (
          <button
            key={idx}
            type="button"
            className={`lobby-stage-btn ${stageId === idx ? "lobby-stage-active" : ""}`}
            onClick={() => setStageId(idx)}
          >
            {name}
          </button>
        ))}
      </div>

      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={() => onEnterGame("training", { cpuCharIds: selectedChars, stageId })}
        disabled={matchCooldown > 0 || graceActive}
      >
        {graceActive ? "Esperando…" : matchCooldown > 0 ? `Disponible en ${matchCooldown}s…` : `Start training vs ${enemyLabel}`}
      </button>
    </div>
  );
}

// ── Mode: Tournament ───────────────────────────────────────────────────────────

function ModeTournament({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const [room,       setRoom]       = useState(null);   // { players, started, tournamentId, maxPlayers }
  const [inRoom,     setInRoom]     = useState(false);
  const [roomError,  setRoomError]  = useState("");
  const [launching,  setLaunching]  = useState(false);

  // Listen for WS events from ws-client.js
  useEffect(() => {
    function onRoomUpdate(e) {
      const data = e.detail;
      setRoom(data);
      // If we left the room (server ack) stop showing us as in-room
      if (data.leftRoom) {
        setInRoom(false);
      }
      // If tournament started and we are in it, enter game
      if (data.started && data.tournamentId) {
        const myId = window._myClientId ?? -1;
        const amPlayer = data.players?.some(p => p.clientId === myId);
        if (amPlayer && !data.leftRoom) {
          onEnterGame("tournament", { tournamentId: data.tournamentId });
        }
      }
    }
    function onStarted(e) {
      const data = e.detail;
      setRoom(prev => prev ? { ...prev, started: true, tournamentId: data.tournamentId } : prev);
      const myId = window._myClientId ?? -1;
      const amPlayer = data.playerIds?.includes(myId);
      if (amPlayer) {
        onEnterGame("tournament", { tournamentId: data.tournamentId });
      }
    }
    function onError(e) {
      const reason = e.detail?.reason ?? "Unknown error";
      const msgs = {
        already_started:   "The tournament has already started. You can spectate it instead.",
        room_full:         "The room is full (8 players max).",
        not_authenticated: "You must be logged in to join.",
        not_in_room:       "You are not in the room.",
      };
      setRoomError(msgs[reason] ?? reason);
      setLaunching(false);
    }
    window.addEventListener("tournament_room_update", onRoomUpdate);
    window.addEventListener("tournament_started",     onStarted);
    window.addEventListener("tournament_room_error",  onError);
    return () => {
      window.removeEventListener("tournament_room_update", onRoomUpdate);
      window.removeEventListener("tournament_started",     onStarted);
      window.removeEventListener("tournament_room_error",  onError);
    };
  }, [onEnterGame]);

  function handleJoin() {
    setRoomError("");
    if (!window._ws || window._ws.readyState !== 1) {
      setRoomError("Not connected to server. Please wait…");
      return;
    }
    window._ws.send(JSON.stringify({ type: "tournament_join" }));
    setInRoom(true);
  }

  function handleLeave() {
    setRoomError("");
    if (window._ws?.readyState === 1) {
      window._ws.send(JSON.stringify({ type: "tournament_leave" }));
    }
    setInRoom(false);
    setRoom(null);
  }

  function handleLaunch() {
    setRoomError("");
    setLaunching(true);
    if (window._ws?.readyState === 1) {
      window._ws.send(JSON.stringify({ type: "tournament_launch" }));
    }
  }

  const playerCount = room?.players?.length ?? 0;
  const maxPlayers  = room?.maxPlayers ?? 8;
  const canLaunch   = inRoom && playerCount >= 2 && !room?.started && !launching;
  const isFirst     = inRoom && room?.players?.[0]?.clientId === (window._myClientId ?? -1);

  if (!inRoom) {
    return (
      <div className="lobby-mode-body">
        <p className="lobby-mode-desc">
          Join the tournament waiting room. Up to 8 players can join. Once
          ready, any player can launch the bracket. Eliminated players watch
          as spectators. Players who arrive after launch can spectate.
        </p>
        {room && (
          <p className="lobby-loading">
            🏟️ {playerCount}/{maxPlayers} player{playerCount !== 1 ? "s" : ""} waiting
            {room.started ? " — tournament in progress" : ""}
          </p>
        )}
        {roomError && <p className="auth-error">{roomError}</p>}
        <button
          className="auth-submit lobby-play"
          type="button"
          onClick={handleJoin}
          disabled={matchCooldown > 0 || graceActive || room?.started}
        >
          {graceActive          ? "Esperando…"
           : matchCooldown > 0 ? `Disponible en ${matchCooldown}s…`
           : room?.started     ? "Tournament in progress — Spectate instead"
           :                     "Join tournament room"}
        </button>
      </div>
    );
  }

  // In-room view
  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Waiting room · {playerCount}/{maxPlayers} players
        {room?.started ? " — Tournament has started!" : ""}
      </p>

      {/* Player list */}
      <div className="lobby-sessions">
        {(room?.players ?? []).map((p, i) => (
          <div key={p.clientId} className="lobby-session-row">
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{i + 1}</span>
              <span className="lobby-session-players">
                {p.username ?? `Player ${p.clientId}`}
              </span>
              {p.clientId === (window._myClientId ?? -1) && (
                <span className="lobby-session-specs">← you</span>
              )}
            </div>
          </div>
        ))}
        {Array.from({ length: maxPlayers - playerCount }).map((_, i) => (
          <div key={`empty-${i}`} className="lobby-session-row" style={{ opacity: 0.35 }}>
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{playerCount + i + 1}</span>
              <span className="lobby-session-players" style={{ fontStyle: "italic" }}>Waiting…</span>
            </div>
          </div>
        ))}
      </div>

      {roomError && <p className="auth-error">{roomError}</p>}

      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={handleLaunch}
        disabled={!canLaunch}
        title={playerCount < 2 ? "Need at least 2 players to start" : undefined}
      >
        {launching ? "Starting…"
         : playerCount < 2 ? "Waiting for players…"
         : `Start tournament (${playerCount} players)`}
      </button>

      <button
        className="lobby-watch-btn lobby-watch-lobby"
        type="button"
        onClick={handleLeave}
        style={{ marginTop: "4px" }}
      >
        ← Leave room
      </button>
    </div>
  );
}

// ── Mode: Spectator ────────────────────────────────────────────────────────────

function ModeSpectator({ onEnterGame }) {
  const [sessions, setSessions] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const intervalRef = useRef(null);

  async function load() {
    try {
      const data = await apiFetch("/api/sessions");
      setSessions(data.sessions ?? []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 3000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const modeLabel = { "1v1": "1v1", brawl: "Brawl", tournament: "Tournament" };

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Watch any active session live. The list refreshes every 3 seconds.
      </p>

      {loading && <p className="lobby-loading">Loading sessions…</p>}
      {error   && <p className="auth-error">{error}</p>}

      {!loading && sessions !== null && (
        sessions.length === 0 ? (
          <p className="lobby-loading">No active sessions right now. Check back soon.</p>
        ) : (
          <div className="lobby-sessions">
            {sessions.map(s => (
              <div key={s.sessionId} className="lobby-session-row">
                <div className="lobby-session-info">
                  <span className="lobby-session-badge">{modeLabel[s.mode] ?? s.mode}</span>
                  <span className="lobby-session-players">
                    {s.playerIds.length} player{s.playerIds.length !== 1 ? "s" : ""}
                  </span>
                  {s.spectators > 0 && (
                    <span className="lobby-session-specs">👁 {s.spectators}</span>
                  )}
                  {s.tournamentId && (
                    <span className="lobby-session-specs">Tournament #{s.tournamentId}</span>
                  )}
                </div>
                <button
                  className="lobby-watch-btn"
                  type="button"
                  onClick={() => onEnterGame("spectate", { sessionId: s.sessionId })}
                >
                  Watch
                </button>
              </div>
            ))}
          </div>
        )
      )}

      <button
        className="lobby-watch-btn lobby-watch-lobby"
        type="button"
        onClick={() => onEnterGame("spectate", { sessionId: null })}
      >
        Enter lobby as spectator
      </button>
    </div>
  );
}

// ── Main Lobby ─────────────────────────────────────────────────────────────────

const MODES = [
  { id: "versus", label: "Versus" },
  { id: "training", label: "vs AI" },
  { id: "tournament", label: "Tournament", disabled: true },  // Temporarily hidden until we can do some UI improvements
  { id: "spectate", label: "Spectate"},
];

export default function Lobby({ user, onEnterGame, onLogout, onPrivacy, onTerms, graceActive = false }) {
  const [stats,         setStats]         = useState(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [activeMode,    setActiveMode]    = useState("versus");
  const [sessionError,  setSessionError]  = useState("");
  // Initialise directly from sessionStorage so the FIRST render already has
  // the correct value — no frame where the button is incorrectly enabled.
  const [matchCooldown, setMatchCooldown] = useState(() => {
    try {
      const safeAt = parseInt(sessionStorage.getItem('matchmakingSafeAt') ?? '0', 10);
      if (!safeAt) return 0;
      const remaining = safeAt - Date.now();
      if (remaining <= 0) { sessionStorage.removeItem('matchmakingSafeAt'); return 0; }
      return Math.ceil(remaining / 1000);
    } catch (_) { return 0; }
  });

  // Tick the cooldown while it is active.
  useEffect(() => {
    if (matchCooldown <= 0) return;
    try {
      const safeAt = parseInt(sessionStorage.getItem('matchmakingSafeAt') ?? '0', 10);
      if (!safeAt) return;
      const interval = setInterval(() => {
        const secs = Math.ceil((safeAt - Date.now()) / 1000);
        if (secs <= 0) {
          clearInterval(interval);
          setMatchCooldown(0);
          sessionStorage.removeItem('matchmakingSafeAt');
        } else {
          setMatchCooldown(secs);
        }
      }, 250);
      return () => clearInterval(interval);
    } catch (_) {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchCooldown > 0]);


  // Confirm session + pull stats
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes] = await Promise.all([
          fetch("/api/me", { credentials: "include" }),
        ]);
        if (!meRes.ok) { onLogout(); return; }

        if (user.id) {
          const statsRes = await fetch(`/api/users/${user.id}/stats`, { credentials: "include" });
          if (!cancelled && statsRes.ok) {
            const d = await statsRes.json();
            setStats(d.stats ?? d ?? null);
          }
        }
      } catch (e) {
        console.error("[lobby] load error:", e);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user.id]);



  async function handleEnterGame(mode, opts = {}) {
    // Block all game entry while a leave-grace is pending (the server still has
    // us in an active session for up to 5s after pressing ← Lobby).
    // Entering training in this window would reconnectWS() and destroy the session.
    if (graceActive) return;
    setSessionError("");
    try {
      if (mode === "training") {
        // Start a training session: need our own clientId first.
        // The WS join happens inside GameShell; we just pass the intent.
        onEnterGame("training", opts);
        return;
      }
      if (mode === "spectate") {
        onEnterGame("spectate", opts);
        return;
      }
      // For versus and tournament we also just pass the intent —
      // GameShell will send the right WS message after joining.
      onEnterGame(mode, opts);
    } catch (e) {
      setSessionError(e.message);
    }
  }

  async function handleLogout() {
    setLogoutLoading(true);
    try {
      await fetch("/api/logout", { method: "POST", credentials: "include" });
    } finally {
      setLogoutLoading(false);
      onLogout();
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card lobby-card">

        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">Lobby</h1>

        <UserCard
          user={user}
          stats={stats}
          onLogout={handleLogout}
          logoutLoading={logoutLoading}
        />

        {/* Mode selector */}
        <div className="lobby-mode-tabs">
          {MODES.map(m => (
            <button
              key={m.id}
              type="button"
              className={`lobby-mode-tab ${activeMode === m.id ? "lobby-mode-tab-active" : ""}`}
              onClick={() => { if (!m.disabled) { setActiveMode(m.id); setSessionError(""); } }}
              disabled={m.disabled}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Grace-period notice: all game buttons are locked until the server
            releases the previous session (up to 5s after leaving mid-countdown) */}
        {graceActive && (
          <p className="auth-error" style={{ textAlign: "center", marginBottom: "0.5rem" }}>
            ⏳ Esperando que el servidor libere la sesión anterior…
          </p>
        )}

        {/* Mode content */}
        <div className="lobby-mode-panel">
          {activeMode === "versus"     && <ModeVersus     onEnterGame={handleEnterGame} matchCooldown={matchCooldown} graceActive={graceActive} />}
          {activeMode === "training"   && <ModeAI         onEnterGame={handleEnterGame} matchCooldown={matchCooldown} graceActive={graceActive} />}
          {activeMode === "tournament" && <ModeTournament  onEnterGame={handleEnterGame} matchCooldown={matchCooldown} graceActive={graceActive} />}
          {activeMode === "spectate"   && <ModeSpectator  onEnterGame={handleEnterGame} />}
        </div>

        {sessionError && <p className="auth-error">{sessionError}</p>}

        <div className="legal-footer">
          <button type="button" className="auth-link" onClick={onPrivacy}>Privacy Policy</button>
          <span className="legal-separator">|</span>
          <button type="button" className="auth-link" onClick={onTerms}>Terms of Service</button>
        </div>

      </div>
    </div>
  );
}
