/**
 * Frontend de caracteristicas: STFT -> mel blanqueado -> tres detectores
 * de onset. Codigo PURO.
 *
 * Los tres detectores no son redundancia: cada uno cubre un tipo de
 * ataque que los otros no ven.
 *
 *   flux            ataques percusivos (bombo, caja, hi-hats)
 *   complexNovelty  ataques suaves (cuerdas, sintetizadores, pads)
 *   pitchNovelty    tarareo, donde no hay ataque, solo nota nueva
 */

import { FFT, clamp, getFFT, hannWindow } from './core';

export interface FeatureConfig {
  /** Frecuencia de muestreo del analisis (normalmente sr del dispositivo / 2). */
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  nMels: number;
  fMin: number;
  fMax: number;
}

export const DEFAULT_FEATURE_CONFIG: Omit<FeatureConfig, 'sampleRate' | 'fMax'> = {
  fftSize: 1024,
  hopSize: 256,
  nMels: 48,
  fMin: 30
};

export interface Frame {
  index: number;
  /** Flujo espectral sobre mel blanqueado. */
  flux: number;
  /** Novedad de dominio complejo rectificada. */
  complexNovelty: number;
  /** Flujo de croma: cambio de altura sin ataque. */
  pitchNovelty: number;
  /** Combinacion normalizada y rectificada de los tres. */
  onset: number;
  lowEnergy: number;
  midEnergy: number;
  highEnergy: number;
  /**
   * Proporcion de energia en la banda aguda, 0..1. Es brillo de TIMBRE,
   * no intensidad: un crash destaca por ser brillante, no por ser fuerte.
   * Usar la energia aguda cruda como pista de downbeat cuenta el acento
   * dos veces, porque un golpe fuerte ya sube la banda grave.
   */
  brightness: number;
  rms: number;
  peak: number;
  /** Vector de croma de 12 clases, normalizado. */
  chroma: Float32Array;
}

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (Math.pow(10, mel / 2595) - 1);

interface MelFilter {
  start: number;
  weights: Float32Array;
}

function buildMelBank(
  nMels: number,
  fftSize: number,
  sampleRate: number,
  fMin: number,
  fMax: number
): MelFilter[] {
  const nBins = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(Math.min(fMax, sampleRate / 2));
  const points: number[] = [];
  for (let i = 0; i < nMels + 2; i++) {
    points.push(melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1)) / binHz);
  }

  const filters: MelFilter[] = [];
  for (let m = 0; m < nMels; m++) {
    const lo = points[m];
    const mid = points[m + 1];
    const hi = points[m + 2];
    const start = Math.max(0, Math.floor(lo));
    const end = Math.min(nBins - 1, Math.ceil(hi));
    const weights = new Float32Array(Math.max(1, end - start + 1));
    let sum = 0;
    for (let b = start; b <= end; b++) {
      let w = 0;
      if (b >= lo && b <= mid) w = mid > lo ? (b - lo) / (mid - lo) : 1;
      else if (b > mid && b <= hi) w = hi > mid ? (hi - b) / (hi - mid) : 1;
      weights[b - start] = w;
      sum += w;
    }
    if (sum > 0) for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    filters.push({ start, weights });
  }
  return filters;
}

/** Mapea cada bin util a su clase de altura (0..11), o -1 si queda fuera. */
function buildChromaMap(fftSize: number, sampleRate: number): Int8Array {
  const nBins = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const map = new Int8Array(nBins).fill(-1);
  for (let b = 1; b < nBins; b++) {
    const hz = b * binHz;
    if (hz < 55 || hz > 2200) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    map[b] = (((Math.round(midi) % 12) + 12) % 12) as number;
  }
  return map;
}

/** Normalizador adaptativo: media y desviacion por EMA. */
class RunningNorm {
  private m = 0;
  private v = 1;
  private primed = 0;

  constructor(private readonly alpha: number) {}

  push(x: number): number {
    if (this.primed < 8) {
      this.primed++;
      this.m = this.m * 0.7 + x * 0.3;
      this.v = this.v * 0.7 + x * x * 0.3;
      return 0;
    }
    const a = this.alpha;
    this.m = (1 - a) * this.m + a * x;
    this.v = (1 - a) * this.v + a * x * x;
    const sd = Math.sqrt(Math.max(1e-12, this.v - this.m * this.m));
    return (x - this.m) / (sd + 1e-9);
  }

