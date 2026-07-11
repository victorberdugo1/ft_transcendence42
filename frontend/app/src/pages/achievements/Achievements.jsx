import LanguageSelector from "@src/components/LanguageSelector.jsx";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "./achievements.css";

const ACHIEVEMENT_ORDER = [
  { key: "first_win", goal: 1, accent: "gold" },
  { key: "veteran", goal: 10, accent: "cyan" },
];

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDate(value, locale, t) {
  if (!value) return t("achievementsPage.labels.notEarnedYet");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("achievementsPage.labels.notEarnedYet");
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function deriveCatalog(achievements, stats, t, language) {
  const unlockedByKey = new Map(
    (Array.isArray(achievements) ? achievements : []).map((achievement) => [achievement.key, achievement])
  );
  const wins = safeNumber(stats?.wins);

  return ACHIEVEMENT_ORDER.map((definition, index) => {
    const unlocked = unlockedByKey.get(definition.key);
    const progressCurrent = clamp(wins, 0, definition.goal);
    const progressPercent = clamp((progressCurrent / definition.goal) * 100, 0, 100);

    return {
      key: definition.key,
      accent: definition.accent,
      ordinal: String(index + 1).padStart(2, "0"),
      unlocked: Boolean(unlocked),
      goal: definition.goal,
      progressCurrent,
      progressPercent,
      earnedAt: unlocked?.earned_at || null,
      name: t(`achievementsPage.definitions.${definition.key}.name`, { defaultValue: unlocked?.name || definition.key }),
      description: t(`achievementsPage.definitions.${definition.key}.description`, {
        defaultValue: unlocked?.description || "",
      }),
      hint: t(`achievementsPage.definitions.${definition.key}.hint`, { goal: definition.goal }),
      progressLabel: t("achievementsPage.labels.progressWins", {
        current: progressCurrent,
        total: definition.goal,
      }),
      earnedLabel: formatDate(unlocked?.earned_at, language, t),
    };
  });
}

function AchievementCard({ achievement, active, onSelect, t }) {
  return (
    <button
      type="button"
      className={active ? `ach-card ach-card-${achievement.accent} ach-card-active` : `ach-card ach-card-${achievement.accent}`}
      onClick={() => onSelect(achievement.key)}
      aria-pressed={active}
    >
      <div className="ach-card-topline">
        <span className="ach-card-ordinal">{achievement.ordinal}</span>
        <span className={achievement.unlocked ? "ach-card-state ach-card-state-unlocked" : "ach-card-state ach-card-state-locked"}>
          {achievement.unlocked ? t("achievementsPage.status.unlocked") : t("achievementsPage.status.locked")}
        </span>
      </div>

      <h3>{achievement.name}</h3>
      <p>{achievement.description}</p>

      <div className="ach-card-progress">
        <div className="ach-card-progressbar" aria-hidden="true">
          <span style={{ width: `${achievement.progressPercent}%` }} />
        </div>
        <strong>{achievement.progressLabel}</strong>
      </div>
    </button>
  );
}

function SummaryStat({ value, label, accent = "cyan" }) {
  return (
    <div className={`ach-stat ach-stat-${accent}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function Achievements({ user, onBack }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [achievements, setAchievements] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState("first_win");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      setError("");

      try {
        const [achievementsRes, statsRes] = await Promise.all([
          fetch(`/api/users/${user.id}/achievements`, { credentials: "include" }),
          fetch(`/api/users/${user.id}/stats`, { credentials: "include" }),
        ]);

        if (!achievementsRes.ok || !statsRes.ok) {
          throw new Error(t("achievementsPage.errors.loadFailed"));
        }

        const [achievementsData, statsData] = await Promise.all([
          achievementsRes.json(),
          statsRes.json(),
        ]);

        if (cancelled) return;

        setAchievements(Array.isArray(achievementsData.achievements) ? achievementsData.achievements : []);
        setStats(statsData.stats ?? statsData ?? null);
        setStatus("ready");
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError.message || t("achievementsPage.errors.loadFailed"));
        setStatus("error");
      }
    }

    if (user?.id) load();

    return () => {
      cancelled = true;
    };
  }, [t, user?.id]);

  const catalog = useMemo(
    () => deriveCatalog(achievements, stats, t, i18n.resolvedLanguage || i18n.language || "en"),
    [achievements, stats, t, i18n.language, i18n.resolvedLanguage]
  );

  const unlockedCount = catalog.filter((item) => item.unlocked).length;
  const completion = catalog.length ? Math.round((unlockedCount / catalog.length) * 100) : 0;
  const totalWins = safeNumber(stats?.wins);
  const bestStreak = safeNumber(stats?.best_streak ?? stats?.bestStreak);
  const filteredCatalog = catalog.filter((item) => {
    if (filter === "unlocked") return item.unlocked;
    if (filter === "locked") return !item.unlocked;
    return true;
  });

  useEffect(() => {
    if (!filteredCatalog.length) return;
    if (!filteredCatalog.some((item) => item.key === selectedKey)) {
      setSelectedKey(filteredCatalog[0].key);
    }
  }, [filteredCatalog, selectedKey]);

  const featured = filteredCatalog.find((item) => item.key === selectedKey) || catalog[0] || null;
  const nextUnlock = catalog.find((item) => !item.unlocked) || null;

  return (
    <div className="ach-page">
      <div className="ach-shell">
        <header className="ach-header">
          <div>
            <span className="ach-kicker">{t("achievementsPage.kicker")}</span>
            <h1>{t("achievementsPage.title")}</h1>
          </div>
          <div className="ach-header-actions">
            <LanguageSelector variant="manual" compact />
            <button type="button" className="ach-back" onClick={onBack}>{t("achievementsPage.backToLobby")}</button>
          </div>
        </header>

        <section className="ach-hero">
          <div className="ach-hero-copy">
            <span className="ach-hero-chip">{t("achievementsPage.hero.chip")}</span>
            <h2>{t("achievementsPage.hero.title", { playerName: user.username || user.email })}</h2>
            <p>{t("achievementsPage.hero.description")}</p>
          </div>

          <div className="ach-hero-stats">
            <SummaryStat value={`${unlockedCount}/${catalog.length}`} label={t("achievementsPage.summary.unlocked")} accent="gold" />
            <SummaryStat value={`${completion}%`} label={t("achievementsPage.summary.completion")} />
            <SummaryStat value={totalWins} label={t("achievementsPage.summary.wins")} accent="pink" />
            <SummaryStat value={bestStreak} label={t("achievementsPage.summary.bestStreak")} accent="green" />
          </div>
        </section>

        {status === "loading" ? (
          <section className="ach-state-card">
            <h2>{t("achievementsPage.loading.title")}</h2>
            <p>{t("achievementsPage.loading.text")}</p>
          </section>
        ) : null}

        {status === "error" ? (
          <section className="ach-state-card ach-state-card-error">
            <h2>{t("achievementsPage.error.title")}</h2>
            <p>{error || t("achievementsPage.errors.loadFailed")}</p>
          </section>
        ) : null}

        {status === "ready" && featured ? (
          <div className="ach-layout">
            <aside className="ach-spotlight">
              <div className={`ach-spotlight-card ach-spotlight-${featured.accent}`}>
                <div className="ach-spotlight-topline">
                  <span>{t("achievementsPage.labels.featured")}</span>
                  <strong>{featured.ordinal}</strong>
                </div>

                <h2>{featured.name}</h2>
                <p>{featured.description}</p>

                <div className="ach-spotlight-progress">
                  <div className="ach-spotlight-bar" aria-hidden="true">
                    <span style={{ width: `${featured.progressPercent}%` }} />
                  </div>
                  <div className="ach-spotlight-meta">
                    <span>{featured.progressLabel}</span>
                    <strong>{featured.unlocked ? featured.earnedLabel : featured.hint}</strong>
                  </div>
                </div>
              </div>

              <div className="ach-next-card">
                <span className="ach-next-label">{t("achievementsPage.labels.nextTarget")}</span>
                {nextUnlock ? (
                  <>
                    <strong>{nextUnlock.name}</strong>
                    <p>{nextUnlock.hint}</p>
                  </>
                ) : (
                  <>
                    <strong>{t("achievementsPage.labels.allUnlockedTitle")}</strong>
                    <p>{t("achievementsPage.labels.allUnlockedText")}</p>
                  </>
                )}
              </div>
            </aside>

            <section className="ach-main">
              <div className="ach-toolbar">
                <div className="ach-toolbar-copy">
                  <span>{t("achievementsPage.labels.catalog")}</span>
                  <strong>{t("achievementsPage.labels.catalogCount", { count: filteredCatalog.length })}</strong>
                </div>

                <div className="ach-filters" role="tablist" aria-label={t("achievementsPage.filters.label")}>
                  {[
                    ["all", t("achievementsPage.filters.all")],
                    ["unlocked", t("achievementsPage.filters.unlocked")],
                    ["locked", t("achievementsPage.filters.locked")],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={filter === value ? "ach-filter ach-filter-active" : "ach-filter"}
                      onClick={() => setFilter(value)}
                      aria-pressed={filter === value}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ach-grid">
                {filteredCatalog.map((achievement) => (
                  <AchievementCard
                    key={achievement.key}
                    achievement={achievement}
                    active={featured.key === achievement.key}
                    onSelect={setSelectedKey}
                    t={t}
                  />
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
