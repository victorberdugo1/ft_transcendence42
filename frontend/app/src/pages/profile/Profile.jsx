import { useEffect, useMemo, useState } from "react";
import eldwinPortrait from "../../assets/characters/eldwin_portrait.jpg";
import gabrielPortrait from "../../assets/characters/gabriel_portrait.jpg";
import hildaPortrait from "../../assets/characters/hilda_portrait.jpg";
import quimburPortrait from "../../assets/characters/quimbur_portrait.jpg";
import eldwinAvatar from "../../assets/avatars/p00.png";
import hildaAvatar from "../../assets/avatars/p01.png";
import quimburAvatar from "../../assets/avatars/p02.png";
import gabrielAvatar from "../../assets/avatars/p03.png";
import logo from "../../../assets/logo.png";
import logomini from "../../../assets/logomini.png";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPercent(value) {
  const n = safeNumber(value);
  return `${Number(n.toFixed(2))}%`;
}

const MATCH_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : MATCH_DATE_FORMATTER.format(date);
}

function formatGameType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!type) return "Unknown";
  if (type === "brawler") return "Brawler";
  if (type === "tournament") return "Tournament";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatResult(value) {
  const result = String(value || "").trim().toLowerCase();
  if (result === "win") return "WIN";
  if (result === "loss") return "LOSS";
  if (result === "draw") return "DRAW";
  return "UNKNOWN";
}

function initials(value) {
  const text = String(value || "").trim();
  if (!text) return "?";
  return text.slice(0, 2).toUpperCase();
}

const XP_PER_WIN = 100;
const CHARACTER_VISUALS = {
  eld: { name: "Eldwin", portrait: eldwinPortrait },
  hil: { name: "Hilda", portrait: hildaPortrait },
  qui: { name: "Quimbur", portrait: quimburPortrait },
  gab: { name: "Gabriel", portrait: gabrielPortrait },
};
const CHARACTER_AVATARS = {
  eld: eldwinAvatar,
  hil: hildaAvatar,
  qui: quimburAvatar,
  gab: gabrielAvatar,
};
const AVATAR_OPTIONS = [
  ...Object.entries(CHARACTER_VISUALS).map(([charId, visual]) => ({
    id: `character:${charId}`,
    label: visual.name,
    type: "character",
    src: CHARACTER_AVATARS[charId],
  })),
  { id: "logo:main", label: "Logo", type: "logo", src: logo },
  { id: "logo:mini", label: "Mini logo", type: "logo", src: logomini },
];
const AVATAR_OPTIONS_BY_ID = new Map(AVATAR_OPTIONS.map(option => [option.id, option]));

function getCharacterId(character) {
  return String(character?.charId || "").trim().toLowerCase();
}

function getCharacterVisual(character) {
  const charId = getCharacterId(character);
  const visual = CHARACTER_VISUALS[charId];
  if (visual) return { charId, name: visual.name, src: visual.portrait };
  if (character?.preview) return { charId, name: character?.name || charId || "Character", src: character.preview };
  return null;
}

function getAvatarVisual(avatarId) {
  return AVATAR_OPTIONS_BY_ID.get(avatarId) ?? null;
}

function xpRequiredForLevel(level) {
  const safeLevel = Math.max(1, Math.floor(safeNumber(level, 1)));
  if (safeLevel <= 1) return 0;
  return ((safeLevel * (safeLevel + 1)) / 2) * XP_PER_WIN;
}

function xpProgress(xp, level) {
  const safeXp = Math.max(0, safeNumber(xp));
  const safeLevel = Math.max(1, safeNumber(level, 1));
  const current = xpRequiredForLevel(safeLevel);
  const next = xpRequiredForLevel(safeLevel + 1);
  if (next <= 0) return { current, next, progress: 0 };
  const progress = Math.min(100, Math.max(0, (safeXp / next) * 100));
  return { current, next, progress };
}

function normalizeProfile(profile) {
  return {
    user: {
      id: profile?.user?.id ?? null,
      username: profile?.user?.username || "Player",
      avatar: profile?.user?.avatar || null,
    },
    globalStats: {
      wins: safeNumber(profile?.globalStats?.wins),
      losses: safeNumber(profile?.globalStats?.losses),
      draws: safeNumber(profile?.globalStats?.draws),
      totalMatches: safeNumber(profile?.globalStats?.totalMatches),
      winRate: safeNumber(profile?.globalStats?.winRate),
      xp: safeNumber(profile?.globalStats?.xp),
      level: safeNumber(profile?.globalStats?.level, 1),
    },
    bestCharacter: profile?.bestCharacter ?? null,
    characters: Array.isArray(profile?.characters) ? profile.characters : [],
    matchHistory: Array.isArray(profile?.matchHistory) ? profile.matchHistory : [],
  };
}

