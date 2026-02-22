const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const JWT_SECRET = 'your-secret-key-change-this';
const ADMIN_EMAIL = 'loling601@gmail.com';
const ADMIN_ID = 'admin';

// Инициализация Firebase Admin
let firebaseInitialized = false;
try {
    const serviceAccount = require('./firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin инициализирован');
} catch (e) {
    console.log('⚠️ Firebase не настроен (пропускаем)');
}

// База данных
const dbPath = path.join(__dirname, 'messenger.db');
const db = new sqlite3.Database(dbPath);

// Создаём таблицы
db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT UNIQUE,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        bio TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        status TEXT DEFAULT 'offline',
        last_seen DATETIME,
        privacy_last_seen TEXT DEFAULT 'everyone',
        privacy_messages TEXT DEFAULT 'everyone',
        privacy_groups TEXT DEFAULT 'everyone',
        theme TEXT DEFAULT 'light',
        accent_color TEXT DEFAULT '#8774e1',
        notification_sound BOOLEAN DEFAULT 1,
        notification_vibrate BOOLEAN DEFAULT 1,
        notification_preview BOOLEAN DEFAULT 1,
        invisible_mode BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица друзей/контактов
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT,
        friend_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, friend_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (friend_id) REFERENCES users(id)
    )`);

    // Таблица сообщений
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT,
        to_id TEXT,
        text TEXT,
        file_data TEXT,
        file_name TEXT,
        file_type TEXT,
        edited BOOLEAN DEFAULT 0,
        reply_to INTEGER,
        forwarded_from TEXT,
        read BOOLEAN DEFAULT 0,
        read_at DATETIME,
        self_destruct BOOLEAN DEFAULT 0,
        self_destruct_time INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_id) REFERENCES users(id),
        FOREIGN KEY (to_id) REFERENCES users(id),
        FOREIGN KEY (reply_to) REFERENCES messages(id)
    )`);

    // Таблица реакций
    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        message_id INTEGER,
        reaction TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (message_id) REFERENCES messages(id),
        UNIQUE(user_id, message_id)
    )`);

    // Таблица закреплённых сообщений
    db.run(`CREATE TABLE IF NOT EXISTS pinned_messages (
        chat_id TEXT,
        message_id INTEGER,
        pinned_by TEXT,
        pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES messages(id),
        FOREIGN KEY (pinned_by) REFERENCES users(id),
        PRIMARY KEY (chat_id, message_id)
    )`);

    // Таблица канала
    db.run(`CREATE TABLE IF NOT EXISTS channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT DEFAULT 'Clock Messenger',
        file_data TEXT,
        file_name TEXT,
        file_type TEXT,
        views INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES users(id)
    )`);

    // Таблица подписчиков канала
    db.run(`CREATE TABLE IF NOT EXISTS channel_subscribers (
        user_id TEXT,
        subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        PRIMARY KEY (user_id)
    )`);

    // Таблица просмотров канала
    db.run(`CREATE TABLE IF NOT EXISTS channel_views (
        user_id TEXT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Таблица комментариев к постам канала
    db.run(`CREATE TABLE IF NOT EXISTS channel_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        user_id TEXT,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES channel_messages(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Таблица сохранённых сообщений
    db.run(`CREATE TABLE IF NOT EXISTS saved_messages (
        user_id TEXT,
        message_id INTEGER,
        saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (message_id) REFERENCES messages(id),
        PRIMARY KEY (user_id, message_id)
    )`);

    // Таблица групп
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT,
        welcome_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
    )`);

    // Таблица участников групп
    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT,
        user_id TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        role TEXT DEFAULT 'member',
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Таблица голосований в группах
    db.run(`CREATE TABLE IF NOT EXISTS group_polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT,
        created_by TEXT,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        multiple BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
    )`);

    // Таблица ответов на голосования
    db.run(`CREATE TABLE IF NOT EXISTS poll_votes (
        poll_id INTEGER,
        user_id TEXT,
        option_index INTEGER,
        voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (poll_id, user_id),
        FOREIGN KEY (poll_id) REFERENCES group_polls(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Таблица закреплённых контактов
    db.run(`CREATE TABLE IF NOT EXISTS pinned_contacts (
        user_id TEXT,
        contact_id TEXT,
        pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, contact_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (contact_id) REFERENCES users(id)
    )`);

    // Таблица заблокированных пользователей
    db.run(`CREATE TABLE IF NOT EXISTS blocked_users (
        user_id TEXT,
        blocked_id TEXT,
        blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, blocked_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (blocked_id) REFERENCES users(id)
    )`);

    // Таблица FCM токенов
    db.run(`CREATE TABLE IF NOT EXISTS fcm_tokens (
        user_id TEXT,
        token TEXT UNIQUE,
        device TEXT DEFAULT 'android',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        PRIMARY KEY (user_id, token)
    )`);

    // Таблица стикеров
    db.run(`CREATE TABLE IF NOT EXISTS stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        image_url TEXT NOT NULL,
        pack_name TEXT,
        animated BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица историй
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        image_url TEXT,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME DEFAULT (datetime('now', '+24 hours')),
        views INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Таблица просмотров историй
    db.run(`CREATE TABLE IF NOT EXISTS story_views (
        story_id INTEGER,
        user_id TEXT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reaction TEXT,
        PRIMARY KEY (story_id, user_id),
        FOREIGN KEY (story_id) REFERENCES stories(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Таблица ботов
    db.run(`CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        owner_id TEXT,
        webhook_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
    )`);

    // Создаём админа
    bcrypt.hash('050506fyu', 10, (err, hash) => {
        if (err) throw err;
        
        db.run(`INSERT OR IGNORE INTO users (id, name, email, username, password_hash, bio) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [ADMIN_ID, 'Администратор', ADMIN_EMAIL, 'admin', hash, 'Создатель Clock Messenger'],
            function(err) {
                if (!err && this.changes) {
                    console.log('✅ Администратор создан');
                    db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [ADMIN_ID]);
                }
            }
        );
    });
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Хранилище активных WebSocket соединений
const clients = new Map();

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

