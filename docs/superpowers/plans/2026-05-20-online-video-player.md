# Онлайн-просмотр видео в браузере — план реализации

> **Для агентов:** REQUIRED SUB-SKILL — `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans`. Шаги используют `- [ ]` для отметки прогресса.

**Goal:** Добавить SPA-вьюху онлайн-просмотра видео в веб-интерфейсе с поддержкой нативных и транскодируемых форматов, для скачанных файлов и файлов из активных торрентов.

**Architecture:** Один новый POST-эндпоинт `/api/watch/resolve` на бэкенде (вычисляет stream-URL и mime, переиспользует логику `/api/dlna/cast`). Новая секция `#watchSection` во фронтенде с нативным `<video>`, переключаемая от `#appSection`. Кнопка «▶ Смотреть» в существующих списках. Без новых зависимостей.

**Tech Stack:** Node.js 18+ ESM, Express, WebTorrent, fluent-ffmpeg (уже в проекте). Frontend — vanilla JS. Тестов в проекте нет; верификация ручная через `curl`, браузер и DevTools.

**Спецификация:** `docs/superpowers/specs/2026-05-20-online-video-player-design.md`

---

## File Structure

| Файл | Действие | Ответственность |
|------|---------|-----------------|
| `server.js` | Modify | Добавить эндпоинт `/api/watch/resolve` |
| `public/index.html` | Modify | Добавить `<section id="watchSection">` |
| `public/style.css` | Modify | Стили `.watch-section`, `.watch-header`, `.watch-quality`, `#watchPlayer` |
| `public/app.js` | Modify | Функции `setView`, `openWatch`, `closeWatch`, `changeQuality`; кнопки «Смотреть» в рендерах |
| `package.json` | Modify | Bump версии: `1.0.8` → `1.1.0` |
| `CHANGELOG.md` | Modify | Запись о новой возможности |

---

## Task 1: Эндпоинт `/api/watch/resolve` на бэкенде

**Files:**
- Modify: `server.js` (вставка после блока DLNA Cast — рядом со строкой 698 примерно)

- [ ] **Шаг 1: Изучить существующий блок `/api/dlna/cast`**

Открыть `server.js` и прочесть строки 648–698. Понять, как там выбирается URL (transcode vs stream). Логика будет переиспользована.

- [ ] **Шаг 2: Добавить эндпоинт `/api/watch/resolve`**

Вставить после блока `/api/dlna/cast` (после строки 698, перед `// Управление воспроизведением`):

```javascript
// Резолвинг URL для онлайн-просмотра в браузере
app.post('/api/watch/resolve', authMiddleware, async (req, res) => {
  const { type, filename, infoHash, fileIndex, quality } = req.body;
  const requestedQuality = quality || 'medium';
  const host = req.headers.host;

  try {
    let url, mimeType, title, size, isTranscoding = false, duration = null;

    if (type === 'torrent') {
      if (!infoHash || fileIndex === undefined) {
        return res.status(400).json({ error: 'Укажите infoHash и fileIndex' });
      }

      const fileInfo = streamingServer.getTorrentFileInfo(infoHash, fileIndex);
      if (!fileInfo) {
        return res.status(404).json({ error: 'Файл торрента не найден' });
      }

      url = streamingServer.getTorrentStreamUrl(infoHash, fileIndex, host);
      mimeType = fileInfo.mimeType;
      title = fileInfo.name;
      size = fileInfo.size;
    } else if (type === 'file') {
      if (!filename) {
        return res.status(400).json({ error: 'Укажите filename' });
      }

      const fileInfo = streamingServer.getFileInfo(filename);
      if (!fileInfo) {
        return res.status(404).json({ error: 'Файл не найден' });
      }

      const needsTranscoding = transcoder.needsTranscoding(filename);
      const forceTranscoding = requestedQuality !== 'original' && requestedQuality !== undefined;

      if (needsTranscoding || forceTranscoding) {
        url = transcoder.getTranscodeUrl(filename, host, requestedQuality);
        mimeType = 'video/mp4';
        isTranscoding = true;
      } else {
        url = streamingServer.getStreamUrl(filename, host);
        mimeType = fileInfo.mimeType;
      }

      title = path.basename(filename);
      size = fileInfo.size;

      try {
        const info = await transcoder.getMediaInfo(path.join(downloadDirectory, filename));
        duration = info.duration || null;
      } catch (e) {
        duration = null;
      }
    } else {
      return res.status(400).json({ error: 'Неизвестный type, ожидается "file" или "torrent"' });
    }

    res.json({
      url,
      mimeType,
      title,
      size,
      duration,
      isTranscoding,
      qualities: ['original', 'high', 'medium', 'low']
    });
  } catch (error) {
    console.error('Ошибка resolve:', error.message);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Шаг 3: Проверить, что Express парсит JSON для POST**

Проверить, что `app.use(express.json())` уже подключён в `server.js` (обычно в начале файла, после `const app = express()`). Если нет — добавить.

- [ ] **Шаг 4: Запустить сервер и проверить эндпоинт**

```powershell
npm start
```

В отдельном окне получить JWT (из браузера через DevTools → Application → LocalStorage → `authToken`) и проверить:

```powershell
curl -X POST http://localhost:3000/api/watch/resolve `
  -H "Authorization: Bearer YOUR_JWT" `
  -H "Content-Type: application/json" `
  -d '{\"type\":\"file\",\"filename\":\"some-existing.mp4\",\"quality\":\"medium\"}'
