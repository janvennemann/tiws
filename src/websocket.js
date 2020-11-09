/**
 * Minimal WebSocket implementation using Ti.Network.Socket.TCP.
 *
 * Heavily inspired by Starscream (https://github.com/daltoniam/Starscream/)
 * and ws (https://github.com/websockets/ws)
 */

const EventEmiter = require('events');

const url = require('./shims/url');
const {
  FinMask,
  MaskMask,
  OpcodeBinaryFrame,
  OpcodeConnectionClose,
  OpcodeContinueFrame,
  OpcodeMask,
  OpcodePing,
  OpcodeTextFrame,
  PayloadLengthMask,
  EMPTY_BUFFER,
  NOOP
} = require('./constants');
const Sender = require('./sender');
const { randomBytes } = require('./utils');

const Url = url.Url;
const readyStates = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
const protocolVersions = [ 8, 13 ];
const closeTimeout = 30 * 1000;
const CloseCode = {
  protocolError: 1002,
  noStatus: 1005,
  abnormal: 1006
};

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketResponse {
  constructor() {
    this.isFin = false;
    this.opcode = OpcodeContinueFrame;
    this.bytesLeft = 0;
    this.frameCount = 0;
    this.buffer = null;
  }
}

class ResponseStack {
  constructor() {
    this.stack = [];
  }

  get length() {
    return this.stack.length;
  }

  get last() {
    if (this.length > 0) {
      return this.stack[this.length - 1];
    }

    return null;
  }

  push(response) {
    this.stack.push(response);
  }

  pop() {
    return this.stack.pop();
  }
}

class WebSocket extends EventEmiter {
  /**
   * Creates a new WebSocket
   *
   * @param {String} address The URL to which to connect
   * @param {String|String[]} protocols The subprotocols
   * @param {Object} options Connection options
   */
  constructor(address, protocols, options) {
    super();

    this.responseStack = new ResponseStack();
    this.readyState = WebSocket.CONNECTING;
    this.socket = null;
    this.isServer = false;
    this.closeFrameSent = false;
    this.closeFrameReceived = false;

    if (Array.isArray(protocols)) {
      protocols = protocols.join(', ');
    } else if (typeof protocols === 'object' && protocols !== null) {
      options = protocols;
      protocols = undefined;
    }
    this.connect(address, protocols, options);
  }

  static get CONNECTING() {
    return 0;
  }

  static get OPEN() {
    return 1;
  }

  static get CLOSING() {
    return 2;
  }

  static get CLOSED() {
    return 3;
  }

  connect(address, protocols, options) {
    const opts = {
      protocolVersion: protocolVersions[1],
      maxPayload: 100 * 1024 * 1024,
      perMessageDeflate: true,
      followRedirects: false,
      maxRedirects: 10,
      ...options,
      createConnection: undefined,
      socketPath: undefined,
      hostname: undefined,
      protocol: undefined,
      timeout: undefined,
      method: undefined,
      auth: undefined,
      host: undefined,
      path: undefined,
      port: undefined
    };

    let parsedUrl;

    if (address instanceof Url) {
      parsedUrl = address;
      this.url = address.href;
    } else {
      parsedUrl = url.parse(address);
      this.url = address;
    }

    const isUnixSocket = parsedUrl.protocol === 'ws+unix:';
    if ((!parsedUrl.host && !parsedUrl.pathname) || isUnixSocket) {
      throw new Error(`Invalid URL: ${this.url}`);
    }

    const isSecure = parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:';
    const defaultPort = isSecure ? 443 : 80;
    this.secWebSocketKey = this.generateSecWebSocketKey();

    opts.defaultPort = opts.defaultPort || defaultPort;
    opts.port = parsedUrl.port || defaultPort;
    opts.host = parsedUrl.hostname.startsWith('[')
      ? parsedUrl.hostname.slice(1, -1)
      : parsedUrl.hostname;
    opts.headers = {
      'Sec-WebSocket-Version': opts.protocolVersion,
      'Sec-WebSocket-Key': this.secWebSocketKey,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      ...opts.headers
    };
    opts.path = parsedUrl.pathname + parsedUrl.search;
    opts.timeout = opts.handshakeTimeout;

    if (opts.perMessageDeflate) {
      Ti.API.warn('WebSocket option "perMessageDeflate" is currently not supported in Titanium.');
      /*
      @todo support PerMessageDeflate
      perMessageDeflate = new PerMessageDeflate(
        opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
        false,
        opts.maxPayload
      );
      opts.headers['Sec-WebSocket-Extensions'] = format({
        [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
      });
      */
    }

    if (protocols) {
      opts.headers['Sec-WebSocket-Protocol'] = protocols;
    }
    if (opts.origin) {
      if (opts.protocolVersion < 13) {
        opts.headers['Sec-WebSocket-Origin'] = opts.origin;
      } else {
        opts.headers.Origin = opts.origin;
      }
    }
    if (parsedUrl.username || parsedUrl.password) {
      opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
    }
    this.options = opts;

    const self = this;
    this.socket = Ti.Network.Socket.createTCP({
      host: opts.host,
      port: opts.port,
      timeout: opts.timeout,
      connected: e => {
        this.sender = new Sender(this.socket);
        this.performWsHandshake();
        Ti.Stream.pump(self.socket, self.processInputStream.bind(self), 64 * 1024, true);
      },
      error: e => {
        this.readyState = WebSocket.CLOSED;
        this.emitEvent('error', e.error);
      }
    });
    this.socket.connect();
  }

