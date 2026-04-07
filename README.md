# WebTorrent Downloader

Веб-приложение для скачивания торрентов через браузер с использованием библиотеки WebTorrent.

## Возможности

- Регистрация и авторизация пользователей (JWT)
- Добавление торрентов по магнет-ссылкам
- Загрузка .torrent файлов
- Отображение прогресса загрузки в реальном времени
- Пауза и возобновление загрузки торрентов
- Выбор файлов для скачивания в многофайловых торрентах
- Просмотр скорости загрузки/отдачи и количества пиров
- Управление скачанными файлами
- Настраиваемый каталог загрузки
- DLNA/UPnP — обнаружение MediaRenderer устройств в сети и трансляция медиа (cast)
- DLNA Media Server — публикация медиа-библиотеки для других устройств в сети
- HTTP-стриминг файлов и активных торрентов с поддержкой Range requests
- Транскодирование видео на лету (требуется ffmpeg)

## Требования

- Node.js 18+

## Установка

```bash
npm install
```

## Запуск

```bash
npm start
```

Сервер запустится на http://localhost:3000

## Конфигурация

Настройки хранятся в файле `config.json`. Если файл отсутствует, используются значения по умолчанию.

```json
{
  "server": {
    "port": 3000
  },
  "torrent": {
    "port": 0
  },
  "dlna": {
    "serverPort": 10293,
    "serverName": "WebTorrent Media Server",
    "autoStart": false
  },
  "downloads": {
    "directory": "./downloads"
  }
}
```

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `server.port` | Порт веб-сервера | `3000` |
| `torrent.port` | TCP-порт для входящих BitTorrent-соединений (`0` — случайный) | `0` |
| `dlna.serverPort` | Порт DLNA Media Server | `10293` |
| `dlna.serverName` | Имя DLNA-сервера в сети | `WebTorrent Media Server` |
| `dlna.autoStart` | Автозапуск DLNA-сервера при старте приложения | `false` |
| `downloads.directory` | Каталог загрузки | `./downloads` |

Конфигурацию также можно изменить через API (`/api/settings/config`). Изменение портов требует перезапуска.

## Переменные окружения

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `PORT` | Порт сервера (переопределяет `server.port`) | `3000` |
| `JWT_SECRET` | Секретный ключ для JWT токенов | `webtorrent-secret-key-change-in-production` |

## API

### Авторизация

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/auth/register` | Регистрация нового пользователя |
| POST | `/api/auth/login` | Вход в систему |
| GET | `/api/auth/me` | Информация о текущем пользователе |

Все остальные endpoints требуют авторизации. Токен передаётся в заголовке `Authorization: Bearer <token>`.

### Торренты

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/download/magnet` | Добавить торрент по магнет-ссылке |
| POST | `/api/download/file` | Загрузить .torrent файл |
| GET | `/api/torrents` | Список активных торрентов |
| DELETE | `/api/torrents/:infoHash` | Удалить торрент |
| POST | `/api/torrents/:infoHash/pause` | Приостановить загрузку |
| POST | `/api/torrents/:infoHash/resume` | Возобновить загрузку |
| POST | `/api/torrents/:infoHash/select-files` | Выбрать файлы для скачивания |
| GET | `/api/progress` | SSE-поток с прогрессом загрузок |

### Файлы

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/files` | Список скачанных файлов |
| DELETE | `/api/files/:filename` | Удалить файл |

### Настройки

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/settings/directory` | Получить текущий каталог загрузки |
| POST | `/api/settings/directory` | Изменить каталог загрузки |
| GET | `/api/settings/config` | Получить текущую конфигурацию |
| POST | `/api/settings/config` | Сохранить конфигурацию |

### DLNA

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/dlna/devices` | Список найденных DLNA-устройств |
| POST | `/api/dlna/devices/scan` | Запустить сканирование сети |
| POST | `/api/dlna/cast` | Отправить медиа на устройство |
| POST | `/api/dlna/control/:action` | Управление воспроизведением (`play`, `pause`, `stop`, `seek`, `volume`) |
| GET | `/api/dlna/status` | Статус текущего воспроизведения |
| GET | `/api/dlna/server/status` | Статус DLNA Media Server |
| POST | `/api/dlna/server/start` | Запустить DLNA Media Server |
| POST | `/api/dlna/server/stop` | Остановить DLNA Media Server |

### Стриминг и транскодирование

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/stream/:filename` | Стриминг файла из каталога загрузок |
| GET | `/api/stream/torrent/:infoHash/:fileIndex` | Стриминг файла из активного торрента |
| GET | `/api/media/files` | Список медиа-файлов |
| GET | `/api/transcode/:filename` | Транскодирование видео на лету |
| GET | `/api/transcode/formats` | Поддерживаемые форматы |
| GET | `/api/transcode/check` | Проверка наличия ffmpeg |

## Структура проекта

```
WebTorrent/
├── server.js              # Сервер Express
├── config.json            # Конфигурация
├── package.json
├── users.json             # База пользователей (создаётся автоматически)
├── public/
│   ├── index.html         # Главная страница
│   ├── style.css          # Стили
│   └── app.js             # Клиентский JavaScript
├── dlna/
│   ├── index.js           # Экспорт DLNA модулей
│   ├── deviceDiscovery.js # Обнаружение DLNA-устройств (SSDP)
│   ├── dlnaServer.js      # DLNA Media Server (UPnP)
│   ├── mediaRenderer.js   # Управление воспроизведением на устройствах
│   ├── streamingServer.js # HTTP-стриминг с Range requests
│   └── transcoder.js      # Транскодирование видео (ffmpeg)
└── downloads/             # Каталог загрузки (создаётся автоматически)
```

## Технологии

- [Express](https://expressjs.com/) — веб-фреймворк
- [WebTorrent](https://webtorrent.io/) — торрент-клиент
- [Multer](https://github.com/expressjs/multer) — загрузка файлов
- [node-ssdp](https://github.com/nickvdp/node-ssdp) — обнаружение DLNA/UPnP устройств
- [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) — транскодирование видео
- Server-Sent Events (SSE) — обновления в реальном времени

## Лицензия

MIT