  reset(): void {
    this.m = 0;
    this.v = 1;
    this.primed = 0;
  }
}

export class FeatureExtractor {
  readonly config: FeatureConfig;
  readonly frameRate: number;

  private readonly fft: FFT;
  private readonly window: Float32Array;
  private readonly melBank: MelFilter[];
  private readonly chromaMap: Int8Array;

  private readonly buffer: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly mag: Float32Array;
  private readonly phase: Float32Array;
  private readonly prevPhase: Float32Array;
  private readonly prevPrevPhase: Float32Array;
  private readonly prevMag: Float32Array;

  private readonly whitened: Float32Array;
  private readonly prevWhitened: Float32Array;
  private readonly peakTrack: Float32Array;
  private readonly whitenDecay: number;

  private readonly chroma: Float32Array;
  private readonly chromaHistory: Float32Array[];
  private chromaWrite = 0;

  private readonly normFlux: RunningNorm;
  private readonly normComplex: RunningNorm;
  private readonly normPitch: RunningNorm;

  private frameIndex = 0;
  private primed = false;

  constructor(sampleRate: number, overrides: Partial<FeatureConfig> = {}) {
    this.config = {
      sampleRate,
      fMax: Math.min(11000, sampleRate / 2),
      ...DEFAULT_FEATURE_CONFIG,
      ...overrides
    };
    const { fftSize, hopSize, nMels, fMin, fMax } = this.config;

    this.frameRate = sampleRate / hopSize;
    this.fft = getFFT(fftSize);
    this.window = hannWindow(fftSize);
    this.melBank = buildMelBank(nMels, fftSize, sampleRate, fMin, fMax);
    this.chromaMap = buildChromaMap(fftSize, sampleRate);

    const nBins = fftSize / 2 + 1;
    this.buffer = new Float32Array(fftSize);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.mag = new Float32Array(nBins);
    this.phase = new Float32Array(nBins);
    this.prevPhase = new Float32Array(nBins);
    this.prevPrevPhase = new Float32Array(nBins);
    this.prevMag = new Float32Array(nBins);

    this.whitened = new Float32Array(nMels);
    this.prevWhitened = new Float32Array(nMels);
    this.peakTrack = new Float32Array(nMels).fill(1e-4);
    // Constante de tiempo del blanqueo: ~1.5 s. Suficiente para seguir un
    // cambio de sala sin aplanar la dinamica dentro de un compas.
    this.whitenDecay = Math.exp(-hopSize / (sampleRate * 1.5));

    this.chroma = new Float32Array(12);
    this.chromaHistory = [
      new Float32Array(12),
      new Float32Array(12),
      new Float32Array(12),
      new Float32Array(12)
    ];

    // ~4 s de constante para la normalizacion adaptativa de cada detector.
    const alpha = 1 / (this.frameRate * 4);
    this.normFlux = new RunningNorm(alpha);
    this.normComplex = new RunningNorm(alpha);
    this.normPitch = new RunningNorm(alpha);
  }

  get hopSize(): number {
    return this.config.hopSize;
  }

