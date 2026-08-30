/**
 * Tempograma, generacion de candidatos y rastreo de beats. Codigo PURO.
 *
 * La cifra final de BPM no sale del pico del tempograma: sale de ajustar
 * una recta por minimos cuadrados a los tiempos de beat de toda la
 * ventana. El pico solo propone; la recta decide.
 */

import { argMax, autocorrelate, bpmToLag, lagToBpm, lerpAt, parabolicPeak, zscore } from './core';

export const MIN_BPM = 40;
export const MAX_BPM = 260;

/** Tempo preferido y anchura del prior perceptual, en octavas. */
export const PREFERRED_BPM = 120;
export const PRIOR_SIGMA = 0.9;

export function tempoPrior(bpm: number): number {
  const d = Math.log2(bpm / PREFERRED_BPM) / PRIOR_SIGMA;
  return Math.exp(-0.5 * d * d);
}

export interface TempoCandidate {
  /** Periodo en tramas, fraccionario. */
  lag: number;
  bpm: number;
  /** Prominencia en el tempograma, 0..1. */
  salience: number;
}

export interface Tempogram {
  salience: Float32Array;
  minLag: number;
  maxLag: number;
  candidates: TempoCandidate[];
}

/**
 * Autocorrelacion reforzada por banco de peines. Sumar la ACF en los
 * multiplos de un lag premia al nivel metrico real frente a sus
 * subdivisiones, que solo aciertan en algunos multiplos.
 */
export function computeTempogram(
  onset: Float32Array,
  frameRate: number,
  topK = 8,
  maxLagLimit?: number
): Tempogram {
  const minLag = Math.max(2, Math.floor(bpmToLag(MAX_BPM, frameRate)));
  // Con poca ventana no se puede afirmar nada sobre los lags largos: la
  // ACF ahi se sostiene sobre un punado de solapes.
  const maxLag = Math.min(
    onset.length - 2,
    Math.ceil(bpmToLag(MIN_BPM, frameRate)),
    maxLagLimit ?? Infinity
  );
  if (maxLag <= minLag + 2) {
    return { salience: new Float32Array(Math.max(2, maxLag + 1)), minLag, maxLag, candidates: [] };
  }

  const acf = autocorrelate(onset, Math.min(onset.length - 1, maxLag * 4));
  const salience = new Float32Array(maxLag + 1);

  const combWeights = [1, 0.55, 0.38, 0.28];
  let maxSal = 1e-9;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const base = Math.max(0, acf[lag]);
    let comb = 0;
    let wsum = 0;
    for (let k = 0; k < combWeights.length; k++) {
      const idx = lag * (k + 1);
      if (idx >= acf.length - 1) break;
      comb += combWeights[k] * Math.max(0, lerpAt(acf, idx));
      wsum += combWeights[k];
    }
    comb = wsum > 0 ? comb / wsum : 0;

    const s = 0.45 * base + 0.55 * comb;
    salience[lag] = s;
    if (s > maxSal) maxSal = s;
  }

  for (let lag = minLag; lag <= maxLag; lag++) salience[lag] /= maxSal;

  // Picos locales, ordenados por prominencia.
  const peaks: TempoCandidate[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (salience[lag] > salience[lag - 1] && salience[lag] >= salience[lag + 1]) {
      const { offset, value } = parabolicPeak(salience, lag);
      const refined = lag + offset;
      peaks.push({ lag: refined, bpm: lagToBpm(refined, frameRate), salience: value });
    }
  }
  peaks.sort((a, b) => b.salience - a.salience);

  return { salience, minLag, maxLag, candidates: peaks.slice(0, topK) };
}

/**
 * Anade los parientes metricos de cada candidato (mitad, doble, tercio,
 * triple). El pico del tempograma casi nunca esta en el nivel equivocado
 * por casualidad: esta en un nivel *vecino*, y hay que poder llegar a el.
 */
