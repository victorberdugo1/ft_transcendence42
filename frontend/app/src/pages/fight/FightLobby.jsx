import { useEffect, useRef, useState } from "react";

const CHAR_PORTRAITS = {
  eld: "data/eldwin_portrait.jpg",
  hil: "data/hilda_portrait.jpg",
  qui: "data/quimbur_portrait.jpg",
  gab: "data/gabriel_portrait.jpg",
};

const CHAR_NAMES = { eld: "Eldwin", hil: "Hilda", qui: "Quimbur", gab: "Gabriel" };
const CHAR_IDS = ["eld", "hil", "qui", "gab"];
const STAGE_NAMES = ["Karnamru", "Surya", "Vayusvara", "Daat"];
const MODES = [
  { id: "versus", label: "Versus" },
  { id: "training", label: "vs AI" },
  { id: "tournament", label: "Tournament" },
  { id: "spectate", label: "Spectate" },
];
const DEFAULT_AVATAR_URL = "/avatars/default.png";

async function apiFetch(path, opts = {}) {
  const response = await fetch(path, { credentials: "include", ...opts });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function UserCard({ user, stats, onLogout, logoutLoading }) {
  const hasCustomAvatar = !!user.avatarUrl && user.avatarUrl !== DEFAULT_AVATAR_URL;
  const [avatarSrc, setAvatarSrc] = useState(hasCustomAvatar ? user.avatarUrl : "");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const initials = (user.username || user.email || "P")
    .trim()
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    const nextAvatar = user.avatarUrl && user.avatarUrl !== DEFAULT_AVATAR_URL
      ? user.avatarUrl
      : "";
    setAvatarSrc(nextAvatar);
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
        <div className="lobby-avatar lobby-avatar-fallback" aria-hidden="true">
          {initials}
        </div>
      )}
      <div className="lobby-user-info">
        <strong className="lobby-username">{user.username}</strong>
        <span className="lobby-email">{user.email}</span>
        {user.role !== "user" && <span className="lobby-role">{user.role}</span>}
      </div>
      {stats && (
        <div className="lobby-mini-stats">
          <span><b>{stats.wins ?? 0}</b> W</span>
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
        {logoutLoading ? "..." : "Log out"}
      </button>
    </div>
  );
}

function ModeVersus({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Play a live 1v1 against another connected player. Matchmaking starts when a
        second player joins.
      </p>
      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={() => onEnterGame("versus")}
        disabled={matchCooldown > 0 || graceActive}
      >
        {graceActive ? "Waiting..." : matchCooldown > 0 ? `Available in ${matchCooldown}s...` : "Find match"}
      </button>
    </div>
  );
}

function ModeAI({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const [selectedChars, setSelectedChars] = useState(["eld"]);
  const [stageId, setStageId] = useState(0);

  function toggleChar(id) {
    setSelectedChars((previous) => {
      if (previous.includes(id)) {
        if (previous.length === 1) return previous;
        return previous.filter((charId) => charId !== id);
      }
      return [...previous, id];
    });
  }

  const enemyLabel = selectedChars.length === 1
    ? CHAR_NAMES[selectedChars[0]]
    : `${selectedChars.length} enemies`;

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Train against CPU opponents. Select 1 to 4 enemies and your preferred stage.
      </p>

      <p className="lobby-section-label">Enemies</p>
      <div className="lobby-char-pick">
        {CHAR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`lobby-char-btn ${selectedChars.includes(id) ? "lobby-char-active" : ""}`}
            onClick={() => toggleChar(id)}
          >
            <img
              src={CHAR_PORTRAITS[id]}
              alt={CHAR_NAMES[id]}
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
            <span>{CHAR_NAMES[id]}</span>
            {selectedChars.includes(id) && <span className="lobby-char-check">OK</span>}
          </button>
        ))}
      </div>

      <p className="lobby-section-label">Stage</p>
      <div className="lobby-stage-pick">
        {STAGE_NAMES.map((name, index) => (
          <button
            key={name}
            type="button"
            className={`lobby-stage-btn ${stageId === index ? "lobby-stage-active" : ""}`}
            onClick={() => setStageId(index)}
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
          ? "Waiting..."
          : matchCooldown > 0
            ? `Available in ${matchCooldown}s...`
            : `Start training vs ${enemyLabel}`}
      </button>
    </div>
  );
}

