import { CHARACTER_VISUALS } from "@src/components/profile/profileVisuals.js";
import { safeNumber } from "@src/utils/number.js";
import { useEffect, useState } from "react";

function formatPercent(value) {
  const n = safeNumber(value);
  return `${Number(n.toFixed(2))}%`;
}

function initials(value) {
  const text = String(value || "").trim();
  if (!text) return "?";
  return text.slice(0, 2).toUpperCase();
}

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

function CharacterPreview({ character, t }) {
  const [failed, setFailed] = useState(false);
  const visual = getCharacterVisual(character);
  const label = visual?.name || character?.name || character?.charId || t("profile.characters.unknownCharacter");
  useEffect(() => {
    setFailed(false);
  }, [visual?.src]);

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

export default function ProfileCharacterCard({ character, featured = false, t }) {
  const totalMatches = safeNumber(character?.totalMatches);
  const visual = getCharacterVisual(character);
  const displayName = character?.name || visual?.name || t("profile.common.unknown");
  return (
    <article className={featured ? "profile-character-card profile-character-card-featured" : "profile-character-card"}>
      <CharacterPreview character={character} t={t} />
      <div className="profile-character-body">
        <div className="profile-character-heading">
          <div>
            {featured ? <span className="profile-character-badge">{t("profile.characters.bestBadge")}</span> : null}
            <h3>{displayName}</h3>
          </div>
          <span>{character?.charId || t("profile.common.notAvailable")}</span>
        </div>
        <div className="profile-character-stats">
          <StatTile label={t("profile.stats.wins")} value={safeNumber(character?.wins)} />
          <StatTile label={t("profile.stats.losses")} value={safeNumber(character?.losses)} />
          <StatTile label={t("profile.stats.draws")} value={safeNumber(character?.draws)} />
          <StatTile label={t("profile.stats.matches")} value={totalMatches} />
          <StatTile label={t("profile.stats.winRate")} value={formatPercent(character?.winRate)} />
        </div>
      </div>
    </article>
  );
}
