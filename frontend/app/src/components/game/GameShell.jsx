import { useEffect, useRef, useState } from "react";

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

// Stays mounted for the entire authenticated session so Emscripten never
// re-initialises (doing so crashes preMainLoop). inLobby=true never hides
// the canvas (no visibility/opacity toggles) — it only lowers its z-index
// so the lobby page sits visually on top, without unmounting or hiding it.
export default function GameShell({
  user,
  gameMode,
  gameOpts,
  gameOptsRef,
  inLobby,
  onBackToLobby,
  grace,
  onRegisterBack,
}) {
  const canvasRef = useRef(null);
  const scriptRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState("");
  const [sessionErr, setSessionErr] = useState("");
  const [pairDissolved, setPairDissolved] = useState(false);
  const [matchStarted, setMatchStarted] = useState(false);
  const matchStartedRef = useRef(false);

  const [paired, setPaired] = useState(false);
  const pairedRef = useRef(false);

  const [leaveLocked, setLeaveLocked] = useState(false);
  const leaveLockTimerRef = useRef(null);
  const leaveLockedRef = useRef(false);
  useEffect(() => {
    leaveLockedRef.current = leaveLocked;
  }, [leaveLocked]);

  const [lobbyPaired, setLobbyPaired] = useState(false);
  const lobbyPairedRef = useRef(false);

  const [leaveAckPending, setLeaveAckPending] = useState(false);
  const leaveAckPendingRef = useRef(false);
  useEffect(() => {
    leaveAckPendingRef.current = leaveAckPending;
  }, [leaveAckPending]);

  // window._victoryActive is a plain global flipped by ws-client.js the
  // instant the 'victory' message arrives (well before the delayed 'victory'
  // DOM event fires for the overlay). Mirror it into real state so the
  // "Back to lobby" button's disabled/title actually update the moment it
  // flips, instead of only on the next unrelated re-render.
  const [victoryActive, setVictoryActive] = useState(!!window._victoryActive);

  // Disparar evento de touch-controls cuando el match comienza/termina
  useEffect(() => {
    if (matchStarted && window._touchControls) {
      window._touchControls.showControls();
    } else if (!matchStarted && window._touchControls) {
      window._touchControls.hideControls();
      window._touchControls.reset();
    }
  }, [matchStarted]);

  function handleBackToLobby() {
    if (
      lobbyPairedRef.current &&
      gameMode !== "training" &&
      gameMode !== "spectate" &&
      !window._isSpectator &&
      !window._eliminatedFromSession
    ) {
      console.warn(
        "[UI] Back to lobby ignored — lobby pair in progress (stage confirmed, awaiting match_start)",
      );
      return;
    }
    if (
      pairedRef.current &&
      leaveLockedRef.current &&
      gameMode !== "training" &&
      gameMode !== "spectate" &&
      !window._isSpectator &&
      !window._eliminatedFromSession
    ) {
      console.warn(
        "[UI] Back to lobby ignored — match setup in progress (SSS/countdown)",
      );
      return;
    }

    const isVersusGuarded =
      gameMode === "versus" &&
      !window._isSpectator &&
      !window._eliminatedFromSession;

    try {
      if (window._ws?.readyState === 1) {
        window._ws.send(JSON.stringify({ type: "leave" }));
      }
    } catch (_) {}

    if (isVersusGuarded) {
      setLeaveAckPending(true);
      window._leaveCleanupPending = {
        gameMode,
        eliminatedFromSession: !!window._eliminatedFromSession,
      };
      return;
    }

    _performBackToLobbyCleanup();
  }

  function _performBackToLobbyCleanup() {
    if (window._eliminatedFromSession) {
      try {
        const existing = parseInt(
          sessionStorage.getItem("matchmakingSafeAt") ?? "0",
          10,
        );
        const proposed = Date.now() + 9000;
        if (proposed > existing)
          sessionStorage.setItem("matchmakingSafeAt", String(proposed));
      } catch (_) {}
    }

    if (gameMode === "training") {
      window._matchSession = null;
      window._programmaticReload = true;
      window._manualReconnect = true;
      window._pendingTraining = null;
      window._pendingGameMode = "versus";
      try {
        window._ws?.close();
      } catch (_) {}
      try {
        [
          "clientId",
          "charSelectData",
          "pendingCharSelect",
          "watchSession",
          "gameState",
          "confirmedStageId",
        ].forEach((k) => sessionStorage.removeItem(k));
        window._myClientId = -1;
        sessionStorage.setItem("postTrainingReload", "1");
      } catch (_) {}
      window.location.reload();
      return;
    }

    if (
      gameMode === "spectate" ||
      window._isSpectator ||
      window._eliminatedFromSession
    ) {
      window._manualReconnect = true;
      window._pendingGameMode = "versus";
      window._programmaticReload = true;
      window._playerChoseToLeave = true;
      try {
        window._ws?.close();
      } catch (_) {}
      try {
        [
          "clientId",
          "charSelectData",
          "pendingCharSelect",
          "watchSession",
          "gameState",
          "confirmedStageId",
        ].forEach((k) => sessionStorage.removeItem(k));
        window._myClientId = -1;
      } catch (_) {}
      window.location.reload();
      return;
    }

    Object.assign(window, {
      _isSpectator: false,
      _spectatorMode: null,
      _matchSession: null,
      _endingSessionId: null,
      _victoryActive: false,
      _victoryConsumed: true,
      _hitstopState: null,
      _countdownStart: null,
      _countdownEndsAt: null,
      _countdownDurationMs: 0,
      _countdownDone: false,
      _confirmedStageId: undefined,
      _isHost: undefined,
      _charSelectData: null,
      _charSelectConfirmed: false,
      _gameState: { players: {} },
      _eliminatedFromSession: null,
    });
    try {
      [
        "charSelectData",
        "pendingCharSelect",
        "watchSession",
        "gameState",
        "confirmedStageId",
      ].forEach((k) => sessionStorage.removeItem(k));
    } catch (_) {}

    setPaired(false);
    pairedRef.current = false;
    setLeaveAckPending(false);
    setVisible(false);
    setStatus("");
    onBackToLobby();
  }

  // handleBackToLobby closes over `gameMode` (and window.* state) from the
  // render it was created in. onRegisterBack below only runs once on mount,
  // so without this ref indirection the parent would keep calling a closure
  // frozen at the very first render forever — e.g. always treating the game
  // as "versus" even after switching to training/spectate/tournament, which
  // broke the browser back button outside Versus mode.
  const handleBackToLobbyRef = useRef(handleBackToLobby);
  useEffect(() => {
    handleBackToLobbyRef.current = handleBackToLobby;
  });

  useEffect(() => {
    if (typeof onRegisterBack === "function") {
      onRegisterBack(() => handleBackToLobbyRef.current());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const { w, h } = calcResolution();
    window._canvasWidth = w;
    window._canvasHeight = h;
    window._pendingGameMode = gameMode;
    window._pendingGameOpts = gameOptsRef.current ?? {};
    window.Module = { canvas: canvasRef.current, locateFile: (p) => `/${p}` };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (inLobby) return;

    const currentOpts = gameOptsRef.current ?? {};

    window._pendingGameMode = gameMode;
    window._pendingGameOpts = currentOpts;
    setVisible(false);
    setStatus("");
    setMatchStarted(false);
    matchStartedRef.current = false;
    setPairDissolved(false);

    try {
      sessionStorage.removeItem("confirmedStageId");
      sessionStorage.removeItem("gameState");
    } catch (_) {}
    window._confirmedStageId = undefined;
    window._matchEnded = false;

    if (gameMode === "training") {
      window._pendingGameMode = "training";
      window._pendingGameOpts = currentOpts;
      window._pendingTraining = currentOpts ?? {
        cpuCharIds: ["eld"],
        stageId: 0,
      };
      if (typeof window.reconnectWS === "function") window.reconnectWS();
      return;
    }

    if (gameMode === "spectate") {
      window._pendingGameMode = "spectate";
      window._pendingGameOpts = currentOpts;
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
          _countdownEndsAt: null,
          _countdownDurationMs: 0,
          _countdownDone: false,
        });
        window._ws.send(
          JSON.stringify({
            type: "rejoin",
            clientId: parseInt(savedId, 10),
            seekingMatch: gameMode === "versus",
          }),
        );
      } else if (gameMode === "spectate") {
        window._ws.send(
          JSON.stringify({
            type: "watch",
            sessionId: currentOpts?.sessionId ?? null,
          }),
        );
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
  }, [inLobby, gameMode]);

  useEffect(() => {
    if (inLobby) return;

    // Da tiempo al WASM a pintar al menos un frame real antes de revelar el
    // canvas — si se revela en el mismo instante en que llegan los datos,
    // a veces se alcanza a ver un frame negro sin dibujar.
    const revealCanvas = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setVisible(true);
          setStatus("");
        });
      });
    };

    const poll = setInterval(() => {
      if (window._isSpectator && window._myClientId > 0) {
        revealCanvas();
        clearInterval(poll);
        return;
      }
      const id = window._myClientId;
      if (id > 0 && window._gameState?.players?.[id]) {
        revealCanvas();
        clearInterval(poll);
      }
    }, 50);

    const onStart = (event) => {
      setSessionErr("");
      setStatus("");
      setMatchStarted(true);
      matchStartedRef.current = true;
      setPairDissolved(false);
      setLobbyPaired(false);
      lobbyPairedRef.current = false;
      setPaired(true);
      pairedRef.current = true;
      const countdownRemainingMs = Math.max(
        0,
        Number(event.detail?.countdownRemainingMs) || 0,
      );
      const countdownActive = countdownRemainingMs > 0;
      setLeaveLocked(countdownActive);
      leaveLockedRef.current = countdownActive;

      if (leaveLockTimerRef.current) clearTimeout(leaveLockTimerRef.current);
      if (countdownActive) {
        leaveLockTimerRef.current = setTimeout(() => {
          setLeaveLocked(false);
          leaveLockedRef.current = false;
          leaveLockTimerRef.current = null;
        }, countdownRemainingMs + 100);
      } else {
        leaveLockTimerRef.current = null;
      }
    };

    const onTrainingStartError = (event) => {
      setStatus("");
      setSessionErr(
        event.detail?.error || "Could not start the training session",
      );
    };

    let enteredAsVoluntarySpectator = false;
    const onSpectateMode = (e) => {
      revealCanvas();
      enteredAsVoluntarySpectator = !e.detail?.eliminated;
    };

    let matchFinishedTimer = null;
    const onMatchFinished = () => {
      setPaired(false);
      pairedRef.current = false;
      setLeaveLocked(false);
      leaveLockedRef.current = false;
      if (leaveLockTimerRef.current) {
        clearTimeout(leaveLockTimerRef.current);
        leaveLockTimerRef.current = null;
      }
      if (enteredAsVoluntarySpectator) {
        matchFinishedTimer = setTimeout(() => {
          window._programmaticReload = true;
          window._playerChoseToLeave = true;
          handleBackToLobby();
        }, 2000);
      }
    };

    let victorySpectatorTimer = null;
    const onVictorySpectator = () => {
      if (!enteredAsVoluntarySpectator) {
        victorySpectatorTimer = setTimeout(() => {
          window._programmaticReload = true;
          window._playerChoseToLeave = true;
          handleBackToLobby();
        }, 5000);
      }
    };

    const onPairDissolved = () => {
      if (!matchStartedRef.current) setPairDissolved(true);
    };

    const onLobbyPaired = () => {
      setLobbyPaired(true);
      lobbyPairedRef.current = true;
    };
    const onLobbyUnpaired = () => {
      setLobbyPaired(false);
      lobbyPairedRef.current = false;
    };

    const onLeaveAck = (e) => {
      const detail = e.detail || {};
      if (detail.rejected) {
        setLeaveAckPending(false);
        setLobbyPaired(true);
        lobbyPairedRef.current = true;
        setLeaveLocked(true);
        leaveLockedRef.current = true;
        console.warn("[UI] leave rejected by server:", detail.reason);
        return;
      }
      setPaired(false);
      pairedRef.current = false;
      if (leaveAckPendingRef.current) {
        _performBackToLobbyCleanup();
      }
    };

    const onGraceExpiredSelf = (e) => {
      if (e.detail?.clientId === (window._myClientId ?? -1)) {
        setPaired(false);
        pairedRef.current = false;
      }
    };

    const victoryPoll = setInterval(() => {
      setVictoryActive((prev) => {
        const next = !!window._victoryActive;
        return prev === next ? prev : next;
      });
    }, 100);

    window.addEventListener("match_start", onStart);
    window.addEventListener("training_start_error", onTrainingStartError);
    window.addEventListener("spectator_mode", onSpectateMode);
    window.addEventListener("match_finished", onMatchFinished);
    window.addEventListener("victory_spectator", onVictorySpectator);
    window.addEventListener("pair_dissolved", onPairDissolved);
    window.addEventListener("leave_ack", onLeaveAck);
    window.addEventListener("leave_grace_expired", onGraceExpiredSelf);
    window.addEventListener("lobby_paired", onLobbyPaired);
    window.addEventListener("lobby_unpaired", onLobbyUnpaired);

    return () => {
      clearInterval(poll);
      clearInterval(victoryPoll);
      clearTimeout(matchFinishedTimer);
      clearTimeout(victorySpectatorTimer);
      if (leaveLockTimerRef.current) {
        clearTimeout(leaveLockTimerRef.current);
        leaveLockTimerRef.current = null;
      }
      window.removeEventListener("match_start", onStart);
      window.removeEventListener("training_start_error", onTrainingStartError);
      window.removeEventListener("spectator_mode", onSpectateMode);
      window.removeEventListener("match_finished", onMatchFinished);
      window.removeEventListener("victory_spectator", onVictorySpectator);
      window.removeEventListener("pair_dissolved", onPairDissolved);
      window.removeEventListener("leave_ack", onLeaveAck);
      window.removeEventListener("leave_grace_expired", onGraceExpiredSelf);
      window.removeEventListener("lobby_paired", onLobbyPaired);
      window.removeEventListener("lobby_unpaired", onLobbyUnpaired);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inLobby]);

  return (
    <div
      className="game-page"
      style={{
        zIndex: inLobby ? -1 : 1,
        pointerEvents: inLobby ? "none" : "auto",
      }}
    >
      <div className="game-toolbar">
        {!inLobby && gameMode !== "tournament" && (
          <button
            type="button"
            className="logout-button"
            onClick={handleBackToLobby}
            disabled={
              !!(grace && grace.clientId !== (window._myClientId ?? -1)) ||
              victoryActive ||
              (lobbyPaired && gameMode === "versus") ||
              (paired && leaveLocked && gameMode === "versus")
            }
            title={
              victoryActive
                ? "Victory animation in progress…"
                : grace && grace.clientId !== (window._myClientId ?? -1)
                  ? "Your rival has a few seconds to reconnect..."
                  : (lobbyPaired || (paired && leaveLocked)) &&
                      gameMode === "versus"
                    ? "Match setup in progress — please wait…"
                    : undefined
            }
          >
            Back to lobby
          </button>
        )}
      </div>

      {status && (
        <div className="game-status-overlay">
          <p>{status}</p>
        </div>
      )}
      {pairDissolved && !matchStarted && (
        <div className="game-status-overlay">
          <p>⚠️ Your partner left — select stage and character again</p>
        </div>
      )}
      {sessionErr && (
        <div className="game-status-overlay game-status-error">
          <p>{sessionErr}</p>
          <button
            type="button"
            className="auth-link"
            onClick={handleBackToLobby}
          >
            Back to lobby
          </button>
        </div>
      )}

      <div className="game-frame">
        <canvas ref={canvasRef} id="canvas" className="game-canvas" />
      </div>
    </div>
  );
}
