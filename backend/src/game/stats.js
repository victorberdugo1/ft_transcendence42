'use strict';

async function updateStatsAfterMatch({ db, winnerDbId, loserDbId, matchId, startedAt }) {
  const durationS = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));

  if (matchId) {
    await db.query(
      `UPDATE matches
             SET ended_at = NOW(), duration_s = COALESCE(duration_s, $2)
             WHERE id = $1`,
      [matchId, durationS]
    );
  }

  const updates = [];

  if (winnerDbId) {
    updates.push(
      db.query(
        `INSERT INTO user_stats (user_id, win_streak, best_streak)
                 VALUES ($1, 1, 1)
                 ON CONFLICT (user_id) DO UPDATE
                 SET win_streak = user_stats.win_streak + 1,
                     best_streak = GREATEST(user_stats.best_streak, user_stats.win_streak + 1),
                     updated_at = NOW()`,
        [winnerDbId]
      )
    );
  }

  if (loserDbId) {
    updates.push(
      db.query(
        `INSERT INTO user_stats (user_id, win_streak, best_streak)
                 VALUES ($1, 0, 0)
                 ON CONFLICT (user_id) DO UPDATE
                 SET win_streak = 0,
                     updated_at = NOW()`,
        [loserDbId]
      )
    );
  }

  await Promise.all(updates);
}

module.exports = { updateStatsAfterMatch };
