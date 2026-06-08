import logoImage from "../assets/logo.png";

export default function Lobby({ user, onPlay, onLogout }) {
  const playerName = user.username || user.email || "player";

  return (
    <div className="lobby-page">
      <main className="lobby-command-center" aria-label="Main hub">
        <section className="lobby-stage">
          <div className="lobby-stage-aura" aria-hidden="true" />
          <div className="lobby-stage-grid" aria-hidden="true" />
          <div className="lobby-stage-orbit" aria-hidden="true" />

          <button type="button" className="lobby-tile lobby-tile-play" onClick={onPlay}>
            <span>Play</span>
          </button>

          <button type="button" className="lobby-tile lobby-tile-profile" disabled>
            <span>Profile</span>
          </button>

          <button type="button" className="lobby-tile lobby-tile-achievements" disabled>
            <span>Achievements</span>
          </button>

          <button type="button" className="lobby-tile lobby-tile-chat" disabled>
            <span>Chat</span>
          </button>

          <button type="button" className="lobby-tile lobby-tile-friends" disabled>
            <span>Friends</span>
          </button>

          <button type="button" className="lobby-tile lobby-tile-settings" disabled>
            <span>Settings</span>
          </button>

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
      </main>
    </div>
  );
}
