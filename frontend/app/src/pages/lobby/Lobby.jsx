import LanguageSelector from "@src/components/LanguageSelector.jsx";
import { useTranslation } from "react-i18next";
import logoImage from "../../../assets/logo.png";

// ── Lobby ──────────────────────────────────────────────────────────────────────
// Decorative hub page — shown after login, before the fight lobby.
// onLogout is passed from App.jsx which already calls /api/logout + reconnectWS,
// so this component just fires it directly without duplicating that logic.

export default function Lobby({ user, onPlay, onProfile, onManual, onLogout }) {
  const { t } = useTranslation();
  const playerName = user.username || user.email || "player";

  const menuItems = [
    {
      className: "lobby-tile-play",
      label:     t("lobby.menu.fight.label"),
      kicker:    t("lobby.menu.fight.kicker"),
      action:    onPlay,
      disabled:  false,
    },
    {
      className: "lobby-tile-profile",
      label:     t("lobby.menu.profile.label"),
      kicker:    t("lobby.menu.profile.kicker"),
      action:    onProfile,
      disabled:  false,
    },
    {
      className: "lobby-tile-achievements",
      label:     t("lobby.menu.achievements.label"),
      kicker:    t("lobby.menu.achievements.kicker"),
      disabled:  true,
    },
    {
      className: "lobby-tile-chat",
      label:     t("lobby.menu.chat.label"),
      kicker:    t("lobby.menu.chat.kicker"),
      disabled:  true,
    },
    {
      className: "lobby-tile-friends",
      label:     t("lobby.menu.friends.label"),
      kicker:    t("lobby.menu.friends.kicker"),
      disabled:  true,
    },
    {
      className: "lobby-tile-manual",
      label:     t("lobby.menu.manual.label"),
      kicker:    t("lobby.menu.manual.kicker"),
      action:    onManual,
      disabled:  false,
    },
  ];

  return (
    <div className="lobby-page">
      <main className="lobby-command-center" aria-label={t("lobby.a11y.mainHub")}>
        <header className="lobby-topbar">
          <div className="lobby-title-lockup">
            <span className="lobby-title-mark">Enuma</span>
            <strong>Fighter</strong>
          </div>
          <div className="lobby-topbar-right">
            <LanguageSelector variant="manual" compact />
            <div className="lobby-player-chip">
              <span className="lobby-player-status">{t("lobby.status.ready")}</span>
              <strong>{playerName}</strong>
            </div>
          </div>
        </header>

        <section className="lobby-stage">
          <div className="lobby-stage-aura"   aria-hidden="true" />
          <div className="lobby-stage-grid"   aria-hidden="true" />
          <div className="lobby-stage-orbit"  aria-hidden="true" />
          <div className="lobby-stage-cross"  aria-hidden="true" />

          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`lobby-tile ${item.className}`}
              onClick={item.action}
              disabled={item.disabled}
            >
              <span className="lobby-tile-kicker">{item.kicker}</span>
              <span className="lobby-tile-label">{item.label}</span>
              {item.disabled ? <span className="lobby-tile-lock">{t("lobby.soon")}</span> : null}
            </button>
          ))}

          {/* Logout — calls App.handleLogout which does /api/logout + reconnectWS */}
          <button
            type="button"
            className="lobby-tile lobby-tile-logout"
            onClick={onLogout}
            aria-label={t("lobby.logoutAria", { playerName })}
          >
            <span>{t("lobby.logout")}</span>
          </button>

          <div className="lobby-logo-core" aria-label={t("lobby.a11y.logo")}>
            <span className="lobby-logo-flare" aria-hidden="true" />
            <img src={logoImage} alt="" className="lobby-logo-image" />
          </div>
        </section>

        <footer className="lobby-footer-strip">
          <span>{t("lobby.footer.arena")}</span>
          <strong>{t("lobby.footer.season")}</strong>
        </footer>
      </main>
    </div>
  );
}
