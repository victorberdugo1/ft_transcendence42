import { useEffect } from "react";

export function useSessionAuth({ setUser, setAuthStatus, setPage, normalizeUser }) {
  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) {
            setUser(null);
            setAuthStatus("guest");
            setPage("auth");
          }
          return;
        }

        const data = await res.json();
        if (!cancelled) {
          setUser(normalizeUser(data.user));
          setAuthStatus("authenticated");
          setPage("lobby");
        }
      } catch (e) {
        console.error("[auth] /api/me failed:", e);
        if (!cancelled) {
          setUser(null);
          setAuthStatus("guest");
          setPage("auth");
        }
      }
    }

    checkSession();
    return () => {
      cancelled = true;
    };
  }, [normalizeUser, setAuthStatus, setPage, setUser]);
}