// Получить список друзей
function getFriendsList(userId, callback) {
    db.all(`SELECT u.*, f.status as friend_status 
            FROM users u
            JOIN friends f ON (f.friend_id = u.id OR f.user_id = u.id)
            WHERE (f.user_id = ? OR f.friend_id = ?) 
            AND f.status = 'accepted' AND u.id != ?`,
        [userId, userId, userId], (err, friends) => {
            if (err) {
                console.error('Ошибка получения друзей:', err);
                callback([]);
                return;
            }
            callback(friends || []);
        });
}

// Получить заблокированных пользователей
function getBlockedUsers(userId, callback) {
    db.all(`SELECT blocked_id FROM blocked_users WHERE user_id = ?`, [userId], (err, blocked) => {
        if (err) {
            console.error('Ошибка получения заблокированных:', err);
            callback([]);
            return;
        }
        callback(blocked.map(b => b.blocked_id));
    });
}

// Получить закреплённые контакты
function getPinnedContacts(userId, callback) {
    db.all(`SELECT contact_id FROM pinned_contacts WHERE user_id = ?`, [userId], (err, pinned) => {
        if (err) {
            console.error('Ошибка получения закреплённых:', err);
            callback([]);
            return;
        }
        callback(pinned.map(p => p.contact_id));
    });
}

// Получить группы пользователя
function getUserGroups(userId, callback) {
    db.all(`SELECT g.* FROM groups g
            JOIN group_members gm ON gm.group_id = g.id
            WHERE gm.user_id = ?`, [userId], (err, groups) => {
        if (err) {
            console.error('Ошибка получения групп:', err);
            callback([]);
            return;
        }
        callback(groups || []);
    });
}

// Получить участников группы
function getGroupMembers(groupId, callback) {
    db.all(`SELECT user_id FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
        if (err) {
            console.error('Ошибка получения участников группы:', err);
            callback([]);
            return;
        }
        callback(members.map(m => m.user_id));
    });
}

// Получить подписчиков канала
function getChannelSubscribers(callback) {
    db.all(`SELECT user_id FROM channel_subscribers`, [], (err, subscribers) => {
        if (err) {
            callback([]);
            return;
        }
        callback(subscribers.map(s => s.user_id));
    });
}

// Отправка PUSH-уведомления
async function sendPushNotification(userId, title, body, data = {}) {
    if (!firebaseInitialized) return false;
    
    return new Promise((resolve) => {
        db.all(`SELECT token FROM fcm_tokens WHERE user_id = ?`, [userId], (err, tokens) => {
            if (err || !tokens || tokens.length === 0) {
                resolve(false);
                return;
            }
            
            const message = {
                notification: { 
                    title, 
                    body,
                    sound: 'default',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                },
                data: {
                    ...data,
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                },
                tokens: tokens.map(t => t.token)
            };
            
            admin.messaging().sendEachForMulticast(message)
                .then(response => {
                    console.log(`✅ Уведомление отправлено ${response.successCount} устройствам`);
                    resolve(true);
                })
                .catch(error => {
                    console.error('❌ Ошибка отправки:', error);
                    resolve(false);
                });
        });
    });
}

// Проверка самоуничтожающихся сообщений
setInterval(() => {
    db.run(`DELETE FROM messages WHERE self_destruct = 1 AND 
            datetime(timestamp, '+' || self_destruct_time || ' seconds') < datetime('now')`);
}, 60000); // Проверка каждую минуту

// ========== HTTP ЭНДПОИНТЫ ==========

// Регистрация
app.post('/api/register', async (req, res) => {
    const { email, username, password, name, bio, phone } = req.body;
    
    if (!email || !username || !password) {
        return res.status(400).json({ error: 'Email, username и password обязательны' });
    }
    
    const userId = username.toLowerCase();
    
    bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ error: 'Ошибка хеширования' });
        
        db.run(`INSERT INTO users (id, name, email, username, password_hash, bio) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, name || username, email, username, hash, bio || ''],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Email или username уже заняты' });
                    }
                    return res.status(500).json({ error: 'Ошибка базы данных' });
                }
                
                const token = jwt.sign({ userId, username }, JWT_SECRET);
                
                // Подписываем на канал
                db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [userId]);
                
                res.json({ 
                    success: true, 
                    token,
                    user: { id: userId, username, email, name: name || username, bio: bio || '' }
                });
            }
        );
    });
});

