'use strict';

const db = require('../db');

const ACHIEVEMENT_CATALOG = [
  { key: 'first_win', name: 'Primera victoria', description: 'Gana tu primera partida' },
  { key: 'veteran', name: 'Veterano', description: 'Consigue 10 victorias' },
  { key: 'hot_streak', name: 'En racha', description: 'Alcanza una racha de 3 victorias consecutivas' },
  { key: 'combo_master', name: 'Maestro del combo', description: 'Ejecuta un combo completo en una victoria' },
  { key: 'untouchable', name: 'Intocable', description: 'Gana una partida sin recibir dano' },
  { key: 'clean_sweep', name: 'Barrida perfecta', description: 'Gana conservando tus 3 stocks' },
  { key: 'speedrunner', name: 'Velocista', description: 'Cierra una victoria en 45 segundos o menos' },
  { key: 'bracket_breaker', name: 'Rompe brackets', description: 'Gana un combate de torneo' },
  { key: 'tournament_champion', name: 'Campeon del torneo', description: 'Gana un torneo completo' },
  { key: 'social', name: 'Sociable', description: 'Acepta o consigue tu primera amistad' },
];

let catalogReady = null;

async function ensureCatalog() {
  if (!catalogReady) {
    catalogReady = (async () => {
      for (const achievement of ACHIEVEMENT_CATALOG) {
        await db.query(
          `INSERT INTO achievements (key, name, description)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (key) DO UPDATE
                     SET name = EXCLUDED.name,
                         description = EXCLUDED.description`,
          [achievement.key, achievement.name, achievement.description]
        );
      }
    })().catch((error) => {
      catalogReady = null;
      throw error;
    });
  }
  return catalogReady;
}

async function grantAchievement(userId, key, client = db) {
  if (!userId || !key) return false;
  await ensureCatalog();
  const { rowCount } = await client.query(
    `INSERT INTO user_achievements (user_id, achievement_id)
         SELECT $1, a.id
         FROM achievements a
         WHERE a.key = $2
         ON CONFLICT (user_id, achievement_id) DO NOTHING`,
    [userId, key]
  );
  return rowCount > 0;
}

async function checkAndGrantAchievements(userId, context = {}) {
  if (!userId) return [];

  await ensureCatalog();

  const { rows } = await db.query(
    `SELECT wins, best_streak
         FROM user_stats
         WHERE user_id = $1`,
    [userId]
  );

  const stats = rows[0] ?? {};
  const wins = Number(stats.wins) || 0;
  const bestStreak = Number(stats.best_streak) || 0;
  const awarded = [];

  if (wins >= 1 && await grantAchievement(userId, 'first_win')) awarded.push('first_win');
  if (wins >= 10 && await grantAchievement(userId, 'veteran')) awarded.push('veteran');
  if (bestStreak >= 3 && await grantAchievement(userId, 'hot_streak')) awarded.push('hot_streak');
  if (context.completedCombo && await grantAchievement(userId, 'combo_master')) awarded.push('combo_master');
  if (context.tookDamage === false && await grantAchievement(userId, 'untouchable')) awarded.push('untouchable');
  if ((Number(context.winnerStocks) || 0) >= 3 && await grantAchievement(userId, 'clean_sweep')) awarded.push('clean_sweep');
  if ((Number(context.durationS) || 9999) <= 45 && await grantAchievement(userId, 'speedrunner')) awarded.push('speedrunner');
  if (context.isTournamentWin && await grantAchievement(userId, 'bracket_breaker')) awarded.push('bracket_breaker');

  return awarded;
}

module.exports = {
  ACHIEVEMENT_CATALOG,
  checkAndGrantAchievements,
  ensureCatalog,
  grantAchievement,
};
