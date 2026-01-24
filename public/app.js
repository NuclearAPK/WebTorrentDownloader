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

// Отрисовка списка торрентов
function renderTorrents(torrents) {
  if (torrents.length === 0) {
    torrentsList.innerHTML = '<p class="empty-message">Нет активных загрузок</p>';
    return;
  }

  torrentsList.innerHTML = torrents.map(torrent => `
    <div class="torrent-item ${torrent.done ? 'torrent-done' : ''}">
      <div class="torrent-header">
        <span class="torrent-name">${escapeHtml(torrent.name)}</span>
        <div class="torrent-actions">
          <button class="btn-danger" onclick="removeTorrent('${torrent.infoHash}')">Удалить</button>
        </div>
      </div>
      <div class="progress-container">
        <div class="progress-bar" style="width: ${torrent.progress}%">
          ${torrent.progress}%
        </div>
      </div>
      <div class="torrent-stats">
        <span>Скачано: <span class="stat-value">${formatBytes(torrent.downloaded)}</span> / ${formatBytes(torrent.length)}</span>
        <span>Скорость: <span class="stat-value">${formatSpeed(torrent.downloadSpeed)}</span></span>
        <span>Отдача: <span class="stat-value">${formatSpeed(torrent.uploadSpeed)}</span></span>
        <span>Пиры: <span class="stat-value">${torrent.numPeers}</span></span>
      </div>
      ${torrent.files.length > 0 ? `
        <div class="torrent-files">
          <button class="torrent-files-toggle" onclick="toggleFiles(this)">Показать файлы (${torrent.files.length})</button>
          <div class="torrent-files-list" style="display: none;">
            ${torrent.files.map(file => `
              <div class="torrent-file">
                <span class="torrent-file-name">${escapeHtml(file.name)}</span>
                <span class="torrent-file-progress">${file.progress}%</span>
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
      <button class="btn-danger" onclick="removeFile('${escapeHtml(file.name)}')">Удалить</button>
    </div>
  `).join('');
}

// Экранирование HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    renderTorrents(torrents);
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

  // Проверка авторизации
  checkAuth();
});
