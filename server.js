const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const JWT_SECRET = 'your-secret-key-change-this';
const ADMIN_EMAIL = 'loling601@gmail.com';
const ADMIN_ID = 'admin';

// База данных
const dbPath = path.join(__dirname, 'messenger.db');
const db = new sqlite3.Database(dbPath);

// Создаём таблицы
db.serialize(() => {
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT,
        friend_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, friend_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (friend_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT,
        to_id TEXT,
        text TEXT,
        file_data TEXT,
        file_name TEXT,
        file_type TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_id) REFERENCES users(id),
        FOREIGN KEY (to_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT DEFAULT 'Clock Messenger',
        file_data TEXT,
        file_name TEXT,
        file_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS channel_subscribers (
        user_id TEXT,
        subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        PRIMARY KEY (user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS channel_views (
        user_id TEXT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
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

// Вспомогательная функция для получения списка друзей
function getFriendsList(userId, callback) {
    db.all(`SELECT u.* FROM users u
            JOIN friends f ON (f.friend_id = u.id OR f.user_id = u.id)
            WHERE (f.user_id = ? OR f.friend_id = ?) 
            AND f.status = 'accepted' AND u.id != ?`,
        [userId, userId, userId], callback);
}

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
                
                db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [userId]);
                
                res.json({ 
                    success: true, 
                    token,
                    user: { id: userId, username, email }
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
                
                res.json({
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        name: user.name,
                        email: user.email,
                        bio: user.bio,
                        avatar: user.avatar
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
                        
                        db.run(`UPDATE users SET status = 'online' WHERE id = ?`, [currentUser.userId]);
                        
                        // Получаем контакты
                        getFriendsList(currentUser.userId, (err, contacts) => {
                            ws.send(JSON.stringify({
                                type: 'auth_success',
                                user: currentUser,
                                contacts: contacts || []
                            }));
                        });
                        
                        db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [currentUser.userId]);
                        
                    } catch (e) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный токен' }));
                    }
                    break;

                case 'message':
                    if (!currentUser) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                        break;
                    }
                    
                    const { to, text } = data;
                    
                    db.run(`INSERT INTO messages (from_id, to_id, text) VALUES (?, ?, ?)`,
                        [currentUser.userId, to, text],
                        function(err) {
                            if (!err) {
                                const targetSocket = clients.get(to);
                                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                    targetSocket.send(JSON.stringify({
                                        type: 'message',
                                        from: currentUser.userId,
                                        fromName: currentUser.username,
                                        text: text,
                                        timestamp: new Date().toISOString(),
                                        messageId: this.lastID
                                    }));
                                }
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
                                const targetSocket = clients.get(fileTo);
                                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                                    targetSocket.send(JSON.stringify({
                                        type: 'file_message',
                                        from: currentUser.userId,
                                        fromName: currentUser.username,
                                        fileName: fileName,
                                        fileType: fileType,
                                        fileData: fileData,
                                        timestamp: new Date().toISOString()
                                    }));
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
                                console.error('Ошибка сохранения в канал:', err);
                                return;
                            }
                            
                            db.all(`SELECT user_id FROM channel_subscribers`, [], (err, subscribers) => {
                                if (err) return;
                                
                                const message = {
                                    type: 'channel_message',
                                    content: content,
                                    author: 'Clock Messenger',
                                    timestamp: new Date().toISOString(),
                                    messageId: this.lastID
                                };
                                
                                if (channelFile) {
                                    message.fileData = channelFile;
                                    message.fileName = channelFileName;
                                    message.fileType = channelFileType;
                                }
                                
                                subscribers.forEach(sub => {
                                    const subscriberWs = clients.get(sub.user_id);
                                    if (subscriberWs && subscriberWs.readyState === WebSocket.OPEN) {
                                        subscriberWs.send(JSON.stringify(message));
                                    }
                                });
                            });
                        }
                    );
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
                                // Отправляем обновлённый список ТОМУ, КТО ПРИНЯЛ (текущий пользователь)
                                getFriendsList(currentUser.userId, (err, contacts) => {
                                    ws.send(JSON.stringify({ 
                                        type: 'friends_list', 
                                        friends: contacts 
                                    }));
                                });
                                
                                // Отправляем обновлённый список ТОМУ, КТО ОТПРАВИЛ ЗАЯВКУ (requesterId)
                                const requesterWs = clients.get(requesterId);
                                if (requesterWs) {
                                    getFriendsList(requesterId, (err, contacts) => {
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
                    
                    // Обновляем списки у обоих
                    getFriendsList(currentUser.userId, (err, contacts) => {
                        ws.send(JSON.stringify({ type: 'friends_list', friends: contacts }));
                    });
                    
                    const deletedFriendWs = clients.get(deleteId);
                    if (deletedFriendWs) {
                        getFriendsList(deleteId, (err, contacts) => {
                            deletedFriendWs.send(JSON.stringify({ type: 'friends_list', friends: contacts }));
                        });
                    }
                    break;

                case 'update_profile':
                    if (!currentUser) break;
                    
                    const { name, bio, avatar } = data;
                    
                    db.run(`UPDATE users SET name = ?, bio = ?, avatar = ? WHERE id = ?`,
                        [name, bio, avatar, currentUser.userId]);
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
                    }
                    break;

                case 'reaction':
                    // Здесь будет логика реакций (для будущего обновления)
                    break;
            }
        } catch (e) {
            console.log('❌ Ошибка:', e);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            clients.delete(currentUser.userId);
            db.run(`UPDATE users SET status = 'offline' WHERE id = ?`, [currentUser.userId]);
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
