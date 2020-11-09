module.exports = {
  OpcodeContinueFrame: 0x0,
  OpcodeTextFrame: 0x1,
  OpcodeBinaryFrame: 0x2,
  OpcodeConnectionClose: 0x8,
  OpcodePing: 0x9,
  OpcodePong: 0xA,

  FinMask: 0x80,
  OpcodeMask: 0x0F,
  MaskMask: 0x80,
  PayloadLengthMask: 0x7F,

  EMPTY_BUFFER: Buffer.alloc(0),
  NOOP: () => {}
};