  /** Consume exactamente `hopSize` muestras y devuelve la trama resultante. */
  push(hop: Float32Array): Frame {
    const { fftSize, hopSize, nMels } = this.config;
    const nBins = fftSize / 2 + 1;

    this.buffer.copyWithin(0, hopSize);
    this.buffer.set(hop.subarray(0, hopSize), fftSize - hopSize);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < hopSize; i++) {
      const s = hop[i];
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, hopSize));

    for (let i = 0; i < fftSize; i++) {
      this.re[i] = this.buffer[i] * this.window[i];
      this.im[i] = 0;
    }
    this.fft.transform(this.re, this.im);

    // --- magnitud, fase y novedad de dominio complejo (rectificada) ---
    let complexNovelty = 0;
    for (let b = 0; b < nBins; b++) {
      const r = this.re[b];
      const i = this.im[b];
      const m = Math.sqrt(r * r + i * i);
      this.mag[b] = m;
      this.phase[b] = Math.atan2(i, r);

      if (this.primed) {
        const predicted = 2 * this.prevPhase[b] - this.prevPrevPhase[b];
        const pr = this.prevMag[b] * Math.cos(predicted);
        const pi = this.prevMag[b] * Math.sin(predicted);
        const dr = r - pr;
        const di = i - pi;
        // Rectificado: solo cuenta cuando la energia crece.
        if (m > this.prevMag[b]) complexNovelty += Math.sqrt(dr * dr + di * di);
      }
    }

    // --- mel, blanqueo adaptativo y flujo espectral ---
    let flux = 0;
    let lowEnergy = 0;
    let midEnergy = 0;
    let highEnergy = 0;
    const binHz = this.config.sampleRate / fftSize;

    for (let m = 0; m < nMels; m++) {
      const f = this.melBank[m];
      let acc = 0;
      for (let k = 0; k < f.weights.length; k++) acc += this.mag[f.start + k] * f.weights[k];

      const logMel = Math.log(1 + 1000 * acc);
      const pk = Math.max(logMel, this.peakTrack[m] * this.whitenDecay);
      this.peakTrack[m] = pk;
      const w = logMel / Math.max(pk, 1e-3);

      this.whitened[m] = w;
      const d = w - this.prevWhitened[m];
      if (d > 0) flux += d;

      const centerHz = (f.start + f.weights.length / 2) * binHz;
      if (centerHz < 150) lowEnergy += acc;
      else if (centerHz < 2000) midEnergy += acc;
      else highEnergy += acc;
    }

    // --- croma y su flujo: el detector que ve el tarareo ---
    this.chroma.fill(0);
    for (let b = 1; b < nBins; b++) {
      const pc = this.chromaMap[b];
      if (pc >= 0) this.chroma[pc] += this.mag[b];
    }
    let chromaSum = 0;
    for (let c = 0; c < 12; c++) chromaSum += this.chroma[c];
    if (chromaSum > 1e-9) for (let c = 0; c < 12; c++) this.chroma[c] /= chromaSum;

    // Se compara contra el croma de 3 tramas atras (~35 ms): a esa escala
    // el vibrato no dispara pero un cambio de nota si.
    const past = this.chromaHistory[(this.chromaWrite + 1) % this.chromaHistory.length];
    let pitchNovelty = 0;
    for (let c = 0; c < 12; c++) {
      const d = this.chroma[c] - past[c];
      if (d > 0) pitchNovelty += d;
    }
    // Sin energia armonica no hay altura que seguir.
    if (chromaSum < 1e-6) pitchNovelty = 0;

    this.chromaHistory[this.chromaWrite].set(this.chroma);
    this.chromaWrite = (this.chromaWrite + 1) % this.chromaHistory.length;

    // --- combinacion normalizada ---
    const nf = this.normFlux.push(flux);
    const nc = this.normComplex.push(complexNovelty);
    const np = this.normPitch.push(pitchNovelty);
    const onset = Math.max(0, 1.0 * nf + 0.7 * nc + 0.6 * np);

    this.prevWhitened.set(this.whitened);
    this.prevPrevPhase.set(this.prevPhase);
    this.prevPhase.set(this.phase);
    this.prevMag.set(this.mag);
    this.primed = true;

    return {
      index: this.frameIndex++,
      flux,
      complexNovelty,
      pitchNovelty,
      onset,
      lowEnergy,
      midEnergy,
      highEnergy,
      brightness: (highEnergy + midEnergy * 0.25) / (lowEnergy + midEnergy + highEnergy + 1e-9),
      rms,
      peak: clamp(peak, 0, 4),
      chroma: this.chroma
    };
  }

  reset(): void {
    this.buffer.fill(0);
    this.prevPhase.fill(0);
    this.prevPrevPhase.fill(0);
    this.prevMag.fill(0);
    this.prevWhitened.fill(0);
    this.peakTrack.fill(1e-4);
    for (const c of this.chromaHistory) c.fill(0);
    this.chromaWrite = 0;
    this.normFlux.reset();
    this.normComplex.reset();
    this.normPitch.reset();
    this.frameIndex = 0;
    this.primed = false;
  }
}
