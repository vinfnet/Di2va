// Generate placeholder PNG icons for the extension
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const sizes = [16, 48, 128];
const outDir = path.join(__dirname, 'icons');

for (const size of sizes) {
  const buf = createPng(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buf);
  console.log(`Created icon${size}.png (${buf.length} bytes)`);
}

function createPng(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Image data: solid orange #fc4c02
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const offset = y * rowBytes;
    raw[offset] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[offset + 1 + x * 3]     = 0xfc;
      raw[offset + 1 + x * 3 + 1] = 0x4c;
      raw[offset + 1 + x * 3 + 2] = 0x02;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const idatChunk = makeChunk('IDAT', compressed);

  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeB, data]);
  const crc = crc32(payload);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
