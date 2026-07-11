import { apiFetchJson } from "@src/utils/http.js";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export default function ModeSpectator({ onEnterGame }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);

  async function load() {
    try {
      const data = await apiFetchJson("/api/sessions");
      setSessions(data.sessions ?? []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 3000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const modeLabel = {
    "1v1": t("fight.spectate.modeLabels.oneVsOne"),
    brawl: t("fight.spectate.modeLabels.brawl"),
    tournament: t("fight.spectate.modeLabels.tournament"),
  };

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.modes.spectate.description")}
      </p>

      {loading && (
        <p className="lobby-loading">{t("fight.spectate.loading")}</p>
      )}
      {error && <p className="auth-error">{error}</p>}

      {!loading && sessions !== null && (
        sessions.length === 0 ? (
          <p className="lobby-loading">{t("fight.spectate.empty")}</p>
        ) : (
          <div className="lobby-sessions">
            {sessions.map((s) => (
              <div key={s.sessionId} className="lobby-session-row">
                <div className="lobby-session-info">
                  <span className="lobby-session-badge">
                    {modeLabel[s.mode] ?? s.mode}
                  </span>
                  <span className="lobby-session-players">
                    {t("fight.spectate.playerCount", {
                      count: s.playerIds.length,
                    })}
                  </span>
                  {s.spectators > 0 && (
                    <span className="lobby-session-specs">
                      {t("fight.spectate.spectators", {
                        count: s.spectators,
                      })}
                    </span>
                  )}
                  {s.tournamentId && (
                    <span className="lobby-session-specs">
                      {t("fight.spectate.tournamentTag", {
                        tournamentId: s.tournamentId,
                      })}
                    </span>
                  )}
                </div>
                <button
                  className="lobby-watch-btn"
                  type="button"
                  onClick={() =>
                    onEnterGame("spectate", { sessionId: s.sessionId })
                  }
                >
                  {t("fight.modes.spectate.cta")}
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
