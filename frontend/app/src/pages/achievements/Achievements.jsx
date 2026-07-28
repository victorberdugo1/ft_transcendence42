import PageHeader from "@src/components/ui/PageHeader.jsx";
import RequestStateCard from "@src/components/ui/RequestStateCard.jsx";
import { useApiRequest } from "@src/hooks/useApiRequest.js";
import { apiFetchJson } from "@src/utils/http.js";
import { safeNumber } from "@src/utils/number.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "./achievements.css";

const ACHIEVEMENT_META = {
  first_win: { order: 1, goal: 1, accent: "gold", progressMetric: "wins" },
  veteran: { order: 2, goal: 10, accent: "cyan", progressMetric: "wins" },
  hot_streak: { order: 3, goal: 3, accent: "pink", progressMetric: "bestStreak" },
  combo_master: { order: 4, goal: 1, accent: "gold", progressMetric: "binary" },
  untouchable: { order: 5, goal: 1, accent: "green", progressMetric: "binary" },
  clean_sweep: { order: 6, goal: 1, accent: "cyan", progressMetric: "binary" },
  speedrunner: { order: 7, goal: 1, accent: "pink", progressMetric: "binary" },
  bracket_breaker: { order: 8, goal: 1, accent: "cyan", progressMetric: "binary" },
  tournament_champion: { order: 9, goal: 1, accent: "gold", progressMetric: "binary" },
  social: { order: 10, goal: 1, accent: "green", progressMetric: "binary" },
};

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

  const bestStreak = safeNumber(stats?.best_streak ?? stats?.bestStreak);
  const keys = Array.from(new Set([
    ...Object.keys(ACHIEVEMENT_META),
    ...unlockedByKey.keys(),
  ])).sort((left, right) => {
    const leftOrder = ACHIEVEMENT_META[left]?.order ?? 999;
    const rightOrder = ACHIEVEMENT_META[right]?.order ?? 999;
    return leftOrder - rightOrder || left.localeCompare(right);
  });

  return keys.map((key, index) => {
    const definition = ACHIEVEMENT_META[key] ?? { goal: 1, accent: "cyan", progressMetric: "binary" };
    const unlocked = unlockedByKey.get(key);
    const progressBase = definition.progressMetric === "wins"
      ? wins
      : definition.progressMetric === "bestStreak"
        ? bestStreak
        : unlocked
          ? 1
          : 0;
    const progressCurrent = clamp(progressBase, 0, definition.goal);
    const progressPercent = clamp((progressCurrent / definition.goal) * 100, 0, 100);

    return {
      key,
      accent: definition.accent,
      ordinal: String(index + 1).padStart(2, "0"),
      unlocked: Boolean(unlocked),
      goal: definition.goal,
      progressCurrent,
      progressPercent,
      earnedAt: unlocked?.earned_at || null,
      name: t(`achievementsPage.definitions.${key}.name`, { defaultValue: unlocked?.name || key }),
      description: t(`achievementsPage.definitions.${key}.description`, {
        defaultValue: unlocked?.description || "",
      }),
      hint: t(`achievementsPage.definitions.${key}.hint`, {
        goal: definition.goal,
        defaultValue: t("achievementsPage.labels.genericHint"),
      }),
      progressLabel: t(
        definition.progressMetric === "bestStreak"
          ? "achievementsPage.labels.progressStreak"
          : definition.progressMetric === "binary"
            ? "achievementsPage.labels.progressBinary"
            : "achievementsPage.labels.progressWins",
        {
        current: progressCurrent,
        total: definition.goal,
        }
      ),
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
      <span className="ach-card-accent" aria-hidden="true" />
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
  const [filter, setFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState("first_win");

  const loadAchievementsData = useCallback(async () => {
    if (!user?.id) return { achievements: [], stats: null };

    const [achievementsData, statsData] = await Promise.all([
      apiFetchJson(`/api/users/${user.id}/achievements`),
      apiFetchJson(`/api/users/${user.id}/stats`),
    ]);

    return {
      achievements: Array.isArray(achievementsData.achievements) ? achievementsData.achievements : [],
      stats: statsData?.stats ?? null,
    };
  }, [user?.id]);

  const achievementsRequest = useApiRequest(
    loadAchievementsData,
    [loadAchievementsData],
    { defaultError: t("achievementsPage.errors.loadFailed") }
  );

  const status = achievementsRequest.status === "success"
    ? "ready"
    : achievementsRequest.status;
  const error = achievementsRequest.error;
  const achievements = achievementsRequest.data?.achievements ?? [];
  const stats = achievementsRequest.data?.stats ?? null;

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
        <PageHeader
          className="ach-header"
          kickerClassName="ach-kicker"
          actionsClassName="ach-header-actions"
          kicker={t("achievementsPage.kicker")}
          title={t("achievementsPage.title")}
          onBack={onBack}
          backLabel={t("achievementsPage.backToLobby")}
        />

        <section className="ach-hero grid grid-cols-[minmax(0,1.3fr)_minmax(320px,0.95fr)] max-[1024px]:grid-cols-1 gap-[22px]">
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
          <RequestStateCard
            className="ach-state-card"
            title={t("achievementsPage.loading.title")}
            message={t("achievementsPage.loading.text")}
          />
        ) : null}

        {status === "error" ? (
          <RequestStateCard
            className="ach-state-card ach-state-card-error"
            title={t("achievementsPage.error.title")}
            message={error || t("achievementsPage.errors.loadFailed")}
          />
        ) : null}

        {status === "ready" && featured ? (
          <div className="ach-layout grid grid-cols-[minmax(320px,380px)_minmax(0,1fr)] max-[1024px]:grid-cols-1 gap-6">
            <aside className="ach-spotlight">
              <div className={`ach-spotlight-card ach-spotlight-${featured.accent}`}>
                <span className="ach-spotlight-emblem" aria-hidden="true">//</span>
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
