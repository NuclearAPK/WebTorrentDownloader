// Токен авторизации
let authToken = localStorage.getItem('authToken');

// Элементы DOM
const authSection = document.getElementById('authSection');
const appSection = document.getElementById('appSection');
const authTabs = document.querySelectorAll('.auth-tab');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const logoutBtn = document.getElementById('logoutBtn');
const usernameDisplay = document.getElementById('usernameDisplay');

const magnetInput = document.getElementById('magnetUri');
const addMagnetBtn = document.getElementById('addMagnet');
const torrentFileInput = document.getElementById('torrentFile');
const uploadTorrentBtn = document.getElementById('uploadTorrent');
const downloadDirInput = document.getElementById('downloadDir');
const changeDirBtn = document.getElementById('changeDir');
const torrentsList = document.getElementById('torrentsList');
const filesList = document.getElementById('filesList');
const refreshFilesBtn = document.getElementById('refreshFiles');
const notifications = document.getElementById('notifications');

// DLNA элементы
const dlnaServerIndicator = document.getElementById('dlnaServerIndicator');
const dlnaServerStatusText = document.getElementById('dlnaServerStatusText');
const startDlnaServerBtn = document.getElementById('startDlnaServer');
const stopDlnaServerBtn = document.getElementById('stopDlnaServer');
const scanDevicesBtn = document.getElementById('scanDevices');
const devicesList = document.getElementById('devicesList');
const playbackPanel = document.getElementById('playbackPanel');
const playbackDevice = document.getElementById('playbackDevice');
const playbackStatus = document.getElementById('playbackStatus');
const playbackPosition = document.getElementById('playbackPosition');
const playbackDuration = document.getElementById('playbackDuration');
const playbackBarFill = document.getElementById('playbackBarFill');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');

// Watch (онлайн-просмотр) элементы
const watchSection = document.getElementById('watchSection');
const watchBack = document.getElementById('watchBack');
const watchTitle = document.getElementById('watchTitle');
const watchPlayer = document.getElementById('watchPlayer');
const watchStatus = document.getElementById('watchStatus');
const qualitySelect = document.getElementById('qualitySelect');

// Текущий контекст просмотра (file или torrent)
let currentWatch = null;

// Интервал обновления статуса воспроизведения
let playbackStatusInterval = null;

// Трекинг торрентов для автоматического показа выбора файлов
const seenTorrentFiles = new Set();

// Последние данные торрентов из SSE (для доступа из UI)
let lastTorrentsData = [];

// API запрос с авторизацией
async function apiRequest(url, options = {}) {
  const headers = options.headers || {};

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  if (!(options.body instanceof FormData) && options.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    logout();
    throw new Error('Сессия истекла');
  }

  return response;
}

// Переключение вкладок авторизации
function switchAuthTab(tab) {
  authTabs.forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'login') {
    loginForm.style.display = 'block';
    registerForm.style.display = 'none';
  } else {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
  }
}

// Вход
async function login(username, password) {
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (response.ok) {
      authToken = data.token;
      localStorage.setItem('authToken', authToken);
      showApp(data.user.username);
      showNotification('Вход выполнен', 'success');
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка входа', 'error');
  }
}

// Регистрация
async function register(username, password) {
  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (response.ok) {
      authToken = data.token;
      localStorage.setItem('authToken', authToken);
      showApp(data.user.username);
      showNotification('Регистрация успешна', 'success');
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка регистрации', 'error');
  }
}

// Выход
function logout() {
  authToken = null;
  localStorage.removeItem('authToken');
  showAuth();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// Показать форму авторизации
function showAuth() {
  authSection.style.display = 'flex';
  appSection.style.display = 'none';
}

// Показать приложение
function showApp(username) {
  authSection.style.display = 'none';
  appSection.style.display = 'block';
  usernameDisplay.textContent = username;

  loadCurrentDirectory();
  loadFiles();
  connectSSE();

  // Загружаем DLNA статус
  loadDlnaServerStatus();
  loadDevices();
  loadPlaybackStatus();
}

// Проверка текущей сессии
async function checkAuth() {
  if (!authToken) {
    showAuth();
    return;
  }

  try {
    const response = await apiRequest('/api/auth/me');
    const data = await response.json();

    if (response.ok) {
      showApp(data.user.username);
    } else {
      logout();
    }
  } catch (error) {
    logout();
  }
}

// Форматирование байтов
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Форматирование скорости
function formatSpeed(bytesPerSecond) {
  return formatBytes(bytesPerSecond) + '/s';
}

// Показать уведомление
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notifications.appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 4000);
}

