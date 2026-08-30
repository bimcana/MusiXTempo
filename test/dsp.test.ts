import { describe, expect, it } from 'vitest';
import {
  FFT,
  autocorrelate,
  bpmToLag,
  lagToBpm,
  parabolicPeak,
  robustMean
} from '../src/dsp/core';
import { computeTempogram, fitTempo, trackBeats } from '../src/dsp/tempo';
import {
  analyzeSubdivision,
  analyzeGrouping,
  pulsesPerBar,
  subdivisionsPerPulse,
  toTimeSignature
} from '../src/dsp/meter';

/** Tren de impulsos a un BPM dado, en el dominio de tramas. */
function impulseTrain(bpm: number, frameRate: number, frames: number, subdivide = 0): Float32Array {
  const out = new Float32Array(frames);
  const period = bpmToLag(bpm, frameRate);
  for (let k = 0; k * period < frames; k++) {
    const i = Math.round(k * period);
    if (i < frames) out[i] = 1;
    if (subdivide > 0) {
      for (let s = 1; s < subdivide; s++) {
        const j = Math.round(k * period + (s * period) / subdivide);
        if (j < frames) out[j] = 0.5;
      }
    }
  }
  return out;
}

describe('FFT', () => {
  it('la inversa devuelve la senal original', () => {
    const n = 256;
    const fft = new FFT(n);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const original = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      original[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 19 * i) / n);
      re[i] = original[i];
    }
    fft.transform(re, im);
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(original[i], 4);
  });

  it('localiza un tono puro en su bin', () => {
    const n = 512;
    const fft = new FFT(n);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const bin = 32;
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fft.transform(re, im);
    let best = 0;
    let bestMag = -1;
    for (let k = 1; k < n / 2; k++) {
      const m = re[k] * re[k] + im[k] * im[k];
      if (m > bestMag) {
        bestMag = m;
        best = k;
      }
    }
    expect(best).toBe(bin);
  });
});

describe('autocorrelacion', () => {
  it('encuentra el periodo de una senal periodica', () => {
    const n = 600;
    const period = 37;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i += period) sig[i] = 1;

    // Se busca dentro del rango de lags que el motor considera fiable
    // (hasta ~0.4 de la ventana). Mas alla, la ACF se sostiene sobre
    // demasiado pocos solapes para afirmar nada.
    const acf = autocorrelate(sig, 200);
    const maxLag = Math.floor(n * 0.4);
    let best = 5;
    for (let lag = 5; lag < Math.min(acf.length, maxLag); lag++) {
      if (acf[lag] > acf[best]) best = lag;
    }
    expect(best).toBe(period);
  });
});

describe('tempograma', () => {
  const frameRate = 86.13;

  it('acierta el tempo de un tren de impulsos a 120 BPM', () => {
    const onset = impulseTrain(120, frameRate, 700);
    const tg = computeTempogram(onset, frameRate);
    expect(tg.candidates.length).toBeGreaterThan(0);
    const bpm = tg.candidates[0].bpm;
    // El pico puede caer en un nivel metrico vecino: aqui solo se exige
    // que sea una relacion simple con el real.
    const ratios = [1, 2, 0.5, 3, 1 / 3];
    expect(ratios.some((r) => Math.abs(bpm - 120 * r) / (120 * r) < 0.04)).toBe(true);
  });

  it('el candidato del pulso aparece incluso con subdivision presente', () => {
    const onset = impulseTrain(100, frameRate, 800, 2);
    const tg = computeTempogram(onset, frameRate, 8);
    const target = bpmToLag(100, frameRate);
    const found = tg.candidates.some((c) => Math.abs(c.lag - target) / target < 0.05);
    expect(found).toBe(true);
  });
});

