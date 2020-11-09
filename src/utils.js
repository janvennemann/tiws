function randomBytes(length) {
  if (Ti.Utils.randomBytes) {
    return Buffer.from(Ti.Utils.randomBytes(length));
  } else {
    const randomBytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      randomBytes[i] = Math.floor(Math.random() * Math.floor(255));
    }
    return randomBytes;
  }
}

function randomFillSync(target, offset, length) {
  const bytes = randomBytes(length);
  bytes.copy(target, offset, 0, length);
}

function applyMask(source, mask, output, offset, length) {
  for (let i = 0; i < length; i++) {
    output[offset + i] = source[i] ^ mask[i & 3];
  }
}

module.exports = {
  randomBytes,
  randomFillSync,
  applyMask
};
