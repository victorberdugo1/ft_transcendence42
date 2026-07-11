import ProfileCharacterCard from "@src/components/profile/ProfileCharacterCard.jsx";
import ProfileEmptyState from "@src/components/profile/ProfileEmptyState.jsx";
import ProfileMatchHistoryCard from "@src/components/profile/ProfileMatchHistoryCard.jsx";
import ProfileStatTile from "@src/components/profile/ProfileStatTile.jsx";
import { CHARACTER_AVATARS, CHARACTER_VISUALS } from "@src/components/profile/profileVisuals.js";
import PageBackButton from "@src/components/ui/PageBackButton.jsx";
import PageHeader from "@src/components/ui/PageHeader.jsx";
import RequestStateCard from "@src/components/ui/RequestStateCard.jsx";
import { useApiRequest } from "@src/hooks/useApiRequest.js";
import { safeNumber } from "@src/utils/number.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import logo from "../../../assets/logo.png";
import logomini from "../../../assets/logomini.png";

const PROFILE_ERROR_KEYS = {
  sessionExpired: "profile.errors.sessionExpired",
  loadFailed: "profile.errors.loadFailed",
  avatarSaveFailed: "profile.errors.avatarSaveFailed",
};

function initials(value) {
  const text = String(value || "").trim();
  if (!text) return "?";
  return text.slice(0, 2).toUpperCase();
}

const XP_PER_WIN = 100;
function getAvatarOptions(t) {
  return [
    ...Object.entries(CHARACTER_VISUALS).map(([charId, visual]) => ({
      id: `character:${charId}`,
      label: visual.name,
      type: "character",
      src: CHARACTER_AVATARS[charId],
    })),
    { id: "logo:main", label: t("profile.avatar.options.logo"), type: "logo", src: logo },
    { id: "logo:mini", label: t("profile.avatar.options.miniLogo"), type: "logo", src: logomini },
  ];
}

function getAvatarVisual(avatarId, optionsById) {
  return optionsById.get(avatarId) ?? null;
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
      username: profile?.user?.username || "",
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

function Avatar({ src, label, className = "", t }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return <img className={`profile-avatar ${className}`} src={src} alt={label || t("profile.avatar.alt")} onError={() => setFailed(true)} />;
  }
  return (
    <div className={`profile-avatar profile-avatar-fallback ${className}`} aria-label={label || t("profile.avatar.alt")}>
      {initials(label)}
    </div>
  );
}

function AvatarPicker({ currentAvatar, selectedAvatar, saving, error, avatarOptions, onSelect, onClose, onSave, t }) {
  const canSave = Boolean(selectedAvatar) && selectedAvatar !== currentAvatar && !saving;

  return (
    <div className="profile-avatar-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="profile-avatar-modal" role="dialog" aria-modal="true" aria-labelledby="profile-avatar-modal-title">
        <header className="profile-avatar-modal-header">
          <div>
            <span className="profile-kicker">{t("profile.avatar.identity")}</span>
            <h2 id="profile-avatar-modal-title">{t("profile.avatar.choose")}</h2>
          </div>
          <button type="button" className="profile-avatar-close" onClick={onClose} disabled={saving} aria-label={t("profile.avatar.closeSelector")}>X</button>
        </header>

        <div className="profile-avatar-grid">
          {avatarOptions.map(option => {
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
                {selected ? <span className="profile-avatar-selected-badge">{t("profile.avatar.selected")}</span> : null}
              </button>
            );
          })}
        </div>

        {error ? <p className="profile-avatar-error" role="alert">{error}</p> : null}

        <div className="profile-avatar-actions">
          <button type="button" className="profile-secondary-button" onClick={onClose} disabled={saving}>{t("profile.avatar.cancel")}</button>
          <button type="button" className="profile-primary-button" onClick={onSave} disabled={!canSave}>
            {saving ? t("profile.avatar.saving") : t("profile.avatar.save")}
          </button>
        </div>
      </section>
    </div>
  );
}


