/**
 * Orquestador del motor de deteccion.
 *
 * Recibe muestras a la frecuencia del dispositivo, las diezma a la mitad,
 * extrae caracteristicas y, cada pocos cientos de milisegundos, resuelve
 * conjuntamente tempo, subdivision y agrupacion.
 *
 * La clave del diseno esta en que tempo y metrica NO se deciden en
 * cascada. Se puntuan juntos: un candidato de tempo que resulta ser en
 * realidad la subdivision de otro se delata porque sus propias
 * subdivisiones son borrosas y su agrupacion, difusa. Sin esa evaluacion
 * conjunta, una balada en 6/8 se detecta como 180 BPM en vez de 60.
 */

import { Decimator2, RingBuffer, clamp, lagToBpm, zscore } from './core';
import { FeatureExtractor } from './features';
import {
  MAX_BPM,
  MIN_BPM,
  computeTempogram,
  expandCandidates,
  fitTempo,
  tempoPrior,
  trackBeats
} from './tempo';
import {
  type Subdivision,
  type TimeSignature,
  analyzeMeter,
  meterLabel,
  quartersPerPulse,
  subdivisionsPerPulse,
  toTimeSignature
} from './meter';
import type { ArbiterCandidate, TempoArbiter } from '../arbiter/types';

export type DetectionStage = 'provisional' | 'stable' | 'refined';

export interface DetectionResult {
  /**
   * NEGRAS por minuto: la convencion de los DAW y lo que un baterista
   * teclea en su click, sea cual sea el compas. En 4/4 coincide con el
   * pulso; en 6/8 es una vez y media el pulso sentido.
   */
  bpm: number;
  /** Pulso sentido: la negra con puntillo en compas compuesto. */
  bpmPulse: number;
  /** La subdivision: corcheas en simple, corcheas de tresillo en compuesto. */
  bpmAlt: number;
  meter: TimeSignature;
  /** Etiqueta lista para pantalla, p. ej. "12/8 · shuffle en 4". */
  meterLabel: string;
  subdivision: Subdivision;
  confidence: number;
  /** Instante del proximo beat, en el reloj del AudioContext. */
  nextBeatAt: number;
  nextDownbeatAt: number;
  stage: DetectionStage;
  elapsedMs: number;
  /**
   * Pulsos que sostienen la media. Es la evidencia acumulada, y crece
   * mientras escuchas: por eso la cifra deja de bailar.
   */
  beatsCounted: number;
  clipping: boolean;
  /** Nivel de senal 0..1, para el medidor de entrada. */
  level: number;
  arbiterId: string | null;
  /** Acuerdo entre clasico y arbitro, 0..1. */
  agreement: number;
}

export interface EngineOptions {
  arbiter?: TempoArbiter | null;
  /** Cada cuanto se resuelve el analisis completo. */
  updateIntervalMs?: number;
  /** Ventana del motor clasico. */
  windowSeconds?: number;
  /** Ventana del arbitro, siempre mayor. */
  longWindowSeconds?: number;
  /** Cada cuanto se lanza el arbitro, en ms. */
  arbiterIntervalMs?: number;
}

interface ScoredCandidate {
  lag: number;
  period: number;
  bpm: number;
  salience: number;
  beatSalience: number;
  subdivision: Subdivision;
  subdivisionScore: number;
  pulsesPerBar: number;
  downbeatIndex: number;
  groupingScore: number;
  score: number;
  phase: number;
  windowStartFrame: number;
  beats: Int32Array;
}

const CLIP_THRESHOLD = 0.985;

/**
 * A partir de aqui la ventana ya cubre varios periodos incluso en los
 * tempos lentos, y la hipotesis se puede tomar en serio: antes se
 * muestra, pero no se fija ni se promedia.
 */
const COMMIT_SECONDS = 3.5;

/**
 * Ajuste global de los beats de TODA la escucha.
 *
 * En vez de quedarse con la lectura de la ultima ventana, acumula cada
 * beat detectado como un par (indice, instante) y ajusta una sola recta
 * por minimos cuadrados sobre todos ellos — que es, literalmente, lo que
 * hace alguien que va marcando el pulso sobre la cancion y promedia.
 *
 * Se lleva con sumas incrementales, asi que no crece en memoria y la
 * precision solo mejora cuanto mas tiempo escuchas.
 */
