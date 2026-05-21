# Загрузка видеофайлов через web UI — дизайн

**Дата:** 2026-05-21
**Статус:** Draft → ожидает одобрения пользователя
**Затрагиваемые компоненты:** `server.js`, `public/index.html`, `public/app.js`, `public/style.css`

## Цель

Дать пользователю возможность загружать собственные видеофайлы через web UI прямо в `downloadDirectory`, чтобы они отображались в секции «Скачанные файлы» наравне с торрент-загрузками и были доступны для встроенного просмотра, DLNA-кастинга и транскодирования через уже существующие функции приложения.

## Скоуп

### В рамках задачи
- Серверный эндпоинт `POST /api/upload/video` с прогресс-фрэндли стримингом и лимитом 20 ГБ
- Серверный эндпоинт `GET /api/upload/video/check` для проверки коллизии имени до начала загрузки
- UI-блок загрузки видео в существующей секции «Добавить торрент»
- Прогресс-бар, отображение скорости загрузки, кнопка отмены
- Модальное окно конфликта имени с тремя действиями (Перезаписать / Переименовать / Отмена)
- Валидация типа файла (расширения из whitelist)
- Валидация имени файла (защита от path traversal)
- Запись в `CHANGELOG.md`, инкремент версии `package.json`

### Вне рамок задачи (YAGNI)
- Возобновляемые/чанкованные загрузки (нет необходимости для локального приложения)
- Создание `.torrent` и сидирование загруженного видео
- Поддержка не-видео-форматов (аудио, изображения, документы)
- Drag-and-drop из проводника (можно добавить позже)
- Множественная загрузка за один раз
- Превью видео до завершения загрузки

## Требования (по итогам опроса)

| № | Решение | Обоснование |
|---|---------|-------------|
| 1 | Назначение | Сохранение в `downloadDirectory` (без сидирования) |
| 2 | Типы файлов | Только видео (`video/*` + расширения whitelist) |
| 3 | Прогресс | Прогресс-бар с процентом, скоростью и кнопкой «Отмена» |
| 4 | Лимит размера | 20 ГБ |
| 5 | Коллизия имени | Спросить пользователя через модальное окно |

## Архитектура

Изменения изолированы и не затрагивают существующие модули:
- WebTorrent-клиент не задействован
- DLNA-модули (`dlna/`) не модифицируются
- Транскодер не модифицируется
- Список файлов (`GET /api/files`) автоматически подхватывает загруженный файл, поскольку он лежит в `downloadDirectory`

```
Клиент (app.js)                      Сервер (server.js)
  │                                    │
  │ 1. preflight: GET /api/upload/     │
  │    video/check?name=…              │
  ├──────────────────────────────────►│
  │ ◄─── { exists, safeName, suggested? }
  │                                    │
  │ 2. (если exists) показать модалку  │
  │    → выбор: overwrite / rename / cancel
  │                                    │
  │ 3. POST /api/upload/video          │
  │    ?targetName=…&mode=overwrite|new│
  │    multipart, поле videoFile       │
  │    XHR + upload.onprogress         │
  ├──────────────────────────────────►│
  │                              multer.diskStorage
  │                              → стрим напрямую в downloadDirectory
  │ ◄─── { success, filename }
  │                                    │
  │ 4. loadFiles() обновляет список   │
```

## Бэкенд

### Новая multer-конфигурация

Рядом с существующей `upload` добавляется `videoUpload`:

```js
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v',
  '.wmv', '.flv', '.ts', '.mpg', '.mpeg', '.3gp', '.ogv'
]);

const MAX_VIDEO_SIZE_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, downloadDirectory),
    filename: (req, file, cb) => {
      const targetName = sanitizeFilename(req.query.targetName || file.originalname);
      cb(null, targetName);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) cb(null, true);
    else cb(new Error('UNSUPPORTED_MEDIA_TYPE'));
  },
  limits: { fileSize: MAX_VIDEO_SIZE_BYTES }
});
```

Используем фильтр по расширению, а не по MIME, поскольку браузеры непоследовательно определяют MIME для `.mkv` и `.ts` (часто пустая строка или `application/octet-stream`).

### `sanitizeFilename(name)` — утилита

Принимает произвольную строку, возвращает безопасное имя файла или выбрасывает ошибку:
- `path.basename(name)` — отсекает любые директорные части
- Запретные символы: `<`, `>`, `:`, `"`, `|`, `?`, `*`, `\0`, управляющие (0x00–0x1F)
- Длина после очистки 1–255 символов
- Не разрешать имена `.` и `..`, пустые имена

### `findAvailableName(name)` — утилита