  pong(data, mask, cb) {
    if (this.readyState === WebSocket.CONNECTING) {
      throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    }

    if (typeof data === 'function') {
      cb = data;
      data = mask = undefined;
    } else if (typeof mask === 'function') {
      cb = mask;
      mask = undefined;
    }

    if (typeof data === 'number') data = data.toString();

    if (this.readyState !== WebSocket.OPEN) {
      this.sendAfterClose(data, cb);
      return;
    }

    if (mask === undefined) mask = !this._isServer;
    this.sender.pong(data || EMPTY_BUFFER, mask, cb);
  }

  send(data, options, cb) {
    if (this.readyState === WebSocket.CONNECTING) {
      throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    }

    if (typeof data === 'number') {
      data = data.toString();
    }

    if (this.readyState !== WebSocket.OPEN) {
      this.sendAfterClose(data, cb);
      return;
    }

    const opts = {
      binary: typeof data !== 'string',
      compress: false,
      fin: true,
      ...options
    };

    this.sender.send(data, opts, cb);
  }

  close(code, reason) {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    if (this.readyState === WebSocket.CONNECTING) {
      const msg = 'WebSocket was closed before the connection was established';
      return abortHandshake(this, msg);
    }

    const closeSocket = () => {
      this.socket.close();
      this.emitClose(code, reason);
    };

    if (this.readyState === WebSocket.CLOSING) {
      if (this.closeFrameSent && this.closeFrameReceived) {
        closeSocket();
      }
      return;
    }

    this.readyState = WebSocket.CLOSING;
    this.sender.close(code, reason, err => {
      this.closeFrameSent = true;
      if (this.closeFrameReceived) {
        closeSocket();
      }
    });
  }

  generateSecWebSocketKey() {
    return randomBytes(16).toString('base64');
  }

  emitClose(code = 1006, message = '') {
    this.readyState = WebSocket.CLOSED;

    this.emitEvent('close', code, message);
  }

  disconnectAndEmitError(error, closeCode) {
    this.emitEvent('error', error);
    this.close(closeCode || CloseCode.abnormal, error.message);
  }

  performWsHandshake() {
    let httpHeader = `GET ${this.options.path} HTTP/1.1\r\n`;
    httpHeader += `Host: ${this.options.host}\r\n`;
    Object.keys(this.options.headers).forEach(headerName => {
      const headerValue = this.options.headers[headerName];
      httpHeader += `${headerName}: ${headerValue}\r\n`;
    });
    httpHeader += '\r\n';
    const data = Ti.createBuffer({
      value: httpHeader
    });
    this.socket.write(data, () => {});
  }

  processHandshake(buffer) {
    const response = buffer.toString();
    if (response.indexOf('HTTP/1.1 101') === -1) {
      abortHandshake(this, 'Invalid HTTP status code received during WebSocket hanshake.');
      return;
    }

    const headers = {};
    const headerPattern = /([\w-]+): (.*)/g;
    let match;
    while ((match = headerPattern.exec(response)) !== null) {
      headers[match[1].toLowerCase()] = match[2];
    }
    const secWebSocketAccept = headers['sec-websocket-accept'];
    const hash = Buffer.from(Ti.Utils.sha1(this.secWebSocketKey + GUID), 'hex').toString('base64');
    if (hash !== secWebSocketAccept) {
      abortHandshake(this, 'Invalid Sec-WebSocket-Accept header');
      return;
    }

    this.readyState = WebSocket.OPEN;

    this.emitEvent('open');
  }

  processInputStream(e) {
    if (e.bytesProcessed === -1) {
      if (this.readyState === WebSocket.CLOSED) {
        // socket is already in closed state, nothing to do
        return;
      }

      this.socketOnClose();
      return;
    }

    if (!e.buffer) {
      throw new Error('No buffer to process in socket pump callback');
    }

    const buffer = Buffer.from(e.buffer.toBlob().toArrayBuffer());
    if (this.readyState === WebSocket.CONNECTING) {
      this.processHandshake(buffer);
    } else {
      this.processDataFramesInBuffer(buffer);
    }
  }

  processDataFramesInBuffer(buffer) {
    while (buffer.length >= 2) {
      buffer = this.processDataFrame(buffer);
    }
    if (buffer.length > 0) {
      throw new Error('Fragmented data in buffer which cannot be processed');
    }
  }

