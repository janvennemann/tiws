const {
  OpcodeBinaryFrame,
  OpcodeConnectionClose,
  OpcodeContinueFrame,
  OpcodePong,
  OpcodeTextFrame
} = require('./constants')
const { randomFillSync, applyMask } = require('./utils');

const mask = Buffer.alloc(4);

class Sender {
  constructor(socket) {
    this.socket = socket;
    this.firstFragment = true;
  }

  send(data, options, cb) {
    const perMessageDeflate = false;
    let opcode = options.binary ? OpcodeBinaryFrame : OpcodeTextFrame;
    let rsv1 = options.compress;

    if (this.firstFragment) {
      this.firstFragment = false;
      // @todo support perMessageDeflate
    } else {
      rsv1 = false;
      opcode = OpcodeContinueFrame;
    }

    if (options.fin) {
      this.firstFragment = true;
    }

    this.sendFrame(this.createFrameBuffer({
      data,
      opcode,
      fin: options.fin,
      rsv1
    }), cb);
  }

  pong(data, cb) {
    const buffer = Buffer.from(data);
    this.sendFrame(this.createFrameBuffer({
      data: buffer,
      opcode: OpcodePong,
      fin: true,
      rsv1: false
    }), cb);
  }

  close(code, reason, cb) {
    let data;
    if (code === undefined) {
      data = Buffer.allocUnsafe(0);
    } else if (typeof code !== 'number') {
      throw new TypeError('Closing code must be a valid error code number');
    } else if (reason === undefined || reason === '') {
      data = Buffer.allocUnsafe(2);
      data.writeUInt16BE(code, 0);
    } else {
      data = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
      data.writeUInt16BE(code, 0);
      data.write(reason, 2);
    }

    this.sendFrame(this.createFrameBuffer({
      data,
      opcode: OpcodeConnectionClose,
      fin: true,
      rsv1: false
    }), cb);
  }

  sendFrame(frame, cb) {
    this.socket.write(frame.toTiBuffer(), 0, frame.length, () => {
      if (cb) {
        cb();
      }
    });
  }

  /**
   * Creates a buffer containing the framed data
   *
   * @param {Object} options Options for the frame
   * @param {Buffer} options.data The data to frame
   * @param {Number} options.opcode Frame opcode
   * @param {Boolean} options.fin Specifies whether or not to set the FIN bit
   * @param {Boolean} options.rsv1 Specifies whether or not to set the RSV1 bit
   * @return {Buffer}
   */
  createFrameBuffer(options) {
    const data = options.data;
    let offset = 6;
    let payloadLength = data.length;

    if (data.length >= 65536) {
      offset += 8;
      payloadLength = 127;
    } else if (data.length > 125) {
      offset += 2;
      payloadLength = 126;
    }

    const target = Buffer.allocUnsafe(offset);

    target[0] = options.fin ? options.opcode | 0x80 : options.opcode;
    if (options.rsv1) {
      target[0] |= 0x40;
    }

    target[1] = payloadLength;

    if (payloadLength === 126) {
      target.writeUInt16BE(data.length, 2);
    } else if (payloadLength === 127) {
      target.writeUInt32BE(0, 2);
      target.writeUInt32BE(data.length, 6);
    }

    randomFillSync(mask, 0, 4);

    target[1] |= 0x80;
    target[offset - 4] = mask[0];
    target[offset - 3] = mask[1];
    target[offset - 2] = mask[2];
    target[offset - 1] = mask[3];

    applyMask(data, mask, data, 0, data.length);

    return Buffer.concat([ target, data ]);
  }
}

module.exports = Sender;
