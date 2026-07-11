import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export default function ModeTournament({
  onEnterGame,
  matchCooldown = 0,
  graceActive = false,
}) {
  const { t } = useTranslation();
  const [room, setRoom] = useState(null);
  const [inRoom, setInRoom] = useState(false);
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
        try {
          sessionStorage.removeItem("inTournamentRoom");
        } catch (_) {}
        return;
      }
      // welcome:true means the server pushed this as part of sendWelcomeToPlayer —
      // the player is confirmed to be in the room, even if _myClientId is still -1.
      if (data.welcome && !data.started) {
        joinedThisSession = true;
        setInRoom(true);
        try {
          sessionStorage.setItem("inTournamentRoom", "1");
        } catch (_) {}
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
      const amInList =
        myId !== -1 && data.players?.some((p) => p.clientId === myId);
      if (!data.started) {
        if (amInList || joinedThisSession) {
          setInRoom(true);
          joinedThisSession = true;
          try {
            sessionStorage.setItem("inTournamentRoom", "1");
          } catch (_) {}
        }
      }
      if (data.started && data.tournamentId) {
        // Clear the flag — tournament is underway, no need to re-join on next reload.
        try {
          sessionStorage.removeItem("inTournamentRoom");
        } catch (_) {}
        const amPlayer = data.players?.some((p) => p.clientId === myId);
        // Only auto-enter if we explicitly joined the room this session.
        // Reconnect after grace sends started:true immediately — block that.
        // Also guard the race where _myClientId is still -1 when this fires:
        // if joinedThisSession is true and myId is -1, we ARE a participant
        // (the server added us), so enter. amPlayer will be true once init resolves.
        const shouldEnter =
          joinedThisSession && (amPlayer || myId === -1);
        if (shouldEnter) {
          onEnterGame("tournament", { tournamentId: data.tournamentId });
        }
      }
    }
    function onStarted(e) {
      const data = e.detail;
      setRoom((prev) =>
        prev
          ? {
              ...prev,
              started: true,
              tournamentId: data.tournamentId,
            }
          : prev
      );
      // Clear the flag — tournament is underway.
      try {
        sessionStorage.removeItem("inTournamentRoom");
      } catch (_) {}
      const myId = window._myClientId ?? -1;
      // Guard race: if myId is still -1 but we joined this session, we're a participant.
      const shouldEnter =
        joinedThisSession &&
        (data.playerIds?.includes(myId) || myId === -1);
      if (shouldEnter) {
        onEnterGame("tournament", { tournamentId: data.tournamentId });
      }
    }
    function onError(e) {
      const reason = e.detail?.reason ?? "Unknown error";
      const msgs = {
        already_started: t("fight.tournament.errors.alreadyStarted"),
        room_full: t("fight.tournament.errors.roomFull"),
        not_authenticated: t(
          "fight.tournament.errors.notAuthenticated"
        ),
        not_in_room: t("fight.tournament.errors.notInRoom"),
      };
      setRoomError(msgs[reason] ?? reason);
      setLaunching(false);
    }
    window.addEventListener("tournament_room_update", onRoomUpdate);
    window.addEventListener("tournament_started", onStarted);
    window.addEventListener("tournament_room_error", onError);

    // Auto-rejoin path (inTournamentRoom in sessionStorage) fires tournament_join
    // from ws-client init handler — mark joinedThisSession so the room update
    // that follows is treated as a genuine join, not a stale reconnect replay.
    function onAutoJoined() {
      joinedThisSession = true;
      setInRoom(true);
    }
    window.addEventListener(
      "ws_tournament_joined_this_session",
      onAutoJoined
    );

    // Expose setter so handleJoin can flag joinedThisSession = true
    // without breaking the closure (we can't call setInRoom from here).
    ModeTournament._setJoined = (v) => {
      joinedThisSession = v;
    };

    return () => {
      window.removeEventListener("tournament_room_update", onRoomUpdate);
      window.removeEventListener("tournament_started", onStarted);
      window.removeEventListener("tournament_room_error", onError);
      window.removeEventListener(
        "ws_tournament_joined_this_session",
        onAutoJoined
      );
      ModeTournament._setJoined = null;
    };
  }, [onEnterGame, t]);

  function handleJoin() {
    setRoomError("");
    if (!window._ws || window._ws.readyState !== 1) {
      setRoomError(t("fight.tournament.errors.notConnected"));
      return;
    }
    window._ws.send(JSON.stringify({ type: "tournament_join" }));
    // Persist membership so a page reload (forfeit, F5) auto-rejoins the room.
    try {
      sessionStorage.setItem("inTournamentRoom", "1");
    } catch (_) {}
    // Mark that we explicitly joined in this session so onRoomUpdate knows
    // a started:true event is genuine and not a stale reconnect replay.
    if (typeof ModeTournament._setJoined === "function")
      ModeTournament._setJoined(true);
    setInRoom(true);
  }

  function handleLeave() {
    setRoomError("");
    if (window._ws?.readyState === 1) {
      window._ws.send(JSON.stringify({ type: "tournament_leave" }));
    }
    // Clear persistence — player consciously left the room.
    try {
      sessionStorage.removeItem("inTournamentRoom");
    } catch (_) {}
    // Clear the pending tournament intent so GameShell doesn't fire a stale
    // tournament join if the user later enters versus or training mode.
    window._pendingTournament = false;
    if (typeof ModeTournament._setJoined === "function")
      ModeTournament._setJoined(false);
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
  const canLaunch =
    inRoom && playerCount >= 2 && !room?.started && !launching;
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
              suffix: room.started
                ? ` ${t("fight.tournament.inProgressSuffix")}`
                : "",
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
              ? t("fight.status.availableIn", {
                  seconds: matchCooldown,
                })
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
          suffix: room?.started
            ? ` ${t("fight.tournament.startedSuffix")}`
            : "",
        })}
      </p>

      <div className="lobby-sessions">
        {(room?.players ?? []).map((p, i) => (
          <div key={p.clientId} className="lobby-session-row">
            <div className="lobby-session-info">
              <span className="lobby-session-badge">#{i + 1}</span>
              <span className="lobby-session-players">
                {p.username ??
                  t("fight.tournament.playerFallback", {
                    clientId: p.clientId,
                  })}
              </span>
              {p.clientId === (window._myClientId ?? -1) && (
                <span className="lobby-session-specs">
                  {t("fight.tournament.youMarker")}
                </span>
              )}
            </div>
          </div>
        ))}
        {Array.from({ length: maxPlayers - playerCount }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="lobby-session-row"
            style={{ opacity: willUseBots ? 0.55 : 0.35 }}
          >
            <div className="lobby-session-info">
              <span className="lobby-session-badge">
                #{playerCount + i + 1}
              </span>
              {willUseBots ? (
                <>
                  <span
                    className="lobby-session-players"
                    style={{ fontStyle: "italic" }}
                  >
                    {t("fight.tournament.botLabel")}
                  </span>
                  <span
                    className="lobby-session-specs"
                    style={{ fontSize: "0.72rem" }}
                  >
                    {t("fight.tournament.autofill")}
                  </span>
                </>
              ) : (
                <span
                  className="lobby-session-players"
                  style={{ fontStyle: "italic" }}
                >
                  {t("fight.status.waiting")}
                </span>
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
        title={
          playerCount < 2 ? t("fight.tournament.needPlayersTitle") : undefined
        }
      >
        {launching
          ? t("fight.tournament.starting")
          : playerCount < 2
            ? t("fight.tournament.waitingPlayers")
            : willUseBots
              ? t("fight.tournament.startWithBots", {
                  playerCount,
                  botCount: maxPlayers - playerCount,
                })
              : t("fight.tournament.startPlayersOnly", {
                  playerCount,
                })}
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
