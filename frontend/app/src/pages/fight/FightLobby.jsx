import LanguageSelector from "@src/components/LanguageSelector.jsx";
import PageBackButton from "@src/components/ui/PageBackButton.jsx";
import { apiFetchJson } from "@src/utils/http.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const CHAR_PORTRAITS = {
  eld: "assets/eldwin_portrait.jpg",
  hil: "assets/hilda_portrait.jpg",
  qui: "assets/quimbur_portrait.jpg",
  gab: "assets/gabriel_portrait.jpg",
};
const CHAR_NAMES = { eld: "Eldwin", hil: "Hilda", qui: "Quimbur", gab: "Gabriel" };
const CHAR_IDS   = ["eld", "hil", "qui", "gab"];
const STAGE_NAMES = ["Karnamru", "Surya", "Vayusvara", "Daat"];
const MODES = [
  { id: "versus" },
  { id: "training" },
  { id: "tournament" },
  { id: "spectate" },
];
const DEFAULT_AVATAR_URL = "/avatars/default.png";

// ── UserCard ───────────────────────────────────────────────────────────────────

function UserCard({ user, stats, onLogout, logoutLoading }) {
  const { t } = useTranslation();
  const hasCustomAvatar = !!user.avatarUrl && user.avatarUrl !== DEFAULT_AVATAR_URL;
  const [avatarSrc,    setAvatarSrc]    = useState(hasCustomAvatar ? user.avatarUrl : "");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const initials = (user.username || user.email || t("fight.userCard.defaultInitials")).trim().slice(0, 2).toUpperCase();

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
          alt={t("fight.userCard.avatarAlt", { playerName: user.username || user.email || t("fight.userCard.playerFallback") })}
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
          <span><b>{stats.wins   ?? 0}</b> {t("fight.userCard.stats.winsShort")}</span>
          <span><b>{stats.losses ?? 0}</b> {t("fight.userCard.stats.lossesShort")}</span>
          <span>{t("fight.userCard.stats.levelShort")} <b>{stats.level ?? 1}</b></span>
          <span><b>{stats.xp ?? 0}</b> XP</span>
        </div>
      )}
      <button
        className="lobby-logout-link"
        type="button"
        onClick={onLogout}
        disabled={logoutLoading}
      >
        {logoutLoading ? "…" : t("fight.actions.logout")}
      </button>
    </div>
  );
}

// ── Mode: Versus ───────────────────────────────────────────────────────────────

function ModeVersus({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const { t } = useTranslation();
  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.modes.versus.description")}
      </p>
      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={() => onEnterGame("versus")}
        disabled={matchCooldown > 0 || graceActive}
      >
        {graceActive
          ? t("fight.status.waiting")
          : matchCooldown > 0
            ? t("fight.status.availableIn", { seconds: matchCooldown })
            : t("fight.modes.versus.cta")}
      </button>
    </div>
  );
}

// ── Mode: vs AI ────────────────────────────────────────────────────────────────

function ModeAI({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const { t } = useTranslation();
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
    : t("fight.modes.training.enemiesSelected", { count: selectedChars.length });

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.modes.training.description")}
      </p>

      <p className="lobby-section-label">{t("fight.modes.training.enemiesLabel")}</p>
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

      <p className="lobby-section-label">{t("fight.modes.training.stageLabel")}</p>
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
          ? t("fight.status.waiting")
          : matchCooldown > 0
            ? t("fight.status.availableIn", { seconds: matchCooldown })
            : t("fight.modes.training.cta", { enemyLabel })}
      </button>
    </div>
  );
}

// ── Mode: Tournament ───────────────────────────────────────────────────────────

