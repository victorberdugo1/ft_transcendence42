import AuthGate from "@src/components/auth/AuthGate.jsx";
import LoadingScreen from "@src/components/auth/LoadingScreen.jsx";
import GameShell from "@src/components/game/GameShell.jsx";
import GraceBanner from "@src/components/game/GraceBanner.jsx";
import { useBrowserBackGuard } from "@src/hooks/useBrowserBackGuard.js";
import { useLeaveGrace } from "@src/hooks/useLeaveGrace.js";
import { useLobbySssLock } from "@src/hooks/useLobbySssLock.js";
import { useSessionAuth } from "@src/hooks/useSessionAuth.js";
import { useWsNavigationGuards } from "@src/hooks/useWsNavigationGuards.js";
import "@src/pages/achievements/achievements.css";
import Achievements from "@src/pages/achievements/Achievements.jsx";
import "@src/pages/auth/auth.css";
import Privacy from "@src/pages/auth/Privacy.jsx";
import Terms from "@src/pages/auth/Terms.jsx";
import "@src/pages/fight/fight.css";
import FightLobby from "@src/pages/fight/FightLobby.jsx";
import "@src/pages/lobby/lobby.css";
import Lobby from "@src/pages/lobby/Lobby.jsx";
import "@src/pages/manual/manual.css";
import Manual from "@src/pages/manual/Manual.jsx";
import "@src/pages/page-shared.css";
import "@src/pages/profile/profile.css";
import Profile from "@src/pages/profile/Profile.jsx";
import "@src/pages/social/social.css";
import SocialHub from "@src/pages/social/SocialHub.jsx";
import { apiFetchJson } from "@src/utils/http.js";
import { cleanupMatchState } from "@src/utils/cleanupMatchState.js";
import { useCallback, useEffect, useRef, useState } from "react";

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