```

Ожидаемый ответ — JSON с полями `url`, `mimeType: "video/mp4"`, `isTranscoding: false`, `duration`, `size`.

Затем проверить для `.mkv` (если есть):

```powershell
curl -X POST http://localhost:3000/api/watch/resolve `
  -H "Authorization: Bearer YOUR_JWT" `
  -H "Content-Type: application/json" `
  -d '{\"type\":\"file\",\"filename\":\"some.mkv\",\"quality\":\"medium\"}'
```

Ожидаем `isTranscoding: true`, `url` содержит `/api/transcode/`.

- [ ] **Шаг 5: Проверить 404-кейсы**

```powershell
curl -X POST http://localhost:3000/api/watch/resolve `
  -H "Authorization: Bearer YOUR_JWT" `
  -H "Content-Type: application/json" `
  -d '{\"type\":\"file\",\"filename\":\"nonexistent.mp4\"}'
```

Ожидаем `HTTP 404` с `{"error":"Файл не найден"}`.

- [ ] **Шаг 6: Коммит**

```powershell
git add server.js
git commit -m "feat: add /api/watch/resolve endpoint for in-browser video playback"
```

---

## Task 2: HTML-разметка плеера

**Files:**
- Modify: `public/index.html` (вставка новой секции после `dlna-section`, перед закрытием `</main>`)

- [ ] **Шаг 1: Добавить секцию плеера в `index.html`**

Вставить **перед** строкой `</main>` (строка 150 в текущем файле):

```html
      <!-- Онлайн-просмотр видео -->
      <section id="watchSection" class="watch-section" style="display: none;">
        <header class="watch-header">
          <button id="watchBack" class="btn-secondary">← К списку</button>
          <h2 id="watchTitle" class="watch-title"></h2>
          <div class="watch-quality">
            <label for="qualitySelect">Качество:</label>
            <select id="qualitySelect">
              <option value="original">Оригинал</option>
              <option value="high">Высокое (1080p)</option>
              <option value="medium" selected>Среднее (720p)</option>
              <option value="low">Низкое (480p)</option>
            </select>
          </div>
        </header>
        <video id="watchPlayer" controls preload="metadata"></video>
        <div id="watchStatus" class="watch-status"></div>
      </section>
```

- [ ] **Шаг 2: Проверить разметку в браузере**

Перезагрузить страницу. Секция должна быть в DOM, но скрыта (`display: none`). Проверить через DevTools → Elements, что `<section id="watchSection">` присутствует.

Временно убрать `style="display: none;"` чтобы увидеть, как выглядит без CSS — будет «голый» HTML. Затем вернуть `display: none;`.

- [ ] **Шаг 3: Коммит**

```powershell
git add public/index.html
git commit -m "feat: add watch section markup to index.html"
```

---

## Task 3: CSS-стили плеера

**Files:**
- Modify: `public/style.css` (добавление в конец файла)

- [ ] **Шаг 1: Добавить стили в конец `style.css`**

Дописать в самый конец `public/style.css`:

```css
/* === Онлайн-просмотр видео === */

.watch-section {
  padding: 20px 0;
}

