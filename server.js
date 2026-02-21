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
            console.log(`✅ Сообщение сохранено в канал, ID: ${messageId}`);
            
            // Получаем всех подписчиков
            db.all(`SELECT user_id FROM channel_subscribers`, [], (err, subscribers) => {
                if (err) {
                    console.error('❌ Ошибка получения подписчиков:', err);
                    return;
                }
                
                console.log(`📢 Отправка сообщения ${subscribers.length} подписчикам`);
                
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
                
                // Рассылаем ВСЕМ подписчикам
                let sentCount = 0;
                subscribers.forEach(sub => {
                    const subscriberWs = clients.get(sub.user_id);
                    if (subscriberWs && subscriberWs.readyState === WebSocket.OPEN) {
                        subscriberWs.send(JSON.stringify(message));
                        sentCount++;
                    } else {
                        console.log(`😴 Подписчик ${sub.user_id} не в сети`);
                    }
                });
                
                console.log(`✅ Сообщение отправлено ${sentCount} подписчикам`);
                
                // Отправляем подтверждение админу
                ws.send(JSON.stringify({
                    type: 'channel_message_sent',
                    messageId: messageId,
                    content: content
                }));
            });
        }
    );
    break;
