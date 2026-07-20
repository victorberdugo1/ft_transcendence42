import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export default function GraceBanner({ grace, myClientId, onRejoin }) {
  const { t } = useTranslation();
  const [secsLeft, setSecsLeft] = useState(null);
  const [defeated, setDefeated] = useState(false);

  useEffect(() => {
    if (!grace) {
      setSecsLeft(null);
      setDefeated(false);
      return;
    }

    let intervalId = 0;

    function tick() {
      const ms = grace.expiresAt - Date.now();
      const secs = Math.max(0, Math.ceil(ms / 1000));
      setSecsLeft(secs);

      if (secs === 0 && grace.clientId === myClientId) {
        clearInterval(intervalId);
        setDefeated(true);
        setTimeout(() => {
          try {
            [
              "clientId",
              "charSelectData",
              "pendingCharSelect",
              "watchSession",
              "gameState",
              "confirmedStageId",
            ].forEach((k) => sessionStorage.removeItem(k));
            sessionStorage.setItem(
              "matchmakingSafeAt",
              String(Date.now() + 6500),
            );
          } catch (_) {}
          window.location.reload();
        }, 6000);
      }
    }

    tick();
    intervalId = window.setInterval(tick, 250);
    return () => clearInterval(intervalId);
  }, [grace, myClientId]);

  if (defeated) {
    return (
      <div className="grace-defeat-screen">
        <div className="grace-defeat-icon">💀</div>
        <div className="grace-defeat-title">{t("grace.defeatTitle")}</div>
        <div className="grace-defeat-copy">{t("grace.defeatSubtitle")}</div>
      </div>
    );
  }

  if (!grace || secsLeft === null || secsLeft === 0) return null;

  const isMe = grace.clientId === myClientId;

  return (
    <div
      className={
        secsLeft <= 2 ? "grace-banner grace-banner-danger" : "grace-banner"
      }
    >
      <span>
        {isMe
          ? t("grace.waitingSelf", { seconds: secsLeft })
          : t("grace.waitingOpponent", { seconds: secsLeft })}
      </span>
      {isMe && (
        <button
          type="button"
          className="grace-rejoin-button"
          onClick={onRejoin}
        >
          {t("grace.rejoinButton")}
        </button>
      )}
    </div>
  );
}