.watch-header {
  display: flex;
  align-items: center;
  gap: 15px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.watch-title {
  flex: 1;
  color: #00d9ff;
  font-size: 1.2rem;
  margin: 0;
  word-break: break-all;
  min-width: 0;
}

.watch-quality {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #a0a0a0;
}

.watch-quality select {
  background: #16213e;
  border: 1px solid #00d9ff;
  color: #e4e4e4;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 0.9rem;
  cursor: pointer;
}

#watchPlayer {
  width: 100%;
  max-height: calc(100vh - 240px);
  background: #000;
  border-radius: 6px;
  outline: none;
}

.watch-status {
  margin-top: 12px;
  padding: 10px;
  color: #a0a0a0;
  font-size: 0.9rem;
  min-height: 1.2em;
}

.watch-status.error {
  color: #ff6b6b;
}

.btn-watch {
  background: transparent;
  border: 1px solid #00d9ff;
  color: #00d9ff;
  padding: 6px 12px;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
}

.btn-watch:hover {
  background: rgba(0, 217, 255, 0.1);
}
```

- [ ] **Шаг 2: Визуальная проверка**

Перезагрузить страницу, временно убрать `display: none` у `#watchSection` через DevTools. Плеер должен быть тёмным, селектор качества справа, кнопка «К списку» слева, заголовок по центру. Вернуть `display: none`.

- [ ] **Шаг 3: Коммит**

```powershell
git add public/style.css
git commit -m "style: add watch section styles"
```

---

## Task 4: JS — переключение вьюхи и базовая логика плеера

**Files:**
- Modify: `public/app.js` (добавление DOM-ссылок и функций)

- [ ] **Шаг 1: Добавить DOM-ссылки**

В блок DOM-ссылок (`public/app.js`, после строки 39, перед `// Интервал обновления`), добавить:

```javascript
// Watch (онлайн-просмотр) элементы
const watchSection = document.getElementById('watchSection');
const watchBack = document.getElementById('watchBack');
const watchTitle = document.getElementById('watchTitle');
const watchPlayer = document.getElementById('watchPlayer');
const watchStatus = document.getElementById('watchStatus');
const qualitySelect = document.getElementById('qualitySelect');

// Текущий контекст просмотра (file или torrent)
let currentWatch = null;
```

- [ ] **Шаг 2: Добавить функцию `setView` и `openWatch`/`closeWatch`**

Добавить в `public/app.js` после функции `escapeHtml` (после строки 583):

```javascript
// === Онлайн-просмотр видео ===

// Ключ для localStorage позиции воспроизведения
function watchPosKey(ctx) {
  if (ctx.type === 'torrent') return `watch:pos:torrent:${ctx.infoHash}:${ctx.fileIndex}`;
  return `watch:pos:file:${ctx.filename}`;
}

// Переключение вьюхи library <-> watch
function setView(view) {
  const mainElements = appSection.querySelectorAll('main > section:not(#watchSection)');
  if (view === 'watch') {
    mainElements.forEach(el => el.style.display = 'none');
    watchSection.style.display = 'block';
  } else {
    mainElements.forEach(el => el.style.display = '');
    watchSection.style.display = 'none';
  }
}

// Открыть видео в плеере
async function openWatch(ctx) {
  currentWatch = ctx;
  watchStatus.textContent = 'Загрузка...';
  watchStatus.classList.remove('error');
  watchTitle.textContent = '';

  const quality = qualitySelect.value || 'medium';

  try {
    const body = ctx.type === 'torrent'
      ? { type: 'torrent', infoHash: ctx.infoHash, fileIndex: ctx.fileIndex, quality }
      : { type: 'file', filename: ctx.filename, quality };

    const response = await apiRequest('/api/watch/resolve', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось получить URL стрима');
    }

    watchTitle.textContent = data.title;
    watchPlayer.src = data.url;
    setView('watch');

    // Восстановление позиции
    const savedPos = parseFloat(localStorage.getItem(watchPosKey(ctx)));
    if (savedPos && !isNaN(savedPos) && savedPos > 5) {
      const restorePos = () => {
        if (data.duration && savedPos < data.duration - 30) {
          watchPlayer.currentTime = savedPos;
          showNotification(`Продолжаем с ${formatTime(savedPos)}`, 'success');
        }
      };
      watchPlayer.addEventListener('loadedmetadata', restorePos, { once: true });
    }

    watchStatus.textContent = data.isTranscoding
      ? 'Транскодирование в реальном времени (перемотка ограничена)'
      : '';

    watchPlayer.play().catch(() => {
      // Autoplay может быть запрещён браузером — игнорируем
    });
  } catch (error) {
    watchStatus.textContent = 'Ошибка: ' + error.message;
    watchStatus.classList.add('error');
    setView('watch');
  }
}

// Закрыть плеер и вернуться к списку
function closeWatch() {
  if (currentWatch && watchPlayer.currentTime > 5) {
    localStorage.setItem(watchPosKey(currentWatch), String(watchPlayer.currentTime));
  }
  watchPlayer.pause();
  watchPlayer.removeAttribute('src');
  watchPlayer.load();
  currentWatch = null;
  setView('library');
}

// Сделать функцию доступной для inline onclick
window.openWatchFile = function(filename) {
  openWatch({ type: 'file', filename });
};
window.openWatchTorrent = function(infoHash, fileIndex) {
  openWatch({ type: 'torrent', infoHash, fileIndex: Number(fileIndex) });
};
```