class BeatAccumulator {
  private anchor = 0;
  private period = 0;
  private last = -Infinity;
  private n = 0;
  private sk = 0;
  private st = 0;
  private skk = 0;
  private skt = 0;

  get count(): number {
    return this.n;
  }

  restart(periodSeconds: number, firstBeatTime: number): void {
    this.anchor = firstBeatTime;
    this.period = periodSeconds;
    this.last = -Infinity;
    this.n = 0;
    this.sk = 0;
    this.st = 0;
    this.skk = 0;
    this.skt = 0;
  }

  /**
   * Incorpora los beats nuevos. Devuelve false cuando el modelo deja de
   * describir lo que suena — un cambio real de tempo o de cancion — para
   * que el motor reinicie en vez de promediar dos cosas distintas.
   */
  add(times: readonly number[]): boolean {
    if (this.period <= 0) return true;
    let added = 0;
    let rejected = 0;

    for (const t of times) {
      // Las ventanas se solapan: un beat ya contado no vuelve a contar.
      if (t <= this.last + this.period * 0.5) continue;
      const k = Math.round((t - this.anchor) / this.period);
      if (this.n >= 6) {
        const predicted = this.predict(k);
        if (predicted !== null && Math.abs(t - predicted) > this.period * 0.35) {
          rejected++;
          continue;
        }
      }
      this.n++;
      this.sk += k;
      this.st += t;
      this.skk += k * k;
      this.skt += k * t;
      this.last = t;
      added++;
    }

    // El periodo de referencia se refina con el propio ajuste, para que
    // asignar indices no derive en escuchas largas.
    const slope = this.slope();
    if (slope !== null && slope > 0) this.period = slope;

    return !(added === 0 && rejected >= 3);
  }

  private slope(): number | null {
    if (this.n < 6) return null;
    const denom = this.n * this.skk - this.sk * this.sk;
    if (Math.abs(denom) < 1e-9) return null;
    return (this.n * this.skt - this.sk * this.st) / denom;
  }

  private intercept(slope: number): number {
    return (this.st - slope * this.sk) / this.n;
  }

  private predict(k: number): number | null {
    const slope = this.slope();
    if (slope === null) return null;
    return this.intercept(slope) + slope * k;
  }

  /** BPM promediado sobre toda la escucha, o null si aun no hay bastante. */
  bpm(): number | null {
    const slope = this.slope();
    if (slope === null || slope <= 0) return null;
    const bpm = 60 / slope;
    return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null;
  }
}

export class TempoEngine {
  readonly analysisSampleRate: number;
  readonly frameRate: number;

  private readonly decimator = new Decimator2();
  private readonly features: FeatureExtractor;
  private readonly hop: number;
  private readonly arbiter: TempoArbiter | null;
  private readonly opts: Required<Omit<EngineOptions, 'arbiter'>>;

  private readonly onsetRing: RingBuffer;
  private readonly lowRing: RingBuffer;
  private readonly brightRing: RingBuffer;
  private readonly chromaBuf: Float32Array;
  private readonly chromaCapacity: number;
  private chromaWrite = 0;

  private readonly decimated: Float32Array;
  private readonly pending: Float32Array;
  private pendingLength = 0;

  private frameCount = 0;
  private analysisSamples = 0;
  private clockOffset = 0;
  private clockAnchored = false;

  private lastAnalysisFrame = -1e9;
  private lastArbiterMs = -1e9;
  private verdict: { lags: number[]; adjust: number[]; agreement: number; id: string; atMs: number } | null =
    null;
  private arbiterBusy = false;

  private lockedPeriod: number | null = null;
  private smoothedBpm = 0;
  private readonly beatFit = new BeatAccumulator();
  private meterVotes: string[] = [];
  private bpmHistory: number[] = [];

  private clipFrames = 0;
  private lastLevel = 0;
  private last: DetectionResult | null = null;

  constructor(deviceSampleRate: number, options: EngineOptions = {}) {
    this.opts = {
      updateIntervalMs: options.updateIntervalMs ?? 250,
      windowSeconds: options.windowSeconds ?? 8,
      longWindowSeconds: options.longWindowSeconds ?? 12,
      arbiterIntervalMs: options.arbiterIntervalMs ?? 4000
    };
    this.arbiter = options.arbiter ?? null;

    this.analysisSampleRate = deviceSampleRate / 2;
    this.features = new FeatureExtractor(this.analysisSampleRate);
    this.hop = this.features.hopSize;
    this.frameRate = this.features.frameRate;

    const cap = Math.ceil(this.opts.longWindowSeconds * this.frameRate) + 8;
    this.onsetRing = new RingBuffer(cap);
    this.lowRing = new RingBuffer(cap);
    this.brightRing = new RingBuffer(cap);
    this.chromaCapacity = cap;
    this.chromaBuf = new Float32Array(cap * 12);

    this.decimated = new Float32Array(8192);
    this.pending = new Float32Array(this.hop * 4);
  }

