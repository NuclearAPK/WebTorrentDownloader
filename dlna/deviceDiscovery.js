/**
 * SSDP Device Discovery
 * Обнаружение DLNA MediaRenderer устройств в локальной сети
 */

import ssdp from 'node-ssdp';
const { Client: SSDPClient, Server: SSDPServer } = ssdp;
import { EventEmitter } from 'events';
import http from 'http';
import { parseStringPromise } from 'xml2js';

/**
 * Класс для обнаружения DLNA устройств
 */
class DeviceDiscovery extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.ssdpClient = null;
    this.scanning = false;
    this.scanInterval = null;
  }

  /**
   * Инициализация SSDP клиента
   */
  init() {
    try {
      this.ssdpClient = new SSDPClient();
    } catch (err) {
      console.warn('DLNA Discovery: не удалось создать SSDP клиент:', err.message);
      this.ssdpClient = null;
      return;
    }

    this.ssdpClient.on('response', async (headers, statusCode, rinfo) => {
      if (statusCode === 200 && headers.LOCATION) {
        await this.processDevice(headers, rinfo);
      }
    });

    // Автоматическое сканирование каждые 30 секунд
    this.scanInterval = setInterval(() => {
      this.scan();
    }, 30000);

    // Первоначальное сканирование
    this.scan();
  }

  /**
   * Обработка найденного устройства
   */
  async processDevice(headers, rinfo) {
    const location = headers.LOCATION;
    const usn = headers.USN || '';

    // Проверяем, что это MediaRenderer
    const st = headers.ST || '';
    if (!st.includes('MediaRenderer') && !usn.includes('MediaRenderer')) {
      return;
    }

    // Если устройство уже известно, обновляем время
    if (this.devices.has(location)) {
      const device = this.devices.get(location);
      device.lastSeen = Date.now();
      return;
    }

    try {
      // Получаем описание устройства
      const deviceInfo = await this.fetchDeviceDescription(location);

      if (deviceInfo) {
        const device = {
          id: this.generateDeviceId(location),
          location: location,
          ip: rinfo.address,
          name: deviceInfo.friendlyName || 'Unknown Device',
          manufacturer: deviceInfo.manufacturer || 'Unknown',
          modelName: deviceInfo.modelName || 'Unknown',
          modelDescription: deviceInfo.modelDescription || '',
          controlUrl: deviceInfo.controlUrl,
          eventSubUrl: deviceInfo.eventSubUrl,
          lastSeen: Date.now(),
          type: 'MediaRenderer'
        };

        this.devices.set(location, device);
        this.emit('deviceFound', device);
        console.log(`DLNA устройство найдено: ${device.name} (${device.ip})`);
      }
    } catch (error) {
      // Игнорируем ошибки получения описания
    }
  }

  /**
   * Получить описание устройства по URL
   */
  fetchDeviceDescription(url) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout'));
      }, 5000);

      http.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          clearTimeout(timeout);

          try {
            const result = await parseStringPromise(data, { explicitArray: false });
            const device = result.root?.device;

            if (!device) {
              resolve(null);
              return;
            }

            // Ищем сервис AVTransport
            let controlUrl = null;
            let eventSubUrl = null;

            const serviceList = device.serviceList?.service;
            const services = Array.isArray(serviceList) ? serviceList : [serviceList];

            for (const service of services) {
              if (service?.serviceType?.includes('AVTransport')) {
                controlUrl = this.resolveUrl(url, service.controlURL);
                eventSubUrl = this.resolveUrl(url, service.eventSubURL);
                break;
              }
            }

            resolve({
              friendlyName: device.friendlyName,
              manufacturer: device.manufacturer,
              modelName: device.modelName,
              modelDescription: device.modelDescription,
              controlUrl,
              eventSubUrl
            });
          } catch (parseError) {
            resolve(null);
          }
        });

        res.on('error', () => {
          clearTimeout(timeout);
          reject(new Error('Request error'));
        });
      }).on('error', () => {
        clearTimeout(timeout);
        reject(new Error('Connection error'));
      });
    });
  }

  /**
   * Разрешить относительный URL
   */
  resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return null;

    try {
      const base = new URL(baseUrl);

      if (relativeUrl.startsWith('http')) {
        return relativeUrl;
      }

      if (relativeUrl.startsWith('/')) {
        return `${base.protocol}//${base.host}${relativeUrl}`;
      }

      const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/'));
      return `${base.protocol}//${base.host}${basePath}/${relativeUrl}`;
    } catch (e) {
      return null;
    }
  }

  /**
   * Сгенерировать уникальный ID устройства
   */
  generateDeviceId(location) {
    return Buffer.from(location).toString('base64').replace(/[/+=]/g, '').substring(0, 16);
  }

  /**
   * Запустить сканирование сети
   */
  scan() {
    if (!this.ssdpClient) {
      this.init();
      return;
    }

    this.scanning = true;

    try {
      // Ищем все MediaRenderer устройства
      this.ssdpClient.search('urn:schemas-upnp-org:device:MediaRenderer:1');
    } catch (err) {
      console.warn('DLNA Discovery: ошибка сканирования:', err.message);
    }

    // Также ищем общий тип устройств
    setTimeout(() => {
      try {
        if (this.ssdpClient) {
          this.ssdpClient.search('ssdp:all');
        }
      } catch (err) {
        console.warn('DLNA Discovery: ошибка сканирования ssdp:all:', err.message);
      }
    }, 1000);

    // Сбрасываем флаг через 10 секунд
    setTimeout(() => {
      this.scanning = false;
      this.cleanupOldDevices();
    }, 10000);
  }

  /**
   * Удалить устройства, которые не отвечали более 2 минут
   */
  cleanupOldDevices() {
    const now = Date.now();
    const timeout = 120000; // 2 минуты

    for (const [location, device] of this.devices) {
      if (now - device.lastSeen > timeout) {
        this.devices.delete(location);
        this.emit('deviceLost', device);
        console.log(`DLNA устройство потеряно: ${device.name}`);
      }
    }
  }

  /**
   * Получить список всех найденных устройств
   */
  getDevices() {
    return Array.from(this.devices.values()).map(device => ({
      id: device.id,
      name: device.name,
      ip: device.ip,
      manufacturer: device.manufacturer,
      modelName: device.modelName,
      type: device.type
    }));
  }

  /**
   * Получить устройство по ID
   */
  getDevice(deviceId) {
    for (const device of this.devices.values()) {
      if (device.id === deviceId) {
        return device;
      }
    }
    return null;
  }

  /**
   * Проверить, идёт ли сканирование
   */
  isScanning() {
    return this.scanning;
  }

  /**
   * Остановить сканирование и освободить ресурсы
   */
  destroy() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    if (this.ssdpClient) {
      this.ssdpClient.stop();
      this.ssdpClient = null;
    }

    this.devices.clear();
  }
}

export default DeviceDiscovery;