- [ ] **Шаг 3: Подключить обработчики кнопок**

Найти в `public/app.js` блок инициализации обработчиков (обычно в конце файла или внутри `DOMContentLoaded`). Добавить:

```javascript
watchBack.addEventListener('click', closeWatch);

// Сохранение позиции на ключевых событиях
watchPlayer.addEventListener('pause', () => {
  if (currentWatch && watchPlayer.currentTime > 5) {
    localStorage.setItem(watchPosKey(currentWatch), String(watchPlayer.currentTime));
  }
});
watchPlayer.addEventListener('seeked', () => {
  if (currentWatch && watchPlayer.currentTime > 5) {
    localStorage.setItem(watchPosKey(currentWatch), String(watchPlayer.currentTime));
  }
});
window.addEventListener('beforeunload', () => {
  if (currentWatch && watchPlayer.currentTime > 5) {
    localStorage.setItem(watchPosKey(currentWatch), String(watchPlayer.currentTime));
  }
});

// Ошибки воспроизведения
watchPlayer.addEventListener('error', () => {
  const err = watchPlayer.error;
  const msg = err ? `Код ${err.code}` : 'неизвестная';
  watchStatus.textContent = `Ошибка воспроизведения (${msg}). Попробуйте другое качество.`;
  watchStatus.classList.add('error');
});
```

- [ ] **Шаг 4: Промежуточная проверка в DevTools-консоли**

Перезагрузить страницу, в DevTools-консоли выполнить (заменив имя на реальное):

```javascript
openWatch({ type: 'file', filename: 'YOUR_VIDEO.mp4' })
```

Плеер должен открыться, видео — начать играть.

- [ ] **Шаг 5: Коммит**

```powershell
git add public/app.js
git commit -m "feat: add watch view with playback and position memory"
```

---

## Task 5: Кнопки «Смотреть» в списках скачанных файлов и торрентов

**Files:**
- Modify: `public/app.js` — функции `renderFiles` (строка 558) и блок рендера файлов торрента (строки 488–495)

- [ ] **Шаг 1: Расширить `isMediaFile` или добавить хелпер для видео**

Существующая `isMediaFile` (строка 551) включает audio. Для плеера нам нужны только видео. Добавить рядом со строкой 555:

```javascript
// Является ли файл видео (без audio)
function isVideoFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const videoExtensions = ['mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv', 'flv', 'm4v'];
  return videoExtensions.includes(ext);
}
```

- [ ] **Шаг 2: Добавить кнопку «Смотреть» в `renderFiles`**

Найти в `renderFiles` (строка 564) блок `<div class="file-actions">` и заменить его на:

```javascript
      <div class="file-actions">
        ${isVideoFile(file.name) ? `<button class="btn-watch btn-small" onclick="openWatchFile('${escapeHtml(file.name).replace(/'/g, "\\'")}')">▶ Смотреть</button>` : ''}
        ${isMediaFile(file.name) ? `<button class="btn-cast btn-small" onclick="showCastModal('${escapeHtml(file.name)}')">Транслировать</button>` : ''}
        <button class="btn-danger btn-small" onclick="removeFile('${escapeHtml(file.name)}')">Удалить</button>
      </div>
