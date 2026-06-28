import logoImage from "../../../assets/logo.png";

// ── Lobby ──────────────────────────────────────────────────────────────────────
// Decorative hub page — shown after login, before the fight lobby.
// onLogout is passed from App.jsx which already calls /api/logout + reconnectWS,
// so this component just fires it directly without duplicating that logic.

export default function Lobby({ user, onPlay, onProfile, onManual, onLogout }) {
  const playerName = user.username || user.email || "player";

  const menuItems = [
    {
      className: "lobby-tile-play",
      label:     "Fight",
      kicker:    "Smash",
      action:    onPlay,
      disabled:  false,
    },
    {
      className: "lobby-tile-profile",
      label:     "Profile",
      kicker:    "Fighter",
      action:    onProfile,
      disabled:  false,
    },
    {
      className: "lobby-tile-achievements",
      label:     "Achievements",
      kicker:    "Rewards",
      disabled:  true,
    },
    {
      className: "lobby-tile-chat",
      label:     "Chat",
      kicker:    "Social",
      disabled:  true,
    },
    {
      className: "lobby-tile-friends",
      label:     "Friends",
      kicker:    "Crew",
      disabled:  true,
    },
    {
      className: "lobby-tile-manual",
      label:     "Manual",
      kicker:    "Codex",
      action:    onManual,
      disabled:  false,
    },
  ];

  return (
    <div className="lobby-page">
      <main className="lobby-command-center" aria-label="Main hub">
        <header className="lobby-topbar">
          <div className="lobby-title-lockup">
            <span className="lobby-title-mark">Enuma</span>
            <strong>Fighter</strong>
          </div>
          <div className="lobby-player-chip">
            <span className="lobby-player-status">Ready</span>
            <strong>{playerName}</strong>
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
              {item.disabled ? <span className="lobby-tile-lock">Soon</span> : null}
            </button>
          ))}

          {/* Logout — calls App.handleLogout which does /api/logout + reconnectWS */}
          <button
            type="button"
            className="lobby-tile lobby-tile-logout"
            onClick={onLogout}
            aria-label={`Log out ${playerName}`}
          >
            <span>Logout</span>
          </button>

          <div className="lobby-logo-core" aria-label="Enuma Fighter logo">
            <span className="lobby-logo-flare" aria-hidden="true" />
            <img src={logoImage} alt="" className="lobby-logo-image" />
          </div>
        </section>

        <footer className="lobby-footer-strip">
          <span>Worldwide Arena</span>
          <strong>Season 01</strong>
        </footer>
      </main>
    </div>
  );
}
