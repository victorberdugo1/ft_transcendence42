'use strict';

const db = require('../db');
const { getLivePresenceMap } = require('./presence');

const MAX_MESSAGE_LENGTH = 500;

let socialSchemaReady = null;
let lobbyChannelId = null;

async function ensureSocialSchema() {
    if (!socialSchemaReady) {
        socialSchemaReady = (async () => {
            await db.query(
                `CREATE TABLE IF NOT EXISTS chat_channels (
                    id SERIAL PRIMARY KEY,
                    key VARCHAR(50) UNIQUE NOT NULL CHECK (key <> ''),
                    title VARCHAR(100) NOT NULL CHECK (title <> ''),
                    description TEXT,
                    is_readonly BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )`
            );
            await db.query(
                `CREATE TABLE IF NOT EXISTS channel_messages (
                    id SERIAL PRIMARY KEY,
                    channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
                    sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    content TEXT NOT NULL CHECK (content <> ''),
                    sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )`
            );
            await db.query('CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_time ON channel_messages(channel_id, sent_at DESC, id DESC)');
            await db.query('CREATE INDEX IF NOT EXISTS idx_channel_messages_sender ON channel_messages(sender_id)');
            await db.query(
                `INSERT INTO chat_channels (key, title, description)
                 VALUES ('lobby', 'Lobby Global', 'Main social channel for the lobby')
                 ON CONFLICT (key) DO UPDATE
                 SET title = EXCLUDED.title,
                     description = EXCLUDED.description,
                     updated_at = NOW()`
            );
        })().catch((error) => {
            socialSchemaReady = null;
            lobbyChannelId = null;
            throw error;
        });
    }
    return socialSchemaReady;
}

async function ensureLobbyChannel() {
    await ensureSocialSchema();
    if (lobbyChannelId) return lobbyChannelId;
    const { rows } = await db.query('SELECT id FROM chat_channels WHERE key = $1 LIMIT 1', ['lobby']);
    lobbyChannelId = rows[0]?.id ?? null;
    return lobbyChannelId;
}

function clampLimit(value, fallback = 80, max = 200) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(1, parsed));
}

function normalizePresence(userId, fallbackOnline, livePresence) {
    return livePresence.get(userId) ?? {
        state: fallbackOnline ? 'online' : 'offline',
        online: Boolean(fallbackOnline),
        label: fallbackOnline ? 'Online' : 'Offline',
        sessionId: null,
        mode: null,
    };
}

function serializeUserSummary(row, livePresence) {
    const presence = normalizePresence(row.id, row.is_online, livePresence);
    return {
        id: row.id,
        username: row.username,
        avatarUrl: row.avatar_url,
        presence,
    };
}

function trimContent(content) {
    return typeof content === 'string' ? content.trim() : '';
}

