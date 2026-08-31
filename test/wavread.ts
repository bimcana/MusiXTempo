/**
 * Lector minimo de WAV PCM para los fixtures reales. Solo lo que los
 * fixtures usan: PCM 16 bits, mono o estereo (se mezcla a mono).
 */

import { readFileSync } from 'node:fs';

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
  seconds: number;
}

export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('No es un WAV: ' + path);
  }

  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(body);
      if (audioFormat !== 1) throw new Error('Solo se soporta PCM (formato 1), no ' + audioFormat);
      format = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    // Los chunks van alineados a 2 bytes.
    offset = body + size + (size % 2);
  }

  if (!format || !data) throw new Error('WAV sin fmt o sin data: ' + path);
  if (format.bits !== 16) throw new Error('Solo PCM de 16 bits, no ' + format.bits);

  const frames = Math.floor(data.length / 2 / format.channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < format.channels; c++) {
      acc += data.readInt16LE((i * format.channels + c) * 2);
    }
    samples[i] = acc / format.channels / 32768;
  }

  return { samples, sampleRate: format.sampleRate, seconds: frames / format.sampleRate };
}
