import { useEffect, useRef, useState } from "react";

const CHAR_PORTRAITS = {
  eld: "data/eldwin_portrait.jpg",
  hil: "data/hilda_portrait.jpg",
  qui: "data/quimbur_portrait.jpg",
  gab: "data/gabriel_portrait.jpg",
};
const CHAR_NAMES = { eld: "Eldwin", hil: "Hilda", qui: "Quimbur", gab: "Gabriel" };
const CHAR_IDS   = ["eld", "hil", "qui", "gab"];
const STAGE_NAMES = ["Karnamru", "Surya", "Vayusvara", "Daat"];
const MODES = [
  { id: "versus",     label: "Versus"     },
  { id: "training",   label: "vs AI"      },
  { id: "tournament", label: "Tournament" },
  { id: "spectate",   label: "Spectate"   },
];
const DEFAULT_AVATAR_URL = "/avatars/default.png";

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── UserCard ───────────────────────────────────────────────────────────────────

function UserCard({ user, stats, onLogout, logoutLoading }) {
  const hasCustomAvatar = !!user.avatarUrl && user.avatarUrl !== DEFAULT_AVATAR_URL;
  const [avatarSrc,    setAvatarSrc]    = useState(hasCustomAvatar ? user.avatarUrl : "");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const initials = (user.username || user.email || "P").trim().slice(0, 2).toUpperCase();

  useEffect(() => {
    const next = user.avatarUrl && user.avatarUrl !== DEFAULT_AVATAR_URL ? user.avatarUrl : "";
    setAvatarSrc(next);
    setAvatarFailed(false);
  }, [user.avatarUrl]);

  return (
    <div className="lobby-user">
      {avatarSrc && !avatarFailed ? (
        <img
          className="lobby-avatar"
          src={avatarSrc}
          alt={user.username || "Player avatar"}
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        <div className="lobby-avatar lobby-avatar-fallback" aria-hidden="true">{initials}</div>
      )}
      <div className="lobby-user-info">
        <strong className="lobby-username">{user.username}</strong>
        <span className="lobby-email">{user.email}</span>
        {user.role !== "user" && <span className="lobby-role">{user.role}</span>}
      </div>
      {stats && (
        <div className="lobby-mini-stats">
          <span><b>{stats.wins   ?? 0}</b> W</span>
          <span><b>{stats.losses ?? 0}</b> L</span>
          <span>Lv <b>{stats.level ?? 1}</b></span>
          <span><b>{stats.xp ?? 0}</b> XP</span>
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
        {graceActive
          ? "Waiting\u2026"
          : matchCooldown > 0
            ? `Available in ${matchCooldown}s\u2026`
            : "Find match"}
      </button>
    </div>
  );
}

// ── Mode: vs AI ────────────────────────────────────────────────────────────────

function ModeAI({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const [selectedChars, setSelectedChars] = useState(["eld"]);
  const [stageId,       setStageId]       = useState(0);

  function toggleChar(id) {
    setSelectedChars(prev => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev; // keep at least one
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
        {graceActive
          ? "Waiting\u2026"
          : matchCooldown > 0
            ? `Available in ${matchCooldown}s\u2026`
            : `Start training vs ${enemyLabel}`}
      </button>
    </div>
  );
}

// ── Mode: Tournament ───────────────────────────────────────────────────────────

function ModeTournament({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const [room,      setRoom]      = useState(null);
  const [inRoom,    setInRoom]    = useState(false);
  const [roomError, setRoomError] = useState("");
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    // Track whether we joined the room IN THIS MOUNT (not a stale reconnect).
    // If started:true arrives before we ever called handleJoin(), it means the
    // server is replaying state for a tournament that finished while we were gone.
    // We must NOT auto-enter in that case.
    let joinedThisSession = false;

    function onRoomUpdate(e) {
      const data = e.detail;
      setRoom(data);
      if (data.leftRoom) {
        setInRoom(false);
        joinedThisSession = false;
        try { sessionStorage.removeItem('inTournamentRoom'); } catch (_) {}
        return;
      }
      // welcome:true means the server pushed this as part of sendWelcomeToPlayer —
      // the player is confirmed to be in the room, even if _myClientId is still -1.
      if (data.welcome && !data.started) {
        joinedThisSession = true;
        setInRoom(true);
        try { sessionStorage.setItem('inTournamentRoom', '1'); } catch (_) {}
        return;
      }
      // If this player appears in the room list, mark them as in the room.
      // Covers three paths:
      //   1. Server welcome: sendWelcomeToPlayer pushes room state — amInList
      //      or onAutoJoined (ws_tournament_joined_this_session) confirms we're in.
      //   2. Auto-rejoin (reload recovery): ws-client init sent tournament_join
      //      automatically — amInList confirms we're in.
      //   3. Manual join: user pressed the button (joinedThisSession=true already).
      //      Even if _myClientId is still -1 when the first update arrives (init
      //      and tournament_room_update race), we trust the flag and stay inRoom.
      const myId = window._myClientId ?? -1;
      const amInList = myId !== -1 && data.players?.some(p => p.clientId === myId);
      if (!data.started) {
        if (amInList || joinedThisSession) {
          setInRoom(true);
          joinedThisSession = true;
          try { sessionStorage.setItem('inTournamentRoom', '1'); } catch (_) {}
        }
      }
      if (data.started && data.tournamentId) {
        // Clear the flag — tournament is underway, no need to re-join on next reload.
        try { sessionStorage.removeItem('inTournamentRoom'); } catch (_) {}
        const amPlayer = data.players?.some(p => p.clientId === myId);
        // Only auto-enter if we explicitly joined the room this session.
        // Reconnect after grace sends started:true immediately — block that.
        // Also guard the race where _myClientId is still -1 when this fires:
        // if joinedThisSession is true and myId is -1, we ARE a participant
        // (the server added us), so enter. amPlayer will be true once init resolves.
        const shouldEnter = joinedThisSession && (amPlayer || myId === -1);
        if (shouldEnter) {
          onEnterGame("tournament", { tournamentId: data.tournamentId });
        }
      }
    }
    function onStarted(e) {
      const data = e.detail;
      setRoom(prev => prev ? { ...prev, started: true, tournamentId: data.tournamentId } : prev);
      // Clear the flag — tournament is underway.
      try { sessionStorage.removeItem('inTournamentRoom'); } catch (_) {}
      const myId = window._myClientId ?? -1;
      // Guard race: if myId is still -1 but we joined this session, we're a participant.
      const shouldEnter = joinedThisSession && (data.playerIds?.includes(myId) || myId === -1);
      if (shouldEnter) {
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

    // Auto-rejoin path (inTournamentRoom in sessionStorage) fires tournament_join
    // from ws-client init handler — mark joinedThisSession so the room update
    // that follows is treated as a genuine join, not a stale reconnect replay.
    function onAutoJoined() {
      joinedThisSession = true;
      setInRoom(true);
    }
    window.addEventListener("ws_tournament_joined_this_session", onAutoJoined);

    // Expose setter so handleJoin can flag joinedThisSession = true
    // without breaking the closure (we can't call setInRoom from here).
    ModeTournament._setJoined = (v) => { joinedThisSession = v; };

    return () => {
      window.removeEventListener("tournament_room_update", onRoomUpdate);
      window.removeEventListener("tournament_started",     onStarted);
      window.removeEventListener("tournament_room_error",  onError);
      window.removeEventListener("ws_tournament_joined_this_session", onAutoJoined);
      ModeTournament._setJoined = null;
    };
  }, [onEnterGame]);

  function handleJoin() {
    setRoomError("");
    if (!window._ws || window._ws.readyState !== 1) {
      setRoomError("Not connected to the server yet. Please wait a moment.");
      return;
    }
    window._ws.send(JSON.stringify({ type: "tournament_join" }));
    // Persist membership so a page reload (forfeit, F5) auto-rejoins the room.
    try { sessionStorage.setItem('inTournamentRoom', '1'); } catch (_) {}
    // Mark that we explicitly joined in this session so onRoomUpdate knows
    // a started:true event is genuine and not a stale reconnect replay.
    if (typeof ModeTournament._setJoined === "function") ModeTournament._setJoined(true);
    setInRoom(true);
  }

  function handleLeave() {
    setRoomError("");
    if (window._ws?.readyState === 1) {
      window._ws.send(JSON.stringify({ type: "tournament_leave" }));
    }
    // Clear persistence — player consciously left the room.
    try { sessionStorage.removeItem('inTournamentRoom'); } catch (_) {}
    // Clear the pending tournament intent so GameShell doesn't fire a stale
    // tournament join if the user later enters versus or training mode.
    window._pendingTournament = false;
    if (typeof ModeTournament._setJoined === "function") ModeTournament._setJoined(false);
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

  if (!inRoom) {
    return (
      <div className="lobby-mode-body">
        <p className="lobby-mode-desc">
          Join the tournament waiting room. Up to 8 players can join. Once
          ready, any player can launch the bracket. Eliminated players watch
          as spectators.
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
          {graceActive
            ? "Waiting\u2026"
            : matchCooldown > 0
              ? `Available in ${matchCooldown}s\u2026`
              : room?.started
                ? "Tournament in progress — Spectate instead"
                : "Join tournament room"}
        </button>
      </div>
    );
  }

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Waiting room · {playerCount}/{maxPlayers} players
        {room?.started ? " — Tournament has started!" : ""}
      </p>

      <div className="lobby-sessions">
        {(room?.players ?? []).map((p, i) => (
          <div key={p.clientId} className="lobby-session-row">
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{i + 1}</span>
              <span className="lobby-session-players">{p.username ?? `Player ${p.clientId}`}</span>
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
        {launching
          ? "Starting\u2026"
          : playerCount < 2
            ? "Waiting for players\u2026"
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

    </div>
  );
}

// ── Main FightLobby ────────────────────────────────────────────────────────────

export default function FightLobby({
  user,
  onEnterGame,
  onBack,
  onLogout,
  onPrivacy,
  onTerms,
  graceActive = false,
}) {
  const [stats,         setStats]         = useState(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [activeMode,    setActiveMode]    = useState("versus");
  const [sessionError,  setSessionError]  = useState("");

  // Initialise directly from sessionStorage so the FIRST render already has
  // the correct value — no frame where the button is incorrectly enabled.
  const [matchCooldown, setMatchCooldown] = useState(() => {
    try {
      const safeAt = parseInt(sessionStorage.getItem("matchmakingSafeAt") ?? "0", 10);
      if (!safeAt) return 0;
      const remaining = safeAt - Date.now();
      if (remaining <= 0) { sessionStorage.removeItem("matchmakingSafeAt"); return 0; }
      return Math.ceil(remaining / 1000);
    } catch (_) { return 0; }
  });

  // ── On-mount cleanup ──────────────────────────────────────────────────────
  // Every time FightLobby mounts (which happens when the user navigates here
  // from either Lobby or Game), we wipe any leftover match state from the
  // previous session. This is belt-and-suspenders on top of GameShell's own
  // cleanup — necessary because FightLobby now unmounts/remounts across routes.
  useEffect(() => {
    try {
      ["charSelectData", "pendingCharSelect", "watchSession", "gameState", "confirmedStageId"]
        .forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}

    // If we arrive here as a lingering spectator (e.g. came back from spectate
    // without a reload), clear the spectator flag so the WASM doesn't keep
    // treating the player as a spectator in the next versus/training session.
    if (window._isSpectator && !window._eliminatedFromSession) {
      window._isSpectator   = false;
      window._spectatorMode = null;
    }

    // Guard: if the player is reconnecting after a tournament grace expiry the
    // server may have reused their old slot and will immediately send a
    // tournament_room_update with started:true for a tournament that is already
    // over. Sending tournament_leave on mount evicts us from any stale room
    // before those events arrive, preventing auto-entry into a zombie session.
    // We only do this when _pendingTournament is still set (set by GameShell when
    // a tournament join was sent and never cleared because the tab reloaded mid-flow).
    if (window._pendingTournament) {
      window._pendingTournament = false;
      try {
        if (window._ws?.readyState === 1) {
          window._ws.send(JSON.stringify({ type: "tournament_leave" }));
        } else {
          // WS not open yet — send leave as soon as it connects
          const sendLeaveOnOpen = () => {
            window._ws?.send(JSON.stringify({ type: "tournament_leave" }));
            window.removeEventListener("ws_open", sendLeaveOnOpen);
          };
          window.addEventListener("ws_open", sendLeaveOnOpen);
          // Fallback: also try after 1s in case ws_open already fired
          setTimeout(() => {
            window.removeEventListener("ws_open", sendLeaveOnOpen);
            if (window._ws?.readyState === 1) {
              window._ws.send(JSON.stringify({ type: "tournament_leave" }));
            }
          }, 1000);
        }
      } catch (_) {}
    }
  }, []); // only on mount

  // ── Cooldown ticker ───────────────────────────────────────────────────────
  // Dep is a boolean (cooldown > 0) not the number itself, so the interval
  // is only registered/cleared when the cooldown starts or ends — not on
  // every 250ms tick (which would leak intervals).
  useEffect(() => {
    if (matchCooldown <= 0) return;
    try {
      const safeAt = parseInt(sessionStorage.getItem("matchmakingSafeAt") ?? "0", 10);
      if (!safeAt) return;
      const interval = setInterval(() => {
        const secs = Math.ceil((safeAt - Date.now()) / 1000);
        if (secs <= 0) {
          clearInterval(interval);
          setMatchCooldown(0);
          sessionStorage.removeItem("matchmakingSafeAt");
        } else {
          setMatchCooldown(secs);
        }
      }, 250);
      return () => clearInterval(interval);
    } catch (_) {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchCooldown > 0]);

  // ── Session guard + stats ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const meRes = await fetch("/api/me", { credentials: "include" });
        if (!meRes.ok) { onLogout(); return; }

        if (user.id) {
          const statsRes = await fetch(`/api/users/${user.id}/stats`, { credentials: "include" });
          if (!cancelled && statsRes.ok) {
            const d = await statsRes.json();
            setStats(d.stats ?? d ?? null);
          }
        }
      } catch (e) {
        console.error("[fight-lobby] load error:", e);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user.id, onLogout]);

  // ── Game entry guard ──────────────────────────────────────────────────────
  function handleEnterGame(mode, opts = {}) {
    // Block all game entry while a leave-grace is pending (the server still has
    // us in an active session for up to 5s after pressing Back to lobby).
    // Entering training in this window would reconnectWS() and destroy the session.
    if (graceActive) return;
    setSessionError("");
    onEnterGame(mode, opts);
  }

  // ── Back guard ────────────────────────────────────────────────────────────
  function handleBack() {
    // Blocked while a grace is active — we could still rejoin the fight.
    if (graceActive) return;
    onBack();
  }

  async function handleLogout() {
    setLogoutLoading(true);
    try {
      // NOTE: do NOT call /api/logout here. onLogout() is App.handleLogout
      // which already does the fetch + reconnectWS + state reset. Duplicating
      // the fetch here causes a double-logout race and leaves the WS in a
      // bad state if the first response clears the session before the second fires.
    } finally {
      setLogoutLoading(false);
      onLogout();
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card lobby-card" style={{ position: "relative" }}>

        {/* Back button — top-right corner, disabled during grace period */}
        <button
          type="button"
          className="fight-lobby-back-button"
          onClick={handleBack}
          disabled={graceActive}
          title={graceActive ? "Waiting for the server to release your previous match…" : undefined}
          style={{ position: "absolute", top: "1rem", right: "1rem" }}
        >
          ← Go back
        </button>

        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">Fight Lobby</h1>

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
              onClick={() => { setActiveMode(m.id); setSessionError(""); }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Grace-period notice: all game buttons are locked until the server
            releases the previous session (up to 5s after pressing Back) */}
        {graceActive && (
          <p className="auth-error" style={{ textAlign: "center", marginBottom: "0.5rem" }}>
            ⏳ Waiting for the server to release your previous match…
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
