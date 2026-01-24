import express from 'express';
import WebTorrent from 'webtorrent';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const client = new WebTorrent();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'webtorrent-secret-key-change-in-production';
const USERS_FILE = path.join(__dirname, 'users.json');

// Каталог загрузки по умолчанию
let downloadDirectory = path.join(__dirname, 'downloads');

// Создаём каталог загрузки, если не существует
if (!fs.existsSync(downloadDirectory)) {
  fs.mkdirSync(downloadDirectory, { recursive: true });
}

// Загрузка/сохранение пользователей
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Ошибка загрузки пользователей:', e.message);
  }
  return [];
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Middleware для проверки JWT
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

// Настройка multer для загрузки .torrent файлов
const upload = multer({
  dest: 'temp/',
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.torrent')) {
      cb(null, true);
    } else {
      cb(new Error('Только .torrent файлы разрешены'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// === Авторизация ===

// Регистрация
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Логин должен быть не менее 3 символов' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
  }

  const users = loadUsers();

  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now().toString(),
    username,
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveUsers(users);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: { id: newUser.id, username: newUser.username }
  });
});

// Вход
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  const users = loadUsers();
  const user = users.find(u => u.username === username);

  if (!user) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username }
  });
});

// Текущий пользователь
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// === Защищённые маршруты ===

// SSE клиенты для прогресса
const sseClients = new Set();

// Отправка обновлений прогресса всем SSE клиентам
function broadcastProgress() {
  const torrents = client.torrents.map(torrent => ({
    infoHash: torrent.infoHash,
    name: torrent.name || 'Загрузка метаданных...',
    progress: Math.round(torrent.progress * 100),
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    downloaded: torrent.downloaded,
    length: torrent.length || 0,
    done: torrent.done,
    files: torrent.files?.map(f => ({
      name: f.name,
      length: f.length,
      progress: Math.round(f.progress * 100)
    })) || []
  }));

  const data = JSON.stringify(torrents);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Интервал обновления прогресса
setInterval(broadcastProgress, 1000);

// SSE endpoint для прогресса (с проверкой токена через query)
app.get('/api/progress', (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  try {
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  broadcastProgress();

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Добавить торрент по магнет-ссылке
app.post('/api/download/magnet', authMiddleware, (req, res) => {
  const { magnetUri } = req.body;

  if (!magnetUri) {
    return res.status(400).json({ error: 'Магнет-ссылка обязательна' });
  }

  const existingTorrent = client.torrents.find(t => t.magnetURI === magnetUri);
  if (existingTorrent) {
    return res.status(400).json({ error: 'Торрент уже добавлен' });
  }

  try {
    const torrent = client.add(magnetUri, { path: downloadDirectory });

    torrent.on('metadata', () => {
      console.log(`Метаданные получены: ${torrent.name}`);
    });

    torrent.on('done', () => {
      console.log(`Загрузка завершена: ${torrent.name}`);
    });

    torrent.on('error', (err) => {
      console.error(`Ошибка торрента: ${err.message}`);
    });

    res.json({
      success: true,
      infoHash: torrent.infoHash,
      message: 'Торрент добавлен'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Загрузить .torrent файл
app.post('/api/download/file', authMiddleware, upload.single('torrentFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '.torrent файл обязателен' });
  }

  try {
    const torrentPath = req.file.path;
    const torrent = client.add(torrentPath, { path: downloadDirectory });

    torrent.on('metadata', () => {
      console.log(`Метаданные получены: ${torrent.name}`);
      fs.unlink(torrentPath, () => {});
    });

    torrent.on('done', () => {
      console.log(`Загрузка завершена: ${torrent.name}`);
    });

    torrent.on('error', (err) => {
      console.error(`Ошибка торрента: ${err.message}`);
      fs.unlink(torrentPath, () => {});
    });

    res.json({
      success: true,
      infoHash: torrent.infoHash,
      message: 'Торрент файл добавлен'
    });
  } catch (error) {
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ error: error.message });
  }
});

// Список активных торрентов
app.get('/api/torrents', authMiddleware, (req, res) => {
  const torrents = client.torrents.map(torrent => ({
    infoHash: torrent.infoHash,
    name: torrent.name || 'Загрузка метаданных...',
    progress: Math.round(torrent.progress * 100),
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    downloaded: torrent.downloaded,
    length: torrent.length || 0,
    done: torrent.done,
    paused: torrent.paused,
    files: torrent.files?.map(f => ({
      name: f.name,
      length: f.length,
      progress: Math.round(f.progress * 100)
    })) || []
  }));

  res.json(torrents);
});

// Удалить торрент
app.delete('/api/torrents/:infoHash', authMiddleware, async (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) {
    return res.status(404).json({ error: 'Торрент не найден' });
  }

  try {
    await client.remove(infoHash, { destroyStore: false });
    res.json({ success: true, message: 'Торрент удалён' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Список скачанных файлов
app.get('/api/files', authMiddleware, (req, res) => {
  fs.readdir(downloadDirectory, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const files = [];

    const processEntry = (entry, basePath = '') => {
      const fullPath = path.join(downloadDirectory, basePath, entry.name);
      const relativePath = path.join(basePath, entry.name);

      if (entry.isDirectory()) {
        try {
          const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
          subEntries.forEach(subEntry => processEntry(subEntry, relativePath));
        } catch (e) {
          // Игнорируем ошибки доступа
        }
      } else {
        try {
          const stats = fs.statSync(fullPath);
          files.push({
            name: relativePath,
            size: stats.size,
            created: stats.birthtime
          });
        } catch (e) {
          // Игнорируем ошибки доступа
        }
      }
    };

    entries.forEach(entry => processEntry(entry));
    res.json(files);
  });
});

// Удалить скачанный файл
app.delete('/api/files/:filename', authMiddleware, (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(downloadDirectory, filename);

  if (!filePath.startsWith(downloadDirectory)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      return res.status(404).json({ error: 'Файл не найден' });
    }

    if (stats.isDirectory()) {
      fs.rm(filePath, { recursive: true }, (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Папка удалена' });
      });
    } else {
      fs.unlink(filePath, (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Файл удалён' });
      });
    }
  });
});

// Изменить каталог загрузки
app.post('/api/settings/directory', authMiddleware, (req, res) => {
  const { directory } = req.body;

  if (!directory) {
    return res.status(400).json({ error: 'Каталог обязателен' });
  }

  const newPath = path.resolve(directory);

  try {
    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }
    downloadDirectory = newPath;
    res.json({ success: true, directory: downloadDirectory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить текущий каталог загрузки
app.get('/api/settings/directory', authMiddleware, (req, res) => {
  res.json({ directory: downloadDirectory });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  console.log(`Каталог загрузки: ${downloadDirectory}`);
});

// Обработка завершения
process.on('SIGINT', async () => {
  console.log('\nЗавершение работы...');
  await client.destroy();
  process.exit(0);
});
