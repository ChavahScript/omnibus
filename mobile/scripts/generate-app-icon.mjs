/**
 * Generates the raster source consumed by Expo/iOS from the adjacent SVG
 * concept. Keeping this tiny dependency-free renderer in-tree makes the icon
 * reproducible without a design export tool or an opaque binary edit.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const size = 1024;
const pixels = Buffer.alloc(size * size * 4);
const black = [9, 9, 9, 255];
const white = [244, 244, 240, 255];

for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(black, offset);

function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) return;
  const offset = (y * size + x) * 4;
  const source = Math.min(1, alpha);
  const inverse = 1 - source;
  pixels[offset] = Math.round(pixels[offset] * inverse + color[0] * source);
  pixels[offset + 1] = Math.round(pixels[offset + 1] * inverse + color[1] * source);
  pixels[offset + 2] = Math.round(pixels[offset + 2] * inverse + color[2] * source);
  pixels[offset + 3] = 255;
}

function smooth(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function circle(cx, cy, radius, color = white, opacity = 1) {
  const minX = Math.floor(cx - radius - 2);
  const maxX = Math.ceil(cx + radius + 2);
  const minY = Math.floor(cy - radius - 2);
  const maxY = Math.ceil(cy + radius + 2);
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    blend(x, y, color, (1 - smooth(radius - 1, radius + 1, distance)) * opacity);
  }
}

function roundedRect(x, y, width, height, radius, color, opacity = 1) {
  const minX = Math.floor(x - 2);
  const maxX = Math.ceil(x + width + 2);
  const minY = Math.floor(y - 2);
  const maxY = Math.ceil(y + height + 2);
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  for (let py = minY; py <= maxY; py += 1) for (let px = minX; px <= maxX; px += 1) {
    const qx = Math.abs(px + 0.5 - centerX) - width / 2 + radius;
    const qy = Math.abs(py + 0.5 - centerY) - height / 2 + radius;
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    blend(px, py, color, (1 - smooth(-1, 1, distance)) * opacity);
  }
}

function roundedStroke(x, y, width, height, radius, stroke, color, opacity = 1) {
  roundedRect(x, y, width, height, radius, color, opacity);
  roundedRect(x + stroke, y + stroke, width - stroke * 2, height - stroke * 2, Math.max(0, radius - stroke), black, 1);
}

// Quiet outer keyline and five “team” heads.
roundedStroke(90, 90, 844, 844, 168, 8, white, 0.12);
circle(314, 338, 78);
circle(710, 338, 78);
circle(282, 656, 78);
circle(742, 656, 78);
circle(512, 244, 65);

// Phone over the team heads: the team is literally inside the phone.
roundedStroke(356, 218, 312, 590, 72, 34, white);
roundedStroke(401, 304, 222, 350, 28, 20, white, 0.84);
roundedRect(465, 712, 94, 24, 12, white);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = crc32(Buffer.concat([name, data]));
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  const target = y * (size * 4 + 1);
  scanlines[target] = 0;
  pixels.copy(scanlines, target + 1, y * size * 4, (y + 1) * size * 4);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8; // RGBA depth
header[9] = 6; // RGBA color type

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../assets/app-icon.png", import.meta.url), png);