// Загрузка текущего каталога
async function loadCurrentDirectory() {
  try {
    const response = await apiRequest('/api/settings/directory');
    const data = await response.json();
    downloadDirInput.value = data.directory;
  } catch (error) {
    console.error('Ошибка загрузки каталога:', error);
  }
}

// Добавить торрент по магнет-ссылке
async function addMagnetLink() {
  const magnetUri = magnetInput.value.trim();
  if (!magnetUri) {
    showNotification('Введите магнет-ссылку', 'error');
    return;
  }

  try {
    const response = await apiRequest('/api/download/magnet', {
      method: 'POST',
      body: JSON.stringify({ magnetUri })
    });

    const data = await response.json();

    if (response.ok) {
      showNotification('Торрент добавлен', 'success');
      magnetInput.value = '';
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка добавления торрента', 'error');
  }
}

// Загрузить .torrent файл
async function uploadTorrentFile() {
  const file = torrentFileInput.files[0];
  if (!file) {
    showNotification('Выберите .torrent файл', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('torrentFile', file);

  try {
    const response = await apiRequest('/api/download/file', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (response.ok) {
      showNotification('Торрент файл добавлен', 'success');
      torrentFileInput.value = '';
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка загрузки файла', 'error');
  }
}

// Изменить каталог загрузки
async function changeDirectory() {
  const directory = downloadDirInput.value.trim();
  if (!directory) {
    showNotification('Введите путь к каталогу', 'error');
    return;
  }

  try {
    const response = await apiRequest('/api/settings/directory', {
      method: 'POST',
      body: JSON.stringify({ directory })
    });

    const data = await response.json();

    if (response.ok) {
      showNotification('Каталог изменён', 'success');
      downloadDirInput.value = data.directory;
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка изменения каталога', 'error');
  }
}

// Удалить торрент
async function removeTorrent(infoHash) {
  try {
    const response = await apiRequest(`/api/torrents/${infoHash}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (response.ok) {
      showNotification('Торрент удалён', 'success');
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка удаления торрента', 'error');
  }
}

// Пауза торрента
async function pauseTorrent(infoHash) {
  try {
    const response = await apiRequest(`/api/torrents/${infoHash}/pause`, { method: 'POST' });
    const data = await response.json();
    if (response.ok) {
      showNotification('Торрент приостановлен', 'info');
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка приостановки торрента', 'error');
  }
}

// Возобновление торрента
async function resumeTorrent(infoHash) {
  try {
    const response = await apiRequest(`/api/torrents/${infoHash}/resume`, { method: 'POST' });
    const data = await response.json();
    if (response.ok) {
      showNotification('Торрент возобновлён', 'success');
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка возобновления торрента', 'error');
  }
}

// Выбор файлов торрента
async function selectTorrentFiles(infoHash, selectedFiles) {
  try {
    const response = await apiRequest(`/api/torrents/${infoHash}/select-files`, {
      method: 'POST',
      body: JSON.stringify({ selectedFiles })
    });
    const data = await response.json();
    if (response.ok) {
      showNotification('Выбор файлов обновлён', 'success');
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка выбора файлов', 'error');
  }
}

// Открыть выбор файлов по infoHash (из кнопки в UI)
function showFileSelectionForHash(infoHash) {
  const torrent = lastTorrentsData.find(t => t.infoHash === infoHash);
  if (torrent) showFileSelectionModal(torrent);
}

// Модальное окно выбора файлов торрента
function showFileSelectionModal(torrent) {
  const modal = document.createElement('div');
  modal.className = 'cast-modal';
  modal.innerHTML = `
    <div class="cast-modal-content file-select-modal">
      <h3>Выберите файлы для скачивания</h3>
      <p class="file-select-torrent-name">${escapeHtml(torrent.name)}</p>
      <div class="file-select-actions-top">
        <button class="btn-small btn-secondary" id="fileSelectAll">Выбрать все</button>
        <button class="btn-small btn-secondary" id="fileDeselectAll">Снять все</button>
      </div>
      <div class="file-select-list">
        ${torrent.files
          .map((file, index) => ({ ...file, originalIndex: index }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(file => `
          <label class="file-select-item">
            <input type="checkbox" value="${file.originalIndex}" ${file.selected !== false ? 'checked' : ''}>
            <span class="file-select-name">${escapeHtml(file.name)}</span>
            <span class="file-select-size">${formatBytes(file.length)}</span>
          </label>
        `).join('')}
      </div>
      <div class="file-select-footer">
        <button class="btn-primary" id="fileSelectConfirm">Скачать выбранные</button>
        <button class="btn-secondary" id="fileSelectAll2">Скачать все</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const checkboxes = modal.querySelectorAll('input[type="checkbox"]');

  modal.querySelector('#fileSelectAll').addEventListener('click', () => {
    checkboxes.forEach(cb => cb.checked = true);
  });

  modal.querySelector('#fileDeselectAll').addEventListener('click', () => {
    checkboxes.forEach(cb => cb.checked = false);
  });

  modal.querySelector('#fileSelectConfirm').addEventListener('click', () => {
    const selected = [];
    checkboxes.forEach(cb => {
      if (cb.checked) selected.push(parseInt(cb.value));
    });
    if (selected.length === 0) {
      showNotification('Выберите хотя бы один файл', 'error');
      return;
    }
    selectTorrentFiles(torrent.infoHash, selected);
    modal.remove();
  });

  modal.querySelector('#fileSelectAll2').addEventListener('click', () => {
    const allIndices = torrent.files.map((_, i) => i);
    selectTorrentFiles(torrent.infoHash, allIndices);
    modal.remove();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// Отрисовка списка торрентов
function renderTorrents(torrents) {
  if (torrents.length === 0) {
    torrentsList.innerHTML = '<p class="empty-message">Нет активных загрузок</p>';
    return;
  }

  torrentsList.innerHTML = torrents.map(torrent => `
    <div class="torrent-item ${torrent.done ? 'torrent-done' : ''} ${torrent.paused ? 'torrent-paused' : ''} ${torrent.awaitingFileSelection ? 'torrent-awaiting' : ''}">
      <div class="torrent-header">
        <span class="torrent-name">${escapeHtml(torrent.name)}${torrent.paused && !torrent.awaitingFileSelection ? ' <span class="torrent-paused-badge">На паузе</span>' : ''}${torrent.awaitingFileSelection ? ' <span class="torrent-awaiting-badge">Ожидание выбора файлов</span>' : ''}</span>
        <div class="torrent-actions">
          ${!torrent.done && !torrent.awaitingFileSelection ? (torrent.paused
            ? `<button class="btn-resume" onclick="resumeTorrent('${torrent.infoHash}')">Продолжить</button>`
            : `<button class="btn-pause" onclick="pauseTorrent('${torrent.infoHash}')">Пауза</button>`
          ) : ''}
          ${torrent.files.length > 1 && !torrent.done ? `<button class="btn-secondary btn-small" onclick="showFileSelectionForHash('${torrent.infoHash}')">Файлы</button>` : ''}
          <button class="btn-danger" onclick="removeTorrent('${torrent.infoHash}')">Удалить</button>
        </div>
      </div>
      ${torrent.awaitingFileSelection ? `
      <div class="torrent-awaiting-message">Выберите файлы для скачивания, нажав кнопку «Файлы»</div>
      ` : `
      <div class="progress-container">
        <div class="progress-bar ${torrent.paused ? 'progress-bar-paused' : ''}" style="width: ${torrent.progress}%">
          ${torrent.progress}%
        </div>
      </div>
      <div class="torrent-stats">
        <span>Скачано: <span class="stat-value">${formatBytes(torrent.downloaded)}</span> / ${formatBytes(torrent.length)}</span>
        <span>Скорость: <span class="stat-value">${formatSpeed(torrent.downloadSpeed)}</span></span>
        <span>Отдача: <span class="stat-value">${formatSpeed(torrent.uploadSpeed)}</span></span>
        <span>Пиры: <span class="stat-value">${torrent.numPeers}</span></span>
      </div>
      `}
      ${torrent.files.length > 0 ? `
        <div class="torrent-files">
          <button class="torrent-files-toggle" onclick="toggleFiles(this)">Показать файлы (${torrent.files.length})</button>
          <div class="torrent-files-list" style="display: none;">
            ${torrent.files.map((file, index) => `
              <div class="torrent-file ${!file.selected ? 'torrent-file-deselected' : ''}">
                <span class="torrent-file-name">${escapeHtml(file.name)}</span>
                <span class="torrent-file-size">${formatBytes(file.length)}</span>
                <span class="torrent-file-progress">${file.selected ? file.progress + '%' : 'Пропущен'}</span>
                ${isMediaFile(file.name) ? `<button class="btn-cast btn-small" onclick="showCastModal(null, {infoHash: '${torrent.infoHash}', fileIndex: ${index}})">Cast</button>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `).join('');
}

// Переключение отображения файлов торрента
function toggleFiles(button) {
  const filesList = button.nextElementSibling;
  if (filesList.style.display === 'none') {
    filesList.style.display = 'block';
    button.textContent = button.textContent.replace('Показать', 'Скрыть');
  } else {
    filesList.style.display = 'none';
    button.textContent = button.textContent.replace('Скрыть', 'Показать');
  }
}

// Загрузка списка файлов
async function loadFiles() {
  try {
    const response = await apiRequest('/api/files');
    const files = await response.json();
    renderFiles(files);
  } catch (error) {
    console.error('Ошибка загрузки файлов:', error);
  }
}

// Удалить файл
async function removeFile(filename) {
  if (!confirm(`Удалить файл "${filename}"?`)) {
    return;
  }

  try {
    const response = await apiRequest(`/api/files/${encodeURIComponent(filename)}`, {
      method: 'DELETE'
    });

    const data = await response.json();

    if (response.ok) {
      showNotification('Файл удалён', 'success');
      loadFiles();
    } else {
      showNotification(data.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка удаления файла', 'error');
  }
}

// Проверить, является ли файл медиа-файлом
function isMediaFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mediaExtensions = ['mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv', 'flv', 'm4v', 'mp3', 'flac', 'aac', 'ogg', 'wav'];
  return mediaExtensions.includes(ext);
}

// Отрисовка списка файлов
function renderFiles(files) {
  if (files.length === 0) {
    filesList.innerHTML = '<p class="empty-message">Нет скачанных файлов</p>';
    return;
  }

  filesList.innerHTML = files.map(file => `
    <div class="file-item">
      <div class="file-info">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-size">${formatBytes(file.size)}</div>
      </div>
      <div class="file-actions">
        ${isMediaFile(file.name) ? `<button class="btn-cast btn-small" onclick="showCastModal('${escapeHtml(file.name)}')">Транслировать</button>` : ''}
        <button class="btn-danger btn-small" onclick="removeFile('${escapeHtml(file.name)}')">Удалить</button>
      </div>
    </div>
  `).join('');
}

// Экранирование HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// === Онлайн-просмотр видео ===

function watchPosKey(ctx) {
  if (ctx.type === 'torrent') return `watch:pos:torrent:${ctx.infoHash}:${ctx.fileIndex}`;
  return `watch:pos:file:${ctx.filename}`;
}

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

window.openWatchFile = function(filename) {
  openWatch({ type: 'file', filename });
};
window.openWatchTorrent = function(infoHash, fileIndex) {
  openWatch({ type: 'torrent', infoHash, fileIndex: Number(fileIndex) });
};

// === DLNA функции ===

// Форматирование времени
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Загрузка статуса DLNA сервера
async function loadDlnaServerStatus() {
  try {
    const response = await apiRequest('/api/dlna/server/status');
    const status = await response.json();
    updateDlnaServerUI(status);
  } catch (error) {
    console.error('Ошибка загрузки статуса DLNA:', error);
  }
}

// Обновление UI DLNA сервера
function updateDlnaServerUI(status) {
  if (status.running) {
    dlnaServerIndicator.classList.add('active');
    dlnaServerStatusText.textContent = `DLNA сервер: ${status.name} (${status.ip}:${status.port})`;
    startDlnaServerBtn.style.display = 'none';
    stopDlnaServerBtn.style.display = 'inline-block';
  } else {
    dlnaServerIndicator.classList.remove('active');
    dlnaServerStatusText.textContent = 'DLNA сервер остановлен';
    startDlnaServerBtn.style.display = 'inline-block';
    stopDlnaServerBtn.style.display = 'none';
  }
}

// Запустить DLNA сервер
async function startDlnaServer() {
  try {
    const response = await apiRequest('/api/dlna/server/start', { method: 'POST' });
    const result = await response.json();

    if (response.ok) {
      showNotification('DLNA сервер запущен', 'success');
      loadDlnaServerStatus();
    } else {
      showNotification(result.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка запуска DLNA сервера', 'error');
  }
}

// Остановить DLNA сервер
async function stopDlnaServer() {
  try {
    const response = await apiRequest('/api/dlna/server/stop', { method: 'POST' });
    const result = await response.json();

    if (response.ok) {
      showNotification('DLNA сервер остановлен', 'success');
      loadDlnaServerStatus();
    } else {
      showNotification(result.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка остановки DLNA сервера', 'error');
  }
}

// Загрузка списка устройств
async function loadDevices() {
  try {
    const response = await apiRequest('/api/dlna/devices');
    const data = await response.json();
    renderDevices(data.devices);
  } catch (error) {
    console.error('Ошибка загрузки устройств:', error);
  }
}

// Сканировать устройства
async function scanDevices() {
  try {
    const response = await apiRequest('/api/dlna/devices/scan', { method: 'POST' });

    if (response.ok) {
      showNotification('Сканирование запущено', 'info');
      // Обновляем список через 3 секунды
      setTimeout(loadDevices, 3000);
    }
  } catch (error) {
    showNotification('Ошибка сканирования', 'error');
  }
}

// Отрисовка списка устройств
function renderDevices(devices) {
  if (!devices || devices.length === 0) {
    devicesList.innerHTML = '<p class="empty-message">Нет устройств. Нажмите "Сканировать"</p>';
    return;
  }

  devicesList.innerHTML = devices.map(device => `
    <div class="device-item" data-device-id="${device.id}">
      <div class="device-info">
        <div class="device-name">${escapeHtml(device.name)}</div>
        <div class="device-details">${escapeHtml(device.manufacturer)} - ${escapeHtml(device.ip)}</div>
      </div>
    </div>
  `).join('');
}

// Показать модальное окно выбора устройства для трансляции
function showCastModal(filename, torrent = null) {
  // Создаём модальное окно
  const modal = document.createElement('div');
  modal.className = 'cast-modal';
  modal.innerHTML = `
    <div class="cast-modal-content">
      <h3>Транслировать на устройство</h3>
      <div class="devices-list" id="castDevicesList">
        <p class="empty-message">Загрузка...</p>
      </div>
      <button class="btn-secondary cast-modal-close">Отмена</button>
    </div>
  `;

  document.body.appendChild(modal);

  // Загружаем устройства
  apiRequest('/api/dlna/devices')
    .then(response => response.json())
    .then(data => {
      const list = modal.querySelector('#castDevicesList');

      if (!data.devices || data.devices.length === 0) {
        list.innerHTML = '<p class="empty-message">Нет доступных устройств</p>';
        return;
      }

      list.innerHTML = data.devices.map(device => `
        <div class="device-item" data-device-id="${device.id}">
          <div class="device-info">
            <div class="device-name">${escapeHtml(device.name)}</div>
            <div class="device-details">${escapeHtml(device.manufacturer)}</div>
          </div>
        </div>
      `).join('');

      // Обработчики клика на устройства
      list.querySelectorAll('.device-item').forEach(item => {
        item.addEventListener('click', () => {
          const deviceId = item.dataset.deviceId;
          castToDevice(deviceId, filename, torrent);
          modal.remove();
        });
      });
    });

  // Закрытие модального окна
  modal.querySelector('.cast-modal-close').addEventListener('click', () => {
    modal.remove();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

// Отправить на устройство
async function castToDevice(deviceId, filename, torrent = null) {
  try {
    const body = { deviceId };

    if (torrent) {
      body.torrent = torrent;
    } else {
      body.filename = filename;
    }

    const response = await apiRequest('/api/dlna/cast', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const result = await response.json();

    if (response.ok) {
      showNotification(`Трансляция на ${result.device.name}`, 'success');
      startPlaybackStatusPolling();
    } else {
      showNotification(result.error, 'error');
    }
  } catch (error) {
    showNotification('Ошибка трансляции', 'error');
  }
}

// Управление воспроизведением
async function controlPlayback(action, params = {}) {
  try {
    const response = await apiRequest(`/api/dlna/control/${action}`, {
      method: 'POST',
      body: JSON.stringify(params)
    });

    const result = await response.json();

    if (!response.ok) {
      showNotification(result.error, 'error');
    }

    if (action === 'stop') {
      stopPlaybackStatusPolling();
    }
  } catch (error) {
    showNotification('Ошибка управления воспроизведением', 'error');
  }
}

// Загрузка статуса воспроизведения
async function loadPlaybackStatus() {
  try {
    const response = await apiRequest('/api/dlna/status');
    const status = await response.json();
    updatePlaybackUI(status);
  } catch (error) {
    console.error('Ошибка загрузки статуса:', error);
  }
}

// Обновление UI воспроизведения
function updatePlaybackUI(status) {
  if (!status.active) {
    playbackPanel.style.display = 'none';
    return;
  }

  playbackPanel.style.display = 'block';
  playbackDevice.textContent = status.device?.name || 'Устройство';
  playbackStatus.textContent = status.state || 'UNKNOWN';
  playbackPosition.textContent = formatTime(status.position);
  playbackDuration.textContent = formatTime(status.duration);

  const progress = status.duration > 0 ? (status.position / status.duration) * 100 : 0;
  playbackBarFill.style.width = `${progress}%`;
}

// Запуск периодического опроса статуса
function startPlaybackStatusPolling() {
  stopPlaybackStatusPolling();
  loadPlaybackStatus();
  playbackStatusInterval = setInterval(loadPlaybackStatus, 2000);
}

// Остановка опроса статуса
function stopPlaybackStatusPolling() {
  if (playbackStatusInterval) {
    clearInterval(playbackStatusInterval);
    playbackStatusInterval = null;
  }
  playbackPanel.style.display = 'none';
}

// SSE для обновления прогресса
let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`/api/progress?token=${authToken}`);

  eventSource.onmessage = (event) => {
    const torrents = JSON.parse(event.data);
    lastTorrentsData = torrents;
    renderTorrents(torrents);

    // Автоматически показать выбор файлов для новых многофайловых торрентов
    torrents.forEach(torrent => {
      if (torrent.files.length > 1 && !seenTorrentFiles.has(torrent.infoHash) && !torrent.done) {
        seenTorrentFiles.add(torrent.infoHash);
        showFileSelectionModal(torrent);
      }
    });
  };

  eventSource.onerror = () => {
    console.log('SSE соединение потеряно, переподключение...');
    eventSource.close();
    setTimeout(connectSSE, 3000);
  };
}

// Обработчики событий
document.addEventListener('DOMContentLoaded', () => {
  // Вкладки авторизации
  authTabs.forEach(tab => {
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
  });

  // Форма входа
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    login(username, password);
  });

  // Форма регистрации
  registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('registerUsername').value;
    const password = document.getElementById('registerPassword').value;
    register(username, password);
  });

  // Выход
  logoutBtn.addEventListener('click', logout);

  // Основные действия
  addMagnetBtn.addEventListener('click', addMagnetLink);
  magnetInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addMagnetLink();
  });

  uploadTorrentBtn.addEventListener('click', uploadTorrentFile);
  changeDirBtn.addEventListener('click', changeDirectory);
  refreshFilesBtn.addEventListener('click', loadFiles);

  // DLNA обработчики
  startDlnaServerBtn.addEventListener('click', startDlnaServer);
  stopDlnaServerBtn.addEventListener('click', stopDlnaServer);
  scanDevicesBtn.addEventListener('click', scanDevices);
  playBtn.addEventListener('click', () => controlPlayback('play'));
  pauseBtn.addEventListener('click', () => controlPlayback('pause'));
  stopBtn.addEventListener('click', () => controlPlayback('stop'));

  // Watch обработчики
  watchBack.addEventListener('click', closeWatch);

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

  watchPlayer.addEventListener('error', () => {
    const err = watchPlayer.error;
    const msg = err ? `код ${err.code}` : 'неизвестная';
    watchStatus.textContent = `Ошибка воспроизведения (${msg}). Попробуйте другое качество.`;
    watchStatus.classList.add('error');
  });

  // Проверка авторизации
  checkAuth();
});