  /**
   * @param samples muestras mono a la frecuencia del dispositivo
   * @param audioTimeOfFirstSample instante de la primera muestra en el reloj de audio
   */
  push(samples: Float32Array, audioTimeOfFirstSample: number): DetectionResult | null {
    if (!this.clockAnchored) {
      this.clockOffset = audioTimeOfFirstSample;
      this.clockAnchored = true;
    } else {
      // Re-anclaje continuo: absorbe cualquier bloque perdido sin que la
      // fase acumule deriva.
      this.clockOffset = audioTimeOfFirstSample - this.analysisSamples / this.analysisSampleRate;
    }

    let offset = 0;
    while (offset < samples.length) {
      const chunk = samples.subarray(offset, Math.min(samples.length, offset + this.decimated.length * 2));
      offset += chunk.length;
      const n = this.decimator.process(chunk, this.decimated);
      this.consumeDecimated(this.decimated.subarray(0, n));
    }

    return this.maybeAnalyze();
  }

  private consumeDecimated(samples: Float32Array): void {
    let i = 0;
    while (i < samples.length) {
      const need = this.hop - this.pendingLength;
      const take = Math.min(need, samples.length - i);
      this.pending.set(samples.subarray(i, i + take), this.pendingLength);
      this.pendingLength += take;
      i += take;

      if (this.pendingLength === this.hop) {
        const frame = this.features.push(this.pending.subarray(0, this.hop));
        this.pendingLength = 0;
        this.analysisSamples += this.hop;

        this.onsetRing.push(frame.onset);
        this.lowRing.push(frame.lowEnergy);
        this.brightRing.push(frame.brightness);
        this.chromaBuf.set(frame.chroma, this.chromaWrite * 12);
        this.chromaWrite = (this.chromaWrite + 1) % this.chromaCapacity;

        if (frame.peak >= CLIP_THRESHOLD) this.clipFrames = Math.min(200, this.clipFrames + 6);
        else if (this.clipFrames > 0) this.clipFrames--;

        this.lastLevel = this.lastLevel * 0.85 + Math.min(1, frame.rms * 6) * 0.15;
        this.frameCount++;
      }
    }
  }

  /** Copia las ultimas `n` tramas de croma en orden cronologico. */
  private tailChroma(n: number): Float32Array {
    const count = Math.min(n, this.frameCount, this.chromaCapacity);
    const out = new Float32Array(count * 12);
    const start = (this.chromaWrite - count + this.chromaCapacity * 2) % this.chromaCapacity;
    for (let i = 0; i < count; i++) {
      const src = ((start + i) % this.chromaCapacity) * 12;
      out.set(this.chromaBuf.subarray(src, src + 12), i * 12);
    }
    return out;
  }

  private frameToAudioTime(globalFrame: number): number {
    const centerSample = globalFrame * this.hop + this.features.config.fftSize / 2;
    return this.clockOffset + centerSample / this.analysisSampleRate;
  }

  private get elapsedSeconds(): number {
    return this.frameCount / this.frameRate;
  }

  private maybeAnalyze(): DetectionResult | null {
    const framesPerUpdate = Math.max(1, Math.round((this.opts.updateIntervalMs / 1000) * this.frameRate));
    if (this.frameCount - this.lastAnalysisFrame < framesPerUpdate) return null;
    // Por debajo de 1.6 s no hay ventana suficiente ni para lo provisional.
    if (this.elapsedSeconds < 1.5) return null;
    this.lastAnalysisFrame = this.frameCount;
    return this.analyze();
  }