function Avatar({ src, label, className = "" }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return <img className={`profile-avatar ${className}`} src={src} alt={label || "Profile avatar"} onError={() => setFailed(true)} />;
  }
  return (
    <div className={`profile-avatar profile-avatar-fallback ${className}`} aria-label={label || "Profile avatar"}>
      {initials(label)}
    </div>
  );
}

function AvatarPicker({ currentAvatar, selectedAvatar, saving, error, onSelect, onClose, onSave }) {
  const canSave = Boolean(selectedAvatar) && selectedAvatar !== currentAvatar && !saving;

  return (
    <div className="profile-avatar-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="profile-avatar-modal" role="dialog" aria-modal="true" aria-labelledby="profile-avatar-modal-title">
        <header className="profile-avatar-modal-header">
          <div>
            <span className="profile-kicker">Player identity</span>
            <h2 id="profile-avatar-modal-title">Choose avatar</h2>
          </div>
          <button type="button" className="profile-avatar-close" onClick={onClose} disabled={saving} aria-label="Close avatar selector">X</button>
        </header>

        <div className="profile-avatar-grid">
          {AVATAR_OPTIONS.map(option => {
            const selected = option.id === selectedAvatar;
            return (
              <button
                key={option.id}
                type="button"
                className={`profile-avatar-option profile-avatar-option-${option.type} ${selected ? "profile-avatar-option-selected" : ""}`}
                onClick={() => onSelect(option.id)}
                aria-pressed={selected}
                disabled={saving}
              >
                <span className="profile-avatar-option-frame">
                  <img className="profile-avatar-option-image" src={option.src} alt="" />
                </span>
                <span className="profile-avatar-option-label">{option.label}</span>
                {selected ? <span className="profile-avatar-selected-badge">Selected</span> : null}
              </button>
            );
          })}
        </div>

        {error ? <p className="profile-avatar-error" role="alert">{error}</p> : null}

        <div className="profile-avatar-actions">
          <button type="button" className="profile-secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="profile-primary-button" onClick={onSave} disabled={!canSave}>
            {saving ? "Saving..." : "Save avatar"}
          </button>
        </div>
      </section>
    </div>
  );
}