  processDataFrame(buffer) {
    let response = this.responseStack.last;
    const bufferLength = buffer.length;
    const isFin = (FinMask & buffer[0]) !== 0;
    const opcode = OpcodeMask & buffer[0];
    const isMasked = (MaskMask & buffer[1]) !== 0;
    const payloadLength = PayloadLengthMask & buffer[1];
    let payloadDataOffset = 2;

    if (isMasked) {
      return this.disconnectAndEmitError(new Error('Received masked data from server'), CloseCode.protocolError);
    }

    const isControlFrame = opcode === OpcodeConnectionClose || opcode === OpcodePing;
    // @todo check for valid opcode

    if (isControlFrame && isFin === false) {
      return this.disconnectAndEmitError(new Error('Control frames can\'t be fragmented.'), CloseCode.protocolError);
    }

    let payloadDataLength = payloadLength;
    if (payloadLength === 126) {
      payloadDataLength = buffer[2] << 8 | buffer[3] & 0xffff;
      payloadDataOffset += 2;
    } else if (payloadLength === 127) {
      // @todo: handle extended payload length of 64 bit unsinged int
      throw new Error('unsupported payload length of 64 bit unsinged int');
    }
    let framePayloadDataLength = payloadDataLength;
    if (framePayloadDataLength > bufferLength) {
      framePayloadDataLength = bufferLength - payloadDataOffset;
    }

    const data = Buffer.alloc(payloadDataLength);
    buffer.copy(data, 0, payloadDataOffset, payloadDataOffset + payloadDataLength);

    let isNewResponse = false;
    if (response === null) {
      isNewResponse = true;
      response = new WebSocketResponse();
      response.opcode = opcode;
      response.bytesLeft = payloadDataLength;
      response.buffer = data;
    } else {
      if (opcode === OpcodeContinueFrame) {
        response.bytesLeft = payloadDataLength;
      } else {
        this.disconnectAndEmitError(new Error('A frame after a fragmeneted message must be a continue frame.'));
      }
      response.buffer = Buffer.concat([response.buffer, data]);
    }

    response.bytesLeft -= framePayloadDataLength;
    response.frameCount += 1;
    response.isFin = isFin;
    if (isNewResponse) {
      this.responseStack.push(response);
    }

    this.processResponse(response);

    const nextFrameOffset = payloadDataOffset + framePayloadDataLength;
    const nextFrameLength = buffer.length - nextFrameOffset
    const nextFrame = Buffer.alloc(nextFrameLength)
    return buffer.copy(nextFrame, 0, nextFrameOffset);
  }

  /**
   * @todo Move this to a class that handles received frames
   *
   * @param {WebSocketResponse} response
   */
  processResponse(response) {
    if (response.isFin && response.bytesLeft <= 0) {
      if (response.opcode === OpcodePing) {
        const data = response.buffer;
        this.pong(data, !this.isServer, NOOP);
        this.emit('ping', data);
      } else if (response.opcode === OpcodeConnectionClose) {
        let closeReason = 'connection closed by server';
        let closeCode;
        const data = response.buffer;
        if (data.length === 0) {
          closeCode = CloseCode.noStatus;
        } else if (data.length === 1) {
          throw new RangeError('Invalid payload length 1');
        } else {
          closeCode = data.readUInt16BE(0);
          // @todo validate status code
          const buf = data.slice(2);
          closeReason = buf.toString();
        }

        this.closeFrameReceived = true;

        if (closeCode === CloseCode.noStatus) {
          this.close();
        } else {
          this.close(closeCode, closeReason);
        }
      } else if (response.opcode === OpcodeTextFrame) {
        const message = response.buffer.toString();
        this.emitEvent('message', {
          data: message
        });
      } else if (response.opcode === OpcodeBinaryFrame) {
        const data = Buffer.from(response.buffer);
        this.emitEvent('message', {
          data
        });
      }

      this.responseStack.pop();
    }
  }

  emitEvent(name, data) {
    const callbackPropertyName = `on${name}`;
    if (this[callbackPropertyName]) {
      this[callbackPropertyName](data);
    }

    this.emit(name, data);
  }

  /**
   * Handle cases where the `ping()`, `pong()`, or `send()` methods are called
   * when the `readyState` attribute is `CLOSING` or `CLOSED`.
   *
   * @param {*} [data] The data to send
   * @param {Function} [cb] Callback
   * @private
   */
  sendAfterClose(data, cb) {
    if (data) {
      // @todo implements checks from websocket/ws
    }

    if (cb) {
      const err = new Error(
        `WebSocket is not open: readyState ${this.readyState} ` +
          `(${readyStates[this.readyState]})`
      );
      cb(err);
    }
  }

  socketOnClose() {
    this.readyState = WebSocket.CLOSING;
    this.socket = undefined;
    this.emitClose();
  }
}

function abortHandshake(webSocket, msg) {
  webSocket.readyState = WebSocket.CLOSING;

  if (webSocket.socket.state === Ti.Network.Socket.CONNECTED) {
    webSocket.socket.close();
  }

  webSocket.emitClose(CloseCode.abnormal, msg);
}

module.exports = WebSocket;