```

- [ ] **Шаг 3: Добавить кнопку «Смотреть» в рендер файлов торрента**

Найти строку 493 в `renderTorrents` (внутри `.map((file, index) => ...)`):

```javascript
                ${isMediaFile(file.name) ? `<button class="btn-cast btn-small" onclick="showCastModal(null, {infoHash: '${torrent.infoHash}', fileIndex: ${index}})">Cast</button>` : ''}
```

Заменить на:

```javascript
                ${isVideoFile(file.name) && file.selected !== false ? `<button class="btn-watch btn-small" onclick="openWatchTorrent('${torrent.infoHash}', ${index})">▶ Смотреть</button>` : ''}
                ${isMediaFile(file.name) ? `<button class="btn-cast btn-small" onclick="showCastModal(null, {infoHash: '${torrent.infoHash}', fileIndex: ${index}})">Cast</button>` : ''}
```

- [ ] **Шаг 4: Проверка в браузере**

Перезагрузить страницу. Убедиться:
- У каждого скачанного видеофайла появилась кнопка «▶ Смотреть».
- В развёрнутом списке файлов активного торрента (если есть) — то же.
- Аудиофайлы и не-видео кнопку **не** получают.
- Клик по «Смотреть» открывает плеер, видео играет.

- [ ] **Шаг 5: Проверить разные форматы вручную**

Минимальный набор: `.mp4` (нативный), `.mkv` (транскод). Для `.mkv` подождать ~5 секунд — буферизация транскода занимает время.

- [ ] **Шаг 6: Коммит**

```powershell
git add public/app.js
git commit -m "feat: add Watch buttons to file lists"
```

---

## Task 6: Переключение качества во время воспроизведения

**Files:**
- Modify: `public/app.js`

- [ ] **Шаг 1: Добавить функцию `changeQuality` и обработчик селектора**

Добавить в `public/app.js` рядом с `openWatch` (после функции `closeWatch`):

```javascript
// Изменение качества во время воспроизведения
async function changeQuality() {
  if (!currentWatch) return;

  const savedTime = watchPlayer.currentTime;
  const wasPlaying = !watchPlayer.paused;

  await openWatch(currentWatch);

  const restoreTime = () => {
    if (savedTime > 5) {
      watchPlayer.currentTime = savedTime;
    }
    if (wasPlaying) {
      watchPlayer.play().catch(() => {});
    }
  };
  watchPlayer.addEventListener('loadedmetadata', restoreTime, { once: true });
}
```

И в блок инициализации обработчиков добавить:

```javascript
qualitySelect.addEventListener('change', changeQuality);
```

- [ ] **Шаг 2: Проверка в браузере**

Открыть видео `.mkv` (транскод). Во время воспроизведения переключить качество с `medium` на `high`. Видео должно перезагрузиться и продолжить с того же места (с небольшой буферизацией).

Для нативного `.mp4` (где транскод не нужен по дефолту) — переключение на `high` теперь принудительно включит транскод (потому что `quality !== 'original'`). Это **по спецификации** — пользователь явно выбрал «не оригинал», значит хочет преобразование. Если это нежелательно — добавить опцию «Оригинал» как default. (Уже есть в селекторе на позиции 1.)

- [ ] **Шаг 3: Коммит**

```powershell
git add public/app.js
git commit -m "feat: add quality switching with position preservation"
```

---

## Task 7: Версионирование и CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `public/index.html` (метка версии в футере, строка 155)

- [ ] **Шаг 1: Прочесть текущие версии**

```powershell
Get-Content package.json | Select-String version
Get-Content CHANGELOG.md -TotalCount 30
```

- [ ] **Шаг 2: Поднять версию в `package.json`**

В `package.json` найти `"version": "1.0.8"` и заменить на `"version": "1.1.0"`.

- [ ] **Шаг 3: Обновить футер в `index.html`**

В `public/index.html` строка 155: заменить `v1.0.8` на `v1.1.0`.

- [ ] **Шаг 4: Добавить запись в `CHANGELOG.md`**

Добавить в начало (под заголовком, перед записью `## [1.0.8]`):

```markdown
## [1.1.0] - 2026-05-20

### Added
- Онлайн-просмотр видео прямо в браузере: отдельная SPA-вьюха с нативным `<video>`-плеером.
- Кнопка «▶ Смотреть» рядом с каждым видеофайлом — и в списке скачанных, и в развёрнутом списке файлов активного торрента (стриминг во время загрузки).
- Селектор качества (Оригинал / Высокое / Среднее / Низкое) с переключением «на лету» без потери позиции.
- Автоматическое транскодирование MKV/AVI/MOV/WMV/FLV/M4V в MP4 для совместимости с браузерами.
- Сохранение позиции воспроизведения в `localStorage` — при повторном открытии предлагается продолжить.
- Новый эндпоинт `POST /api/watch/resolve` для определения stream-URL и метаданных видео.
```

