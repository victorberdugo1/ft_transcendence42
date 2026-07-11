import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    CHAR_IDS,
    CHAR_NAMES,
    CHAR_PORTRAITS,
    STAGE_NAMES,
} from "./gameConstants.js";

export default function ModeAI({
  onEnterGame,
  matchCooldown = 0,
  graceActive = false,
}) {
  const { t } = useTranslation();
  const [selectedChars, setSelectedChars] = useState(["eld"]);
  const [stageId, setStageId] = useState(0);

  function toggleChar(id) {
    setSelectedChars((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev; // keep at least one
        return prev.filter((c) => c !== id);
      }
      return [...prev, id];
    });
  }

  const enemyLabel =
    selectedChars.length === 1
      ? CHAR_NAMES[selectedChars[0]]
      : t("fight.modes.training.enemiesSelected", {
          count: selectedChars.length,
        });

  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.modes.training.description")}
      </p>

      <p className="lobby-section-label">
        {t("fight.modes.training.enemiesLabel")}
      </p>
      <div className="lobby-char-pick">
        {CHAR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`lobby-char-btn ${
              selectedChars.includes(id) ? "lobby-char-active" : ""
            }`}
            onClick={() => toggleChar(id)}
          >
            <img
              src={CHAR_PORTRAITS[id]}
              alt={CHAR_NAMES[id]}
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span>{CHAR_NAMES[id]}</span>
            {selectedChars.includes(id) && (
              <span className="lobby-char-check">✓</span>
            )}
          </button>
        ))}
      </div>

      <p className="lobby-section-label">
        {t("fight.modes.training.stageLabel")}
      </p>
      <div className="lobby-stage-pick">
        {STAGE_NAMES.map((name, idx) => (
          <button
            key={idx}
            type="button"
            className={`lobby-stage-btn ${
              stageId === idx ? "lobby-stage-active" : ""
            }`}
            onClick={() => setStageId(idx)}
          >
            {name}
          </button>
        ))}
      </div>

      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={() =>
          onEnterGame("training", { cpuCharIds: selectedChars, stageId })
        }
        disabled={matchCooldown > 0 || graceActive}
      >
        {graceActive
          ? t("fight.status.waiting")
          : matchCooldown > 0
            ? t("fight.status.availableIn", { seconds: matchCooldown })
            : t("fight.modes.training.cta", { enemyLabel })}
      </button>
    </div>
  );
}