function CharacterPreview({ character }) {
  const [failed, setFailed] = useState(false);
  const visual = getCharacterVisual(character);
  const label = visual?.name || character?.name || character?.charId || "Character";
  if (visual?.src && !failed) {
    return (
      <div className="profile-character-preview profile-character-portrait-card">
        <div className="profile-character-portrait-frame">
          <img src={visual.src} alt={label} onError={() => setFailed(true)} />
        </div>
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div className="profile-character-preview profile-character-fallback" aria-label={label}>
      {initials(character?.charId || label)}
    </div>
  );
}

function StatTile({ label, value }) {
  const variant = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className={`profile-stat-tile profile-stat-${variant}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CharacterCard({ character, featured = false }) {
  const totalMatches = safeNumber(character?.totalMatches);
  const visual = getCharacterVisual(character);
  const displayName = character?.name || visual?.name || "Unknown";
  return (
    <article className={featured ? "profile-character-card profile-character-card-featured" : "profile-character-card"}>
      <CharacterPreview character={character} />
      <div className="profile-character-body">
        <div className="profile-character-heading">
          <div>
            {featured ? <span className="profile-character-badge">Best character</span> : null}
            <h3>{displayName}</h3>
          </div>
          <span>{character?.charId || "n/a"}</span>
        </div>
        <div className="profile-character-stats">
          <StatTile label="Wins" value={safeNumber(character?.wins)} />
          <StatTile label="Losses" value={safeNumber(character?.losses)} />
          <StatTile label="Draws" value={safeNumber(character?.draws)} />
          <StatTile label="Matches" value={totalMatches} />
          <StatTile label="Win rate" value={formatPercent(character?.winRate)} />
        </div>
      </div>
    </article>
  );
}

function HistoryFighter({ participant, label }) {
  const charId = getCharacterId(participant);
  const avatar = CHARACTER_AVATARS[charId] ?? null;
  const characterName = participant?.characterName || "Unknown";

  return (
    <div className="profile-history-fighter">
      {avatar ? (
        <span className="profile-history-fighter-frame">
          <img src={avatar} alt="" />
        </span>
      ) : (
        <span className="profile-history-fighter-frame profile-history-fighter-fallback" aria-hidden="true">
          {initials(characterName)}
        </span>
      )}
      <span>
        <small>{label}</small>
        <strong>{characterName}</strong>
      </span>
    </div>
  );
}

function MatchHistoryCard({ match }) {
  const result = ["win", "loss", "draw"].includes(match?.result) ? match.result : "unknown";
  const score = match?.score?.raw || `${safeNumber(match?.score?.player)} - ${safeNumber(match?.score?.opponent)}`;

  return (
    <article className={`profile-history-card profile-history-card-${result}`}>
      <div className="profile-history-result">
        <span>{formatResult(result)}</span>
        <strong>{score}</strong>
      </div>

      <div className="profile-history-matchup">
        <span className="profile-history-opponent-label">Opponent</span>
        <h3>vs {match?.opponent?.username || "Unknown player"}</h3>
        <div className="profile-history-fighters">
          <HistoryFighter participant={match?.player} label="You" />
          <span className="profile-history-versus">VS</span>
          <HistoryFighter participant={match?.opponentPlayer} label="Rival" />
        </div>
      </div>

      <footer className="profile-history-meta">
        <span>{formatGameType(match?.gameType)}</span>
        <time dateTime={match?.playedAt || undefined}>{formatDate(match?.playedAt)}</time>
      </footer>
    </article>
  );
}

function EmptyState({ title, text }) {
  return (
    <div className="profile-empty">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

export default function Profile({ onBack }) {
  const [status, setStatus] = useState("loading");
  const [activeTab, setActiveTab] = useState("overview");
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadProfile() {
      setStatus("loading");
      setError("");
      try {
        const res = await fetch("/api/profile/me", { credentials: "include" });
        if (!res.ok) throw new Error(res.status === 401 ? "Session expired. Please sign in again." : "Profile could not be loaded.");
        const data = await res.json();
        if (!cancelled) {
          setProfile(data);
          setStatus("success");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Profile could not be loaded.");
          setStatus("error");
        }
      }
    }
    loadProfile();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const safeProfile = useMemo(() => normalizeProfile(profile), [profile]);
  const stats = safeProfile.globalStats;
  const user = safeProfile.user;
  const characters = safeProfile.characters;
  const matchHistory = safeProfile.matchHistory;
  const level = safeNumber(stats.level, 1);
  const xp = safeNumber(stats.xp);
  const xpBar = useMemo(() => xpProgress(xp, level), [xp, level]);
  const avatarVisual = getAvatarVisual(user.avatar);

  useEffect(() => {
    if (!avatarPickerOpen) return undefined;
    function closeOnEscape(event) {
      if (event.key === "Escape" && !avatarSaving) setAvatarPickerOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [avatarPickerOpen, avatarSaving]);

  function openAvatarPicker() {
    setSelectedAvatar(getAvatarVisual(user.avatar) ? user.avatar : null);
    setAvatarError("");
    setAvatarPickerOpen(true);
  }

  function closeAvatarPicker() {
    if (avatarSaving) return;
    setAvatarPickerOpen(false);
    setAvatarError("");
  }

  async function saveAvatar() {
    if (!selectedAvatar || selectedAvatar === user.avatar || avatarSaving) return;
    setAvatarSaving(true);
    setAvatarError("");
    try {
      const res = await fetch("/api/profile/avatar", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: selectedAvatar }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Avatar could not be saved.");
      setProfile(current => current ? {
        ...current,
        user: { ...current.user, avatar: data.avatar },
      } : current);
      setAvatarPickerOpen(false);
    } catch (err) {
      setAvatarError(err.message || "Avatar could not be saved.");
    } finally {
      setAvatarSaving(false);
    }
  }

  if (status === "loading") {
    return (
      <main className="profile-page">
        <section className="profile-state-card">
          <span className="profile-kicker">Profile</span>
          <h1>Loading profile...</h1>
          <p>Pulling your latest arena record.</p>
          <button type="button" className="profile-secondary-button" onClick={onBack}>Back to lobby</button>
        </section>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="profile-page">
        <section className="profile-state-card">
          <span className="profile-kicker">Profile</span>
          <h1>Could not load profile</h1>
          <p>{error}</p>
          <div className="profile-actions">
            <button type="button" className="profile-primary-button" onClick={() => setReloadKey(k => k + 1)}>Retry</button>
            <button type="button" className="profile-secondary-button" onClick={onBack}>Back to lobby</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="profile-page">
      <div className="profile-shell">
        <header className="profile-header">
          <div>
            <span className="profile-kicker">Fighter data</span>
            <h1>Player Profile</h1>
          </div>
          <button type="button" className="profile-secondary-button" onClick={onBack}>Back to lobby</button>
        </header>

        <nav className="profile-tabs" role="tablist" aria-label="Profile sections">
          <button
            id="profile-overview-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "overview"}
            aria-controls="profile-overview-panel"
            className={activeTab === "overview" ? "profile-tab profile-tab-active" : "profile-tab"}
            onClick={() => setActiveTab("overview")}
          >
            Overview
          </button>
          <button
            id="profile-history-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            aria-controls="profile-history-panel"
            className={activeTab === "history" ? "profile-tab profile-tab-active" : "profile-tab"}
            onClick={() => setActiveTab("history")}
          >
            History
          </button>
        </nav>

        {activeTab === "overview" ? (
        <div className="profile-layout" id="profile-overview-panel" role="tabpanel" aria-labelledby="profile-overview-tab">
          <aside className="profile-card profile-user-card">
            <button type="button" className="profile-avatar-button" onClick={openAvatarPicker} aria-label="Change avatar">
              <Avatar
                src={avatarVisual?.src ?? null}
                label={user.username || "Player"}
                className={avatarVisual ? `profile-avatar-${avatarVisual.type}` : ""}
              />
              <span className="profile-avatar-edit-hint">Change avatar</span>
            </button>
            <div className="profile-user-copy">
              <span>Player</span>
              <h2>{user.username || "Unknown player"}</h2>
              <strong className="profile-level-pill">Lv. {level}</strong>
            </div>
            <div className="profile-xp-block">
              <div className="profile-xp-label">
                <span>Experience</span>
                <strong>{xp} / {xpBar.next}</strong>
              </div>
              <div className="profile-xp-track" aria-label={`XP progress ${Math.round(xpBar.progress)} percent`}>
                <span style={{ width: `${xpBar.progress}%` }} />
              </div>
              <div className="profile-xp-meta">
                <span>Lv. {level}</span>
                <strong>{Math.round(xpBar.progress)}%</strong>
              </div>
            </div>
          </aside>

          <section className="profile-main">
            <section className="profile-card">
              <div className="profile-section-heading">
                <h2>Global stats</h2>
              </div>
              <div className="profile-stats-grid">
                <StatTile label="Wins" value={safeNumber(stats.wins)} />
                <StatTile label="Losses" value={safeNumber(stats.losses)} />
                <StatTile label="Draws" value={safeNumber(stats.draws)} />
                <StatTile label="Matches" value={safeNumber(stats.totalMatches)} />
                <StatTile label="Win rate" value={formatPercent(stats.winRate)} />
                <StatTile label="XP" value={xp} />
                <StatTile label="Level" value={level} />
              </div>
            </section>

            <section className="profile-card">
              <div className="profile-section-heading">
                <h2>Best character</h2>
              </div>
              {safeProfile.bestCharacter
                ? <CharacterCard character={safeProfile.bestCharacter} featured />
                : <EmptyState title="No best character yet" text="Play matches to discover your best character" />}
            </section>

            <section className="profile-card">
              <div className="profile-section-heading">
                <h2>Character stats</h2>
              </div>
              {characters.length ? (
                <div className="profile-character-grid">
                  {characters.map((character) => (
                    <CharacterCard key={character.charId || character.name} character={character} />
                  ))}
                </div>
              ) : (
                <EmptyState title="No character stats yet" text="New matches with character tracking will appear here." />
              )}
            </section>
          </section>
        </div>
        ) : (
          <section className="profile-history-panel" id="profile-history-panel" role="tabpanel" aria-labelledby="profile-history-tab">
            <header className="profile-history-heading">
              <div>
                <span className="profile-kicker">Match archive</span>
                <h2>Recent matches</h2>
              </div>
              <strong>{matchHistory.length} / 20</strong>
            </header>

            {matchHistory.length ? (
              <div className="profile-history-list">
                {matchHistory.map(match => <MatchHistoryCard key={match.id} match={match} />)}
              </div>
            ) : (
              <EmptyState title="No match history yet" text="Play human matches to build your history" />
            )}
          </section>
        )}
      </div>

      {avatarPickerOpen ? (
        <AvatarPicker
          currentAvatar={user.avatar}
          selectedAvatar={selectedAvatar}
          saving={avatarSaving}
          error={avatarError}
          onSelect={avatarId => {
            setSelectedAvatar(avatarId);
            setAvatarError("");
          }}
          onClose={closeAvatarPicker}
          onSave={saveAvatar}
        />
      ) : null}
    </main>
  );
}