  private analyze(): DetectionResult | null {
    const winFrames = Math.min(
      this.onsetRing.length,
      Math.round(this.opts.windowSeconds * this.frameRate)
    );
    if (winFrames < this.frameRate * 1.5) return null;

    const onset = this.onsetRing.tail(winFrames);
    const onsetZ = zscore(onset);
    const lowEnergy = this.lowRing.tail(winFrames);
    const brightness = this.brightRing.tail(winFrames);
    const chroma = this.tailChroma(winFrames);
    const windowStartFrame = this.frameCount - winFrames;

    // La ventana limita el lag fiable: con 2 s de audio no se puede
    // afirmar nada sobre 40 BPM.
    const maxLagLimit = Math.floor(winFrames / 2.5);
    const tg = computeTempogram(onset, this.frameRate, 8, maxLagLimit);
    if (tg.maxLag <= tg.minLag + 2) return null;

    // La HIPOTESIS se elige siempre sobre la ventana actual. Promediar
    // el tempograma de toda la escucha refuerza por igual el periodo
    // real y su armonico al doble, y ahi se pierde el desempate de
    // octava. Lo que se promedia es la CIFRA, mas abajo, sobre los
    // beats — donde promediar anade precision en vez de borrarla.
    const pool = expandCandidates(tg.candidates, this.frameRate, tg.salience)
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 7);

    const scored: ScoredCandidate[] = [];
    for (const cand of pool) {
      const track = trackBeats(onsetZ, cand.lag);
      if (track.beats.length < 4) continue;

      const fit = fitTempo(track.beats, cand.lag);
      const period = fit && Number.isFinite(fit.period) ? fit.period : cand.lag;
      const bpm = lagToBpm(period, this.frameRate);
      if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) continue;

      const meter = analyzeMeter({
        onsetZ,
        lowEnergy,
        brightness,
        chroma,
        beats: track.beats,
        period
      });
      const residualPenalty = fit ? clamp(fit.residual / (0.18 * period), 0, 1) : 1;

      // Discriminante de octava. Una subdivision legitima pesa bastante
      // menos que su pulso; cuando pesa lo mismo es que el candidato va
      // un nivel por debajo del beat real. Sin este termino el motor se
      // va sistematicamente a la mitad de velocidad, porque a medio
      // tempo el beat verdadero cae justo en la mitad y la evidencia de
      // subdivision sale, engañosamente, perfecta.
      const strongestSub = Math.max(meter.halfRatio, meter.thirdRatio);
      const tooSlow = clamp((strongestSub - 0.58) / 0.42, 0, 1);

      const score =
        0.28 * cand.salience +
        0.2 * clamp(track.salience / 1.5, 0, 1) +
        0.12 * meter.subdivisionScore +
        0.18 * meter.groupingScore +
        0.16 * tempoPrior(bpm) -
        0.08 * residualPenalty -
        0.22 * tooSlow;

