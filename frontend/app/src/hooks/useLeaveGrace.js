import { useEffect, useState } from "react";

export function useLeaveGrace() {
  const [grace, setGrace] = useState(null);

  useEffect(() => {
    const onGrace = (e) => setGrace(e.detail);
    const clearGrace = () => setGrace(null);

    window.addEventListener("leave_grace", onGrace);
    window.addEventListener("leave_grace_expired", clearGrace);
    window.addEventListener("player_reconnected", clearGrace);

    return () => {
      window.removeEventListener("leave_grace", onGrace);
      window.removeEventListener("leave_grace_expired", clearGrace);
      window.removeEventListener("player_reconnected", clearGrace);
    };
  }, []);

  return { grace, setGrace };
}
