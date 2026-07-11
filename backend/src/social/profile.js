'use strict';

const db = require('../db');
const { checkAndGrantAchievements } = require('../game/achievements');
const { CHARACTER_DEFS } = require('../game/constants');

const ALLOWED_AVATARS = new Set([
    'character:eld',
    'character:hil',
    'character:qui',
    'character:gab',
    'logo:main',
    'logo:mini',
]);

function normalizeAvatar(value) {
    return typeof value === 'string' && ALLOWED_AVATARS.has(value) ? value : null;
}

function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function winRate(wins, totalMatches) {
    if (!totalMatches) return 0;
    return Math.round((wins / totalMatches) * 10000) / 100;
}

function characterMeta(charId) {
    const normalizedCharId = typeof charId === 'string' && charId.trim() ? charId.trim() : null;
    const def = normalizedCharId ? CHARACTER_DEFS[normalizedCharId] ?? {} : {};
    return {
        charId: normalizedCharId,
        name: def.name ?? 'Unknown',
        preview: null,
    };
}

function buildCharacterStats(row) {
    const wins = toInt(row.wins);
    const losses = toInt(row.losses);
    const draws = toInt(row.draws);
    const totalMatches = wins + losses + draws;
    return {
        ...characterMeta(row.char_id),
        wins,
        losses,
        draws,
        totalMatches,
        winRate: winRate(wins, totalMatches),
    };
}

function compareBestCharacter(a, b) {
    return (b.wins - a.wins) ||
        (b.winRate - a.winRate) ||
        (b.totalMatches - a.totalMatches) ||
        a.charId.localeCompare(b.charId);
}

