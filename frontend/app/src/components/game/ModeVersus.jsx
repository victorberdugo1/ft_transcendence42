import { useTranslation } from "react-i18next";

export default function ModeVersus({
  onEnterGame,
  matchCooldown = 0,
  graceActive = false,
}) {
  const { t } = useTranslation();
  return (
    <div className="lobby-mode-body">
      <p className="lobby-mode-desc">
        {t("fight.modes.versus.description")}
      </p>
      <button
        className="auth-submit lobby-play"
        type="button"
        onClick={() => onEnterGame("versus")}
        disabled={matchCooldown > 0 || graceActive}
      >
        {graceActive
          ? t("fight.status.waiting")
          : matchCooldown > 0
            ? t("fight.status.availableIn", { seconds: matchCooldown })
            : t("fight.modes.versus.cta")}
      </button>
    </div>
  );
}
