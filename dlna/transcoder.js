/**
 * Transcoder
 * Транскодирование медиа-файлов через ffmpeg
 * Поддерживает преобразование на лету для несовместимых форматов
 */

import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

// Устанавливаем путь к ffmpeg из ffmpeg-static
ffmpeg.setFfmpegPath(ffmpegStatic);

/**
 * Класс для транскодирования медиа
 */
class Transcoder {
  constructor(downloadDirectory) {
    this.downloadDirectory = downloadDirectory;

    // Поддерживаемые форматы для транскодирования
    this.supportedInputFormats = ['.mkv', '.avi', '.wmv', '.webm', '.flv', '.mov', '.m4v'];

    // Пресеты качества
    this.presets = {
      low: { videoBitrate: '1000k', audioBitrate: '128k', resolution: '720x480' },
      medium: { videoBitrate: '2500k', audioBitrate: '192k', resolution: '1280x720' },
      high: { videoBitrate: '5000k', audioBitrate: '256k', resolution: '1920x1080' },
      original: { videoBitrate: null, audioBitrate: null, resolution: null }
    };
  }

  /**
   * Обновить директорию загрузок
   */
  setDownloadDirectory(directory) {
    this.downloadDirectory = directory;
  }

  /**
   * Проверить, требуется ли транскодирование для файла
   */
  needsTranscoding(filename) {
    const ext = path.extname(filename).toLowerCase();
    return this.supportedInputFormats.includes(ext);
  }

  /**
   * Получить информацию о медиа-файле
   */
  getMediaInfo(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }

        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration,
          size: metadata.format.size,
          bitrate: metadata.format.bit_rate,
          video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: eval(videoStream.r_frame_rate) || 0
          } : null,
          audio: audioStream ? {
            codec: audioStream.codec_name,
            channels: audioStream.channels,
            sampleRate: audioStream.sample_rate
          } : null
        });
      });
    });
  }

  /**
   * Транскодировать файл на лету и вернуть поток
   * @param {string} filename - имя файла относительно downloadDirectory
   * @param {object} options - опции транскодирования
   * @returns {PassThrough} - поток для стриминга
   */
  transcodeStream(filename, options = {}) {
    const filePath = path.join(this.downloadDirectory, filename);

    // Проверка безопасности пути
    if (!filePath.startsWith(this.downloadDirectory)) {
      throw new Error('Доступ запрещён');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('Файл не найден');
    }

    const preset = this.presets[options.quality] || this.presets.medium;
    const outputStream = new PassThrough();

    const command = ffmpeg(filePath)
      .format('mp4')
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency'
      ]);

    // Применяем пресет качества
    if (preset.videoBitrate) {
      command.videoBitrate(preset.videoBitrate);
    }
    if (preset.audioBitrate) {
      command.audioBitrate(preset.audioBitrate);
    }
    if (preset.resolution) {
      const [width, height] = preset.resolution.split('x');
      command.size(`${width}x${height}`);
    }

    // Обработка ошибок
    command.on('error', (err) => {
      console.error('Ошибка транскодирования:', err.message);
      outputStream.destroy(err);
    });

    command.on('end', () => {
      outputStream.end();
    });

    // Запускаем транскодирование и направляем в поток
    command.pipe(outputStream, { end: true });

    return outputStream;
  }

  /**
   * Обработчик HTTP запроса для транскодирования
   */
  handleTranscodeRequest(req, res) {
    const filename = decodeURIComponent(req.params.filename);
    const quality = req.query.quality || 'medium';

    const filePath = path.join(this.downloadDirectory, filename);

    // Проверка безопасности пути
    if (!filePath.startsWith(this.downloadDirectory)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Файл не найден' });
    }

    // Проверяем, поддерживается ли формат
    const ext = path.extname(filename).toLowerCase();
    if (!this.supportedInputFormats.includes(ext)) {
      return res.status(400).json({
        error: 'Формат не требует транскодирования',
        suggestion: 'Используйте /api/stream/ для этого файла'
      });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none'); // Range не поддерживается при транскодировании
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('transferMode.dlna.org', 'Streaming');

    try {
      const stream = this.transcodeStream(filename, { quality });

      stream.on('error', (err) => {
        console.error('Ошибка потока:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Ошибка транскодирования' });
        }
      });

      stream.pipe(res);

      // Обрабатываем отключение клиента
      req.on('close', () => {
        stream.destroy();
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Получить URL для транскодированного потока
   */
  getTranscodeUrl(filename, host, quality = 'medium') {
    return `http://${host}/api/transcode/${encodeURIComponent(filename)}?quality=${quality}`;
  }

  /**
   * Получить список поддерживаемых форматов
   */
  getSupportedFormats() {
    return {
      input: this.supportedInputFormats,
      output: ['mp4'],
      presets: Object.keys(this.presets)
    };
  }

  /**
   * Проверить доступность ffmpeg
   */
  async checkFfmpeg() {
    return new Promise((resolve) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          resolve({ available: false, error: err.message });
        } else {
          resolve({ available: true, formatsCount: Object.keys(formats).length });
        }
      });
    });
  }
}

export default Transcoder;