- [ ] **Шаг 5: Коммит**

```powershell
git add package.json CHANGELOG.md public/index.html
git commit -m "chore: bump version to 1.1.0 and update changelog"
```

---

## Task 8: Финальная end-to-end проверка

Эта таска — ручной чек-лист без правок кода (если что-то найдётся — открыть отдельный fix-commit).

- [ ] **Чек 1: Сценарий — скачанный MP4**

1. Запустить `npm start`.
2. Войти в браузере.
3. В разделе «Скачанные файлы» нажать «▶ Смотреть» у `.mp4`.
4. Видео должно начать играть. Перемотка работает.
5. Селектор качества показан, по умолчанию «Среднее».

- [ ] **Чек 2: Сценарий — скачанный MKV (транскод)**

1. Нажать «▶ Смотреть» у `.mkv`.
2. Появляется сообщение «Транскодирование в реальном времени».
3. Через 3–10 секунд видео начинает играть.
4. Перемотка вперёд — ограниченно, но в начало работает.

- [ ] **Чек 3: Сценарий — активный торрент**

1. Добавить торрент с видеофайлом.
2. Дождаться, пока WebTorrent получит метаданные и начнётся загрузка.
3. Раскрыть список файлов кнопкой «Показать файлы».
4. У видеофайла должна быть кнопка «▶ Смотреть».
5. Клик → видео играет из частично-скачанного торрента.

- [ ] **Чек 4: Сценарий — переключение качества**

1. Во время воспроизведения сменить качество.
2. Видео перезагружается, позиция сохраняется.

- [ ] **Чек 5: Сценарий — сохранение позиции**

1. Посмотреть видео на 30+ секунд.
2. Нажать «← К списку».
3. Снова открыть тот же файл.
4. Появится уведомление «Продолжаем с 0:30», позиция восстановлена.

- [ ] **Чек 6: Сценарий — ошибки**

1. Открыть DevTools → Network. Попробовать открыть несуществующий файл через консоль:
   ```javascript
   openWatchFile('nonexistent.mp4')
   ```
2. Должно появиться красное сообщение об ошибке в `#watchStatus`.

- [ ] **Чек 7: Совместимость с DLNA**

1. Открыть видеофайл в плеере.
2. Затем закрыть плеер и нажать «Транслировать» у того же файла.
3. DLNA-функциональность должна работать без регрессий.

- [ ] **Финальный коммит (если были fix-правки)**

Если в ходе проверки нашлись и поправились мелкие баги — собрать их в один коммит:

```powershell
git add .
git commit -m "fix: minor adjustments after end-to-end testing"
```

---

## Critical Notes

1. **Стрим-эндпоинты остаются открытыми (без `authMiddleware`).** Это **намеренно** — DLNA-устройства не могут отправлять JWT. Веб-плеер использует то же поведение. Не добавляйте авторизацию на `/api/stream/*` и `/api/transcode/*` в этой итерации.

2. **`/api/transcode/` параметр — `quality`, НЕ `preset`.** Проверено в `dlna/transcoder.js:148`.

3. **FFmpeg транскод-стрим не поддерживает Range.** Перемотка в транскоде ограничена возможностями браузера (только в уже буферизованную часть). Это явно сообщается пользователю в `#watchStatus`.

4. **Inline `onclick` — паттерн проекта.** В существующем `app.js` повсюду `onclick="..."`. Следуйте этому стилю — это не место для рефакторинга на event-делегирование.

5. **`escapeHtml` экранирует HTML, но не JS-строку.** В onclick-атрибутах с одинарными кавычками возможны кавычки в имени файла. Решение: `.replace(/'/g, "\\'")` в Task 5 шаг 2.

6. **Никаких новых npm-зависимостей.** Если ловите искушение подключить Plyr или hls.js — это вторая итерация (v1.2.0+), не сейчас.

7. **Используйте github plugin для всех удалённых git-операций** (правило из CLAUDE.md). Локальные `git add`/`git commit` — обычными командами.