      scored.push({
        lag: cand.lag,
        period,
        bpm,
        salience: cand.salience,
        beatSalience: track.salience,
        subdivision: meter.subdivision,
        subdivisionScore: meter.subdivisionScore,
        pulsesPerBar: meter.pulsesPerBar,
        downbeatIndex: meter.downbeatIndex,
        groupingScore: meter.groupingScore,
        score,
        phase: fit ? fit.phase : track.beats[0],
        windowStartFrame,
        beats: track.beats
      });
    }

    if (scored.length === 0) return null;

    this.applyVerdict(scored);

    // Adherencia a la hipotesis vigente: evita saltar de nivel metrico
    // por una sola ventana mala.
    //
    // Solo desde que hay ventana suficiente. Antes de eso la hipotesis
    // se apoya en poco mas de un periodo, y premiarla congelaria una
    // suposicion mal informada — que es justo como un tarareo lento
    // acaba leido al doble de velocidad. La adherencia esta para
    // resistir ruido, no para petrificar la primera corazonada.
    if (this.lockedPeriod !== null && this.elapsedSeconds >= COMMIT_SECONDS) {
      for (const c of scored) {
        if (Math.abs(Math.log2(c.period / this.lockedPeriod)) < 0.03) c.score += 0.08;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    this.maybeRunArbiter(scored);

    const sameHypothesis =
      this.lockedPeriod !== null && Math.abs(Math.log2(best.period / this.lockedPeriod)) < 0.03;

    this.lockedPeriod = sameHypothesis ? this.lockedPeriod! * 0.7 + best.period * 0.3 : best.period;
    this.smoothedBpm = sameHypothesis && this.smoothedBpm > 0
      ? this.smoothedBpm * 0.72 + best.bpm * 0.28
      : best.bpm;

    // Ajuste global: si cambiamos de nivel metrico, los indices de beat
    // anteriores dejan de significar lo mismo y hay que empezar de cero.
    const periodSeconds = best.period / this.frameRate;
    const beatTimes: number[] = [];
    for (const frame of best.beats) {
      beatTimes.push(this.frameToAudioTime(best.windowStartFrame + frame));
    }
    // La media tampoco empieza antes de tiempo: acumular los primeros
    // segundos solo mete en el promedio la parte menos fiable.
    if (this.elapsedSeconds < COMMIT_SECONDS) {
      this.beatFit.restart(periodSeconds, beatTimes[0] ?? 0);
    } else {
      if (!sameHypothesis || this.beatFit.count === 0) {
        this.beatFit.restart(periodSeconds, beatTimes[0] ?? 0);
      }
      if (beatTimes.length > 0 && !this.beatFit.add(beatTimes)) {
        this.beatFit.restart(periodSeconds, beatTimes[beatTimes.length - 1]);
      }
    }

    this.bpmHistory.push(this.smoothedBpm);
    if (this.bpmHistory.length > 6) this.bpmHistory.shift();

    return this.buildResult(best);
  }

  private buildResult(best: ScoredCandidate): DetectionResult {
    const stage = this.stageFor();

    // Voto de metrica: la moda de las ultimas lecturas, no la ultima.
    const key = best.pulsesPerBar + ':' + best.subdivision;
    this.meterVotes.push(key);
    if (this.meterVotes.length > 5) this.meterVotes.shift();
    const winner = modeOf(this.meterVotes);
    const [votedPulses, votedSub] = winner.split(':');
    const pulses = Number(votedPulses);
    const subdivision = votedSub as Subdivision;

    const meter = toTimeSignature(pulses, subdivision);
    // La cifra sale del ajuste sobre TODOS los beats de la escucha, no
    // de la ultima ventana: es lo que hace alguien que va marcando el
    // pulso sobre la cancion y promedia, y por eso la precision mejora
    // cuanto mas escuchas.
    //
    // Pero el promedio solo REFINA; nunca contradice. Si se aleja mas de
    // un 6 % de la hipotesis viva, es que el motor cambio de nivel
    // metrico o cambio la musica, y perpetuar la media seria arrastrar
    // un error antiguo en vez de corregirlo.
    const fitted = this.beatFit.bpm();
    const bpmPulse =
      fitted !== null && this.smoothedBpm > 0 && Math.abs(Math.log2(fitted / this.smoothedBpm)) < 0.09
        ? fitted
        : this.smoothedBpm;
    const bpm = bpmPulse * quartersPerPulse(meter);
    const bpmAlt = bpmPulse * subdivisionsPerPulse(meter);

    const period = this.lockedPeriod ?? best.period;
    const now = this.frameToAudioTime(this.frameCount);
    const beat0Frame = best.windowStartFrame + best.phase;

    let k = Math.ceil((this.frameCount - beat0Frame) / period);
    const nextBeatFrame = beat0Frame + k * period;
    const nextBeatAt = this.frameToAudioTime(nextBeatFrame);

    let dk = k;
    const guard = dk + pulses * 2 + 2;
    while (((dk % pulses) + pulses) % pulses !== best.downbeatIndex % pulses && dk < guard) dk++;
    const nextDownbeatAt = this.frameToAudioTime(beat0Frame + dk * period);

    const spread = bpmSpread(this.bpmHistory);
    const stability = 1 - clamp(spread / (0.05 * Math.max(1, bpmPulse)), 0, 1);
    const agreement = this.verdict ? this.verdict.agreement : 1;
    // Cuantos mas beats sostienen el ajuste, mas fiable es la cifra.
    // Es la parte de la confianza que solo crece escuchando.
    const evidence = clamp(this.beatFit.count / 48, 0, 1);

    let confidence =
      clamp(best.score, 0, 1) *
      (0.6 + 0.4 * stability) *
      (0.72 + 0.28 * agreement) *
      (0.62 + 0.38 * evidence);
    if (stage === 'provisional') confidence = Math.min(confidence, 0.55);
    else if (stage === 'stable') confidence = Math.min(confidence, 0.85);

    const result: DetectionResult = {
      bpm: Math.round(bpm * 10) / 10,
      bpmPulse: Math.round(bpmPulse * 10) / 10,
      bpmAlt: Math.round(bpmAlt * 10) / 10,
      meter,
      meterLabel: meterLabel(meter),
      subdivision,
      confidence: clamp(confidence, 0, 1),
      nextBeatAt: Math.max(now, nextBeatAt),
      nextDownbeatAt: Math.max(now, nextDownbeatAt),
      stage,
      elapsedMs: Math.round(this.elapsedSeconds * 1000),
      beatsCounted: this.beatFit.count,
      clipping: this.clipFrames > 24,
      level: clamp(this.lastLevel, 0, 1),
      arbiterId: this.verdict?.id ?? this.arbiter?.id ?? null,
      agreement
    };

    this.last = result;
    return result;
  }

  private stageFor(): DetectionStage {
    const t = this.elapsedSeconds;
    if (t < 5) return 'provisional';
    if (t < 8) return 'stable';
    return 'refined';
  }

  private applyVerdict(scored: ScoredCandidate[]): void {
    const v = this.verdict;
    if (!v) return;
    // Un veredicto viejo ya no describe lo que suena ahora.
    if (Date.now() - v.atMs > 8000) {
      this.verdict = null;
      return;
    }
    for (const c of scored) {
      for (let i = 0; i < v.lags.length; i++) {
        if (Math.abs(Math.log2(c.period / v.lags[i])) < 0.03) {
          c.score += v.adjust[i];
          break;
        }
      }
    }
  }

  private maybeRunArbiter(scored: ScoredCandidate[]): void {
    if (!this.arbiter || this.arbiterBusy) return;
    const nowMs = Date.now();
    if (nowMs - this.lastArbiterMs < this.opts.arbiterIntervalMs) return;

    const longFrames = Math.min(
      this.onsetRing.length,
      Math.round(this.opts.longWindowSeconds * this.frameRate)
    );
    if (longFrames < this.frameRate * 6) return;

    this.lastArbiterMs = nowMs;
    this.arbiterBusy = true;

    const candidates: ArbiterCandidate[] = scored.map((c) => ({
      bpm: c.bpm,
      lag: c.period,
      salience: c.salience,
      subdivision: c.subdivision,
      pulsesPerBar: c.pulsesPerBar,
      subdivisionScore: c.subdivisionScore,
      groupingScore: c.groupingScore,
      beatSalience: c.beatSalience,
      score: c.score
    }));
    const lags = scored.map((c) => c.period);
    const longOnset = this.onsetRing.tail(longFrames);

    // Deliberadamente sin await: el arbitro no bloquea la deteccion.
    // Su veredicto se aplica en el siguiente analisis.
    this.arbiter
      .arbitrate({ frameRate: this.frameRate, candidates, chosenIndex: 0, longOnset })
      .then((verdict) => {
        if (verdict) {
          this.verdict = {
            lags,
            adjust: verdict.adjust,
            agreement: verdict.agreement,
            id: verdict.arbiterId,
            atMs: Date.now()
          };
        }
      })
      .catch(() => {
        /* Un arbitro que falla no puede tumbar la deteccion. */
      })
      .finally(() => {
        this.arbiterBusy = false;
      });
  }

  get latest(): DetectionResult | null {
    return this.last;
  }

  reset(): void {
    this.decimator.reset();
    this.features.reset();
    this.onsetRing.clear();
    this.lowRing.clear();
    this.brightRing.clear();
    this.chromaBuf.fill(0);
    this.chromaWrite = 0;
    this.pendingLength = 0;
    this.frameCount = 0;
    this.analysisSamples = 0;
    this.clockAnchored = false;
    this.lastAnalysisFrame = -1e9;
    this.lastArbiterMs = -1e9;
    this.verdict = null;
    this.lockedPeriod = null;
    this.smoothedBpm = 0;
    this.beatFit.restart(0, 0);
    this.meterVotes = [];
    this.bpmHistory = [];
    this.clipFrames = 0;
    this.lastLevel = 0;
    this.last = null;
  }
}

function modeOf(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[values.length - 1];
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

function bpmSpread(history: number[]): number {
  if (history.length < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of history) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/**
 * Analisis offline de un buffer completo. Es la puerta de entrada del
 * corpus de pruebas: mismo motor, sin navegador y sin mocks.
 */
export function analyzeBuffer(
  samples: Float32Array,
  sampleRate: number,
  options: EngineOptions = {}
): DetectionResult | null {
  const engine = new TempoEngine(sampleRate, options);
  const block = 4096;
  for (let i = 0; i < samples.length; i += block) {
    const chunk = samples.subarray(i, Math.min(samples.length, i + block));
    engine.push(chunk, i / sampleRate);
  }
  return engine.latest;
}