function ModeTournament({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const [room, setRoom] = useState(null);
  const [inRoom, setInRoom] = useState(false);
  const [roomError, setRoomError] = useState("");
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    function onRoomUpdate(event) {
      const data = event.detail;
      setRoom(data);
      if (data.leftRoom) setInRoom(false);
      if (data.started && data.tournamentId) {
        const myId = window._myClientId ?? -1;
        const amPlayer = data.players?.some((player) => player.clientId === myId);
        if (amPlayer && !data.leftRoom) {
          onEnterGame("tournament", { tournamentId: data.tournamentId });
        }
      }
    }

    function onStarted(event) {
      const data = event.detail;
      setRoom((previous) => (
        previous ? { ...previous, started: true, tournamentId: data.tournamentId } : previous
      ));
      const myId = window._myClientId ?? -1;
      if (data.playerIds?.includes(myId)) {
        onEnterGame("tournament", { tournamentId: data.tournamentId });
      }
    }

    function onError(event) {
      const reason = event.detail?.reason ?? "Unknown error";
      const messages = {
        already_started: "The tournament has already started. You can spectate it instead.",
        room_full: "The room is full (8 players max).",
        not_authenticated: "You must be logged in to join.",
        not_in_room: "You are not in the room.",
      };
      setRoomError(messages[reason] ?? reason);
      setLaunching(false);
    }

    window.addEventListener("tournament_room_update", onRoomUpdate);
    window.addEventListener("tournament_started", onStarted);
    window.addEventListener("tournament_room_error", onError);

    return () => {
      window.removeEventListener("tournament_room_update", onRoomUpdate);
      window.removeEventListener("tournament_started", onStarted);
      window.removeEventListener("tournament_room_error", onError);
    };
  }, [onEnterGame]);

  function handleJoin() {
    setRoomError("");
    if (!window._ws || window._ws.readyState !== 1) {
      setRoomError("Not connected to the server yet. Please wait a moment.");
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
  const maxPlayers = room?.maxPlayers ?? 8;
  const canLaunch = inRoom && playerCount >= 2 && !room?.started && !launching;

  if (!inRoom) {
    return (
      <div className="lobby-mode-body">
        <p className="lobby-mode-desc">
          Join the tournament waiting room. Up to 8 players can join before the bracket
          is launched.
        </p>
        {room && (
          <p className="lobby-loading">
            {playerCount}/{maxPlayers} players waiting
            {room.started ? " - tournament in progress" : ""}
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
            ? "Waiting..."
            : matchCooldown > 0
              ? `Available in ${matchCooldown}s...`
              : room?.started
                ? "Tournament in progress"
                : "Join tournament room"}
        </button>
      </div>
    );
  }

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Waiting room - {playerCount}/{maxPlayers} players
        {room?.started ? " - tournament started" : ""}
      </p>

      <div className="lobby-sessions">
        {(room?.players ?? []).map((player, index) => (
          <div key={player.clientId} className="lobby-session-row">
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{index + 1}</span>
              <span className="lobby-session-players">
                {player.username ?? `Player ${player.clientId}`}
              </span>
              {player.clientId === (window._myClientId ?? -1) && (
                <span className="lobby-session-specs">you</span>
              )}
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
      >
        {launching ? "Starting..." : playerCount < 2 ? "Waiting for players..." : "Start tournament"}
      </button>

      <button className="lobby-watch-btn lobby-watch-lobby" type="button" onClick={handleLeave}>
        Leave room
      </button>
    </div>
  );
}

function ModeSpectator({ onEnterGame }) {
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);

  async function load() {
    try {
      const data = await apiFetch("/api/sessions");
      setSessions(data.sessions ?? []);
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    intervalRef.current = window.setInterval(load, 3000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const modeLabel = { "1v1": "1v1", brawl: "Brawl", tournament: "Tournament" };

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        Watch any active session live. The list refreshes automatically every few seconds.
      </p>

      {loading && <p className="lobby-loading">Loading sessions...</p>}
      {error && <p className="auth-error">{error}</p>}

      {!loading && sessions !== null && (
        sessions.length === 0 ? (
          <p className="lobby-loading">No active sessions right now.</p>
        ) : (
          <div className="lobby-sessions">
            {sessions.map((session) => (
              <div key={session.sessionId} className="lobby-session-row">
                <div className="lobby-session-info">
                  <span className="lobby-session-badge">{modeLabel[session.mode] ?? session.mode}</span>
                  <span className="lobby-session-players">
                    {session.playerIds.length} players
                  </span>
                  {session.spectators > 0 && (
                    <span className="lobby-session-specs">{session.spectators} spectating</span>
                  )}
                </div>
                <button
                  className="lobby-watch-btn"
                  type="button"
                  onClick={() => onEnterGame("spectate", { sessionId: session.sessionId })}
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

export default function FightLobby({
  user,
  onEnterGame,
  onBack,
  onLogout,
  onPrivacy,
  onTerms,
  graceActive = false,
}) {
  const [stats, setStats] = useState(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [activeMode, setActiveMode] = useState("versus");
  const [sessionError] = useState("");
  const [matchCooldown, setMatchCooldown] = useState(() => {
    try {
      const safeAt = parseInt(sessionStorage.getItem("matchmakingSafeAt") ?? "0", 10);
      if (!safeAt) return 0;
      const remaining = safeAt - Date.now();
      if (remaining <= 0) {
        sessionStorage.removeItem("matchmakingSafeAt");
        return 0;
      }
      return Math.ceil(remaining / 1000);
    } catch (_) {
      return 0;
    }
  });

  useEffect(() => {
    if (matchCooldown <= 0) return;

    try {
      const safeAt = parseInt(sessionStorage.getItem("matchmakingSafeAt") ?? "0", 10);
      if (!safeAt) return;

      const interval = window.setInterval(() => {
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
    } catch (_) {
      return undefined;
    }
  }, [matchCooldown]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const meResponse = await fetch("/api/me", { credentials: "include" });
        if (!meResponse.ok) {
          onLogout();
          return;
        }

        if (user.id) {
          const statsResponse = await fetch(`/api/users/${user.id}/stats`, {
            credentials: "include",
          });
          if (!cancelled && statsResponse.ok) {
            const data = await statsResponse.json();
            setStats(data.stats ?? data ?? null);
          }
        }
      } catch (error) {
        console.error("[fight-lobby] load error:", error);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [onLogout, user.id]);

  function handleEnterGame(mode, opts = {}) {
    if (graceActive) return;
    onEnterGame(mode, opts);
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
        <h1 className="auth-title">Fight Lobby</h1>

        <button type="button" className="fight-lobby-back-button" onClick={onBack}>
          Go back
        </button>

        <UserCard
          user={user}
          stats={stats}
          onLogout={handleLogout}
          logoutLoading={logoutLoading}
        />

        <div className="lobby-mode-tabs">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`lobby-mode-tab ${activeMode === mode.id ? "lobby-mode-tab-active" : ""}`}
              onClick={() => setActiveMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {graceActive && (
          <p className="auth-error fight-lobby-inline-error">
            Waiting for the server to release your previous match...
          </p>
        )}

        <div className="lobby-mode-panel">
          {activeMode === "versus" && (
            <ModeVersus
              onEnterGame={handleEnterGame}
              matchCooldown={matchCooldown}
              graceActive={graceActive}
            />
          )}
          {activeMode === "training" && (
            <ModeAI
              onEnterGame={handleEnterGame}
              matchCooldown={matchCooldown}
              graceActive={graceActive}
            />
          )}
          {activeMode === "tournament" && (
            <ModeTournament
              onEnterGame={handleEnterGame}
              matchCooldown={matchCooldown}
              graceActive={graceActive}
            />
          )}
          {activeMode === "spectate" && <ModeSpectator onEnterGame={handleEnterGame} />}
        </div>

        {sessionError && <p className="auth-error">{sessionError}</p>}

        <div className="legal-footer">
          <button type="button" className="auth-link" onClick={onPrivacy}>
            Privacy Policy
          </button>
          <span className="legal-separator">|</span>
          <button type="button" className="auth-link" onClick={onTerms}>
            Terms of Service
          </button>
        </div>
      </div>
    </div>
  );
}
