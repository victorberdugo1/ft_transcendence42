import { useEffect } from "react";

export function useBrowserBackGuard({
  pageRef,
  authStatusRef,
  legalBackPageRef,
  backToLobbyRef,
  setPage,
  cleanupMatchState,
}) {
  useEffect(() => {
    const historyState = { enumaHistoryGuard: true };
    window.history.replaceState(historyState, "", window.location.href);
    window.history.pushState(historyState, "", window.location.href);

    function handleBrowserBack() {
      const currentPage = pageRef.current;

      if (currentPage === "game") {
        if (typeof backToLobbyRef.current === "function") {
          backToLobbyRef.current();
        } else {
          setPage("fightLobby");
        }
      } else if (currentPage === "fightLobby") {
        cleanupMatchState();
        setPage("lobby");
      } else if (currentPage === "profile") {
        setPage("lobby");
      } else if (currentPage === "privacy" || currentPage === "terms") {
        setPage(legalBackPageRef.current || "lobby");
      } else if (authStatusRef.current === "authenticated") {
        setPage("lobby");
      }

      window.history.pushState(historyState, "", window.location.href);
    }

    window.addEventListener("popstate", handleBrowserBack);
    return () => window.removeEventListener("popstate", handleBrowserBack);
  }, [
    authStatusRef,
    backToLobbyRef,
    cleanupMatchState,
    legalBackPageRef,
    pageRef,
    setPage,
  ]);
}
