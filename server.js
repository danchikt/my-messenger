// Подключаем библиотеки
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Создаем веб-сервер
const app = express();
const server = http.createServer(app);

// Создаем сервер WebSockets
const wss = new WebSocket.Server({ server });

// Склад для хранения всех подключившихся клиентов
const clients = new Map();

// Это событие срабатывает, когда кто-то подключается
wss.on('connection', (ws) => {
    console.log('✅ Новый клиент подключился');
    
    let userId = null;

    // Обработка входящих сообщений
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Получено сообщение:', data);

            switch (data.type) {
                // ===== АВТОРИЗАЦИЯ =====
                case 'auth':
                    userId = data.userId;
                    clients.set(userId, ws);
                    console.log(`👤 Пользователь ${userId} авторизован`);
                    
                    ws.send(JSON.stringify({ 
                        type: 'auth_success', 
                        userId: userId 
                    }));
                    break;

                // ===== ОТПРАВКА СООБЩЕНИЯ =====
                case 'message':
                    const { to, text } = data;
                    
                    const targetSocket = clients.get(to);
                    
                    if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                        targetSocket.send(JSON.stringify({
                            type: 'message',
                            from: userId,
                            text: text,
                            timestamp: new Date().toISOString()
                        }));
                        console.log(`✉️ Сообщение от ${userId} к ${to}: "${text}"`);
                    } else {
                        console.log(`😴 Пользователь ${to} не в сети`);
                    }
                    break;

                // ===== ДОБАВЛЕНИЕ В ДРУЗЬЯ =====
                case 'add_friend':
                    console.log('\n=== ПОЛУЧЕН ЗАПРОС ADD_FRIEND ===');
                    console.log('От пользователя:', userId);
                    
                    const { friendId } = data;
                    console.log('ID друга для добавления:', friendId);
                    
                    if (!friendId) {
                        console.log('❌ Ошибка: нет ID друга');
                        break;
                    }
                    
                    if (friendId === userId) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Нельзя добавить самого себя'
                        }));
                        break;
                    }
                    
                    const friendSocket = clients.get(friendId);
                    
                    if (friendSocket && friendSocket.readyState === WebSocket.OPEN) {
                        console.log(`👤 Друг ${friendId} онлайн, отправляем уведомление`);
                        
                        friendSocket.send(JSON.stringify({
                            type: 'friend_request',
                            from: userId,
                            fromName: userId,
                            message: `Пользователь ${userId} хочет добавить вас в друзья`
                        }));
                        
                        ws.send(JSON.stringify({
                            type: 'friend_request_sent',
                            to: friendId,
                            message: `Запрос отправлен пользователю ${friendId}`
                        }));
                    } else {
                        console.log(`💤 Друг ${friendId} не в сети`);
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Пользователь не в сети или не существует'
                        }));
                    }
                    break;

                // ===== ПРИНЯТЬ ЗАЯВКУ =====
                case 'accept_friend':
                    const { requesterId } = data;
                    console.log(`✅ Заявка принята: ${requesterId} -> ${userId}`);
                    
                    // Отправляем уведомление
                    const requesterSocket = clients.get(requesterId);
                    if (requesterSocket) {
                        requesterSocket.send(JSON.stringify({
                            type: 'friend_request_accepted',
                            by: userId,
                            message: `Пользователь ${userId} принял вашу заявку`
                        }));
                    }
                    
                    ws.send(JSON.stringify({
                        type: 'notification',
                        message: `Вы приняли заявку от ${requesterId}`
                    }));
                    break;

                // ===== ОТКЛОНИТЬ ЗАЯВКУ =====
                case 'decline_friend':
                    const { requesterId: declineId } = data;
                    console.log(`❌ Заявка отклонена: ${declineId} -> ${userId}`);
                    
                    ws.send(JSON.stringify({
                        type: 'notification',
                        message: `Заявка от ${declineId} отклонена`
                    }));
                    break;

                default:
                    console.log('❌ Неизвестный тип сообщения:', data.type);
            }
        } catch (e) {
            console.log('❌ Ошибка обработки сообщения:', e);
        }
    });

    // Обработка отключения
    ws.on('close', () => {
        if (userId) {
            clients.delete(userId);
            console.log(`👋 Пользователь ${userId} отключился`);
        }
    });
});

// Отдаем HTML файл
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запускаем сервер
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🔌 WebSocket сервер работает`);
});