Принимает безопасное имя, возвращает первое свободное имя в `downloadDirectory` по схеме `name (N).ext`, начиная с N=1.

### Эндпоинт preflight

```
GET /api/upload/video/check?name=<filename>
Authorization: Bearer <jwt>
```

Логика:
1. `authMiddleware`
2. `safeName = sanitizeFilename(req.query.name)` — при ошибке → `400`
3. `exists = fs.existsSync(path.join(downloadDirectory, safeName))`
4. Ответ:
   - Если не существует: `{ exists: false, safeName }`
   - Если существует: `{ exists: true, safeName, suggested: findAvailableName(safeName) }`

### Эндпоинт загрузки

```
POST /api/upload/video?targetName=<name>&mode=new|overwrite
Authorization: Bearer <jwt>
Content-Type: multipart/form-data
поле: videoFile
```

Логика:
1. `authMiddleware`
2. Предварительная проверка query до запуска multer:
   - `safeName = sanitizeFilename(req.query.targetName)` — при ошибке → `400`
   - `mode = req.query.mode === 'overwrite' ? 'overwrite' : 'new'`
   - Если `mode === 'new'` и файл уже существует → `409 Conflict, { error: 'Файл существует' }` (без чтения тела запроса; отменяем поток явно, чтобы клиент быстро увидел ошибку)
3. Запуск `videoUpload.single('videoFile')`
4. Обработка результата:
   - Успех: `200, { success: true, filename: safeName, size }`
   - Ошибка multer: см. секцию «Обработка ошибок»
5. Защита от прерывания: `req.on('aborted', () => { fs.unlink(path.join(downloadDirectory, safeName), () => {}); })` — удаляет недозагруженный файл при разрыве соединения / отмене

### Обработка ошибок multer

В обработчике-обёртке (или через next-middleware):
- `MulterError.code === 'LIMIT_FILE_SIZE'` → `413, { error: 'Файл превышает лимит 20 ГБ' }` + удаление частичного файла
- `err.message === 'UNSUPPORTED_MEDIA_TYPE'` → `415, { error: 'Поддерживаются только видеофайлы' }`
- Прочие ошибки → `500, { error: err.message }` + удаление частичного файла

## Фронтенд

### HTML (`public/index.html`)

В секции «Добавить торрент» после блока загрузки `.torrent`:

```html
<div class="form-group">
  <label for="videoFile">Видеофайл:</label>
  <div class="input-row">
    <input type="file" id="videoFile" accept="video/*,.mkv,.ts,.m4v">
    <button id="uploadVideo">Загрузить</button>
  </div>
  <div id="videoUploadProgress" class="video-upload-progress" style="display: none;">
    <div class="progress-info">
      <span id="videoUploadName"></span>
      <span id="videoUploadStats">0% • 0 МБ/с</span>
    </div>
    <div class="progress-bar">
      <div class="progress-bar-fill" id="videoUploadFill"></div>
    </div>
    <button id="videoUploadCancel" class="btn-small btn-secondary">Отмена</button>
  </div>
</div>
```

### Модальное окно конфликта

В конце `<body>` (рядом с `#notifications`):

```html
<div id="conflictModal" class="modal" style="display: none;">
  <div class="modal-overlay"></div>
  <div class="modal-content">
    <h3>Файл уже существует</h3>
    <p>В каталоге загрузок уже есть файл <strong id="conflictFilename"></strong>.</p>
    <p>Что сделать?</p>
    <div class="modal-actions">
      <button id="conflictOverwrite" class="btn-primary">Перезаписать</button>
      <button id="conflictRename" class="btn-primary">Сохранить как <span id="conflictSuggested"></span></button>
      <button id="conflictCancel" class="btn-secondary">Отмена</button>
    </div>
  </div>
</div>
```

### JS (`public/app.js`) — основные функции

```
uploadVideoFile()                — главный обработчик кнопки «Загрузить»
  ↓
askConflictResolution(name, suggested) → Promise<'overwrite' | 'rename' | 'cancel'>
  ↓
performUpload(file, targetName, mode) — XHR + onprogress + abort
  ↓
loadFiles() — обновить список после успеха
```

Псевдокод `uploadVideoFile`:
```
1. file = input.files[0]; если нет — уведомление об ошибке, выход
2. Клиентская валидация:
   - расширение в whitelist (быстрая ошибка)
   - file.size <= 20 ГБ
3. preflightResult = await fetch('/api/upload/video/check?name=' + file.name)
4. let targetName = preflightResult.safeName, mode = 'new'
5. if (preflightResult.exists):
     choice = await askConflictResolution(safeName, suggested)
     if (choice === 'cancel') return
     if (choice === 'overwrite') mode = 'overwrite'
     if (choice === 'rename') targetName = suggested
6. await performUpload(file, targetName, mode)
7. loadFiles()
```

