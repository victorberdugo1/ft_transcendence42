import LanguageSelector from "@src/components/LanguageSelector.jsx";
import ModeAI from "@src/components/game/ModeAI.jsx";
import ModeSpectator from "@src/components/game/ModeSpectator.jsx";
import ModeTournament from "@src/components/game/ModeTournament.jsx";
import ModeVersus from "@src/components/game/ModeVersus.jsx";
import { DEFAULT_AVATAR_URL, MODES } from "@src/components/game/gameConstants.js";
import PageBackButton from "@src/components/ui/PageBackButton.jsx";
import { apiFetchJson } from "@src/utils/http.js";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Game Constants ─────────────────────────────────────────────────────────────

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
        // Only a real auth failure should log the user out — a transient
        // network hiccup or a fetch racing an in-flight WS reconnect must
        // not be escalated into a session-ending logout.
        if (!cancelled && (e?.status === 401 || e?.status === 403)) onLogout();
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
    <div className="fight-lobby-page">
      <div className="lobby-card">

        <div className="fight-lobby-toolbar max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:mb-4">
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
