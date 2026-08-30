/**
 * Primitivas numericas del motor.
 *
 * Codigo PURO: sin DOM, sin Web Audio, sin async. Entra Float32Array,
 * sale un numero o un Float32Array. Esto es lo que hace que el motor se
 * pueda probar en Node sin navegador y sin mocks.
 */

/* ------------------------------------------------------------------ */
/* FFT                                                                 */
/* ------------------------------------------------------------------ */

function reverseBits(x: number, bits: number): number {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>>= 1;
  }
  return y >>> 0;
}

/** FFT radix-2 iterativa (Cooley-Tukey), en el sitio. */
export class FFT {
  readonly n: number;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new Error('El tamano de FFT debe ser potencia de dos: ' + n);
    }
    this.n = n;
    const levels = Math.round(Math.log2(n));
    const half = n >> 1;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / n);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.rev[i] = reverseBits(i, levels);
  }

  transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    const rev = this.rev;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    for (let size = 2; size <= n; size = size * 2) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /** Inversa, con escalado 1/n. */
  inverse(re: Float32Array, im: Float32Array): void {
    this.transform(im, re);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

const fftCache = new Map<number, FFT>();

export function getFFT(n: number): FFT {
  let f = fftCache.get(n);
  if (!f) {
    f = new FFT(n);
    fftCache.set(n, f);
  }
  return f;
}

/**
 * Autocorrelacion via Wiener-Khinchin, con normalizacion no sesgada:
 * cada lag se divide por el numero real de terminos solapados, de modo
 * que los lags largos no quedan artificialmente hundidos.
 */
export function autocorrelate(signal: Float32Array, maxLag: number): Float32Array {
  const n = signal.length;
  let size = 1;
  while (size < n * 2) size = size * 2;

  const fft = getFFT(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);

  let m = 0;
  for (let i = 0; i < n; i++) m += signal[i];
  m /= n || 1;
  for (let i = 0; i < n; i++) re[i] = signal[i] - m;

  fft.transform(re, im);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft.inverse(re, im);

  const lags = Math.min(maxLag + 1, n);
  const out = new Float32Array(lags);
  const norm = re[0] > 1e-12 ? re[0] : 1;
  for (let lag = 0; lag < lags; lag++) {
    // Compensacion PARCIAL del solape. Sin ninguna, la ACF decae sola con
    // el lag y el motor se sesga hacia tempi rapidos; con la compensacion
    // completa (n / (n - lag)) pasa lo contrario y un armonico lejano
    // termina superando al periodo real. La raiz cuadrada es el punto
    // medio: quita la pendiente sin inflar la cola.
    out[lag] = (re[lag] / norm) * Math.sqrt(n / Math.max(1, n - lag));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ventanas y remuestreo                                               */
/* ------------------------------------------------------------------ */

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function lowpassTaps(numTaps: number, cutoff: number): Float32Array {
  const taps = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < numTaps; i++) taps[i] /= sum;
  return taps;
}

/**
 * Diezmado por 2 con FIR paso bajo: 48000 -> 24000, 44100 -> 22050.
 * Evita el remuestreo fraccionario. El motor arrastra el frameRate real.
 */
export class Decimator2 {
  private readonly taps: Float32Array;
  private readonly history: Float32Array;
  private phase = 0;

  constructor(numTaps = 31) {
    this.taps = lowpassTaps(numTaps | 1, 0.23);
    this.history = new Float32Array(this.taps.length);
  }

  /** Devuelve cuantas muestras se escribieron en `out` (~input.length / 2). */
  process(input: Float32Array, out: Float32Array): number {
    const taps = this.taps;
    const hist = this.history;
    const nt = taps.length;
    let written = 0;

    for (let i = 0; i < input.length; i++) {
      hist.copyWithin(0, 1);
      hist[nt - 1] = input[i];
      this.phase ^= 1;
      if (this.phase === 0 && written < out.length) {
        let acc = 0;
        for (let k = 0; k < nt; k++) acc += hist[nt - 1 - k] * taps[k];
        out[written++] = acc;
      }
    }
    return written;
  }

  reset(): void {
    this.history.fill(0);
    this.phase = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Estadistica y picos                                                 */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function mean(a: ArrayLike<number>, from = 0, to = a.length): number {
  const n = to - from;
  if (n <= 0) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return s / n;
}

export function stdev(a: ArrayLike<number>, from = 0, to = a.length): number {
  const n = to - from;
  if (n <= 1) return 0;
  const m = mean(a, from, to);
  let s = 0;
  for (let i = from; i < to; i++) {
    const d = a[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / (n - 1));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Promedio robusto: descarta lo que se aleja mas de `k` desviaciones
 * absolutas medianas. Es lo que sostiene el tap tempo frente a un toque
 * suelto mal dado.
 */
export function robustMean(values: readonly number[], k = 2.5): number {
  if (values.length === 0) return 0;
  if (values.length < 3) return mean(values);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med))) || 1e-9;
  const kept = values.filter((v) => Math.abs(v - med) <= k * mad);
  return kept.length ? mean(kept) : med;
}

/** Interpolacion parabolica alrededor de un pico discreto. */
export function parabolicPeak(
  a: ArrayLike<number>,
  i: number
): { offset: number; value: number } {
  if (i <= 0 || i >= a.length - 1) return { offset: 0, value: a[i] ?? 0 };
  const y0 = a[i - 1];
  const y1 = a[i];
  const y2 = a[i + 1];
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-12) return { offset: 0, value: y1 };
  const offset = clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5);
  return { offset, value: y1 - 0.25 * (y0 - y2) * offset };
}

export function argMax(a: ArrayLike<number>, from = 0, to = a.length): number {
  let best = from;
  let bestV = -Infinity;
  for (let i = from; i < to; i++) {
    if (a[i] > bestV) {
      bestV = a[i];
      best = i;
    }
  }
  return best;
}

/** Lectura interpolada linealmente en un indice fraccionario. */
export function lerpAt(a: ArrayLike<number>, x: number): number {
  if (a.length === 0) return 0;
  if (x <= 0) return a[0];
  if (x >= a.length - 1) return a[a.length - 1];
  const i = Math.floor(x);
  const f = x - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

/** Media movil simetrica. */
export function smooth(a: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return a.slice();
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += a[j];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

export function zscore(a: Float32Array): Float32Array {
  const m = mean(a);
  const s = stdev(a) || 1e-9;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - m) / s;
  return out;
}

/* ------------------------------------------------------------------ */
/* Conversiones de tempo                                               */
/* ------------------------------------------------------------------ */

export const bpmToLag = (bpm: number, frameRate: number): number => (60 / bpm) * frameRate;
export const lagToBpm = (lag: number, frameRate: number): number => (60 * frameRate) / lag;

/**
 * Buffer circular de escalares. El motor mantiene aqui las curvas de
 * onset y las features por trama sin reasignar memoria nunca.
 */
export class RingBuffer {
  private readonly data: Float32Array;
  private write = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity);
  }

  push(v: number): void {
    this.data[this.write] = v;
    this.write = (this.write + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  get length(): number {
    return this.filled;
  }

  /** Copia las ultimas `n` muestras en orden cronologico. */
  tail(n: number, out?: Float32Array): Float32Array {
    const count = Math.min(n, this.filled);
    const dst = out && out.length === count ? out : new Float32Array(count);
    const start = (this.write - count + this.capacity * 2) % this.capacity;
    for (let i = 0; i < count; i++) dst[i] = this.data[(start + i) % this.capacity];
    return dst;
  }

  clear(): void {
    this.data.fill(0);
    this.write = 0;
    this.filled = 0;
  }
}
