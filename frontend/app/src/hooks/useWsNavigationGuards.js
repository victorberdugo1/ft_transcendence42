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
