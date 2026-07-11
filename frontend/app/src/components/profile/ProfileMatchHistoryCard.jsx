import { CHARACTER_AVATARS } from "@src/components/profile/profileVisuals.js";
import { safeNumber } from "@src/utils/number.js";

function formatDate(value, formatter, t) {
  if (!value) return t("profile.history.unknownDate");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("profile.history.unknownDate") : formatter.format(date);
}

function formatGameType(value, t) {
  const type = String(value || "").trim().toLowerCase();
  if (!type) return t("profile.history.gameTypes.unknown");
  if (type === "brawler") return t("profile.history.gameTypes.brawler");
  if (type === "tournament") return t("profile.history.gameTypes.tournament");
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatResult(value, t) {
  const result = String(value || "").trim().toLowerCase();
  if (result === "win") return t("profile.history.results.win");
  if (result === "loss") return t("profile.history.results.loss");
  if (result === "draw") return t("profile.history.results.draw");
  return t("profile.history.results.unknown");
}

function initials(value) {
  const text = String(value || "").trim();
  if (!text) return "?";
  return text.slice(0, 2).toUpperCase();
}

function getCharacterId(character) {
  return String(character?.charId || "").trim().toLowerCase();
}

function HistoryFighter({ participant, label, t }) {
  const charId = getCharacterId(participant);
  const avatar = CHARACTER_AVATARS[charId] ?? null;
  const characterName = participant?.characterName || t("profile.common.unknown");

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

export default function ProfileMatchHistoryCard({ match, t, dateFormatter }) {
  const result = ["win", "loss", "draw"].includes(match?.result) ? match.result : "unknown";
  const score = match?.score?.raw || `${safeNumber(match?.score?.player)} - ${safeNumber(match?.score?.opponent)}`;

  return (
    <article className={`profile-history-card profile-history-card-${result}`}>
      <div className="profile-history-result">
        <span>{formatResult(result, t)}</span>
        <strong>{score}</strong>
      </div>

      <div className="profile-history-matchup">
        <span className="profile-history-opponent-label">{t("profile.history.opponent")}</span>
        <h3>{t("profile.history.vs")} {match?.opponent?.username || t("profile.history.unknownPlayer")}</h3>
        <div className="profile-history-fighters">
          <HistoryFighter participant={match?.player} label={t("profile.history.you")} t={t} />
          <span className="profile-history-versus">VS</span>
          <HistoryFighter participant={match?.opponentPlayer} label={t("profile.history.rival")} t={t} />
        </div>
      </div>

      <footer className="profile-history-meta">
        <span>{formatGameType(match?.gameType, t)}</span>
        <time dateTime={match?.playedAt || undefined}>{formatDate(match?.playedAt, dateFormatter, t)}</time>
      </footer>
    </article>
  );
}