// Вход
app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    
    if (!login || !password) {
        return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }
    
    db.get(`SELECT * FROM users WHERE email = ? OR phone = ? OR username = ? OR id = ?`,
        [login, login, login, login], (err, user) => {
            if (err || !user) {
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }
            
            bcrypt.compare(password, user.password_hash, (err, isValid) => {
                if (!isValid) {
                    return res.status(401).json({ error: 'Неверный логин или пароль' });
                }
                
                const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
                
                // Обновляем last_seen
                db.run(`UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
                
                res.json({
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        name: user.name,
                        email: user.email,
                        bio: user.bio,
                        avatar: user.avatar,
                        theme: user.theme,
                        accent_color: user.accent_color,
                        privacy_last_seen: user.privacy_last_seen,
                        privacy_messages: user.privacy_messages,
                        privacy_groups: user.privacy_groups,
                        notification_sound: user.notification_sound,
                        notification_vibrate: user.notification_vibrate,
                        notification_preview: user.notification_preview,
                        invisible_mode: user.invisible_mode
                    }
                });
            });
        }
    );
});

// Получить подписчиков канала
app.get('/api/channel/stats', (req, res) => {
    db.get(`SELECT COUNT(*) as subscribers FROM channel_subscribers`, (err, subResult) => {
        db.get(`SELECT COUNT(*) as views FROM channel_views`, (err, viewsResult) => {
            res.json({
                subscribers: subResult?.subscribers || 0,
                views: viewsResult?.views || 0
            });
        });
    });
});

// Получить все стикеры
app.get('/api/stickers', (req, res) => {
    db.all(`SELECT * FROM stickers`, [], (err, stickers) => {
        res.json(stickers || []);
    });
});

// Получить активные истории
app.get('/api/stories', (req, res) => {
    db.all(`SELECT s.*, u.name as user_name, u.avatar as user_avatar,
            (SELECT COUNT(*) FROM story_views WHERE story_id = s.id) as views_count
            FROM stories s
            JOIN users u ON u.id = s.user_id
            WHERE expires_at > datetime('now')
            ORDER BY created_at DESC`, [], (err, stories) => {
        res.json(stories || []);
    });
});

// ========== WEBSOCKET ==========

wss.on('connection', (ws) => {
    console.log('✅ Новый WebSocket клиент');
    let currentUser = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Получено:', data.type);

            switch (data.type) {
                case 'auth':
                    const { token } = data;
                    
                    try {
                        const decoded = jwt.verify(token, JWT_SECRET);
                        currentUser = decoded;
                        
                        clients.set(currentUser.userId, ws);
                        
                        // Обновляем статус и last_seen (если не невидимка)
                        db.get(`SELECT invisible_mode FROM users WHERE id = ?`, [currentUser.userId], (err, user) => {
                            if (!err && user && !user.invisible_mode) {
                                db.run(`UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [currentUser.userId]);
                            }
                        });
                        
                        // Получаем все данные пользователя
                        Promise.all([
                            new Promise(resolve => getFriendsList(currentUser.userId, resolve)),
                            new Promise(resolve => getBlockedUsers(currentUser.userId, resolve)),
                            new Promise(resolve => getPinnedContacts(currentUser.userId, resolve)),
                            new Promise(resolve => getUserGroups(currentUser.userId, resolve))
                        ]).then(([friends, blocked, pinned, groups]) => {
                            ws.send(JSON.stringify({
                                type: 'auth_success',
                                user: currentUser,
                                contacts: friends,
                                blocked: blocked,
                                pinnedContacts: pinned,
                                groups: groups
                            }));
                        });
                        
                        // Подписываем на канал
                        db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [currentUser.userId]);
                        
                        // Отправляем последние сообщения канала
                        db.all(`SELECT * FROM channel_messages ORDER BY created_at ASC`, [], (err, messages) => {
                            if (messages) {
                                messages.forEach(msg => {
                                    ws.send(JSON.stringify({
                                        type: 'channel_message',
                                        content: msg.content,
                                        author: 'Clock Messenger',
                                        timestamp: msg.created_at,
                                        fileData: msg.file_data,
                                        fileName: msg.file_name,
                                        fileType: msg.file_type,
                                        messageId: msg.id,
                                        views: msg.views
                                    }));
                                });
                            }
                        });
                        
                    } catch (e) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный токен' }));
                    }
                    break;

                case 'register_fcm':
                    if (!currentUser) break;
                    
                    const { token: fcmToken, device } = data;
                    
                    db.run(`INSERT OR REPLACE INTO fcm_tokens (user_id, token, device) VALUES (?, ?, ?)`,
                        [currentUser.userId, fcmToken, device || 'android']);
                    break;

                case 'message':
                    if (!currentUser) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                        break;
                    }
                    
                    const { to, text, replyTo, selfDestruct, selfDestructTime } = data;
                    
                    db.run(`INSERT INTO messages (from_id, to_id, text, reply_to, self_destruct, self_destruct_time) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [currentUser.userId, to, text, replyTo, selfDestruct || false, selfDestructTime || 0],
                        function(err) {
                            if (!err) {
                                const messageId = this.lastID;
                                
                                db.get(`SELECT * FROM messages WHERE id = ?`, [messageId], (err, message) => {
                                    if (message) {
                                        const targetSocket = clients.get(to);
                                        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                            targetSocket.send(JSON.stringify({
                                                type: 'message',
                                                from: currentUser.userId,
                                                fromName: currentUser.username,
                                                text: text,
                                                timestamp: message.timestamp,
                                                messageId: messageId,
                                                replyTo: replyTo,
                                                selfDestruct: selfDestruct
                                            }));
                                        } else {
                                            // Отправляем PUSH-уведомление
                                            sendPushNotification(
                                                to,
                                                currentUser.username,
                                                text.length > 50 ? text.substring(0, 50) + '...' : text,
                                                { 
                                                    chatId: currentUser.userId, 
                                                    messageId: messageId.toString(),
                                                    type: 'message'
                                                }
                                            );
                                        }
                                    }
                                });
                            }
                        }
                    );
                    break;

                case 'file_message':
                    if (!currentUser) break;
                    
                    const { to: fileTo, fileName, fileType, fileData } = data;
                    
                    db.run(`INSERT INTO messages (from_id, to_id, file_data, file_name, file_type) VALUES (?, ?, ?, ?, ?)`,
                        [currentUser.userId, fileTo, fileData, fileName, fileType],
                        function(err) {
                            if (!err) {
                                const messageId = this.lastID;
                                const targetSocket = clients.get(fileTo);
                                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                    targetSocket.send(JSON.stringify({
                                        type: 'file_message',
                                        from: currentUser.userId,
                                        fromName: currentUser.username,
                                        fileName: fileName,
                                        fileType: fileType,
                                        fileData: fileData,
                                        timestamp: new Date().toISOString(),
                                        messageId: messageId
                                    }));
                                } else {
                                    sendPushNotification(
                                        fileTo,
                                        currentUser.username,
                                        '📎 Отправил(а) файл',
                                        { chatId: currentUser.userId, type: 'file' }
                                    );
                                }
                            }
                        }
                    );
                    break;

                case 'channel_message':
                    if (!currentUser) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                        break;
                    }
                    
                    if (currentUser.userId !== ADMIN_ID) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Только администратор может писать в канал' }));
                        break;
                    }
                    
                    const { content, fileData: channelFile, fileName: channelFileName, fileType: channelFileType } = data;
                    
                    db.run(`INSERT INTO channel_messages (content, author_id, author_name, file_data, file_name, file_type) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [content || '', currentUser.userId, 'Clock Messenger', channelFile, channelFileName, channelFileType],
                        function(err) {
                            if (err) {
                                console.error('❌ Ошибка сохранения в канал:', err);
                                return;
                            }
                            
                            const messageId = this.lastID;
                            
                            const message = {
                                type: 'channel_message',
                                content: content,
                                author: 'Clock Messenger',
                                timestamp: new Date().toISOString(),
                                messageId: messageId
                            };
                            
                            if (channelFile) {
                                message.fileData = channelFile;
                                message.fileName = channelFileName;
                                message.fileType = channelFileType;
                            }
                            
                            // Рассылаем всем подписчикам
                            getChannelSubscribers((subscribers) => {
                                subscribers.forEach(userId => {
                                    const subscriberWs = clients.get(userId);
                                    if (subscriberWs && subscriberWs.readyState === WebSocket.OPEN) {
                                        subscriberWs.send(JSON.stringify(message));
                                    } else {
                                        sendPushNotification(
                                            userId,
                                            'Clock Messenger',
                                            content || '📢 Новый пост в канале',
                                            { type: 'channel', messageId: messageId.toString() }
                                        );
                                    }
                                });
                            });
                            
                            ws.send(JSON.stringify({
                                type: 'channel_message_sent',
                                messageId: messageId,
                                content: content
                            }));
                        }
                    );
                    break;

                case 'channel_comment':
                    if (!currentUser) break;
                    
                    const { messageId: channelMessageId, commentText } = data;
                    
                    db.run(`INSERT INTO channel_comments (message_id, user_id, text) VALUES (?, ?, ?)`,
                        [channelMessageId, currentUser.userId, commentText], function(err) {
                            if (!err) {
                                const commentId = this.lastID;
                                
                                // Уведомляем админа
                                if (currentUser.userId !== ADMIN_ID) {
                                    sendPushNotification(
                                        ADMIN_ID,
                                        currentUser.username,
                                        `💬 Комментарий: ${commentText.substring(0, 30)}...`,
                                        { type: 'channel_comment', messageId: channelMessageId.toString() }
                                    );
                                }
                                
                                ws.send(JSON.stringify({
                                    type: 'comment_added',
                                    commentId: commentId,
                                    messageId: channelMessageId,
                                    text: commentText,
                                    userId: currentUser.userId,
                                    username: currentUser.username,
                                    timestamp: new Date().toISOString()
                                }));
                            }
                        });
                    break;

                case 'add_friend':
                    if (!currentUser) break;
                    
                    const { friendId } = data;
                    
                    db.get(`SELECT id, name, username FROM users WHERE id = ? OR username = ?`, 
                        [friendId, friendId], (err, friend) => {
                            if (!friend) {
                                ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
                                return;
                            }
                            
                            db.run(`INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')`,
                                [currentUser.userId, friend.id], (err) => {
                                    if (err) {
                                        ws.send(JSON.stringify({ type: 'error', message: 'Заявка уже существует' }));
                                        return;
                                    }
                                    
                                    const friendWs = clients.get(friend.id);
                                    if (friendWs) {
                                        friendWs.send(JSON.stringify({
                                            type: 'friend_request',
                                            from: currentUser.userId,
                                            fromName: currentUser.username
                                        }));
                                    } else {
                                        sendPushNotification(
                                            friend.id,
                                            currentUser.username,
                                            'Хочет добавить вас в друзья',
                                            { type: 'friend_request', from: currentUser.userId }
                                        );
                                    }
                                    
                                    ws.send(JSON.stringify({ 
                                        type: 'friend_request_sent', 
                                        to: friend.id 
                                    }));
                                });
                        });
                    break;

                case 'accept_friend':
                    if (!currentUser) break;
                    
                    const { requesterId } = data;
                    
                    db.run(`UPDATE friends SET status = 'accepted' 
                            WHERE user_id = ? AND friend_id = ?`,
                        [requesterId, currentUser.userId], function(err) {
                            if (!err) {
                                getFriendsList(currentUser.userId, (contacts) => {
                                    ws.send(JSON.stringify({ 
                                        type: 'friends_list', 
                                        friends: contacts 
                                    }));
                                });
                                
                                const requesterWs = clients.get(requesterId);
                                if (requesterWs) {
                                    getFriendsList(requesterId, (contacts) => {
                                        requesterWs.send(JSON.stringify({ 
                                            type: 'friends_list', 
                                            friends: contacts 
                                        }));
                                    });
                                    
                                    requesterWs.send(JSON.stringify({
                                        type: 'friend_request_accepted',
                                        by: currentUser.userId,
                                        message: `Пользователь ${currentUser.username} принял вашу заявку`
                                    }));
                                } else {
                                    sendPushNotification(
                                        requesterId,
                                        currentUser.username,
                                        'Принял(а) вашу заявку в друзья',
                                        { type: 'friend_accepted' }
                                    );
                                }
                            }
                        });
                    break;

                case 'decline_friend':
                    if (!currentUser) break;
                    
                    const { requesterId: declineId } = data;
                    
                    db.run(`DELETE FROM friends WHERE user_id = ? AND friend_id = ?`,
                        [declineId, currentUser.userId]);
                    break;

                case 'delete_friend':
                    if (!currentUser) break;
                    
                    const { friendId: deleteId } = data;
                    
                    db.run(`DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
                        [currentUser.userId, deleteId, deleteId, currentUser.userId]);
                    
                    getFriendsList(currentUser.userId, (contacts) => {
                        ws.send(JSON.stringify({ type: 'friends_list', friends: contacts }));
                    });
                    
                    const deletedFriendWs = clients.get(deleteId);
                    if (deletedFriendWs) {
                        getFriendsList(deleteId, (contacts) => {
                            deletedFriendWs.send(JSON.stringify({ type: 'friends_list', friends: contacts }));
                        });
                    }
                    break;

                case 'block_user':
                    if (!currentUser) break;
                    
                    const { blockedId } = data;
                    
                    db.run(`INSERT OR IGNORE INTO blocked_users (user_id, blocked_id) VALUES (?, ?)`,
                        [currentUser.userId, blockedId]);
                    
                    db.run(`DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
                        [currentUser.userId, blockedId, blockedId, currentUser.userId]);
                    
                    getBlockedUsers(currentUser.userId, (blocked) => {
                        ws.send(JSON.stringify({ type: 'blocked_list', blocked: blocked }));
                    });
                    break;

                case 'unblock_user':
                    if (!currentUser) break;
                    
                    const { unblockedId } = data;
                    
                    db.run(`DELETE FROM blocked_users WHERE user_id = ? AND blocked_id = ?`,
                        [currentUser.userId, unblockedId]);
                    
                    getBlockedUsers(currentUser.userId, (blocked) => {
                        ws.send(JSON.stringify({ type: 'blocked_list', blocked: blocked }));
                    });
                    break;

                case 'pin_contact':
                    if (!currentUser) break;
                    
                    const { contactId } = data;
                    
                    db.run(`INSERT OR IGNORE INTO pinned_contacts (user_id, contact_id) VALUES (?, ?)`,
                        [currentUser.userId, contactId]);
                    
                    getPinnedContacts(currentUser.userId, (pinned) => {
                        ws.send(JSON.stringify({ type: 'pinned_contacts', pinned: pinned }));
                    });
                    break;

                case 'unpin_contact':
                    if (!currentUser) break;
                    
                    const { unpinId } = data;
                    
                    db.run(`DELETE FROM pinned_contacts WHERE user_id = ? AND contact_id = ?`,
                        [currentUser.userId, unpinId]);
                    
                    getPinnedContacts(currentUser.userId, (pinned) => {
                        ws.send(JSON.stringify({ type: 'pinned_contacts', pinned: pinned }));
                    });
                    break;

                case 'clear_chat':
                    if (!currentUser) break;
                    
                    const { chatId: clearChatId } = data;
                    
                    db.run(`DELETE FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`,
                        [currentUser.userId, clearChatId, clearChatId, currentUser.userId], function(err) {
                            if (!err) {
                                const targetSocket = clients.get(clearChatId);
                                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                    targetSocket.send(JSON.stringify({
                                        type: 'chat_cleared',
                                        chatId: clearChatId,
                                        by: currentUser.userId
                                    }));
                                }
                                
                                ws.send(JSON.stringify({
                                    type: 'chat_cleared',
                                    chatId: clearChatId,
                                    by: currentUser.userId
                                }));
                            }
                        });
                    break;

                case 'clear_channel':
                    if (!currentUser || currentUser.userId !== ADMIN_ID) break;
                    
                    db.run(`DELETE FROM channel_messages`, function(err) {
                        if (!err) {
                            clients.forEach((client, userId) => {
                                if (client && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'channel_cleared'
                                    }));
                                }
                            });
                        }
                    });
                    break;

                case 'update_profile':
                    if (!currentUser) break;
                    
                    const { name, bio, avatar, theme, accent_color, privacy_last_seen, privacy_messages, privacy_groups, notification_sound, notification_vibrate, notification_preview, invisible_mode } = data;
                    
                    db.run(`UPDATE users SET name = ?, bio = ?, avatar = ?, theme = ?, accent_color = ?, 
                            privacy_last_seen = ?, privacy_messages = ?, privacy_groups = ?,
                            notification_sound = ?, notification_vibrate = ?, notification_preview = ?,
                            invisible_mode = ?
                            WHERE id = ?`,
                        [name, bio, avatar, theme, accent_color, privacy_last_seen, privacy_messages, privacy_groups,
                         notification_sound, notification_vibrate, notification_preview, invisible_mode, currentUser.userId]);
                    break;

                case 'get_channel_stats':
                    db.get(`SELECT COUNT(*) as subscribers FROM channel_subscribers`, (err, subResult) => {
                        db.get(`SELECT COUNT(*) as views FROM channel_views`, (err, viewsResult) => {
                            ws.send(JSON.stringify({
                                type: 'channel_stats',
                                subscribers: subResult?.subscribers || 0,
                                views: viewsResult?.views || 0
                            }));
                        });
                    });
                    break;

                case 'channel_view':
                    if (currentUser) {
                        db.run(`INSERT OR IGNORE INTO channel_views (user_id) VALUES (?)`, [currentUser.userId]);
                        db.run(`UPDATE channel_messages SET views = views + 1 WHERE id IN (SELECT id FROM channel_messages ORDER BY id DESC LIMIT 10)`);
                    }
                    break;

                case 'create_group':
                    if (!currentUser) break;
                    
                    const { group } = data;
                    
                    db.serialize(() => {
                        db.run(`INSERT INTO groups (id, name, description, created_by, welcome_message) VALUES (?, ?, ?, ?, ?)`,
                            [group.id, group.name, group.description, currentUser.userId, group.welcomeMessage || '']);
                        
                        db.run(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'creator')`,
                            [group.id, currentUser.userId]);
                        
                        ws.send(JSON.stringify({
                            type: 'group_created',
                            group: { ...group, members: [currentUser.userId] }
                        }));
                    });
                    break;

                case 'add_to_group':
                    if (!currentUser) break;
                    
                    const { groupId, members } = data;
                    
                    members.forEach(memberId => {
                        db.run(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`,
                            [groupId, memberId], function(err) {
                                if (!err) {
                                    const memberWs = clients.get(memberId);
                                    if (memberWs) {
                                        db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err, group) => {
                                            if (group) {
                                                memberWs.send(JSON.stringify({
                                                    type: 'group_created',
                                                    group: group
                                                }));
                                            }
                                        });
                                    } else {
                                        db.get(`SELECT name FROM groups WHERE id = ?`, [groupId], (err, group) => {
                                            if (group) {
                                                sendPushNotification(
                                                    memberId,
                                                    currentUser.username,
                                                    `Добавил(а) вас в группу "${group.name}"`,
                                                    { type: 'group_added', groupId: groupId }
                                                );
                                            }
                                        });
                                    }
                                }
                            });
                    });
                    
                    getGroupMembers(groupId, (membersList) => {
                        ws.send(JSON.stringify({
                            type: 'group_members_updated',
                            groupId: groupId,
                            count: membersList.length
                        }));
                    });
                    break;

                case 'kick_from_group':
                    if (!currentUser) break;
                    
                    const { groupId: kickGroupId, memberId } = data;
                    
                    db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`,
                        [kickGroupId, memberId]);
                    
                    const kickedWs = clients.get(memberId);
                    if (kickedWs) {
                        kickedWs.send(JSON.stringify({
                            type: 'member_kicked',
                            groupId: kickGroupId,
                            memberId: memberId
                        }));
                    } else {
                        sendPushNotification(
                            memberId,
                            currentUser.username,
                            'Вас исключили из группы',
                            { type: 'group_kicked', groupId: kickGroupId }
                        );
                    }
                    
                    getGroupMembers(kickGroupId, (membersList) => {
                        ws.send(JSON.stringify({
                            type: 'group_members_updated',
                            groupId: kickGroupId,
                            count: membersList.length
                        }));
                    });
                    break;

                case 'delete_group':
                    if (!currentUser) break;
                    
                    const { groupId: deleteGroupId } = data;
                    
                    db.run(`DELETE FROM group_members WHERE group_id = ?`, [deleteGroupId]);
                    db.run(`DELETE FROM groups WHERE id = ?`, [deleteGroupId]);
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'group_deleted',
                                groupId: deleteGroupId
                            }));
                        } else {
                            sendPushNotification(
                                userId,
                                'Система',
                                'Группа была удалена',
                                { type: 'group_deleted', groupId: deleteGroupId }
                            );
                        }
                    });
                    break;

                case 'leave_group':
                    if (!currentUser) break;
                    
                    const { groupId: leaveGroupId } = data;
                    
                    db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`,
                        [leaveGroupId, currentUser.userId]);
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN && userId !== currentUser.userId) {
                            client.send(JSON.stringify({
                                type: 'member_kicked',
                                groupId: leaveGroupId,
                                memberId: currentUser.userId
                            }));
                        }
                    });
                    break;

                case 'create_poll':
                    if (!currentUser) break;
                    
                    const { pollGroupId, question, options, multiple } = data;
                    
                    db.run(`INSERT INTO group_polls (group_id, created_by, question, options, multiple) 
                            VALUES (?, ?, ?, ?, ?)`,
                        [pollGroupId, currentUser.userId, question, JSON.stringify(options), multiple || false],
                        function(err) {
                            if (!err) {
                                const pollId = this.lastID;
                                
                                getGroupMembers(pollGroupId, (members) => {
                                    members.forEach(memberId => {
                                        const memberWs = clients.get(memberId);
                                        const pollData = {
                                            type: 'new_poll',
                                            pollId: pollId,
                                            groupId: pollGroupId,
                                            question: question,
                                            options: options,
                                            multiple: multiple,
                                            createdBy: currentUser.userId
                                        };
                                        
                                        if (memberWs && memberWs.readyState === WebSocket.OPEN) {
                                            memberWs.send(JSON.stringify(pollData));
                                        } else if (memberId !== currentUser.userId) {
                                            sendPushNotification(
                                                memberId,
                                                currentUser.username,
                                                `Новый опрос в группе: ${question}`,
                                                { type: 'new_poll', pollId: pollId.toString() }
                                            );
                                        }
                                    });
                                });
                            }
                        });
                    break;

                case 'vote_poll':
                    if (!currentUser) break;
                    
                    const { pollId, optionIndex } = data;
                    
                    db.run(`INSERT OR REPLACE INTO poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)`,
                        [pollId, currentUser.userId, optionIndex]);
                    break;

                case 'reaction':
                    if (!currentUser) break;
                    
                    const { chatId: reactionChatId, messageId: reactionMessageId, reaction: reactionEmoji, remove } = data;
                    
                    if (remove) {
                        db.run(`DELETE FROM reactions WHERE user_id = ? AND message_id = ?`,
                            [currentUser.userId, reactionMessageId]);
                    } else {
                        db.run(`INSERT OR REPLACE INTO reactions (user_id, message_id, reaction) VALUES (?, ?, ?)`,
                            [currentUser.userId, reactionMessageId, reactionEmoji]);
                    }
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'reaction',
                                chatId: reactionChatId,
                                messageId: reactionMessageId,
                                reaction: reactionEmoji,
                                userId: currentUser.userId,
                                remove: remove
                            }));
                        }
                    });
                    break;

                case 'pin_message':
                    if (!currentUser) break;
                    
                    const { chatId: pinChatId, message: pinMessage } = data;
                    
                    db.run(`INSERT OR REPLACE INTO pinned_messages (chat_id, message_id, pinned_by) VALUES (?, ?, ?)`,
                        [pinChatId, pinMessage.id, currentUser.userId]);
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'pin_message',
                                chatId: pinChatId,
                                message: pinMessage
                            }));
                        }
                    });
                    break;

                case 'unpin_message':
                    if (!currentUser) break;
                    
                    const { chatId: unpinChatId } = data;
                    
                    db.run(`DELETE FROM pinned_messages WHERE chat_id = ?`, [unpinChatId]);
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'unpin_message',
                                chatId: unpinChatId
                            }));
                        }
                    });
                    break;

                case 'edit_message':
                    if (!currentUser) break;
                    
                    const { chatId: editChatId, messageId: editMessageId, text: newText } = data;
                    
                    db.run(`UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND from_id = ?`,
                        [newText, editMessageId, currentUser.userId]);
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'edit_message',
                                chatId: editChatId,
                                messageId: editMessageId,
                                text: newText
                            }));
                        }
                    });
                    break;

                case 'delete_message':
                    if (!currentUser) break;
                    
                    const { chatId: deleteChatId, messageId: deleteMessageId, forEveryone } = data;
                    
                    if (forEveryone) {
                        db.run(`DELETE FROM messages WHERE id = ?`, [deleteMessageId]);
                    }
                    
                    clients.forEach((client, userId) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'delete_message',
                                chatId: deleteChatId,
                                messageId: deleteMessageId
                            }));
                        }
                    });
                    break;

                case 'typing':
                    if (!currentUser) break;
                    
                    const { chatId: typingChatId } = data;
                    
                    const targetSocket = clients.get(typingChatId);
                    if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                        targetSocket.send(JSON.stringify({
                            type: 'typing',
                            chatId: currentUser.userId,
                            userId: currentUser.userId
                        }));
                    }
                    break;

                case 'save_message':
                    if (!currentUser) break;
                    
                    const { messageId: saveMessageId } = data;
                    
                    db.run(`INSERT OR IGNORE INTO saved_messages (user_id, message_id) VALUES (?, ?)`,
                        [currentUser.userId, saveMessageId]);
                    break;

                case 'mark_read':
                    if (!currentUser) break;
                    
                    const { chatId: readChatId, messageId: readMessageId } = data;
                    
                    db.run(`UPDATE messages SET read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ?`, [readMessageId]);
                    
                    const readTargetSocket = clients.get(readChatId);
                    if (readTargetSocket && readTargetSocket.readyState === WebSocket.OPEN) {
                        readTargetSocket.send(JSON.stringify({
                            type: 'message_read',
                            chatId: currentUser.userId,
                            messageId: readMessageId
                        }));
                    }
                    break;

                case 'create_story':
                    if (!currentUser) break;
                    
                    const { storyImage, storyText } = data;
                    
                    db.run(`INSERT INTO stories (user_id, image_url, text) VALUES (?, ?, ?)`,
                        [currentUser.userId, storyImage, storyText], function(err) {
                            if (!err) {
                                const storyId = this.lastID;
                                
                                getFriendsList(currentUser.userId, (friends) => {
                                    friends.forEach(friend => {
                                        const friendWs = clients.get(friend.id);
                                        if (friendWs && friendWs.readyState === WebSocket.OPEN) {
                                            friendWs.send(JSON.stringify({
                                                type: 'new_story',
                                                storyId: storyId,
                                                userId: currentUser.userId,
                                                userName: currentUser.username,
                                                imageUrl: storyImage,
                                                text: storyText
                                            }));
                                        } else {
                                            sendPushNotification(
                                                friend.id,
                                                currentUser.username,
                                                '📸 Опубликовал(а) новую историю',
                                                { type: 'new_story', storyId: storyId.toString() }
                                            );
                                        }
                                    });
                                });
                            }
                        });
                    break;

                case 'view_story':
                    if (!currentUser) break;
                    
                    const { storyId: viewStoryId, reaction: storyReaction } = data;
                    
                    db.run(`INSERT OR IGNORE INTO story_views (story_id, user_id, reaction) VALUES (?, ?, ?)`,
                        [viewStoryId, currentUser.userId, storyReaction]);
                    break;

                case 'get_stickers':
                    db.all(`SELECT * FROM stickers`, [], (err, stickers) => {
                        ws.send(JSON.stringify({ type: 'stickers_list', stickers: stickers || [] }));
                    });
                    break;

                case 'search_messages':
                    if (!currentUser) break;
                    
                    const { searchQuery, searchFrom, searchDate } = data;
                    
                    let query = `SELECT m.*, u.name as from_name 
                                 FROM messages m
                                 JOIN users u ON u.id = m.from_id
                                 WHERE (m.from_id = ? OR m.to_id = ?)`;
                    let params = [currentUser.userId, currentUser.userId];
                    
                    if (searchQuery) {
                        query += ` AND m.text LIKE ?`;
                        params.push(`%${searchQuery}%`);
                    }
                    if (searchFrom) {
                        query += ` AND m.from_id = ?`;
                        params.push(searchFrom);
                    }
                    if (searchDate) {
                        query += ` AND date(m.timestamp) = date(?)`;
                        params.push(searchDate);
                    }
                    
                    query += ` ORDER BY m.timestamp DESC LIMIT 100`;
                    
                    db.all(query, params, (err, messages) => {
                        ws.send(JSON.stringify({ type: 'search_results', messages: messages || [] }));
                    });
                    break;

                case 'create_bot':
                    if (!currentUser || currentUser.userId !== ADMIN_ID) break;
                    
                    const { botName, botToken, webhookUrl } = data;
                    
                    const botId = 'bot_' + Date.now();
                    
                    db.run(`INSERT INTO bots (id, name, token, owner_id, webhook_url) VALUES (?, ?, ?, ?, ?)`,
                        [botId, botName, botToken, currentUser.userId, webhookUrl]);
                    break;

                case 'bot_message':
                    const { botId, chatId, botText } = data;
                    
                    db.get(`SELECT * FROM bots WHERE id = ?`, [botId], (err, bot) => {
                        if (bot && bot.webhook_url) {
                            axios.post(bot.webhook_url, {
                                message: botText,
                                from: botId,
                                to: chatId,
                                timestamp: new Date().toISOString()
                            }).catch(e => console.log('Webhook error:', e));
                        }
                    });
                    break;
            }
        } catch (e) {
            console.log('❌ Ошибка:', e);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            clients.delete(currentUser.userId);
            
            // Обновляем статус (если не невидимка)
            db.get(`SELECT invisible_mode FROM users WHERE id = ?`, [currentUser.userId], (err, user) => {
                if (!err && user && !user.invisible_mode) {
                    db.run(`UPDATE users SET status = 'offline', last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [currentUser.userId]);
                }
            });
            
            console.log(`👋 ${currentUser.username} отключился`);
        }
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, HOST, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📝 Регистрация: https://my-messenger-xiic.onrender.com/api/register`);
    console.log(`🔑 Вход: https://my-messenger-xiic.onrender.com/api/login`);
});