async function hasMatchCharacterColumns() {
    const { rows } = await db.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'matches'
           AND column_name IN ('player1_char_id', 'player2_char_id')`
    );
    return new Set(rows.map(row => row.column_name)).size === 2;
}

async function getCharacterStatsRows(userId) {
    if (!await hasMatchCharacterColumns()) {
        console.warn('[PROFILE] matches character columns missing; returning empty character stats');
        return [];
    }

    const { rows } = await db.query(
        `WITH character_results AS (
            SELECT player1_char_id AS char_id, 1 AS wins, 0 AS losses, 0 AS draws
            FROM matches
            WHERE player1_id = $1 AND player1_char_id IS NOT NULL
            UNION ALL
            SELECT player2_char_id AS char_id, 0 AS wins, 1 AS losses, 0 AS draws
            FROM matches
            WHERE player2_id = $1 AND player2_char_id IS NOT NULL
         )
         SELECT char_id,
                SUM(wins)::int AS wins,
                SUM(losses)::int AS losses,
                SUM(draws)::int AS draws
         FROM character_results
         GROUP BY char_id`,
        [userId]
    );
    return rows;
}

async function getRecentMatchHistoryRows(userId) {
    const hasCharacterColumns = await hasMatchCharacterColumns();
    const player1CharSelect = hasCharacterColumns
        ? 'm.player1_char_id'
        : 'NULL::varchar AS player1_char_id';
    const player2CharSelect = hasCharacterColumns
        ? 'm.player2_char_id'
        : 'NULL::varchar AS player2_char_id';

    const { rows } = await db.query(
        `SELECT m.id,
                m.player1_id,
                p1.username AS player1_username,
                ${player1CharSelect},
                m.player2_id,
                p2.username AS player2_username,
                ${player2CharSelect},
                m.winner_id,
                m.score1,
                m.score2,
                m.game_type,
                m.played_at
         FROM matches m
         LEFT JOIN users p1 ON p1.id = m.player1_id
         LEFT JOIN users p2 ON p2.id = m.player2_id
         WHERE m.player1_id = $1 OR m.player2_id = $1
         ORDER BY m.played_at DESC, m.id DESC
         LIMIT 20`,
        [userId]
    );
    return rows;
}

function historyParticipant(id, username, charId) {
    const character = characterMeta(charId);
    return {
        id: id ?? null,
        username: username || 'Unknown player',
        charId: character.charId,
        characterName: character.name,
    };
}

function buildMatchHistoryEntry(row, userId) {
    const isPlayer1 = Number(row.player1_id) === Number(userId);
    const player = isPlayer1
        ? historyParticipant(row.player1_id, row.player1_username, row.player1_char_id)
        : historyParticipant(row.player2_id, row.player2_username, row.player2_char_id);
    const opponentPlayer = isPlayer1
        ? historyParticipant(row.player2_id, row.player2_username, row.player2_char_id)
        : historyParticipant(row.player1_id, row.player1_username, row.player1_char_id);
    const playerScore = toInt(isPlayer1 ? row.score1 : row.score2);
    const opponentScore = toInt(isPlayer1 ? row.score2 : row.score1);

    return {
        id: row.id,
        result: isPlayer1 ? 'win' : 'loss',
        opponent: {
            id: opponentPlayer.id,
            username: opponentPlayer.username,
        },
        player,
        opponentPlayer,
        score: {
            player: playerScore,
            opponent: opponentScore,
            raw: `${playerScore} - ${opponentScore}`,
        },
        gameType: row.game_type ?? null,
        playedAt: row.played_at ?? null,
    };
}

async function getProfile(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT id, username, avatar_url, is_online, role, created_at FROM users WHERE id = $1`,
            [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ user: rows[0] });
    } catch (err) {
        console.error('[PROFILE] getProfile:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function updateProfile(req, res) {
    const { username, avatar_url } = req.body ?? {};
    const nextUsername = typeof username === 'string' && username.trim() ? username.trim() : null;
    const hasAvatarUpdate = avatar_url !== undefined;
    if (!nextUsername && !hasAvatarUpdate)
        return res.status(400).json({ error: 'Nothing to update' });
    if (hasAvatarUpdate && !normalizeAvatar(avatar_url))
        return res.status(400).json({ error: 'Invalid avatar' });
    try {
        const { rows } = await db.query(
            `UPDATE users SET username = COALESCE($1, username), avatar_url = COALESCE($2, avatar_url), updated_at = NOW()
             WHERE id = $3 RETURNING id, username, email, avatar_url, role`,
            [nextUsername, hasAvatarUpdate ? avatar_url : null, req.user.user_id]
        );
        res.json({ user: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
        console.error('[PROFILE] updateProfile:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getUserStats(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT s.wins, s.losses, s.draws, s.win_streak, s.best_streak, s.xp, s.level, s.updated_at,
                    u.username, u.avatar_url
             FROM user_stats s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
            [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Stats not found' });
        res.json({ stats: rows[0] });
    } catch (err) {
        console.error('[PROFILE] getUserStats:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getMyProfileSummary(req, res) {
    const userId = req.user.user_id;
    try {
        const [{ rows: [user] }, { rows: [statsRow] }, characterRows, historyRows] = await Promise.all([
            db.query(
                `SELECT id, username, avatar_url FROM users WHERE id = $1`,
                [userId]
            ),
            db.query(
                `SELECT wins, losses, draws, xp, level FROM user_stats WHERE user_id = $1`,
                [userId]
            ),
            getCharacterStatsRows(userId),
            getRecentMatchHistoryRows(userId),
        ]);

        const wins = toInt(statsRow?.wins);
        const losses = toInt(statsRow?.losses);
        const draws = toInt(statsRow?.draws);
        const totalMatches = wins + losses + draws;
        const characters = characterRows
            .map(buildCharacterStats)
            .sort((a, b) => a.charId.localeCompare(b.charId));
        const [bestCharacter = null] = [...characters].sort(compareBestCharacter);
        const matchHistory = historyRows.map(row => buildMatchHistoryEntry(row, userId));

        res.json({
            user: {
                id: user?.id ?? userId,
                username: user?.username ?? req.user.username ?? '',
                avatar: normalizeAvatar(user?.avatar_url ?? req.user.avatar_url),
            },
            globalStats: {
                wins,
                losses,
                draws,
                totalMatches,
                winRate: winRate(wins, totalMatches),
                xp: toInt(statsRow?.xp),
                level: toInt(statsRow?.level, 1),
            },
            bestCharacter,
            characters,
            matchHistory,
        });
    } catch (err) {
        console.error('[PROFILE] getMyProfileSummary:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function updateAvatar(req, res) {
    const { avatar } = req.body ?? {};
    if (!normalizeAvatar(avatar))
        return res.status(400).json({ error: 'Invalid avatar' });

    try {
        const { rows } = await db.query(
            `UPDATE users SET avatar_url = $1, updated_at = NOW()
             WHERE id = $2 RETURNING avatar_url`,
            [avatar, req.user.user_id]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ avatar: rows[0].avatar_url });
    } catch (err) {
        console.error('[PROFILE] updateAvatar:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getMatchHistory(req, res) {
    const userId = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            `SELECT m.id, m.score1, m.score2, m.game_type, m.played_at, m.winner_id,
                    u1.username AS player1, u1.avatar_url AS avatar1,
                    u2.username AS player2, u2.avatar_url AS avatar2
             FROM matches m
             LEFT JOIN users u1 ON u1.id = m.player1_id
             LEFT JOIN users u2 ON u2.id = m.player2_id
             WHERE m.player1_id = $1 OR m.player2_id = $1
             ORDER BY m.played_at DESC LIMIT 20`,
            [userId]
        );
        res.json({ matches: rows });
    } catch (err) {
        console.error('[PROFILE] getMatchHistory:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getUserAchievements(req, res) {
    const userId = parseInt(req.params.id);
    try {
        await checkAndGrantAchievements(userId);

        const { rows } = await db.query(
            `SELECT a.key, a.name, a.description, ua.earned_at
             FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
             WHERE ua.user_id = $1 ORDER BY ua.earned_at DESC`,
            [userId]
        );
        res.json({ achievements: rows });
    } catch (err) {
        console.error('[PROFILE] getUserAchievements:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function exportData(req, res) {
    try {
        const [{ rows: [user] }, { rows: [stats] }, { rows: history }, { rows: achievements }] = await Promise.all([
            db.query(`SELECT id, username, email, avatar_url, created_at FROM users WHERE id = $1`,
                [req.user.user_id]),
            db.query(`SELECT * FROM user_stats WHERE user_id = $1`,
                [req.user.user_id]),
            db.query(
                `SELECT m.id, m.score1, m.score2, m.game_type, m.played_at, m.winner_id,
                        u1.username AS player1, u2.username AS player2
                 FROM matches m
                 LEFT JOIN users u1 ON u1.id = m.player1_id
                 LEFT JOIN users u2 ON u2.id = m.player2_id
                 WHERE m.player1_id = $1 OR m.player2_id = $1 ORDER BY m.played_at DESC`,
                [req.user.user_id]),
            db.query(
                `SELECT a.key, a.name, a.description, ua.earned_at
                 FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
                 WHERE ua.user_id = $1`,
                [req.user.user_id]),
        ]);
        res.json({ user: user ?? null, stats: stats ?? null, history, achievements });
    } catch (err) {
        console.error('[PROFILE] exportData:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function deleteAccount(req, res) {
    try {
        await db.query(`DELETE FROM users WHERE id = $1`, [req.user.user_id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('[PROFILE] deleteAccount:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

module.exports = { getProfile, updateProfile, updateAvatar, getUserStats, getMyProfileSummary, getMatchHistory, getUserAchievements, exportData, deleteAccount };
