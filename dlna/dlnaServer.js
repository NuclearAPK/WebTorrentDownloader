/**
 * DLNA Media Server
 * UPnP Media Server для публикации медиа-библиотеки
 * Позволяет другим устройствам в сети видеть и воспроизводить наши файлы
 */

import ssdp from 'node-ssdp';
const { Server: SSDPServer } = ssdp;
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import mime from 'mime-types';

/**
 * Класс DLNA Media Server
 */
class DLNAServer {
  constructor(downloadDirectory, options = {}) {
    this.downloadDirectory = downloadDirectory;
    this.port = options.port || 10293;
    this.serverName = options.serverName || 'WebTorrent Media Server';
    this.uuid = this.generateUUID();

    this.httpServer = null;
    this.ssdpServer = null;
    this.running = false;
    this.mediaFiles = [];
  }

  /**
   * Генерация UUID для устройства
   */
  generateUUID() {
    return 'uuid:' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Получить локальный IP адрес
   * Предпочитает реальные сетевые адаптеры над виртуальными
   */
  getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    // Виртуальные адаптеры, которые нужно пропустить
    const virtualPatterns = [
      /vmware/i, /virtualbox/i, /vbox/i, /hyper-v/i,
      /vethernet/i, /docker/i, /wsl/i, /vmnet/i
    ];

    for (const name of Object.keys(interfaces)) {
      // Пропускаем виртуальные адаптеры
      const isVirtual = virtualPatterns.some(pattern => pattern.test(name));

      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          candidates.push({
            name,
            address: iface.address,
            isVirtual,
            // Предпочитаем адреса 192.168.x.x и 10.x.x.x
            isPrivate: iface.address.startsWith('192.168.') || iface.address.startsWith('10.')
          });
        }
      }
    }

    // Сортируем: реальные адаптеры с приватными IP первыми
    candidates.sort((a, b) => {
      if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1;
      if (a.isPrivate !== b.isPrivate) return a.isPrivate ? -1 : 1;
      return 0;
    });

    return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
  }

  /**
   * Сканировать медиа-файлы
   */
  scanMediaFiles() {
    this.mediaFiles = [];
    let id = 1;

    const scanDirectory = (dir, basePath = '') => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            scanDirectory(fullPath, relativePath);
          } else {
            const mimeType = mime.lookup(entry.name);
            if (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) {
              const stats = fs.statSync(fullPath);
              this.mediaFiles.push({
                id: id++,
                name: entry.name,
                path: relativePath,
                fullPath: fullPath,
                size: stats.size,
                mimeType: mimeType
              });
            }
          }
        }
      } catch (e) {
        // Игнорируем ошибки доступа
      }
    };

    scanDirectory(this.downloadDirectory);
    return this.mediaFiles;
  }

  /**
   * Генерация XML описания устройства
   */
  getDeviceDescription() {
    const ip = this.getLocalIP();
    return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${this.escapeXml(this.serverName)}</friendlyName>
    <manufacturer>WebTorrent</manufacturer>
    <manufacturerURL>https://webtorrent.io</manufacturerURL>
    <modelDescription>WebTorrent DLNA Media Server</modelDescription>
    <modelName>WebTorrent Media Server</modelName>
    <modelNumber>1.0</modelNumber>
    <modelURL>https://webtorrent.io</modelURL>
    <serialNumber>1</serialNumber>
    <UDN>${this.uuid}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/ContentDirectory.xml</SCPDURL>
        <controlURL>/ContentDirectory/control</controlURL>
        <eventSubURL>/ContentDirectory/event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/ConnectionManager.xml</SCPDURL>
        <controlURL>/ConnectionManager/control</controlURL>
        <eventSubURL>/ConnectionManager/event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
  }

  /**
   * Генерация SCPD для ContentDirectory
   */
  getContentDirectorySCPD() {
    return `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument>
          <name>ObjectID</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable>
        </argument>
        <argument>
          <name>BrowseFlag</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable>
        </argument>
        <argument>
          <name>Filter</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable>
        </argument>
        <argument>
          <name>StartingIndex</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable>
        </argument>
        <argument>
          <name>RequestedCount</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable>
        </argument>
        <argument>
          <name>SortCriteria</name>
          <direction>in</direction>
          <relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable>
        </argument>
        <argument>
          <name>Result</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable>
        </argument>
        <argument>
          <name>NumberReturned</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable>
        </argument>
        <argument>
          <name>TotalMatches</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable>
        </argument>
        <argument>
          <name>UpdateID</name>
          <direction>out</direction>
          <relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable>
        </argument>
      </argumentList>
    </action>
    <action>
      <name>GetSystemUpdateID</name>
      <argumentList>
        <argument>
          <name>Id</name>
          <direction>out</direction>
          <relatedStateVariable>SystemUpdateID</relatedStateVariable>
        </argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_ObjectID</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Result</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_BrowseFlag</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Filter</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_SortCriteria</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Index</name>
      <dataType>ui4</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Count</name>
      <dataType>ui4</dataType>
    </stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_UpdateID</name>
      <dataType>ui4</dataType>
    </stateVariable>
    <stateVariable sendEvents="yes">
      <name>SystemUpdateID</name>
      <dataType>ui4</dataType>
    </stateVariable>
  </serviceStateTable>
</scpd>`;
  }

  /**
   * Генерация SCPD для ConnectionManager
   */
  getConnectionManagerSCPD() {
    return `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <actionList>
    <action>
      <name>GetProtocolInfo</name>
      <argumentList>
        <argument>
          <name>Source</name>
          <direction>out</direction>
          <relatedStateVariable>SourceProtocolInfo</relatedStateVariable>
        </argument>
        <argument>
          <name>Sink</name>
          <direction>out</direction>
          <relatedStateVariable>SinkProtocolInfo</relatedStateVariable>
        </argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes">
      <name>SourceProtocolInfo</name>
      <dataType>string</dataType>
    </stateVariable>
    <stateVariable sendEvents="yes">
      <name>SinkProtocolInfo</name>
      <dataType>string</dataType>
    </stateVariable>
  </serviceStateTable>
</scpd>`;
  }

  /**
   * Генерация DIDL-Lite для списка файлов
   */
  generateDIDL(files, parentId = '0') {
    const ip = this.getLocalIP();
    let items = '';

    for (const file of files) {
      const url = `http://${ip}:${this.port}/media/${encodeURIComponent(file.path)}`;
      const dlnaFeatures = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
      const protocolInfo = `http-get:*:${file.mimeType}:${dlnaFeatures}`;

      items += `<item id="${file.id}" parentID="${parentId}" restricted="1">
  <dc:title>${this.escapeXml(file.name)}</dc:title>
  <upnp:class>${file.mimeType.startsWith('video/') ? 'object.item.videoItem' : 'object.item.audioItem'}</upnp:class>
  <res protocolInfo="${protocolInfo}" size="${file.size}">${this.escapeXml(url)}</res>
</item>`;
    }

    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
${items}
</DIDL-Lite>`;
  }

  /**
   * Обработка SOAP запроса Browse
   */
  handleBrowse(body) {
    // Обновляем список файлов при каждом запросе
    this.scanMediaFiles();

    const didl = this.generateDIDL(this.mediaFiles);
    const count = this.mediaFiles.length;

    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>${this.escapeXml(didl)}</Result>
      <NumberReturned>${count}</NumberReturned>
      <TotalMatches>${count}</TotalMatches>
      <UpdateID>1</UpdateID>
    </u:BrowseResponse>
  </s:Body>
</s:Envelope>`;
  }

  /**
   * Обработка GetSystemUpdateID
   */
  handleGetSystemUpdateID() {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Id>1</Id>
    </u:GetSystemUpdateIDResponse>
  </s:Body>
</s:Envelope>`;
  }

  /**
   * Обработка GetProtocolInfo
   */
  handleGetProtocolInfo() {
    const protocols = [
      'http-get:*:video/mp4:*',
      'http-get:*:video/x-matroska:*',
      'http-get:*:video/avi:*',
      'http-get:*:video/webm:*',
      'http-get:*:audio/mpeg:*',
      'http-get:*:audio/mp4:*',
      'http-get:*:audio/flac:*'
    ].join(',');

    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetProtocolInfoResponse xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1">
      <Source>${protocols}</Source>
      <Sink></Sink>
    </u:GetProtocolInfoResponse>
  </s:Body>
</s:Envelope>`;
  }

  /**
   * Экранировать XML
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
   * Запустить сервер
   */
  async start() {
    if (this.running) {
      return { success: true, message: 'Сервер уже запущен' };
    }

    const ip = this.getLocalIP();

    // Создаём HTTP сервер
    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.listen(this.port, () => {
        console.log(`DLNA сервер запущен на http://${ip}:${this.port}`);
        resolve();
      });

      this.httpServer.on('error', reject);
    });

    // Создаём SSDP сервер для анонсирования
    this.ssdpServer = new SSDPServer({
      location: `http://${ip}:${this.port}/description.xml`,
      udn: this.uuid,
      allowWildcards: true
    });

    this.ssdpServer.addUSN('upnp:rootdevice');
    this.ssdpServer.addUSN('urn:schemas-upnp-org:device:MediaServer:1');
    this.ssdpServer.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1');
    this.ssdpServer.addUSN('urn:schemas-upnp-org:service:ConnectionManager:1');

    this.ssdpServer.start();

    this.running = true;
    this.scanMediaFiles();

    return {
      success: true,
      ip,
      port: this.port,
      name: this.serverName
    };
  }

  /**
   * Обработка HTTP запроса
   */
  handleRequest(req, res) {
    const url = req.url;

    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, SOAPAction');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Описание устройства
    if (url === '/description.xml') {
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.end(this.getDeviceDescription());
      return;
    }

    // SCPD файлы
    if (url === '/ContentDirectory.xml') {
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.end(this.getContentDirectorySCPD());
      return;
    }

    if (url === '/ConnectionManager.xml') {
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.end(this.getConnectionManagerSCPD());
      return;
    }

    // SOAP Control
    if (url === '/ContentDirectory/control' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');

        if (body.includes('Browse')) {
          res.end(this.handleBrowse(body));
        } else if (body.includes('GetSystemUpdateID')) {
          res.end(this.handleGetSystemUpdateID());
        } else {
          res.writeHead(500);
          res.end('Unknown action');
        }
      });
      return;
    }

    if (url === '/ConnectionManager/control' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');

        if (body.includes('GetProtocolInfo')) {
          res.end(this.handleGetProtocolInfo());
        } else {
          res.writeHead(500);
          res.end('Unknown action');
        }
      });
      return;
    }

    // Стриминг медиа-файлов
    if (url.startsWith('/media/')) {
      const filePath = decodeURIComponent(url.substring(7));
      this.streamMedia(req, res, filePath);
      return;
    }

    // Event subscription (заглушка)
    if (url.includes('/event')) {
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  /**
   * Стриминг медиа-файла
   */
  streamMedia(req, res, relativePath) {
    const fullPath = path.join(this.downloadDirectory, relativePath);

    // Проверка безопасности
    if (!fullPath.startsWith(this.downloadDirectory)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(fullPath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        res.end('File not found');
        return;
      }

      const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
      const fileSize = stats.size;
      const range = req.headers.range;

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('transferMode.dlna.org', 'Streaming');

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunkSize
        });

        fs.createReadStream(fullPath, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', fileSize);
        fs.createReadStream(fullPath).pipe(res);
      }
    });
  }

  /**
   * Остановить сервер
   */
  async stop() {
    if (!this.running) {
      return { success: true, message: 'Сервер не запущен' };
    }

    if (this.ssdpServer) {
      this.ssdpServer.stop();
      this.ssdpServer = null;
    }

    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(resolve);
      });
      this.httpServer = null;
    }

    this.running = false;
    console.log('DLNA сервер остановлен');

    return { success: true };
  }

  /**
   * Получить статус сервера
   */
  getStatus() {
    return {
      running: this.running,
      name: this.serverName,
      port: this.port,
      ip: this.running ? this.getLocalIP() : null,
      mediaFilesCount: this.mediaFiles.length
    };
  }

  /**
   * Обновить директорию загрузок
   */
  setDownloadDirectory(directory) {
    this.downloadDirectory = directory;
    if (this.running) {
      this.scanMediaFiles();
    }
  }
}

export default DLNAServer;
