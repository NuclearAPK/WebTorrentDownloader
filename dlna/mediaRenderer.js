/**
 * Media Renderer Client
 * Управление воспроизведением на DLNA устройствах
 */

import http from 'http';
import { URL } from 'url';
import { parseStringPromise } from 'xml2js';
import { EventEmitter } from 'events';

/**
 * Класс для управления воспроизведением на DLNA устройстве
 */
class MediaRenderer extends EventEmitter {
  constructor(deviceDiscovery) {
    super();
    this.deviceDiscovery = deviceDiscovery;
    this.currentDevice = null;
    this.currentMediaUrl = null;
    this.statusPollInterval = null;
    this.lastStatus = null;
  }

  /**
   * Отправить SOAP запрос на устройство
   */
  sendSoapRequest(controlUrl, action, params = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(controlUrl);

      let paramsXml = '';
      for (const [key, value] of Object.entries(params)) {
        paramsXml += `<${key}>${this.escapeXml(value)}</${key}>`;
      }

      const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      ${paramsXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`
        }
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const result = await parseStringPromise(data, { explicitArray: false });
              resolve(result);
            } catch (e) {
              resolve({ raw: data });
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Экранировать XML спецсимволы
   */
  escapeXml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Отправить медиа на устройство
   */
  async cast(deviceId, mediaUrl, title = 'Media', mimeType = 'video/mp4') {
    const device = this.deviceDiscovery.getDevice(deviceId);

    if (!device) {
      throw new Error('Устройство не найдено');
    }

    if (!device.controlUrl) {
      throw new Error('Устройство не поддерживает воспроизведение');
    }

    // Сначала останавливаем текущее воспроизведение
    try {
      await this.sendSoapRequest(device.controlUrl, 'Stop');
    } catch (e) {
      // Игнорируем ошибку остановки
    }

    // Формируем DIDL-Lite метаданные
    const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="-1" restricted="1">
    <dc:title>${this.escapeXml(title)}</dc:title>
    <upnp:class>object.item.videoItem</upnp:class>
    <res protocolInfo="http-get:*:${mimeType}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000">${this.escapeXml(mediaUrl)}</res>
  </item>
</DIDL-Lite>`;

    // Устанавливаем URI
    await this.sendSoapRequest(device.controlUrl, 'SetAVTransportURI', {
      CurrentURI: mediaUrl,
      CurrentURIMetaData: didl
    });

    // Запускаем воспроизведение
    await this.sendSoapRequest(device.controlUrl, 'Play', {
      Speed: '1'
    });

    this.currentDevice = device;
    this.currentMediaUrl = mediaUrl;

    // Запускаем опрос статуса
    this.startStatusPolling();

    this.emit('castStarted', { device, mediaUrl, title });

    return {
      success: true,
      device: {
        id: device.id,
        name: device.name
      },
      mediaUrl
    };
  }

  /**
   * Воспроизведение
   */
  async play() {
    if (!this.currentDevice) {
      throw new Error('Нет активного устройства');
    }

    await this.sendSoapRequest(this.currentDevice.controlUrl, 'Play', {
      Speed: '1'
    });

    this.emit('play');
    return { success: true };
  }

  /**
   * Пауза
   */
  async pause() {
    if (!this.currentDevice) {
      throw new Error('Нет активного устройства');
    }

    await this.sendSoapRequest(this.currentDevice.controlUrl, 'Pause');

    this.emit('pause');
    return { success: true };
  }

  /**
   * Остановка
   */
  async stop() {
    if (!this.currentDevice) {
      throw new Error('Нет активного устройства');
    }

    await this.sendSoapRequest(this.currentDevice.controlUrl, 'Stop');

    this.stopStatusPolling();
    const device = this.currentDevice;
    this.currentDevice = null;
    this.currentMediaUrl = null;

    this.emit('stop', { device });
    return { success: true };
  }

  /**
   * Перемотка
   */
  async seek(position) {
    if (!this.currentDevice) {
      throw new Error('Нет активного устройства');
    }

    // Преобразуем секунды в формат HH:MM:SS
    const time = this.formatTime(position);

    await this.sendSoapRequest(this.currentDevice.controlUrl, 'Seek', {
      Unit: 'REL_TIME',
      Target: time
    });

    this.emit('seek', { position });
    return { success: true };
  }

  /**
   * Установить громкость (0-100)
   */
  async setVolume(volume) {
    if (!this.currentDevice) {
      throw new Error('Нет активного устройства');
    }

    // Громкость обычно управляется через RenderingControl
    // Для AVTransport эта функция может не поддерживаться
    // Оставляем заглушку

    this.emit('volumeChange', { volume });
    return { success: true, volume };
  }

  /**
   * Получить текущий статус воспроизведения
   */
  async getStatus() {
    if (!this.currentDevice) {
      return {
        active: false,
        device: null,
        state: 'STOPPED',
        position: 0,
        duration: 0,
        mediaUrl: null
      };
    }

    try {
      const result = await this.sendSoapRequest(
        this.currentDevice.controlUrl,
        'GetTransportInfo'
      );

      const positionResult = await this.sendSoapRequest(
        this.currentDevice.controlUrl,
        'GetPositionInfo'
      );

      // Извлекаем данные из SOAP ответа
      const envelope = result['s:Envelope'] || result['SOAP-ENV:Envelope'] || {};
      const body = envelope['s:Body'] || envelope['SOAP-ENV:Body'] || {};
      const transportInfo = body['u:GetTransportInfoResponse'] || {};

      const posEnvelope = positionResult['s:Envelope'] || positionResult['SOAP-ENV:Envelope'] || {};
      const posBody = posEnvelope['s:Body'] || posEnvelope['SOAP-ENV:Body'] || {};
      const positionInfo = posBody['u:GetPositionInfoResponse'] || {};

      const status = {
        active: true,
        device: {
          id: this.currentDevice.id,
          name: this.currentDevice.name
        },
        state: transportInfo.CurrentTransportState || 'UNKNOWN',
        position: this.parseTime(positionInfo.RelTime || '0:00:00'),
        duration: this.parseTime(positionInfo.TrackDuration || '0:00:00'),
        mediaUrl: this.currentMediaUrl
      };

      this.lastStatus = status;
      return status;
    } catch (error) {
      return {
        active: true,
        device: {
          id: this.currentDevice.id,
          name: this.currentDevice.name
        },
        state: 'UNKNOWN',
        position: 0,
        duration: 0,
        mediaUrl: this.currentMediaUrl,
        error: error.message
      };
    }
  }

  /**
   * Форматировать время в HH:MM:SS
   */
  formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Парсинг времени HH:MM:SS в секунды
   */
  parseTime(timeStr) {
    if (!timeStr || timeStr === 'NOT_IMPLEMENTED') return 0;

    const parts = timeStr.split(':');
    if (parts.length !== 3) return 0;

    const [h, m, s] = parts.map(p => parseFloat(p) || 0);
    return h * 3600 + m * 60 + s;
  }

  /**
   * Запустить периодический опрос статуса
   */
  startStatusPolling() {
    this.stopStatusPolling();

    this.statusPollInterval = setInterval(async () => {
      try {
        const status = await this.getStatus();
        this.emit('statusUpdate', status);

        // Если воспроизведение остановилось
        if (status.state === 'STOPPED' && this.lastStatus?.state !== 'STOPPED') {
          this.emit('playbackEnded');
        }
      } catch (error) {
        // Игнорируем ошибки опроса
      }
    }, 2000);
  }

  /**
   * Остановить опрос статуса
   */
  stopStatusPolling() {
    if (this.statusPollInterval) {
      clearInterval(this.statusPollInterval);
      this.statusPollInterval = null;
    }
  }

  /**
   * Получить текущее устройство
   */
  getCurrentDevice() {
    return this.currentDevice ? {
      id: this.currentDevice.id,
      name: this.currentDevice.name
    } : null;
  }

  /**
   * Освободить ресурсы
   */
  destroy() {
    this.stopStatusPolling();
    this.currentDevice = null;
    this.currentMediaUrl = null;
  }
}

export default MediaRenderer;
