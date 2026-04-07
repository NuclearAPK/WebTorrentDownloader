import express from 'express';
import WebTorrent from 'webtorrent';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// DLNA модули
import {
  StreamingServer,
  DeviceDiscovery,
  MediaRenderer,
  DLNAServer,
  Transcoder
} from './dlna/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загрузка конфигурации
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  server: { port: 3000 },
  torrent: { port: 0 },
  dlna: { serverPort: 10293, serverName: 'WebTorrent Media Server', autoStart: false },
  downloads: { directory: './downloads' }
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    config = { ...config, ...configData };
    console.log('Конфигурация загружена из config.json');
  } catch (e) {
    console.error('Ошибка чтения config.json, используются значения по умолчанию:', e.message);
  }
}

const app = express();
const client = new WebTorrent({ torrentPort: config.torrent.port || 0 });
const PORT = process.env.PORT || config.server.port;
const DLNA_PORT = config.dlna.serverPort;
const DLNA_SERVER_NAME = config.dlna.serverName;
const JWT_SECRET = process.env.JWT_SECRET || 'webtorrent-secret-key-change-in-production';
const USERS_FILE = path.join(__dirname, 'users.json');

// Каталог загрузки
let downloadDirectory = path.isAbsolute(config.downloads.directory)
  ? config.downloads.directory
  : path.join(__dirname, config.downloads.directory);

// Создаём каталог загрузки, если не существует
if (!fs.existsSync(downloadDirectory)) {
  fs.mkdirSync(downloadDirectory, { recursive: true });
}

// Трекинг выбора файлов: infoHash -> массив boolean (true = выбран)
const torrentFileSelections = {};

// Инициализация DLNA модулей
const streamingServer = new StreamingServer(downloadDirectory, client);
const deviceDiscovery = new DeviceDiscovery();
const mediaRenderer = new MediaRenderer(deviceDiscovery);
const dlnaServer = new DLNAServer(downloadDirectory, { port: DLNA_PORT, serverName: DLNA_SERVER_NAME });
const transcoder = new Transcoder(downloadDirectory);

