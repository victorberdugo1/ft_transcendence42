import { useEffect, useRef, useState } from "react";

export function useLobbySssLock() {
  const [sssLocked, setSssLocked] = useState(false);
  const sssLockedRef = useRef(false);

  useEffect(() => {
    const onPaired = () => {
      setSssLocked(true);
      sssLockedRef.current = true;
    };
    const onUnpaired = () => {
      setSssLocked(false);
      sssLockedRef.current = false;
    };

    window.addEventListener("lobby_paired", onPaired);
    window.addEventListener("lobby_unpaired", onUnpaired);
    window.addEventListener("match_start", onUnpaired);

    return () => {
      window.removeEventListener("lobby_paired", onPaired);
      window.removeEventListener("lobby_unpaired", onUnpaired);
      window.removeEventListener("match_start", onUnpaired);
    };
  }, []);

  return { sssLocked, sssLockedRef };
}
