import { useEffect } from "react";

export function useWsNavigationGuards({
  pageRef,
  setGrace,
  setGameMode,
  setGameOpts,
  setPage,
  cleanupMatchState,
}) {
  useEffect(() => {
    function onResumedMatch(event) {
      const detail = event.detail || {};
      if (!detail.resumed || pageRef.current === "game") return;

      const resumedMode = detail.spectatorSync
        ? "spectate"
        : detail.mode === "1v1" || detail.mode === "brawl"
          ? "versus"
          : detail.mode;

      setGrace(null);
      setGameMode(resumedMode || "versus");
      setGameOpts(
        detail.spectatorSync && detail.sessionId
          ? { sessionId: detail.sessionId }
          : {},
      );
      setPage("game");
    }

    window.addEventListener("match_start", onResumedMatch);
    return () => window.removeEventListener("match_start", onResumedMatch);
  }, [pageRef, setGameMode, setGameOpts, setGrace, setPage]);

  useEffect(() => {
    function onKickedResume() {
      setGrace(null);
      setGameMode("versus");
      setGameOpts({});
      const cur = pageRef.current;
      if (cur === "game" || cur === "fightLobby") {
        setPage("fightLobby");
      }
    }

    window.addEventListener("ws_kicked_resume", onKickedResume);
    return () => window.removeEventListener("ws_kicked_resume", onKickedResume);
  }, [pageRef, setGameMode, setGameOpts, setGrace, setPage]);

  useEffect(() => {
    function onLobbyEjected() {
      const cur = pageRef.current;
      if (cur !== "game") return;

      cleanupMatchState();
      setGrace(null);
      setGameMode("versus");
      setGameOpts({});
      setPage("fightLobby");
      console.log(
        "[App] ws_lobby_ejected: navigating from game -> fightLobby (empty stage avoided)",
      );
    }

    window.addEventListener("ws_lobby_ejected", onLobbyEjected);
    return () => window.removeEventListener("ws_lobby_ejected", onLobbyEjected);
  }, [cleanupMatchState, pageRef, setGameMode, setGameOpts, setGrace, setPage]);

  useEffect(() => {
    function onMatchFinishedApp() {
      requestAnimationFrame(() => {
        if (pageRef.current !== "game") return;

        cleanupMatchState();
        setGrace(null);
        setGameMode("versus");
        setGameOpts({});
        setPage("fightLobby");
        console.log("[App] match_finished backstop: navigating game -> fightLobby");
      });
    }

    window.addEventListener("match_finished", onMatchFinishedApp);
    return () =>
      window.removeEventListener("match_finished", onMatchFinishedApp);
  }, [cleanupMatchState, pageRef, setGameMode, setGameOpts, setGrace, setPage]);
}
