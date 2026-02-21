const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { 
    db, 
    createUser, 
    findUser, 
    verifyPassword,
    getUserContacts,
    subscribeToChannel,
    getChannelMessages,
    addChannelMessage 
} = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Настройки
const JWT_SECRET = 'your-secret-key-change-this'; // В продакшене смени на случайную строку
const ADMIN_EMAIL = 'loling601@gmail.com';
const ADMIN_ID = 'admin';

// Middleware
app.use(cors());
app.use(express.json());

// Хранилище активных WebSocket соединений
const clients = new Map();

// ========== HTTP ЭНДПОИНТЫ (для регистрации/входа) ==========

// Регистрация
app.post('/api/register', async (req, res) => {
    const { email, username, password, name, bio, phone } = req.body;
    
    if (!email || !username || !password) {
        return res.status(400).json({ error: 'Email, username и password обязательны' });
    }
    
    // Генерируем ID из username
    const userId = username.toLowerCase();
    
    try {
        createUser({
            id: userId,
            name: name || username,
            email,
            username,
            password,
            bio: bio || '',
            phone
        }, (err, user) => {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'Email или username уже заняты' });
                }
                return res.status(500).json({ error: 'Ошибка базы данных' });
            }
            
            // Создаём JWT токен
            const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
            
            res.json({ 
                success: true, 
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    
    if (!login || !password) {
        return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }
    
    findUser(login, async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        
        const isValid = await verifyPassword(password, user.password_hash);
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
});

// Получить сообщения канала
app.get('/api/channel/messages', (req, res) => {
    getChannelMessages(50, (err, messages) => {
        if (err) {
            return res.status(500).json({ error: 'Ошибка базы данных' });
        }
        res.json(messages);
    });
});

// ========== WEBSOCKET (основная логика) ==========

wss.on('connection', (ws) => {
    console.log('✅ Новый WebSocket клиент');
    let currentUser = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Получено:', data.type);

            switch (data.type) {
                // ===== АВТОРИЗАЦИЯ ПО ТОКЕНУ =====
                case 'auth':
                    const { token } = data;
                    
                    try {
                        const decoded = jwt.verify(token, JWT_SECRET);
                        currentUser = decoded;
                        
                        // Сохраняем соединение
                        clients.set(currentUser.userId, ws);
                        
                        // Обновляем статус в базе
                        db.run(`UPDATE users SET status = 'online' WHERE id = ?`, [currentUser.userId]);
                        
                        // Получаем контакты
                        getUserContacts(currentUser.userId, (err, contacts) => {
                            ws.send(JSON.stringify({
                                type: 'auth_success',
                                user: currentUser,
                                contacts: contacts || []
                            }));
                        });
                        
                        // Подписываем на канал (если ещё нет)
                        subscribeToChannel(currentUser.userId, () => {});
                        
                    } catch (e) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный токен' }));
                    }
                    break;

                // ===== ОТПРАВКА СООБЩЕНИЯ =====
                case 'message':
                    if (!currentUser) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                        break;
                    }
                    
                    const { to, text } = data;
                    
                    // Сохраняем в базу
                    db.run(`INSERT INTO messages (from_id, to_id, text) VALUES (?, ?, ?)`,
                        [currentUser.userId, to, text]);
                    
                    // Отправляем получателю, если онлайн
                    const targetSocket = clients.get(to);
                    if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                        targetSocket.send(JSON.stringify({
                            type: 'message',
                            from: currentUser.userId,
                            fromName: currentUser.username,
                            text: text,
                            timestamp: new Date().toISOString()
                        }));
                    }
                    break;

                // ===== ОТПРАВКА В КАНАЛ (только для админа) =====
                case 'channel_message':
                    if (!currentUser) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                        break;
                    }
                    
                    // Проверяем, админ ли
                    if (currentUser.userId !== ADMIN_ID) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Только администратор может писать в канал' }));
                        break;
                    }
                    
                    const { content } = data;
                    
                    // Сохраняем в базу
                    addChannelMessage(content, currentUser.userId, 'Официальный канал', (err) => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Ошибка сохранения' }));
                            return;
                        }
                        
                        // Рассылаем всем подписчикам онлайн
                        db.all(`SELECT user_id FROM channel_subscribers`, [], (err, subscribers) => {
                            subscribers.forEach(sub => {
                                const subscriberWs = clients.get(sub.user_id);
                                if (subscriberWs && subscriberWs.readyState === WebSocket.OPEN) {
                                    subscriberWs.send(JSON.stringify({
                                        type: 'channel_message',
                                        content: content,
                                        author: 'Официальный канал',
                                        timestamp: new Date().toISOString()
                                    }));
                                }
                            });
                        });
                    });
                    break;

                // ===== ДОБАВЛЕНИЕ В ДРУЗЬЯ =====
                case 'add_friend':
                    if (!currentUser) break;
                    
                    const { friendId } = data;
                    
                    // Проверяем, существует ли пользователь
                    db.get(`SELECT id, name, username FROM users WHERE id = ? OR username = ?`, 
                        [friendId, friendId], (err, friend) => {
                            if (!friend) {
                                ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
                                return;
                            }
                            
                            // Создаём заявку
                            db.run(`INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')`,
                                [currentUser.userId, friend.id], (err) => {
                                    if (err) {
                                        ws.send(JSON.stringify({ type: 'error', message: 'Заявка уже существует' }));
                                        return;
                                    }
                                    
                                    // Уведомляем друга, если онлайн
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

                // ===== ПРИНЯТЬ ЗАЯВКУ =====
                case 'accept_friend':
                    if (!currentUser) break;
                    
                    const { requesterId } = data;
                    
                    db.run(`UPDATE friends SET status = 'accepted' 
                            WHERE user_id = ? AND friend_id = ?`,
                        [requesterId, currentUser.userId], function(err) {
                            if (!err) {
                                // Отправляем обновлённые списки обоим
                                getUserContacts(currentUser.userId, (err, contacts) => {
                                    ws.send(JSON.stringify({ type: 'friends_list', friends: contacts }));
                                });
                                
                                const requesterWs = clients.get(requesterId);
                                if (requesterWs) {
                                    getUserContacts(requesterId, (err, contacts) => {
                                        requesterWs.send(JSON.stringify({ type: 'friends_list', friends: contacts }));
                                    });
                                }
                            }
                        });
                    break;

                // ===== ПОЛУЧИТЬ ПРОФИЛЬ =====
                case 'get_profile':
                    const { profileId } = data;
                    
                    db.get(`SELECT id, name, username, bio, avatar, status FROM users WHERE id = ?`,
                        [profileId], (err, profile) => {
                            if (profile) {
                                ws.send(JSON.stringify({
                                    type: 'profile_info',
                                    profile: profile
                                }));
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
            db.run(`UPDATE users SET status = 'offline' WHERE id = ?`, [currentUser.userId]);
            console.log(`👋 ${currentUser.username} отключился`);
        }
    });
});

// Отдаём HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📝 Регистрация: http://localhost:${PORT}/api/register`);
    console.log(`🔑 Вход: http://localhost:${PORT}/api/login`);
});
