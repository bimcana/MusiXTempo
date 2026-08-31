/**
 * Preparacion del fragmento que se manda a identificar.
 *
 * Se remuestrea a ~12 kHz mono y se codifica en WAV de 16 bits. Los
 * motores de fingerprinting trabajan de sobra a esa frecuencia, y baja
 * el envio de mas de un mega a unos 300 KB — que en datos moviles es la
 * diferencia entre util e inaceptable.
 */

import { Decimator2 } from '../dsp/core';

/** Frecuencia objetivo aproximada. Se alcanza dividiendo por potencias de dos. */
const TARGET_RATE = 12000;

export interface EncodedSnippet {
  blob: Blob;
  sampleRate: number;
  seconds: number;
}

/** Divide por dos tantas veces como se pueda sin bajar del objetivo. */
function decimate(samples: Float32Array, sampleRate: number): { samples: Float32Array; sampleRate: number } {
  let current = samples;
  let rate = sampleRate;
  while (rate / 2 >= TARGET_RATE) {
    const decimator = new Decimator2();
    const out = new Float32Array(Math.ceil(current.length / 2) + 2);
    const written = decimator.process(current, out);
    current = out.subarray(0, written);
    rate = rate / 2;
  }
  return { samples: current, sampleRate: rate };
}

/** WAV PCM 16 bits mono. El formato que aceptan todos los proveedores. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // tamano del bloque fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // bytes por segundo
  view.setUint16(32, bytesPerSample, true); // alineacion de bloque
  view.setUint16(34, 16, true); // bits por muestra
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function prepareSnippet(samples: Float32Array, sampleRate: number): EncodedSnippet {
  const reduced = decimate(samples, sampleRate);
  return {
    blob: encodeWav(reduced.samples, reduced.sampleRate),
    sampleRate: reduced.sampleRate,
    seconds: reduced.samples.length / reduced.sampleRate
  };
}