export default function Profile({ onBack }) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState("overview");
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  const loadProfile = useCallback(async () => {
    const res = await fetch("/api/profile/me", { credentials: "include" });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? PROFILE_ERROR_KEYS.sessionExpired
          : PROFILE_ERROR_KEYS.loadFailed
      );
    }
    return res.json();
  }, []);

  const profileRequest = useApiRequest(
    loadProfile,
    [loadProfile],
    { defaultError: PROFILE_ERROR_KEYS.loadFailed }
  );

  const status = profileRequest.status;
  const error = profileRequest.error;
  const profile = profileRequest.data;

  const safeProfile = useMemo(() => normalizeProfile(profile), [profile]);
  const stats = safeProfile.globalStats;
  const user = safeProfile.user;
  const characters = safeProfile.characters;
  const matchHistory = safeProfile.matchHistory;
  const level = safeNumber(stats.level, 1);
  const xp = safeNumber(stats.xp);
  const xpBar = useMemo(() => xpProgress(xp, level), [xp, level]);
  const avatarOptions = useMemo(() => getAvatarOptions(t), [t]);
  const avatarOptionsById = useMemo(() => new Map(avatarOptions.map(option => [option.id, option])), [avatarOptions]);
  const avatarVisual = getAvatarVisual(user.avatar, avatarOptionsById);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language || "en", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [i18n.language, i18n.resolvedLanguage]
  );

  useEffect(() => {
    if (!avatarPickerOpen) return undefined;
    function closeOnEscape(event) {
      if (event.key === "Escape" && !avatarSaving) setAvatarPickerOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [avatarPickerOpen, avatarSaving]);

  function openAvatarPicker() {
    setSelectedAvatar(getAvatarVisual(user.avatar, avatarOptionsById) ? user.avatar : null);
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
      if (!res.ok) throw new Error(data.error || PROFILE_ERROR_KEYS.avatarSaveFailed);
      profileRequest.setData(current => current ? {
        ...current,
        user: { ...current.user, avatar: data.avatar },
      } : current);
      setAvatarPickerOpen(false);
    } catch (err) {
      setAvatarError(err.message || PROFILE_ERROR_KEYS.avatarSaveFailed);
    } finally {
      setAvatarSaving(false);
    }
  }

  if (status === "loading") {
    return (
      <main className="profile-page">
        <RequestStateCard
          className="profile-state-card"
          kicker={t("profile.kicker")}
          kickerClassName="profile-kicker"
          title={t("profile.loading.title")}
          message={t("profile.loading.text")}
          headingTag="h1"
          actions={(
            <PageBackButton onClick={onBack}>
              {t("profile.actions.backToLobby")}
            </PageBackButton>
          )}
        />
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="profile-page">
        <RequestStateCard
          className="profile-state-card"
          kicker={t("profile.kicker")}
          kickerClassName="profile-kicker"
          title={t("profile.error.title")}
          message={error?.startsWith("profile.") ? t(error) : error}
          headingTag="h1"
          actions={(
            <div className="profile-actions">
              <button type="button" className="profile-primary-button" onClick={profileRequest.run}>{t("profile.actions.retry")}</button>
              <PageBackButton onClick={onBack}>
                {t("profile.actions.backToLobby")}
              </PageBackButton>
            </div>
          )}
        />
      </main>
    );
  }

  return (
    <main className="profile-page">
      <div className="profile-shell">
        <PageHeader
          className="profile-header"
          kickerClassName="profile-kicker"
          actionsClassName="profile-header-controls"
          kicker={t("profile.header.kicker")}
          title={t("profile.header.title")}
          onBack={onBack}
          backLabel={t("profile.actions.backToLobby")}
        />

        <nav className="profile-tabs" role="tablist" aria-label={t("profile.tabs.aria")}>
          <button
            id="profile-overview-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "overview"}
            aria-controls="profile-overview-panel"
            className={activeTab === "overview" ? "profile-tab profile-tab-active" : "profile-tab"}
            onClick={() => setActiveTab("overview")}
          >
            {t("profile.tabs.overview")}
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
            {t("profile.tabs.history")}
          </button>
        </nav>

        {activeTab === "overview" ? (
        <div className="profile-layout" id="profile-overview-panel" role="tabpanel" aria-labelledby="profile-overview-tab">
          <aside className="profile-card profile-user-card">
            <button type="button" className="profile-avatar-button" onClick={openAvatarPicker} aria-label={t("profile.avatar.change")}>
              <Avatar
                src={avatarVisual?.src ?? null}
                label={user.username || t("profile.player")}
                className={avatarVisual ? `profile-avatar-${avatarVisual.type}` : ""}
                t={t}
              />
              <span className="profile-avatar-edit-hint">{t("profile.avatar.change")}</span>
            </button>
            <div className="profile-user-copy">
              <span>{t("profile.player")}</span>
              <h2>{user.username || t("profile.history.unknownPlayer")}</h2>
              <strong className="profile-level-pill">Lv. {level}</strong>
            </div>
            <div className="profile-xp-block">
              <div className="profile-xp-label">
                <span>{t("profile.stats.experience")}</span>
                <strong>{xp} / {xpBar.next}</strong>
              </div>
              <div className="profile-xp-track" aria-label={t("profile.stats.xpProgress", { percent: Math.round(xpBar.progress) })}>
                <span style={{ width: `${xpBar.progress}%` }} />
              </div>
              <div className="profile-xp-meta">
                <span>Lv. {level}</span>
                <strong>{Math.round(xpBar.progress)}%</strong>
              </div>
            </div>
          </aside>

          <section className="profile-main">
            <section className="profile-card profile-overview-surface">
              <section className="profile-overview-block">
                <div className="profile-section-heading">
                  <h2>{t("profile.sections.globalStats")}</h2>
                </div>
                <div className="profile-stats-grid">
                  <ProfileStatTile label={t("profile.stats.wins")} value={safeNumber(stats.wins)} />
                  <ProfileStatTile label={t("profile.stats.losses")} value={safeNumber(stats.losses)} />
                  <ProfileStatTile label={t("profile.stats.draws")} value={safeNumber(stats.draws)} />
                  <ProfileStatTile label={t("profile.stats.matches")} value={safeNumber(stats.totalMatches)} />
                  <ProfileStatTile label={t("profile.stats.winRate")} value={`${Number(safeNumber(stats.winRate).toFixed(2))}%`} />
                  <ProfileStatTile label={t("profile.stats.xp")} value={xp} />
                  <ProfileStatTile label={t("profile.stats.level")} value={level} />
                </div>
              </section>

              <section className="profile-overview-block">
                <div className="profile-section-heading">
                  <h2>{t("profile.sections.bestCharacter")}</h2>
                </div>
                {safeProfile.bestCharacter
                  ? <ProfileCharacterCard character={safeProfile.bestCharacter} featured t={t} />
                  : <ProfileEmptyState title={t("profile.empty.bestCharacterTitle")} text={t("profile.empty.bestCharacterText")} />}
              </section>

              <section className="profile-overview-block">
              <div className="profile-section-heading">
                <h2>{t("profile.sections.characterStats")}</h2>
              </div>
              {characters.length ? (
                <div className="profile-character-grid">
                  {characters.map((character) => (
                    <ProfileCharacterCard key={character.charId || character.name} character={character} t={t} />
                  ))}
                </div>
              ) : (
                <ProfileEmptyState title={t("profile.empty.characterStatsTitle")} text={t("profile.empty.characterStatsText")} />
              )}
              </section>
            </section>
          </section>
        </div>
        ) : (
          <section className="profile-history-panel" id="profile-history-panel" role="tabpanel" aria-labelledby="profile-history-tab">
            <header className="profile-history-heading">
              <div>
                <span className="profile-kicker">{t("profile.history.kicker")}</span>
                <h2>{t("profile.history.recentMatches")}</h2>
              </div>
              <strong>{matchHistory.length} / 20</strong>
            </header>

            {matchHistory.length ? (
              <div className="profile-history-list">
                {matchHistory.map(match => <ProfileMatchHistoryCard key={match.id} match={match} t={t} dateFormatter={dateFormatter} />)}
              </div>
            ) : (
              <ProfileEmptyState title={t("profile.empty.matchHistoryTitle")} text={t("profile.empty.matchHistoryText")} />
            )}
          </section>
        )}
      </div>

      {avatarPickerOpen ? (
        <AvatarPicker
          currentAvatar={user.avatar}
          selectedAvatar={selectedAvatar}
          saving={avatarSaving}
          error={avatarError?.startsWith("profile.") ? t(avatarError) : avatarError}
          avatarOptions={avatarOptions}
          onSelect={avatarId => {
            setSelectedAvatar(avatarId);
            setAvatarError("");
          }}
          onClose={closeAvatarPicker}
          onSave={saveAvatar}
          t={t}
        />
      ) : null}
    </main>
  );
}
