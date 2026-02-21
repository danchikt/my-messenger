const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'messenger.db');
const db = new sqlite3.Database(dbPath);

// Создаем таблицы, если их нет
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица друзей
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
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_id) REFERENCES users(id),
        FOREIGN KEY (to_id) REFERENCES users(id)
    )`);

    // Таблица официального канала
    db.run(`CREATE TABLE IF NOT EXISTS channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT DEFAULT 'Официальный канал',
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

    // Создаём официальный канал и твоего пользователя
    const adminEmail = 'loling601@gmail.com';
    const adminPassword = '050506fyu';
    const adminId = 'admin';
    
    bcrypt.hash(adminPassword, 10, (err, hash) => {
        if (err) throw err;
        
        db.run(`INSERT OR IGNORE INTO users (id, name, email, username, password_hash, bio) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [adminId, 'Администратор', adminEmail, 'admin', hash, 'Создатель мессенджера'],
            function(err) {
                if (!err && this.changes) {
                    console.log('✅ Администратор создан');
                    db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [adminId]);
                }
            }
        );
    });
});

// ===== ФУНКЦИИ ДЛЯ РАБОТЫ =====

// Хеширование пароля
async function hashPassword(password) {
    return await bcrypt.hash(password, 10);
}

// Проверка пароля
async function verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
}

// Создание нового пользователя
function createUser(userData, callback) {
    const { id, name, email, username, password, bio = '', avatar = '', phone = null } = userData;
    
    hashPassword(password).then(hash => {
        db.run(`INSERT INTO users (id, name, email, phone, username, password_hash, bio, avatar) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, name, email, phone, username, hash, bio, avatar],
            function(err) {
                if (err) {
                    callback(err);
                } else {
                    const userId = id;
                    // Автоматически подписываем на официальный канал
                    db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [userId]);
                    callback(null, { id: userId, username, email });
                }
            }
        );
    });
}

// Поиск пользователя по email/phone/username/id
function findUser(login, callback) {
    db.get(`SELECT * FROM users WHERE email = ? OR phone = ? OR username = ? OR id = ?`,
        [login, login, login, login], callback);
}

// Получить контакты пользователя
function getUserContacts(userId, callback) {
    db.all(`SELECT u.* FROM users u
            JOIN friends f ON (f.friend_id = u.id OR f.user_id = u.id)
            WHERE (f.user_id = ? OR f.friend_id = ?) 
            AND f.status = 'accepted' AND u.id != ?`,
        [userId, userId, userId], callback);
}

// Подписать на канал
function subscribeToChannel(userId, callback) {
    db.run(`INSERT OR IGNORE INTO channel_subscribers (user_id) VALUES (?)`, [userId], callback);
}

// Получить сообщения канала
function getChannelMessages(limit = 50, callback) {
    db.all(`SELECT * FROM channel_messages ORDER BY created_at DESC LIMIT ?`, [limit], callback);
}

// Добавить сообщение в канал (только для админа)
function addChannelMessage(content, authorId, authorName, callback) {
    db.run(`INSERT INTO channel_messages (content, author_id, author_name) VALUES (?, ?, ?)`,
        [content, authorId, authorName], callback);
}

module.exports = { 
    db, 
    createUser, 
    findUser, 
    verifyPassword,
    getUserContacts,
    subscribeToChannel,
    getChannelMessages,
    addChannelMessage,
    hashPassword
};