describe('rastreo de beats y ajuste', () => {
  const frameRate = 86.13;

  it('recupera el periodo con precision muy por debajo de la trama', () => {
    const bpm = 137.4;
    const period = bpmToLag(bpm, frameRate);
    const frames = 900;
    const onset = new Float32Array(frames);
    for (let k = 0; k * period < frames; k++) {
      const exact = k * period;
      const i = Math.round(exact);
      if (i < frames) onset[i] = 3;
    }

    const track = trackBeats(onset, period);
    expect(track.beats.length).toBeGreaterThan(8);

    const fit = fitTempo(track.beats, period);
    expect(fit).not.toBeNull();
    const estimated = lagToBpm(fit!.period, frameRate);
    // El redondeo a trama introduce +-11 ms por beat; el ajuste por
    // minimos cuadrados sobre toda la ventana lo promedia casi a cero.
    expect(Math.abs(estimated - bpm)).toBeLessThan(0.5);
  });

  it('sobrevive a un beat perdido', () => {
    const bpm = 120;
    const period = bpmToLag(bpm, frameRate);
    const beats: number[] = [];
    for (let k = 0; k < 16; k++) {
      if (k === 7) continue;
      beats.push(Math.round(k * period));
    }
    const fit = fitTempo(beats, period);
    expect(fit).not.toBeNull();
    expect(Math.abs(lagToBpm(fit!.period, frameRate) - bpm)).toBeLessThan(1);
  });
});

describe('subdivision y agrupacion', () => {
  it('distingue binario de ternario en el perfil de pulso', () => {
    const binary = new Float32Array(24);
    binary[0] = 3;
    binary[12] = 1.6;
    expect(analyzeSubdivision(binary).subdivision).toBe('binary');

    const ternary = new Float32Array(24);
    ternary[0] = 3;
    ternary[8] = 1.5;
    ternary[16] = 1.5;
    expect(analyzeSubdivision(ternary).subdivision).toBe('ternary');
  });

  it('prefiere agrupar de cuatro antes que de dos cuando el patron es de cuatro', () => {
    const cues: number[] = [];
    for (let i = 0; i < 32; i++) cues.push(i % 4 === 0 ? 1.4 : -0.5);
    const g = analyzeGrouping(cues);
    expect(g.pulsesPerBar).toBe(4);
    expect(g.phase).toBe(0);
  });

  it('detecta agrupacion de dos, que es lo que hace posible el 6/8', () => {
    const cues: number[] = [];
    for (let i = 0; i < 24; i++) cues.push(i % 2 === 0 ? 1.3 : -0.7);
    expect(analyzeGrouping(cues).pulsesPerBar).toBe(2);
  });

  it('detecta agrupacion de tres', () => {
    const cues: number[] = [];
    for (let i = 0; i < 30; i++) cues.push(i % 3 === 0 ? 1.5 : -0.6);
    expect(analyzeGrouping(cues).pulsesPerBar).toBe(3);
  });
});

describe('cifra de compas', () => {
  it('traduce agrupacion y subdivision a la cifra correcta', () => {
    expect(toTimeSignature(2, 'ternary')).toEqual({ beatsPerBar: 6, beatUnit: 8 });
    expect(toTimeSignature(4, 'binary')).toEqual({ beatsPerBar: 4, beatUnit: 4 });
    expect(toTimeSignature(3, 'binary')).toEqual({ beatsPerBar: 3, beatUnit: 4 });
    expect(toTimeSignature(4, 'ternary')).toEqual({ beatsPerBar: 12, beatUnit: 8 });
    expect(toTimeSignature(2, 'binary')).toEqual({ beatsPerBar: 2, beatUnit: 4 });
  });

  it('el numero de pulsos por compas es la inversa exacta', () => {
    for (const pulses of [2, 3, 4, 5]) {
      for (const sub of ['binary', 'ternary'] as const) {
        expect(pulsesPerBar(toTimeSignature(pulses, sub))).toBe(pulses);
      }
    }
  });

  it('en compuesto hay tres subdivisiones por pulso, en simple dos', () => {
    expect(subdivisionsPerPulse({ beatsPerBar: 6, beatUnit: 8 })).toBe(3);
    expect(subdivisionsPerPulse({ beatsPerBar: 4, beatUnit: 4 })).toBe(2);
    expect(subdivisionsPerPulse({ beatsPerBar: 12, beatUnit: 8 })).toBe(3);
  });
});

describe('utilidades', () => {
  it('el promedio robusto descarta un toque mal dado', () => {
    // Siete toques a 500 ms y uno perdido a 900: el tap tempo no debe
    // dejarse arrastrar por el atipico.
    const taps = [500, 505, 498, 502, 900, 497, 503, 501];
    expect(robustMean(taps)).toBeGreaterThan(495);
    expect(robustMean(taps)).toBeLessThan(510);
  });

  it('la interpolacion parabolica afina el pico', () => {
    const a = [0, 1, 4, 3.5, 0];
    const { offset } = parabolicPeak(a, 2);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(0.5);
  });
});