export function expandCandidates(
  candidates: readonly TempoCandidate[],
  frameRate: number,
  salience: Float32Array
): TempoCandidate[] {
  const out: TempoCandidate[] = [];
  const seen: number[] = [];
  const ratios = [1, 0.5, 2, 1 / 3, 3, 2 / 3, 1.5];

  const push = (lag: number, baseSalience: number, ratio: number) => {
    const bpm = lagToBpm(lag, frameRate);
    if (bpm < MIN_BPM || bpm > MAX_BPM) return;
    // Duplicados: dos candidatos a menos de 1.5 % son el mismo tempo.
    for (const s of seen) if (Math.abs(Math.log2(s / lag)) < 0.021) return;
    seen.push(lag);
    const measured = lag < salience.length ? lerpAt(salience, lag) : 0;
    // Un pariente hereda parte de la prominencia del padre pero pesa
    // sobre todo por su propia evidencia en el tempograma.
    const inherited = ratio === 1 ? baseSalience : 0.35 * baseSalience;
    out.push({ lag, bpm, salience: Math.max(measured, inherited) });
  };

  for (const c of candidates) {
    for (const r of ratios) push(c.lag * r, c.salience, r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rastreo de beats por programacion dinamica (Ellis 2007)             */
/* ------------------------------------------------------------------ */

export interface BeatTrack {
  /** Indices de trama de cada beat. */
  beats: Int32Array;
  /** Fuerza media de onset en los beats, en unidades z. */
  salience: number;
}

/**
 * Encuentra la secuencia de beats que maximiza energia de onset menos
 * penalizacion por desviarse del periodo. La penalizacion es cuadratica
 * en el logaritmo del ratio, asi que un 10 % de error cuesta lo mismo
 * adelantando que atrasando.
 */
export function trackBeats(
  onsetZ: Float32Array,
  period: number,
  tightness = 300
): BeatTrack {
  const n = onsetZ.length;
  const minLag = Math.max(1, Math.round(period * 0.5));
  const maxLag = Math.max(minLag + 1, Math.round(period * 2));

  if (n < maxLag + 2) return { beats: new Int32Array(0), salience: 0 };

  const penalty = new Float32Array(maxLag + 1);
  for (let l = minLag; l <= maxLag; l++) {
    const r = Math.log(l / period);
    penalty[l] = -tightness * r * r;
  }

  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);

  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestV = -1;
    const lo = Math.max(0, t - maxLag);
    const hi = t - minLag;
    for (let v = lo; v <= hi; v++) {
      const s = cum[v] + penalty[t - v];
      if (s > best) {
        best = s;
        bestV = v;
      }
    }
    if (bestV < 0) {
      cum[t] = onsetZ[t];
    } else {
      cum[t] = onsetZ[t] + best;
      back[t] = bestV;
    }
  }

  // El ultimo beat se busca en la cola, no en el maximo global: interesa
  // terminar cerca del final de la ventana para que la fase sirva ahora.
  const tailFrom = Math.max(0, n - Math.round(period) - 1);
  let end = argMax(cum, tailFrom, n);

  const rev: number[] = [];
  while (end >= 0) {
    rev.push(end);
    end = back[end];
  }
  rev.reverse();

  const beats = Int32Array.from(rev);
  let sal = 0;
  for (const b of beats) sal += onsetZ[b];
  return { beats, salience: beats.length ? sal / beats.length : 0 };
}

/* ------------------------------------------------------------------ */
/* Ajuste por minimos cuadrados                                        */
/* ------------------------------------------------------------------ */

export interface TempoFit {
  /** Periodo en tramas, con precision muy por debajo de la trama. */
  period: number;
  /** Trama del beat de indice 0 del ajuste. */
  phase: number;
  /** Error tipico del ajuste, en tramas. */
  residual: number;
  /** Beats efectivamente usados tras descartar atipicos. */
  used: number;
}

/**
 * Ajusta beat_i = phase + period * k_i. Los indices k_i se derivan del
 * intervalo mediano, de modo que un beat perdido o uno de mas no arrastra
 * todo el ajuste. Se hace una segunda pasada descartando residuos grandes.
 */
export function fitTempo(beats: ArrayLike<number>, approxPeriod: number): TempoFit | null {
  const m = beats.length;
  if (m < 3) return null;

  const intervals: number[] = [];
  for (let i = 1; i < m; i++) intervals.push(beats[i] - beats[i - 1]);
  intervals.sort((a, b) => a - b);
  const medianIbi = intervals[intervals.length >> 1] || approxPeriod;
  if (!Number.isFinite(medianIbi) || medianIbi <= 0) return null;

  const idx: number[] = [];
  for (let i = 0; i < m; i++) idx.push(Math.round((beats[i] - beats[0]) / medianIbi));

  const solve = (keep: boolean[]): TempoFit | null => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < m; i++) {
      if (!keep[i]) continue;
      const x = idx[i];
      const y = beats[i];
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    if (n < 3) return null;
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;
    const period = (n * sxy - sx * sy) / denom;
    const phase = (sy - period * sx) / n;
    if (!Number.isFinite(period) || period <= 0) return null;

    let sse = 0;
    for (let i = 0; i < m; i++) {
      if (!keep[i]) continue;
      const r = beats[i] - (phase + period * idx[i]);
      sse += r * r;
    }
    return { period, phase, residual: Math.sqrt(sse / n), used: n };
  };

  const keep = new Array<boolean>(m).fill(true);
  const first = solve(keep);
  if (!first) return null;

  // Segunda pasada: fuera lo que se desvie mas de un cuarto de periodo.
  const tol = Math.max(1, first.period * 0.25);
  let dropped = 0;
  for (let i = 0; i < m; i++) {
    const r = Math.abs(beats[i] - (first.phase + first.period * idx[i]));
    if (r > tol) {
      keep[i] = false;
      dropped++;
    }
  }
  if (dropped === 0 || m - dropped < 3) return first;
  return solve(keep) ?? first;
}

/** Prepara la curva de onset para el rastreo: suavizado leve y z-score. */
export function prepareOnset(onset: Float32Array): Float32Array {
  return zscore(onset);
}
