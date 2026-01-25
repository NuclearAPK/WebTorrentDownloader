/**
 * HTTP Streaming Server с поддержкой Range requests
 * Позволяет стримить файлы и торренты для DLNA устройств
 */

import fs from 'fs';
import path from 'path';
import mime from 'mime-types';

/**
 * Класс для HTTP стриминга медиа-файлов
 */
class StreamingServer {
  constructor(downloadDirectory, webTorrentClient) {
    this.downloadDirectory = downloadDirectory;
    this.client = webTorrentClient;
  }

  /**
   * Обновить директорию загрузок
   */
  setDownloadDirectory(directory) {
    this.downloadDirectory = directory;
  }

  /**
   * Получить MIME тип файла
   */
  getMimeType(filename) {
    const mimeType = mime.lookup(filename);
    return mimeType || 'application/octet-stream';
  }

  /**
   * Проверить, является ли файл медиа-файлом
   */
  isMediaFile(filename) {
    const mimeType = this.getMimeType(filename);
    return mimeType.startsWith('video/') || mimeType.startsWith('audio/');
  }

  /**
   * Обработчик стриминга файла из директории downloads
   */
  streamFile(req, res) {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(this.downloadDirectory, filename);

    // Проверка безопасности пути
    if (!filePath.startsWith(this.downloadDirectory)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        return res.status(404).json({ error: 'Файл не найден' });
      }

      if (stats.isDirectory()) {
        return res.status(400).json({ error: 'Это директория' });
      }

      const mimeType = this.getMimeType(filename);
      const fileSize = stats.size;
      const range = req.headers.range;

      // Заголовки для DLNA совместимости
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('transferMode.dlna.org', 'Streaming');
      res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');

      if (range) {
        // Range request - для перемотки и частичной загрузки
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize);

        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', (error) => {
          console.error('Ошибка стриминга:', error.message);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Ошибка чтения файла' });
          }
        });
        stream.pipe(res);
      } else {
        // Полный файл
        res.setHeader('Content-Length', fileSize);

        const stream = fs.createReadStream(filePath);
        stream.on('error', (error) => {
          console.error('Ошибка стриминга:', error.message);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Ошибка чтения файла' });
          }
        });
        stream.pipe(res);
      }
    });
  }

  /**
   * Обработчик стриминга файла из активного торрента
   * Позволяет смотреть видео во время загрузки
   */
  streamTorrent(req, res) {
    const { infoHash, fileIndex } = req.params;
    const torrent = this.client.get(infoHash);

    if (!torrent) {
      return res.status(404).json({ error: 'Торрент не найден' });
    }

    const index = parseInt(fileIndex, 10);
    const file = torrent.files[index];

    if (!file) {
      return res.status(404).json({ error: 'Файл не найден в торренте' });
    }

    const mimeType = this.getMimeType(file.name);
    const fileSize = file.length;
    const range = req.headers.range;

    // Заголовки для DLNA совместимости
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');

    if (range) {
      // Range request
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      // Используем createReadStream с опциями start/end
      const stream = file.createReadStream({ start, end });
      stream.on('error', (error) => {
        console.error('Ошибка стриминга торрента:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Ошибка чтения торрента' });
        }
      });
      stream.pipe(res);
    } else {
      // Полный файл
      res.setHeader('Content-Length', fileSize);

      const stream = file.createReadStream();
      stream.on('error', (error) => {
        console.error('Ошибка стриминга торрента:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Ошибка чтения торрента' });
        }
      });
      stream.pipe(res);
    }
  }

  /**
   * Получить информацию о файле для стриминга
   */
  getFileInfo(filename) {
    const filePath = path.join(this.downloadDirectory, filename);

    if (!filePath.startsWith(this.downloadDirectory)) {
      return null;
    }

    try {
      const stats = fs.statSync(filePath);
      return {
        name: filename,
        path: filePath,
        size: stats.size,
        mimeType: this.getMimeType(filename),
        isMedia: this.isMediaFile(filename)
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Получить информацию о файле торрента
   */
  getTorrentFileInfo(infoHash, fileIndex) {
    const torrent = this.client.get(infoHash);

    if (!torrent) {
      return null;
    }

    const file = torrent.files[fileIndex];

    if (!file) {
      return null;
    }

    return {
      name: file.name,
      size: file.length,
      mimeType: this.getMimeType(file.name),
      isMedia: this.isMediaFile(file.name),
      progress: Math.round(file.progress * 100),
      torrentName: torrent.name
    };
  }

  /**
   * Получить список всех медиа-файлов
   */
  getMediaFiles() {
    const files = [];

    const scanDirectory = (dir, basePath = '') => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const relativePath = path.join(basePath, entry.name);
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            scanDirectory(fullPath, relativePath);
          } else if (this.isMediaFile(entry.name)) {
            const stats = fs.statSync(fullPath);
            files.push({
              name: relativePath,
              size: stats.size,
              mimeType: this.getMimeType(entry.name)
            });
          }
        }
      } catch (e) {
        // Игнорируем ошибки доступа
      }
    };

    scanDirectory(this.downloadDirectory);
    return files;
  }

  /**
   * Получить URL для стриминга файла
   */
  getStreamUrl(filename, host) {
    return `http://${host}/api/stream/${encodeURIComponent(filename)}`;
  }

  /**
   * Получить URL для стриминга файла торрента
   */
  getTorrentStreamUrl(infoHash, fileIndex, host) {
    return `http://${host}/api/stream/torrent/${infoHash}/${fileIndex}`;
  }
}

export default StreamingServer;