Псевдокод `performUpload`:
```
xhr = new XMLHttpRequest()
xhr.upload.onprogress = (e) => updateProgressUI(e.loaded, e.total, startTime)
xhr.onload = () => resolveOnSuccessOr ShowError
xhr.onerror = () => showError + удалить серверу не нужно (он сам отслеживает aborted)
xhr.onabort = () => showCancelled
cancelButton.onclick = () => xhr.abort()
fd = new FormData(); fd.append('videoFile', file)
xhr.open('POST', '/api/upload/video?targetName=' + encodeURIComponent(targetName) + '&mode=' + mode)
xhr.setRequestHeader('Authorization', 'Bearer ' + token)
xhr.send(fd)
```

Расчёт скорости: `bytesPerSec = loaded / ((Date.now() - startTime) / 1000)`, отображать в МБ/с (`bytesPerSec / 1024 / 1024`).

### CSS (`public/style.css`)

Новые селекторы (используют существующие CSS-переменные тёмной темы):
- `.video-upload-progress` — контейнер прогресса, `display: flex; flex-direction: column; gap: 8px; margin-top: 12px;`
- `.progress-info` — горизонтальная строка с именем и статистикой
- `.progress-bar` — фон полосы прогресса
- `.progress-bar-fill` — заливка (`transition: width 0.2s`)
- `.modal`, `.modal-overlay`, `.modal-content`, `.modal-actions` — модалка по существующей цветовой схеме

Если в проекте уже есть переменные для overlay/модалок — переиспользуем их; если нет, создаём минимальный набор стилей.

## Безопасность

| Угроза | Меры |
|--------|------|
| Path traversal через `targetName` | `sanitizeFilename` + проверка `safeName !== '.'/'..'`; `path.join(downloadDirectory, safeName)` после `path.normalize` |
| Запись вне `downloadDirectory` | Проверка `resolvedPath.startsWith(downloadDirectory)` перед записью |
| Загрузка исполняемых/опасных файлов | Whitelist расширений |
| Несанкционированный доступ | `authMiddleware` на обоих эндпоинтах |
| DoS заполнением диска | Лимит 20 ГБ на файл; администратор должен мониторить место (out of scope автоматический мониторинг) |
| Race condition (два одновременных upload с одинаковым именем в `mode=new`) | Принимаем как пограничный случай — последний выигрывает; при необходимости можно усилить через `O_EXCL`, но это излишняя сложность для локального приложения |

## Логирование

В консоль сервера добавить:
- `Видео загружено: <filename> (<size> байт)` — при успехе
- `Загрузка видео отменена: <filename>` — при aborted
- `Ошибка загрузки видео: <message>` — при ошибках

## Тестирование (ручное — авто-тестов в проекте нет)

| # | Сценарий | Ожидаемый результат |
|---|----------|---------------------|
| 1 | Загрузить mp4 размером ≤ 100 МБ | Файл появляется в «Скачанных», прогресс достиг 100% |
| 2 | Загрузить mkv размером ≥ 5 ГБ | Прогресс показывает скорость, файл записан корректно |
| 3 | Попытаться загрузить `.exe` | Кнопка отключена клиентской валидацией, либо `415` от сервера |
| 4 | Загрузить файл > 20 ГБ | Серверная ошибка `413`, файл не остаётся на диске |
| 5 | Загрузить файл, имя которого уже есть → «Перезаписать» | Старый файл заменён |
| 6 | То же → «Переименовать в X (1).mp4» | Создан новый файл с суффиксом, старый цел |
| 7 | То же → «Отмена» | Загрузка не начинается |
| 8 | Нажать «Отмена» в середине загрузки | Прогресс прерван, частичный файл удалён с диска |
| 9 | Загрузить mp4, затем смотреть его через «Смотреть» | Воспроизведение работает |
| 10 | Загрузить mp4, затем кастить через DLNA | Кастинг работает |
| 11 | Имя с `../../etc/passwd.mp4` | Имя нормализовано до `passwd.mp4`, файл записан в `downloadDirectory` |
| 12 | Без JWT | `401` на обоих эндпоинтах |

## Версионирование

- `package.json`: 1.1.1 → 1.2.0 (minor — новая функциональность)
- `CHANGELOG.md`: новая запись `## [1.2.0] — 2026-05-21` с описанием функции

## Открытые вопросы

Нет.