async function getHubOverview(req, res) {
    const userId = req.user.user_id;

    try {
        const lobbyId = await ensureLobbyChannel();
        const livePresence = getLivePresenceMap();

        const [friendResult, requestResult, conversationResult, channelResult] = await Promise.all([
            db.query(
                `SELECT u.id, u.username, u.avatar_url, u.is_online, f.status
                 FROM friendships f
                 JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
                 WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
                 ORDER BY u.username`,
                [userId]
            ),
            db.query(
                `SELECT u.id, u.username, u.avatar_url, u.is_online, f.created_at
                 FROM friendships f
                 JOIN users u ON u.id = f.user_id
                 WHERE f.friend_id = $1 AND f.status = 'pending'
                 ORDER BY f.created_at DESC`,
                [userId]
            ),
            db.query(
                `WITH direct_messages AS (
                    SELECT id,
                           sender_id,
                           receiver_id,
                           content,
                           is_read,
                           sent_at,
                           CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_user_id
                    FROM messages
                    WHERE sender_id = $1 OR receiver_id = $1
                 ),
                 latest_messages AS (
                    SELECT DISTINCT ON (other_user_id)
                           other_user_id,
                           id,
                           sender_id,
                           receiver_id,
                           content,
                           is_read,
                           sent_at
                    FROM direct_messages
                    ORDER BY other_user_id, sent_at DESC, id DESC
                 ),
                 unread_counts AS (
                    SELECT sender_id AS other_user_id,
                           COUNT(*)::int AS unread_count
                    FROM messages
                    WHERE receiver_id = $1 AND is_read = FALSE
                    GROUP BY sender_id
                 )
                 SELECT u.id,
                        u.username,
                        u.avatar_url,
                        u.is_online,
                        lm.content AS last_message,
                        lm.sent_at AS last_message_at,
                        lm.sender_id AS last_sender_id,
                        COALESCE(uc.unread_count, 0) AS unread_count
                 FROM latest_messages lm
                 JOIN users u ON u.id = lm.other_user_id
                 LEFT JOIN unread_counts uc ON uc.other_user_id = lm.other_user_id
                 ORDER BY lm.sent_at DESC NULLS LAST, u.username ASC`,
                [userId]
            ),
            db.query(
                `SELECT c.id,
                        c.key,
                        c.title,
                        c.description,
                        last_msg.content AS last_message,
                        last_msg.sent_at AS last_message_at,
                        sender.username AS last_sender_username
                 FROM chat_channels c
                 LEFT JOIN LATERAL (
                    SELECT cm.content, cm.sent_at, cm.sender_id
                    FROM channel_messages cm
                    WHERE cm.channel_id = c.id
                    ORDER BY cm.sent_at DESC, cm.id DESC
                    LIMIT 1
                 ) last_msg ON TRUE
                 LEFT JOIN users sender ON sender.id = last_msg.sender_id
                 WHERE c.id = $1`,
                [lobbyId]
            ),
        ]);

        const friends = friendResult.rows.map((row) => ({
            ...serializeUserSummary(row, livePresence),
            relationship: row.status,
        }));

        const requests = requestResult.rows.map((row) => ({
            ...serializeUserSummary(row, livePresence),
            createdAt: row.created_at,
        }));

        const conversations = conversationResult.rows.map((row) => ({
            user: serializeUserSummary(row, livePresence),
            lastMessage: row.last_message,
            lastMessageAt: row.last_message_at,
            lastSenderId: row.last_sender_id,
            unreadCount: Number(row.unread_count) || 0,
        }));

        const channels = channelResult.rows.map((row) => ({
            id: row.id,
            key: row.key,
            title: row.title,
            description: row.description,
            lastMessage: row.last_message,
            lastMessageAt: row.last_message_at,
            lastSenderUsername: row.last_sender_username,
        }));

        res.json({
            friends,
            requests,
            conversations,
            channels,
        });
    } catch (err) {
        console.error('[CHAT] getHubOverview:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function searchUsers(req, res) {
    const userId = req.user.user_id;
    const query = trimContent(req.query.q);

    if (!query) return res.json({ users: [] });

    try {
        await ensureSocialSchema();
        const livePresence = getLivePresenceMap();
        const { rows } = await db.query(
            `SELECT u.id,
                    u.username,
                    u.avatar_url,
                    u.is_online,
                    CASE
                        WHEN f.status = 'accepted' THEN 'accepted'
                        WHEN f.user_id = $1 AND f.status = 'pending' THEN 'outgoing'
                        WHEN f.friend_id = $1 AND f.status = 'pending' THEN 'incoming'
                        WHEN f.status = 'blocked' THEN 'blocked'
                        ELSE 'none'
                    END AS friendship_status
             FROM users u
             LEFT JOIN friendships f
               ON ((f.user_id = $1 AND f.friend_id = u.id) OR (f.friend_id = $1 AND f.user_id = u.id))
             WHERE u.id <> $1 AND u.username ILIKE $2
             ORDER BY
                CASE WHEN u.username ILIKE $3 THEN 0 ELSE 1 END,
                u.username ASC
             LIMIT 12`,
            [userId, `%${query}%`, `${query}%`]
        );

        res.json({
            users: rows.map((row) => ({
                ...serializeUserSummary(row, livePresence),
                friendshipStatus: row.friendship_status,
            })),
        });
    } catch (err) {
        console.error('[CHAT] searchUsers:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getConversation(req, res) {
    const otherId = parseInt(req.params.userId);
    if (!otherId) return res.status(400).json({ error: 'Invalid user id' });
    try {
        await ensureSocialSchema();
        const limit = clampLimit(req.query.limit);
        const before = req.query.before ? new Date(req.query.before) : null;
        const { rows } = await db.query(
            `SELECT id, sender_id, receiver_id, content, is_read, sent_at
             FROM messages
             WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
               AND ($3::timestamptz IS NULL OR sent_at < $3)
             ORDER BY sent_at DESC, id DESC
             LIMIT $4`,
            [req.user.user_id, otherId, before, limit]
        );
        res.json({ messages: rows.reverse() });
    } catch (err) {
        console.error('[CHAT] getConversation:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function sendMessage(req, res) {
    const receiverId = parseInt(req.params.userId);
    const { content } = req.body ?? {};
    const trimmed = trimContent(content);
    if (!receiverId || receiverId === req.user.user_id)
        return res.status(400).json({ error: 'Invalid receiver id' });
    if (!trimmed)
        return res.status(400).json({ error: 'content is required' });
    if (trimmed.length > MAX_MESSAGE_LENGTH)
        return res.status(400).json({ error: 'Message is too long' });
    try {
        await ensureSocialSchema();
        const { rows } = await db.query(
            `INSERT INTO messages (sender_id, receiver_id, content)
             VALUES ($1, $2, $3)
             RETURNING id, sender_id, receiver_id, content, is_read, sent_at`,
            [req.user.user_id, receiverId, trimmed]
        );
        res.status(201).json({ message: rows[0] });
    } catch (err) {
        console.error('[CHAT] sendMessage:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function markRead(req, res) {
    const senderId = parseInt(req.params.userId);
    try {
        await ensureSocialSchema();
        await db.query(
            `UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
            [senderId, req.user.user_id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('[CHAT] markRead:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function unreadCounts(req, res) {
    try {
        await ensureSocialSchema();
        const { rows } = await db.query(
            `SELECT sender_id, COUNT(*) AS count FROM messages
             WHERE receiver_id = $1 AND is_read = FALSE GROUP BY sender_id`,
            [req.user.user_id]
        );
        res.json({ unread: rows });
    } catch (err) {
        console.error('[CHAT] unreadCounts:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function getChannelMessages(req, res) {
    const channelKey = trimContent(req.params.channelKey).toLowerCase();
    if (!channelKey) return res.status(400).json({ error: 'Invalid channel key' });

    try {
        await ensureSocialSchema();
        const limit = clampLimit(req.query.limit);
        const before = req.query.before ? new Date(req.query.before) : null;
        const { rows } = await db.query(
            `SELECT c.id AS channel_id,
                    c.key AS channel_key,
                    c.title AS channel_title,
                    c.description AS channel_description,
                    cm.id,
                    cm.sender_id,
                    cm.content,
                    cm.sent_at,
                    u.username AS sender_username,
                    u.avatar_url AS sender_avatar_url
             FROM chat_channels c
             LEFT JOIN channel_messages cm ON cm.channel_id = c.id
             LEFT JOIN users u ON u.id = cm.sender_id
             WHERE c.key = $1
               AND ($2::timestamptz IS NULL OR cm.sent_at < $2 OR cm.sent_at IS NULL)
             ORDER BY cm.sent_at DESC NULLS LAST, cm.id DESC NULLS LAST
             LIMIT $3`,
            [channelKey, before, limit]
        );

        if (!rows.length) {
            const lookup = await db.query(
                'SELECT id, key, title, description FROM chat_channels WHERE key = $1 LIMIT 1',
                [channelKey]
            );
            if (!lookup.rows.length) return res.status(404).json({ error: 'Channel not found' });
            return res.json({ channel: lookup.rows[0], messages: [] });
        }

        const channel = {
            id: rows[0].channel_id,
            key: rows[0].channel_key,
            title: rows[0].channel_title,
            description: rows[0].channel_description,
        };

        const messages = rows
            .filter((row) => row.id != null)
            .reverse()
            .map((row) => ({
                id: row.id,
                senderId: row.sender_id,
                content: row.content,
                sentAt: row.sent_at,
                sender: row.sender_id ? {
                    id: row.sender_id,
                    username: row.sender_username,
                    avatarUrl: row.sender_avatar_url,
                } : null,
            }));

        res.json({ channel, messages });
    } catch (err) {
        console.error('[CHAT] getChannelMessages:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

async function sendChannelMessage(req, res) {
    const channelKey = trimContent(req.params.channelKey).toLowerCase();
    const trimmed = trimContent(req.body?.content);

    if (!channelKey) return res.status(400).json({ error: 'Invalid channel key' });
    if (!trimmed) return res.status(400).json({ error: 'content is required' });
    if (trimmed.length > MAX_MESSAGE_LENGTH)
        return res.status(400).json({ error: 'Message is too long' });

    try {
        const channelId = channelKey === 'lobby'
            ? await ensureLobbyChannel()
            : null;

        if (!channelId) return res.status(404).json({ error: 'Channel not found' });

        const { rows } = await db.query(
            `INSERT INTO channel_messages (channel_id, sender_id, content)
             VALUES ($1, $2, $3)
             RETURNING id, channel_id, sender_id, content, sent_at`,
            [channelId, req.user.user_id, trimmed]
        );

        await db.query('UPDATE chat_channels SET updated_at = NOW() WHERE id = $1', [channelId]);

        res.status(201).json({ message: rows[0] });
    } catch (err) {
        console.error('[CHAT] sendChannelMessage:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

module.exports = {
    getHubOverview,
    searchUsers,
    getConversation,
    sendMessage,
    markRead,
    unreadCounts,
    getChannelMessages,
    sendChannelMessage,
};
