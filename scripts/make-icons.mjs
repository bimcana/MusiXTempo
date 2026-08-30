/**
 * Genera los iconos PNG de la PWA sin dependencias: rasteriza a mano y
 * escribe el PNG con zlib, que ya viene en Node.
 *
 * El motivo es el mismo indicador de pulso de la app: un aro con las
 * marcas de compas y el uno encendido.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');

const GROUND = [0x0e, 0x12, 0x16];
const RING = [0x39, 0x43, 0x4e];
const SIGNAL = [0xf5, 0xb3, 0x3f];
const SIGNAL_HI = [0xff, 0xc9, 0x6b];

/* ---------------- CRC32 y contenedor PNG ---------------- */

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidad de bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- Dibujo ---------------- */

/** Supermuestreo 3x3: sin antialiasing el aro se ve escalonado. */
function render(size, { maskable }) {
  const ss = 3;
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  // En modo maskable el sistema recorta hasta un 20 % del borde.
  const scale = maskable ? 0.62 : 0.78;
  const ringRadius = (size / 2) * scale;
  const ringWidth = size * 0.055;
  const pulses = 4;
  const dotRadius = size * 0.055;
  const accentRadius = size * 0.085;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          let color = GROUND;

          const d = Math.hypot(px - c, py - c);
          if (Math.abs(d - ringRadius) <= ringWidth / 2) color = RING;

          for (let i = 0; i < pulses; i++) {
            const angle = -Math.PI / 2 + (i / pulses) * Math.PI * 2;
            const dx = px - (c + Math.cos(angle) * ringRadius);
            const dy = py - (c + Math.sin(angle) * ringRadius);
            const radius = i === 0 ? accentRadius : dotRadius;
            if (dx * dx + dy * dy <= radius * radius) {
              color = i === 0 ? SIGNAL_HI : SIGNAL;
            }
          }

          r += color[0];
          g += color[1];
          b += color[2];
        }
      }

      const n = ss * ss;
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0E1216"/>
  <circle cx="32" cy="32" r="22" fill="none" stroke="#39434E" stroke-width="3.5"/>
  <circle cx="32" cy="10" r="5.5" fill="#FFC96B"/>
  <circle cx="54" cy="32" r="3.5" fill="#F5B33F"/>
  <circle cx="32" cy="54" r="3.5" fill="#F5B33F"/>
  <circle cx="10" cy="32" r="3.5" fill="#F5B33F"/>
</svg>
`;

mkdirSync(publicDir, { recursive: true });

const outputs = [
  ['icon-192.png', render(192, { maskable: false })],
  ['icon-512.png', render(512, { maskable: false })],
  ['icon-maskable-512.png', render(512, { maskable: true })],
  ['apple-touch-icon.png', render(180, { maskable: false })],
  ['favicon.svg', Buffer.from(FAVICON_SVG, 'utf8')]
];

for (const [name, data] of outputs) {
  writeFileSync(join(publicDir, name), data);
  console.log(name.padEnd(24) + (data.length / 1024).toFixed(1) + ' KB');
}