// Запускаем обнаружение устройств
try {
  deviceDiscovery.init();
} catch (e) {
  console.warn('Не удалось запустить обнаружение DLNA устройств:', e.message);
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
    paused: torrent.paused || false,
    files: torrent.files?.map((f, i) => ({
      name: f.name,
      length: f.length,
      progress: Math.round(f.progress * 100),
      selected: torrentFileSelections[torrent.infoHash] ? torrentFileSelections[torrent.infoHash][i] : true
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

    torrent.on('ready', () => {
      if (torrent.files.length > 1) {
        // Паузим торрент и снимаем выбор со всех файлов до подтверждения пользователем
        torrent.pause();
        torrent.files.forEach(f => f.deselect());
        torrentFileSelections[torrent.infoHash] = torrent.files.map(() => false);
        console.log(`Многофайловый торрент — приостановлен, ожидание выбора файлов: ${torrent.name}`);
      }
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

    torrent.on('ready', () => {
      if (torrent.files.length > 1) {
        torrent.pause();
        torrent.files.forEach(f => f.deselect());
        torrentFileSelections[torrent.infoHash] = torrent.files.map(() => false);
        console.log(`Многофайловый торрент — приостановлен, ожидание выбора файлов: ${torrent.name}`);
      }
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
    paused: torrent.paused || false,
    files: torrent.files?.map((f, i) => ({
      name: f.name,
      length: f.length,
      progress: Math.round(f.progress * 100),
      selected: torrentFileSelections[torrent.infoHash] ? torrentFileSelections[torrent.infoHash][i] : true
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
    delete torrentFileSelections[infoHash];
    await client.remove(infoHash, { destroyStore: false });
    res.json({ success: true, message: 'Торрент удалён' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Пауза торрента
app.post('/api/torrents/:infoHash/pause', authMiddleware, (req, res) => {
  const torrent = client.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Торрент не найден' });
  torrent.pause();
  res.json({ success: true, message: 'Торрент приостановлен' });
});

// Возобновление торрента
app.post('/api/torrents/:infoHash/resume', authMiddleware, (req, res) => {
  const torrent = client.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Торрент не найден' });
  torrent.resume();
  res.json({ success: true, message: 'Торрент возобновлён' });
});

// Выбор файлов для скачивания
app.post('/api/torrents/:infoHash/select-files', authMiddleware, (req, res) => {
  const torrent = client.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Торрент не найден' });
  if (!torrent.files || torrent.files.length === 0) {
    return res.status(400).json({ error: 'Метаданные торрента ещё не получены' });
  }

  const { selectedFiles } = req.body;
  if (!Array.isArray(selectedFiles)) {
    return res.status(400).json({ error: 'selectedFiles должен быть массивом индексов' });
  }

  const selections = [];
  torrent.files.forEach((file, index) => {
    const selected = selectedFiles.includes(index);
    selections.push(selected);
    if (selected) {
      file.select();
    } else {
      file.deselect();
    }
  });

  torrentFileSelections[torrent.infoHash] = selections;

  // Возобновляем торрент если он был приостановлен при ожидании выбора файлов
  if (torrent.paused) {
    torrent.resume();
  }

  res.json({ success: true, message: 'Выбор файлов обновлён' });
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

    // Обновляем директорию в DLNA модулях
    streamingServer.setDownloadDirectory(newPath);
    dlnaServer.setDownloadDirectory(newPath);
    transcoder.setDownloadDirectory(newPath);

    res.json({ success: true, directory: downloadDirectory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Получить текущий каталог загрузки
app.get('/api/settings/directory', authMiddleware, (req, res) => {
  res.json({ directory: downloadDirectory });
});

// Получить конфигурацию
app.get('/api/settings/config', authMiddleware, (req, res) => {
  res.json(config);
});

// Сохранить конфигурацию
app.post('/api/settings/config', authMiddleware, (req, res) => {
  const newConfig = req.body;

  try {
    // Обновляем конфигурацию
    if (newConfig.server) {
      config.server = { ...config.server, ...newConfig.server };
    }
    if (newConfig.torrent) {
      config.torrent = { ...config.torrent, ...newConfig.torrent };
    }
    if (newConfig.dlna) {
      config.dlna = { ...config.dlna, ...newConfig.dlna };
    }
    if (newConfig.downloads) {
      config.downloads = { ...config.downloads, ...newConfig.downloads };
    }

    // Сохраняем в файл
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    res.json({ success: true, config, message: 'Конфигурация сохранена. Перезапустите сервер для применения изменений портов.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === DLNA API ===

// --- Streaming ---

// Стриминг файла из downloads
app.get('/api/stream/:filename(*)', (req, res) => {
  streamingServer.streamFile(req, res);
});

// Стриминг файла из активного торрента
app.get('/api/stream/torrent/:infoHash/:fileIndex', (req, res) => {
  streamingServer.streamTorrent(req, res);
});

// Список медиа-файлов для стриминга
app.get('/api/media/files', authMiddleware, (req, res) => {
  const files = streamingServer.getMediaFiles();
  res.json(files);
});

// --- Device Discovery ---

// Список найденных DLNA устройств
app.get('/api/dlna/devices', authMiddleware, (req, res) => {
  const devices = deviceDiscovery.getDevices();
  res.json({
    devices,
    scanning: deviceDiscovery.isScanning()
  });
});

// Запустить сканирование сети
app.post('/api/dlna/devices/scan', authMiddleware, (req, res) => {
  try {
    deviceDiscovery.scan();
    res.json({ success: true, message: 'Сканирование запущено' });
  } catch (e) {
    res.status(503).json({ error: 'Не удалось запустить сканирование: ' + e.message });
  }
});

// --- Media Renderer (Cast) ---

// Отправить медиа на устройство
app.post('/api/dlna/cast', authMiddleware, async (req, res) => {
  const { deviceId, filename, torrent } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'ID устройства обязателен' });
  }

  try {
    // Определяем URL для стриминга
    const host = req.headers.host;
    let mediaUrl, title, mimeType;

    if (torrent) {
      // Стриминг из торрента
      const { infoHash, fileIndex } = torrent;
      const fileInfo = streamingServer.getTorrentFileInfo(infoHash, fileIndex);

      if (!fileInfo) {
        return res.status(404).json({ error: 'Файл торрента не найден' });
      }

      mediaUrl = streamingServer.getTorrentStreamUrl(infoHash, fileIndex, host);
      title = fileInfo.name;
      mimeType = fileInfo.mimeType;
    } else if (filename) {
      // Стриминг из файла
      const fileInfo = streamingServer.getFileInfo(filename);

      if (!fileInfo) {
        return res.status(404).json({ error: 'Файл не найден' });
      }

      // Проверяем, нужно ли транскодирование
      if (transcoder.needsTranscoding(filename)) {
        mediaUrl = transcoder.getTranscodeUrl(filename, host, 'medium');
        mimeType = 'video/mp4';
      } else {
        mediaUrl = streamingServer.getStreamUrl(filename, host);
        mimeType = fileInfo.mimeType;
      }
      title = path.basename(filename);
    } else {
      return res.status(400).json({ error: 'Укажите filename или torrent' });
    }

    const result = await mediaRenderer.cast(deviceId, mediaUrl, title, mimeType);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Управление воспроизведением
app.post('/api/dlna/control/:action', authMiddleware, async (req, res) => {
  const { action } = req.params;

  try {
    let result;

    switch (action) {
      case 'play':
        result = await mediaRenderer.play();
        break;
      case 'pause':
        result = await mediaRenderer.pause();
        break;
      case 'stop':
        result = await mediaRenderer.stop();
        break;
      case 'seek':
        const { position } = req.body;
        if (position === undefined) {
          return res.status(400).json({ error: 'Позиция обязательна' });
        }
        result = await mediaRenderer.seek(position);
        break;
      case 'volume':
        const { volume } = req.body;
        if (volume === undefined) {
          return res.status(400).json({ error: 'Громкость обязательна' });
        }
        result = await mediaRenderer.setVolume(volume);
        break;
      default:
        return res.status(400).json({ error: 'Неизвестное действие' });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Статус воспроизведения
app.get('/api/dlna/status', authMiddleware, async (req, res) => {
  try {
    const status = await mediaRenderer.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- DLNA Server ---

// Статус DLNA сервера
app.get('/api/dlna/server/status', authMiddleware, (req, res) => {
  res.json(dlnaServer.getStatus());
});

// Запустить DLNA сервер
app.post('/api/dlna/server/start', authMiddleware, async (req, res) => {
  try {
    const result = await dlnaServer.start();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Остановить DLNA сервер
app.post('/api/dlna/server/stop', authMiddleware, async (req, res) => {
  try {
    const result = await dlnaServer.stop();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Transcoding ---

// Транскодирование на лету
app.get('/api/transcode/:filename(*)', (req, res) => {
  transcoder.handleTranscodeRequest(req, res);
});

// Поддерживаемые форматы транскодирования
app.get('/api/transcode/formats', authMiddleware, (req, res) => {
  res.json(transcoder.getSupportedFormats());
});

// Проверка ffmpeg
app.get('/api/transcode/check', authMiddleware, async (req, res) => {
  const result = await transcoder.checkFfmpeg();
  res.json(result);
});

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  console.log(`Каталог загрузки: ${downloadDirectory}`);

  // Автозапуск DLNA сервера если включено в конфиге
  if (config.dlna.autoStart) {
    try {
      await dlnaServer.start();
    } catch (e) {
      console.error('Ошибка автозапуска DLNA сервера:', e.message);
    }
  }
});

// Обработка завершения
process.on('SIGINT', async () => {
  console.log('\nЗавершение работы...');

  // Останавливаем DLNA модули
  deviceDiscovery.destroy();
  mediaRenderer.destroy();
  await dlnaServer.stop();

  await client.destroy();
  process.exit(0);
});