function ModeTournament({ onEnterGame, matchCooldown = 0, graceActive = false }) {
  const { t } = useTranslation();
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
        already_started:   t("fight.tournament.errors.alreadyStarted"),
        room_full:         t("fight.tournament.errors.roomFull"),
        not_authenticated: t("fight.tournament.errors.notAuthenticated"),
        not_in_room:       t("fight.tournament.errors.notInRoom"),
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
      setRoomError(t("fight.tournament.errors.notConnected"));
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
  // When ≥2 humans are present the remaining slots will be filled with bots on launch.
  const willUseBots = playerCount >= 2 && playerCount < maxPlayers;

  if (!inRoom) {
    return (
      <div className="lobby-mode-body">
        <p className="lobby-mode-desc">
          {t("fight.modes.tournament.description")}
        </p>
        {room && (
          <p className="lobby-loading">
            {t("fight.tournament.waitingLine", {
              playerCount,
              maxPlayers,
              suffix: room.started ? ` ${t("fight.tournament.inProgressSuffix")}` : "",
            })}
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
            ? t("fight.status.waiting")
            : matchCooldown > 0
              ? t("fight.status.availableIn", { seconds: matchCooldown })
              : room?.started
                ? t("fight.modes.tournament.spectateCta")
                : t("fight.modes.tournament.joinCta")}
        </button>
      </div>
    );
  }

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.tournament.roomStatus", {
          playerCount,
          maxPlayers,
          suffix: room?.started ? ` ${t("fight.tournament.startedSuffix")}` : "",
        })}
      </p>

      <div className="lobby-sessions">
        {(room?.players ?? []).map((p, i) => (
          <div key={p.clientId} className="lobby-session-row">
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{i + 1}</span>
              <span className="lobby-session-players">{p.username ?? t("fight.tournament.playerFallback", { clientId: p.clientId })}</span>
              {p.clientId === (window._myClientId ?? -1) && (
                <span className="lobby-session-specs">{t("fight.tournament.youMarker")}</span>
              )}
            </div>
          </div>
        ))}
        {Array.from({ length: maxPlayers - playerCount }).map((_, i) => (
          <div key={`empty-${i}`} className="lobby-session-row" style={{ opacity: willUseBots ? 0.55 : 0.35 }}>
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{playerCount + i + 1}</span>
              {willUseBots ? (
                <>
                  <span className="lobby-session-players" style={{ fontStyle: "italic" }}>{t("fight.tournament.botLabel")}</span>
                  <span className="lobby-session-specs" style={{ fontSize: "0.72rem" }}>{t("fight.tournament.autofill")}</span>
                </>
              ) : (
                <span className="lobby-session-players" style={{ fontStyle: "italic" }}>{t("fight.status.waiting")}</span>
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
        title={playerCount < 2 ? t("fight.tournament.needPlayersTitle") : undefined}
      >
        {launching
          ? t("fight.tournament.starting")
          : playerCount < 2
            ? t("fight.tournament.waitingPlayers")
            : willUseBots
              ? t("fight.tournament.startWithBots", { playerCount, botCount: maxPlayers - playerCount })
              : t("fight.tournament.startPlayersOnly", { playerCount })}
      </button>

      <button
        className="lobby-watch-btn lobby-watch-lobby"
        type="button"
        onClick={handleLeave}
        style={{ marginTop: "4px" }}
      >
        {t("fight.modes.tournament.leaveCta")}
      </button>
    </div>
  );
}

// ── Mode: Spectator ────────────────────────────────────────────────────────────

function ModeSpectator({ onEnterGame }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const intervalRef = useRef(null);

  async function load() {
    try {
      const data = await apiFetchJson("/api/sessions");
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

  const modeLabel = {
    "1v1": t("fight.spectate.modeLabels.oneVsOne"),
    brawl: t("fight.spectate.modeLabels.brawl"),
    tournament: t("fight.spectate.modeLabels.tournament"),
  };

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.modes.spectate.description")}
      </p>

      {loading && <p className="lobby-loading">{t("fight.spectate.loading")}</p>}
      {error   && <p className="auth-error">{error}</p>}

      {!loading && sessions !== null && (
        sessions.length === 0 ? (
          <p className="lobby-loading">{t("fight.spectate.empty")}</p>
        ) : (
          <div className="lobby-sessions">
            {sessions.map(s => (
              <div key={s.sessionId} className="lobby-session-row">
                <div className="lobby-session-info">
                  <span className="lobby-session-badge">{modeLabel[s.mode] ?? s.mode}</span>
                  <span className="lobby-session-players">
                    {t("fight.spectate.playerCount", { count: s.playerIds.length })}
                  </span>
                  {s.spectators > 0 && (
                    <span className="lobby-session-specs">{t("fight.spectate.spectators", { count: s.spectators })}</span>
                  )}
                  {s.tournamentId && (
                    <span className="lobby-session-specs">{t("fight.spectate.tournamentTag", { tournamentId: s.tournamentId })}</span>
                  )}
                </div>
                <button
                  className="lobby-watch-btn"
                  type="button"
                  onClick={() => onEnterGame("spectate", { sessionId: s.sessionId })}
                >
                  {t("fight.modes.spectate.cta")}
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
  sssLocked   = false,
}) {
  const { t } = useTranslation();
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
        await apiFetchJson("/api/me");

        if (user.id) {
          try {
            const d = await apiFetchJson(`/api/users/${user.id}/stats`);
            if (!cancelled) {
              setStats(d.stats ?? d ?? null);
            }
          } catch (e) {
            console.error("[fight-lobby] stats load error:", e);
          }
        }
      } catch (e) {
        console.error("[fight-lobby] load error:", e);
        onLogout();
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user.id, onLogout]);

  // ── Game entry guard ──────────────────────────────────────────────────────
  const handleEnterGame = useCallback((mode, opts = {}) => {
    // Block all game entry while a leave-grace is pending (the server still has
    // us in an active session for up to 5s after pressing Back to lobby).
    // Entering training in this window would reconnectWS() and destroy the session.
    if (graceActive) return;
    setSessionError("");
    onEnterGame(mode, opts);
  }, [graceActive, onEnterGame]);

  // ── Back guard ────────────────────────────────────────────────────────────
  function handleBack() {
    if (graceActive || sssLocked) return;
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

        <div className="fight-lobby-toolbar">
          <div className="fight-lobby-toolbar-start">
            {!sssLocked ? (
              <PageBackButton
                onClick={handleBack}
                disabled={graceActive}
                title={graceActive ? t("fight.status.serverRelease") : undefined}
                style={{ position: "static", top: "auto", right: "auto" }}
              >
                {t("fight.actions.back")}
              </PageBackButton>
            ) : (
              <div className="fight-lobby-back-spacer" aria-hidden="true" />
            )}
          </div>
          <div className="fight-lobby-toolbar-end">
            <LanguageSelector variant="auth" compact />
          </div>
        </div>

        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">{t("fight.header.title")}</h1>

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
              {t(`fight.modes.${m.id}.tab`)}
            </button>
          ))}
        </div>

        <div className="lobby-mode-stack">
          {/* Grace-period notice: all game buttons are locked until the server
              releases the previous session (up to 5s after pressing Back) */}
          {graceActive ? (
            <p className="auth-error fight-lobby-inline-error">
              {t("fight.status.serverRelease")}
            </p>
          ) : null}

          {/* Mode content */}
          <div className="lobby-mode-panel">
            {activeMode === "versus"     && <ModeVersus     onEnterGame={handleEnterGame} matchCooldown={matchCooldown} graceActive={graceActive} />}
            {activeMode === "training"   && <ModeAI         onEnterGame={handleEnterGame} matchCooldown={matchCooldown} graceActive={graceActive} />}
            {activeMode === "tournament" && <ModeTournament  onEnterGame={handleEnterGame} matchCooldown={matchCooldown} graceActive={graceActive} />}
            {activeMode === "spectate"   && <ModeSpectator  onEnterGame={handleEnterGame} />}
          </div>

          <p
            className={sessionError ? "auth-error lobby-session-error" : "auth-error lobby-session-error lobby-session-error-empty"}
            aria-live="polite"
          >
            {sessionError || "\u00A0"}
          </p>
        </div>

        <div className="legal-footer">
          <button type="button" className="auth-link" onClick={onPrivacy}>{t("fight.legal.privacy")}</button>
          <span className="legal-separator">|</span>
          <button type="button" className="auth-link" onClick={onTerms}>{t("fight.legal.terms")}</button>
        </div>

      </div>
    </div>
  );
}