function teardownGameRuntime() {
  const glfw = window.GLFW;
  if (glfw) {
    if (typeof glfw.onKeydown === "function") {
      window.removeEventListener("keydown", glfw.onKeydown, true);
      document.removeEventListener("keydown", glfw.onKeydown, true);
    }
    if (typeof glfw.onKeyPress === "function") {
      window.removeEventListener("keypress", glfw.onKeyPress, true);
      document.removeEventListener("keypress", glfw.onKeyPress, true);
    }
    if (typeof glfw.onKeyup === "function") {
      window.removeEventListener("keyup", glfw.onKeyup, true);
      document.removeEventListener("keyup", glfw.onKeyup, true);
    }
    if (typeof glfw.onBlur === "function") {
      window.removeEventListener("blur", glfw.onBlur, true);
      document.removeEventListener("blur", glfw.onBlur, true);
    }
  }

  const gameScript = document.querySelector('script[src="/game.js"]');
  if (gameScript) gameScript.remove();

  // Defensive reset in case a previous runtime assigned DOM key handlers.
  window.onkeydown = null;
  window.onkeyup = null;
  window.onkeypress = null;
  document.onkeydown = null;
  document.onkeyup = null;
  document.onkeypress = null;

  // If a focus trap or stale element survived outside React, drop focus now.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export default function App() {
  const [authStatus, setAuthStatus] = useState("loading");
  const [authView, setAuthView] = useState("login");
  const [authEpoch, setAuthEpoch] = useState(0);
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("auth");
  const [legalBackPage, setLegalBackPage] = useState("auth");
  const [gameMode, setGameMode] = useState("versus");
  const [gameOpts, setGameOpts] = useState({});
  const [socialInitialTab, setSocialInitialTab] = useState("global");
  // Ref espejo de gameOpts — permite que el efecto de GameShell lea los opts
  // actuales sin necesitar gameOpts como dependencia (evita doble disparo).
  const gameOptsRef = useRef({});
  const { grace, setGrace } = useLeaveGrace();
  // True while stage_confirmed arrived but match_start has not yet —
  // i.e. the lobby SSS pair is active. Blocks ALL back-navigation at
  // the App level so neither FightLobby nor GameShell can exit.
  const { sssLocked, sssLockedRef } = useLobbySssLock();

  // Ref used by the browser-back handler so it can call GameShell's cleanup
  // without a stale closure.
  const backToLobbyRef = useRef(null);
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
    if (page !== "game") teardownGameRuntime();
  }, [page]);

  useSessionAuth({ setUser, setAuthStatus, setPage, normalizeUser });

  const runMatchCleanup = useCallback(() => {
    cleanupMatchState();
  }, []);

  useBrowserBackGuard({
    pageRef,
    authStatusRef,
    legalBackPageRef,
    backToLobbyRef,
    setPage,
    cleanupMatchState: runMatchCleanup,
  });

  useWsNavigationGuards({
    pageRef,
    setGrace,
    setGameMode,
    setGameOpts,
    setPage,
    cleanupMatchState: runMatchCleanup,
  });

  // ── Navigation helpers ──────────────────────────────────────────────────────
  function openPrivacy(from) {
    setLegalBackPage(from);
    setPage("privacy");
  }
  function openTerms(from) {
    setLegalBackPage(from);
    setPage("terms");
  }

  function handleAuthSuccess(rawUser) {
    setUser(normalizeUser(rawUser));
    setAuthStatus("authenticated");
    if (typeof window.reconnectWS === "function") window.reconnectWS();
    setPage("lobby");
  }

  async function handleLogout() {
    try {
      await apiFetchJson("/api/logout", { method: "POST" });
    } catch (_) {}

    teardownGameRuntime();

    setUser(null);
    setAuthStatus("guest");
    setAuthView("login");
    setAuthEpoch((v) => v + 1);
    // Clean matchmaking cooldown so it does not bleed into the next login.
    try {
      sessionStorage.removeItem("matchmakingSafeAt");
    } catch (_) {}
    setPage("auth");
    // Reconnect WS so the old authenticated socket is closed and replaced
    // with an unauthenticated one. Without this the server keeps the slot open.
    if (typeof window.reconnectWS === "function") window.reconnectWS();

    // Some stale capture listeners from previous game runtimes can survive
    // a SPA-only transition. A programmatic reload guarantees a clean keyboard
    // state (same effect users report when pressing F5 manually).
    window._programmaticReload = true;
    window._playerChoseToLeave = true;
    window.location.reload();
  }

  const handleEnterGame = useCallback((mode, opts = {}) => {
    gameOptsRef.current = opts; // actualizar ref ANTES del setState para que
    setGameMode(mode); // el efecto de GameShell lea el valor correcto
    setGameOpts(opts); // sin necesitar gameOpts como dependencia
    setGrace(null);
    setPage("game");
  }, []);

  // Player clicks "Rejoin fight" from the GraceBanner
  function handleRejoinFight() {
    // BUG FIX: this used to only clear local UI state (setGrace/setPage),
    // never telling the server. We never actually disconnected (same ws,
    // same clientId — we just sent 'leave'), so the server's 5s forfeit
    // timer (pendingEliminations) kept running regardless of this click,
    // and the opponent was awarded the win once it expired. Sending
    // 'cancel_leave' clears that timer server-side so rejoining actually
    // saves the match instead of just hiding the banner locally.
    try {
      if (typeof window.cancelLeaveGrace === "function") {
        window.cancelLeaveGrace();
      } else if (window._ws?.readyState === 1) {
        window._ws.send(JSON.stringify({ type: "cancel_leave" }));
      }
    } catch (_) {}
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
    // Blocked while SSS pair is active (stage_confirmed received, match_start
    // not yet). The server will reject a leave at this point anyway; prevent
    // the optimistic navigation so the player stays in fightLobby.
    if (sssLockedRef.current) return;

    if (typeof backToLobbyRef.current === "function") {
      // GameShell is mounted — run the full cleanup. It calls onBackToLobby()
      // which sets page="fightLobby"; we override that to go all the way to "lobby".
      // We swap onBackToLobby temporarily for this one call.
      // Patch: call handleBackToLobby but land on "lobby" not "fightLobby".
      // Since handleBackToLobby calls onBackToLobby() which is () => setPage("fightLobby"),
      // we need a different approach: do the cleanup inline and then go to "lobby".
      runMatchCleanup();
      setPage("lobby");
    } else {
      setPage("lobby");
    }
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

  if (page === "privacy")
    return <Privacy onBack={() => setPage(legalBackPage)} />;
  if (page === "terms") return <Terms onBack={() => setPage(legalBackPage)} />;

  if (authStatus !== "authenticated" || !user) {
    return (
      <AuthGate
        key={`auth-${authEpoch}`}
        view={authView}
        onChangeView={setAuthView}
        onLogin={handleAuthSuccess}
        onPrivacy={() => openPrivacy("auth")}
        onTerms={() => openTerms("auth")}
      />
    );
  }

  // GameShell MUST stay mounted across every post-login page so the Emscripten
  // WASM module is never torn down and re-injected (re-initialising it races the
  // still-running previous instance against shared Module/Browser/GL globals,
  // crashing mainLoop — see teardownGameRuntime, which only removes the <script>
  // tag and never actually stops the WASM runtime's requestAnimationFrame loop).
  // It is hidden (visibility:hidden) whenever page !== "game".
  const gameActive =
    page === "lobby" ||
    page === "profile" ||
    page === "fightLobby" ||
    page === "game" ||
    page === "achievements" ||
    page === "social" ||
    page === "manual";
  const myClientId = window._myClientId ?? -1;

  return (
    <>
      {/* GameShell is always mounted once the user is authenticated */}
      {gameActive && (
        <GameShell
          user={user}
          gameMode={gameMode}
          gameOpts={gameOpts}
          gameOptsRef={gameOptsRef}
          inLobby={page !== "game"}
          onBackToLobby={() => setPage("fightLobby")}
          grace={grace}
          onRegisterBack={(fn) => {
            backToLobbyRef.current = fn;
          }}
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
            onProfile={() => setPage("profile")}
            onAchievements={() => setPage("achievements")}
            onSocial={() => {
              setSocialInitialTab("global");
              setPage("social");
            }}
            onManual={() => setPage("manual")}
            onLogout={handleLogout}
          />
        </div>
      )}

      {page === "social" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10, overflow: "auto" }}>
          <SocialHub
            user={user}
            initialTab={socialInitialTab}
            onBack={() => setPage("lobby")}
          />
        </div>
      )}

      {page === "achievements" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10 }}>
          <Achievements user={user} onBack={() => setPage("lobby")} />
        </div>
      )}

      {page === "manual" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10 }}>
          <Manual onBack={() => setPage("lobby")} />
        </div>
      )}

      {page === "profile" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10 }}>
          <Profile onBack={() => setPage("lobby")} />
        </div>
      )}

      {/* FightLobby: mode selector (versus / training / tournament / spectate) */}
      {page === "fightLobby" && (
        <div
          className="fight-lobby-overlay"
          style={{ position: "fixed", inset: 0, zIndex: 10 }}
        >
          <FightLobby
            user={user}
            onEnterGame={handleEnterGame}
            onBack={handleBackFromFightLobby}
            onLogout={handleLogout}
            onPrivacy={() => openPrivacy("fightLobby")}
            onTerms={() => openTerms("fightLobby")}
            graceActive={!!(grace && grace.clientId === myClientId)}
            sssLocked={sssLocked}
          />
        </div>
      )}
    </>
  );
}
