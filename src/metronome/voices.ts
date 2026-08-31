/**
 * Banco de voces sintetizadas. Cero bytes de assets, cero riesgo de
 * licencia.
 *
 * La lista sigue de cerca la de los clicks de un DAW — Click II de Pro
 * Tools, el Klopfgeist de Logic, los click sounds de Cubase — porque es
 * el vocabulario que un musico ya conoce.
 *
 * Casi todo sale de cuatro generadores parametricos. Un woodblock, una
 * clave, un cencerro y un agogo son el MISMO grafo con otros ratios de
 * parciales: escribir treinta funciones distintas seria repetirse
 * treinta veces.
 *
 *   tone       oscilador simple            beeps, pings, blips
 *   mallet     parciales + ruido de ataque madera, metal, laminas
 *   noiseHit   ruido filtrado              shakers, aros, platillos
 *   sweep      barrido de tono descendente bombos, toms
 */

export interface VoiceParams {
  gain: number;
  accent: boolean;
  /** Transporte en semitonos. */
  tune: number;
  /** Multiplicador de decaimiento. */
  decay: number;
  /** Brillo, 0..1. */
  tone: number;
}

export const DEFAULT_PARAMS: VoiceParams = {
  gain: 0.8,
  accent: false,
  tune: 0,
  decay: 1,
  tone: 0.5
};

export type VoiceRender = (
  ctx: BaseAudioContext,
  out: AudioNode,
  time: number,
  p: VoiceParams
) => void;

export type VoiceFamily = 'click' | 'wood' | 'metal' | 'mallet' | 'hand' | 'kit' | 'mech';

export interface VoiceDef {
  id: string;
  name: string;
  family: VoiceFamily;
  render: VoiceRender;
}

/* ------------------------------------------------------------------ */
/* Primitivas                                                          */
/* ------------------------------------------------------------------ */

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const n = Math.floor(ctx.sampleRate * 1.2);
    buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

const semis = (freq: number, tune: number): number => freq * Math.pow(2, tune / 12);

/**
 * Envolvente percusiva. `exponentialRampToValueAtTime` no admite el
 * cero, de ahi el suelo: sin el, la rampa se ignora en silencio y el
 * sonido queda colgado.
 */
function percEnv(ctx: BaseAudioContext, time: number, peak: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.01, decay));
  return g;
}

function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: number,
  time: number,
  duration: number
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, time);
  o.start(time);
  o.stop(time + duration + 0.05);
  return o;
}

function noise(ctx: BaseAudioContext, time: number, duration: number): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = true;
  s.start(time, Math.random() * 0.5);
  s.stop(time + duration + 0.05);
  return s;
}

function filter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 1
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

const level = (p: VoiceParams): number => p.gain * (p.accent ? 1 : 0.62);

/* ------------------------------------------------------------------ */
/* Generadores                                                         */
/* ------------------------------------------------------------------ */

interface ToneSpec {
  freq: number;
  accentFreq?: number;
  decay: number;
  type?: OscillatorType;
  lowpass?: number;
  gain?: number;
}

function tone(spec: ToneSpec): VoiceRender {
  return (ctx, out, time, p) => {
    const base = semis(p.accent ? (spec.accentFreq ?? spec.freq * 1.5) : spec.freq, p.tune);
    const d = spec.decay * p.decay;
    const g = percEnv(ctx, time, level(p) * (spec.gain ?? 1), d);
    const source = osc(ctx, spec.type ?? 'sine', base, time, d);
    if (spec.lowpass) {
      const lp = filter(ctx, 'lowpass', spec.lowpass + p.tone * 4000);
      source.connect(lp);
      lp.connect(g);
    } else {
      source.connect(g);
    }
    g.connect(out);
  };
}

interface MalletSpec {
  freq: number;
  accentFreq?: number;
  /** Ratios de los parciales. Inarmonicos = madera o metal; casi armonicos = lamina. */
  partials: readonly (readonly [number, number])[];
  decay: number;
  type?: OscillatorType;
  /** Golpe de ruido en el ataque, 0..1. */
  attack?: number;
  attackHz?: number;
  gain?: number;
}

function mallet(spec: MalletSpec): VoiceRender {
  return (ctx, out, time, p) => {
    const base = semis(p.accent ? (spec.accentFreq ?? spec.freq * 1.26) : spec.freq, p.tune);
    const d = spec.decay * p.decay;
    const g = percEnv(ctx, time, level(p) * (spec.gain ?? 1), d);

    for (const [ratio, amp] of spec.partials) {
      const v = ctx.createGain();
      v.gain.value = amp;
      osc(ctx, spec.type ?? 'sine', base * ratio, time, d).connect(v);
      v.connect(g);
    }
    g.connect(out);

    if (spec.attack) {
      const hp = filter(ctx, 'highpass', spec.attackHz ?? 900);
      const ag = percEnv(ctx, time, level(p) * spec.attack, 0.012);
      noise(ctx, time, 0.02).connect(hp);
      hp.connect(ag);
      ag.connect(out);
    }
  };
}

interface NoiseSpec {
  type: BiquadFilterType;
  freq: number;
  q?: number;
  decay: number;
  /** Segundo filtro en serie, para estrechar mas la banda. */
  second?: { type: BiquadFilterType; freq: number; q?: number };
  /** Cuerpo tonal opcional. */
  body?: { freq: number; amp: number; decay: number };
  gain?: number;
}

function noiseHit(spec: NoiseSpec): VoiceRender {
  return (ctx, out, time, p) => {
    const d = spec.decay * p.decay;
    const g = percEnv(ctx, time, level(p) * (spec.gain ?? 1), d);
    const f = filter(ctx, spec.type, semis(spec.freq, p.tune) + p.tone * 1200, spec.q ?? 1);
    noise(ctx, time, d).connect(f);
    if (spec.second) {
      const f2 = filter(ctx, spec.second.type, spec.second.freq, spec.second.q ?? 1);
      f.connect(f2);
      f2.connect(g);
    } else {
      f.connect(g);
    }
    g.connect(out);

    if (spec.body) {
      const bg = percEnv(ctx, time, level(p) * spec.body.amp, spec.body.decay * p.decay);
      osc(ctx, 'triangle', semis(spec.body.freq, p.tune), time, spec.body.decay).connect(bg);
      bg.connect(out);
    }
  };
}

interface SweepSpec {
  from: number;
  to: number;
  sweep: number;
  decay: number;
  click?: number;
}

function sweep(spec: SweepSpec): VoiceRender {
  return (ctx, out, time, p) => {
    const d = spec.decay * p.decay;
    const g = percEnv(ctx, time, level(p), d);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(semis(spec.from, p.tune), time);
    o.frequency.exponentialRampToValueAtTime(semis(spec.to, p.tune), time + spec.sweep);
    o.start(time);
    o.stop(time + d + 0.05);
    o.connect(g);
    g.connect(out);

    if (spec.click) {
      const cg = percEnv(ctx, time, level(p) * spec.click, 0.006);
      const hp = filter(ctx, 'highpass', 1200);
      noise(ctx, time, 0.01).connect(hp);
      hp.connect(cg);
      cg.connect(out);
    }
  };
}

/** Palmada: tres reflexiones y cola. Es lo que la separa de un golpe de ruido. */
const clap: VoiceRender = (ctx, out, time, p) => {
  const bp = filter(ctx, 'bandpass', 1400 + p.tone * 900, 1.1);
  for (const [offset, amp] of [
    [0, 1],
    [0.011, 0.75],
    [0.022, 0.55]
  ] as const) {
    const g = percEnv(ctx, time + offset, level(p) * 0.5 * amp, 0.014);
    noise(ctx, time + offset, 0.02).connect(bp);
    bp.connect(g);
    g.connect(out);
  }
  const tail = percEnv(ctx, time + 0.03, level(p) * 0.22, 0.13 * p.decay);
  noise(ctx, time + 0.03, 0.16).connect(bp);
  bp.connect(tail);
  tail.connect(out);
};

/** Charles: seis cuadradas en ratios metalicos, filtradas en paso alto. */
function hat(open: boolean): VoiceRender {
  return (ctx, out, time, p) => {
    const d = (open ? 0.36 : 0.055) * p.decay;
    const g = percEnv(ctx, time, level(p) * (open ? 0.42 : 0.5), d);
    const hp = filter(ctx, 'highpass', 7000 + p.tone * 3000);
    const bp = filter(ctx, 'bandpass', 10000, 0.7);
    const base = semis(320, p.tune);
    for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) osc(ctx, 'square', base * r, time, d).connect(hp);
    hp.connect(bp);
    bp.connect(g);
    g.connect(out);
  };
}

/** Metronomo mecanico: tic y tac distintos, como una pieza de madera. */
const mechanical: VoiceRender = (ctx, out, time, p) => {
  const d = 0.045 * p.decay;
  const g = percEnv(ctx, time, level(p), d);
  const bp = filter(ctx, 'bandpass', p.accent ? 2400 : 1900, 2.4);
  noise(ctx, time, d).connect(bp);
  bp.connect(g);
  const body = percEnv(ctx, time, level(p) * 0.45, 0.02);
  osc(ctx, 'triangle', semis(p.accent ? 780 : 620, p.tune), time, 0.03).connect(body);
  body.connect(out);
  g.connect(out);
};

/* ------------------------------------------------------------------ */
/* Catalogo                                                            */
/* ------------------------------------------------------------------ */

/** Ratios de parciales por tipo de material. */
const WOOD = [
  [1, 1],
  [2.71, 0.4],
  [4.13, 0.18]
] as const;
const BELL = [
  [1, 1],
  [2.76, 0.5],
  [5.4, 0.25],
  [8.93, 0.12]
] as const;
const BAR = [
  [1, 1],
  [3.98, 0.3],
  [10.6, 0.1]
] as const;
const GLASS = [
  [1, 1],
  [2.0, 0.55],
  [3.01, 0.3],
  [4.02, 0.15]
] as const;

export const VOICES: VoiceDef[] = [
  // --- clicks digitales ---
  { id: 'click', name: 'Click', family: 'click', render: tone({ freq: 1050, accentFreq: 1600, decay: 0.035 }) },
  { id: 'beep', name: 'Beep', family: 'click', render: tone({ freq: 880, accentFreq: 1320, decay: 0.055, type: 'square', lowpass: 1200, gain: 0.55 }) },
  { id: 'blip', name: 'Blip', family: 'click', render: tone({ freq: 1400, accentFreq: 2000, decay: 0.028, type: 'triangle', gain: 0.8 }) },
  { id: 'ping', name: 'Ping', family: 'click', render: tone({ freq: 2200, accentFreq: 2960, decay: 0.16, gain: 0.55 }) },
  { id: 'pip', name: 'Pip', family: 'click', render: tone({ freq: 660, accentFreq: 990, decay: 0.02, gain: 0.9 }) },
  { id: 'noiseClick', name: 'Click de ruido', family: 'click', render: noiseHit({ type: 'highpass', freq: 3000, decay: 0.014, gain: 0.7 }) },

  // --- madera ---
  { id: 'woodblock', name: 'Woodblock', family: 'wood', render: mallet({ freq: 880, accentFreq: 1180, partials: WOOD, decay: 0.05, attack: 0.25 }) },
  { id: 'woodblockLow', name: 'Woodblock grave', family: 'wood', render: mallet({ freq: 520, accentFreq: 700, partials: WOOD, decay: 0.07, attack: 0.22 }) },
  { id: 'templeBlock', name: 'Temple block', family: 'wood', render: mallet({ freq: 400, accentFreq: 540, partials: WOOD, decay: 0.11, attack: 0.15, gain: 0.9 }) },
  { id: 'clave', name: 'Clave', family: 'wood', render: mallet({ freq: 2200, accentFreq: 2500, partials: [[1, 1], [1.47, 0.3]], decay: 0.045, gain: 0.9 }) },
  { id: 'castanet', name: 'Castañuela', family: 'wood', render: noiseHit({ type: 'bandpass', freq: 4200, q: 2.2, decay: 0.02, gain: 0.85 }) },
  { id: 'stick', name: 'Baquetas', family: 'wood', render: noiseHit({ type: 'bandpass', freq: 2400, q: 1.2, decay: 0.03 }) },
  { id: 'rim', name: 'Rim', family: 'wood', render: noiseHit({ type: 'bandpass', freq: 1700, q: 3, decay: 0.05, body: { freq: 420, amp: 0.4, decay: 0.03 }, gain: 0.85 }) },
  { id: 'sidestick', name: 'Cross-stick', family: 'wood', render: mallet({ freq: 620, accentFreq: 760, partials: [[1, 1], [3.4, 0.35], [6.1, 0.12]], decay: 0.055, attack: 0.4, attackHz: 2000, gain: 0.85 }) },

  // --- metal ---
  { id: 'bell', name: 'Campana', family: 'metal', render: mallet({ freq: 1750, accentFreq: 2100, partials: BELL, decay: 0.9, gain: 0.3 }) },
  { id: 'cowbell', name: 'Cencerro', family: 'metal', render: mallet({ freq: 587, accentFreq: 700, partials: [[1, 1], [1.44, 0.9]], decay: 0.32, type: 'square', gain: 0.35 }) },
  { id: 'agogoHigh', name: 'Agogo agudo', family: 'metal', render: mallet({ freq: 900, accentFreq: 1070, partials: [[1, 1], [1.51, 0.7], [2.6, 0.2]], decay: 0.24, type: 'square', gain: 0.32 }) },
  { id: 'agogoLow', name: 'Agogo grave', family: 'metal', render: mallet({ freq: 640, accentFreq: 760, partials: [[1, 1], [1.51, 0.7], [2.6, 0.2]], decay: 0.3, type: 'square', gain: 0.32 }) },
  { id: 'triangle', name: 'Triángulo', family: 'metal', render: mallet({ freq: 3400, accentFreq: 3900, partials: [[1, 1], [2.4, 0.6], [4.7, 0.35], [7.1, 0.2]], decay: 1.4, gain: 0.22 }) },
  { id: 'cymbal', name: 'Platillo', family: 'metal', render: noiseHit({ type: 'highpass', freq: 6000, decay: 0.7, second: { type: 'bandpass', freq: 9000, q: 0.6 }, gain: 0.3 }) },
  { id: 'hatClosed', name: 'Charles cerrado', family: 'metal', render: hat(false) },
  { id: 'hatOpen', name: 'Charles abierto', family: 'metal', render: hat(true) },

  // --- laminas ---
  { id: 'marimba', name: 'Marimba', family: 'mallet', render: mallet({ freq: 440, accentFreq: 587, partials: BAR, decay: 0.4, attack: 0.12, gain: 0.6 }) },
  { id: 'vibraphone', name: 'Vibráfono', family: 'mallet', render: mallet({ freq: 523, accentFreq: 698, partials: GLASS, decay: 1.1, gain: 0.35 }) },
  { id: 'glockenspiel', name: 'Glockenspiel', family: 'mallet', render: mallet({ freq: 1760, accentFreq: 2349, partials: BAR, decay: 0.55, gain: 0.28 }) },
  { id: 'kalimba', name: 'Kalimba', family: 'mallet', render: mallet({ freq: 660, accentFreq: 880, partials: [[1, 1], [2.02, 0.35], [3.1, 0.12]], decay: 0.5, attack: 0.1, gain: 0.5 }) },

  // --- percusion de mano ---
  { id: 'shaker', name: 'Shaker', family: 'hand', render: noiseHit({ type: 'highpass', freq: 5200, decay: 0.055, gain: 0.7 }) },
  { id: 'cabasa', name: 'Cabasa', family: 'hand', render: noiseHit({ type: 'highpass', freq: 4200, decay: 0.09, second: { type: 'bandpass', freq: 6500, q: 0.8 }, gain: 0.6 }) },
  { id: 'tambourine', name: 'Pandereta', family: 'hand', render: noiseHit({ type: 'highpass', freq: 6000, decay: 0.16, second: { type: 'bandpass', freq: 9000, q: 1.2 }, gain: 0.55 }) },
  { id: 'clap', name: 'Palmada', family: 'hand', render: clap },
  { id: 'snap', name: 'Chasquido', family: 'hand', render: noiseHit({ type: 'bandpass', freq: 2600, q: 1.6, decay: 0.035, gain: 0.8 }) },
  { id: 'conga', name: 'Conga', family: 'hand', render: mallet({ freq: 260, accentFreq: 340, partials: [[1, 1], [2.4, 0.25]], decay: 0.22, attack: 0.3, attackHz: 700, gain: 0.75 }) },
  { id: 'bongo', name: 'Bongo', family: 'hand', render: mallet({ freq: 430, accentFreq: 560, partials: [[1, 1], [2.6, 0.3]], decay: 0.13, attack: 0.35, attackHz: 1200, gain: 0.75 }) },

  // --- kit ---
  { id: 'kick808', name: 'Bombo 808', family: 'kit', render: sweep({ from: 120, to: 45, sweep: 0.09, decay: 0.34, click: 0.25 }) },
  { id: 'kick909', name: 'Bombo 909', family: 'kit', render: sweep({ from: 180, to: 52, sweep: 0.05, decay: 0.3, click: 0.55 }) },
  { id: 'kickAcoustic', name: 'Bombo acústico', family: 'kit', render: sweep({ from: 95, to: 48, sweep: 0.05, decay: 0.28, click: 0.7 }) },
  { id: 'tom', name: 'Tom', family: 'kit', render: sweep({ from: 240, to: 130, sweep: 0.12, decay: 0.3, click: 0.2 }) },
  { id: 'snare808', name: 'Caja 808', family: 'kit', render: noiseHit({ type: 'bandpass', freq: 1800, q: 0.8, decay: 0.19, body: { freq: 185, amp: 0.5, decay: 0.1 }, gain: 0.8 }) },
  { id: 'snare909', name: 'Caja 909', family: 'kit', render: noiseHit({ type: 'bandpass', freq: 3200, q: 0.8, decay: 0.19, body: { freq: 210, amp: 0.45, decay: 0.09 }, gain: 0.9 }) },
  { id: 'rimshot', name: 'Rimshot', family: 'kit', render: noiseHit({ type: 'bandpass', freq: 2600, q: 2, decay: 0.07, body: { freq: 330, amp: 0.55, decay: 0.04 }, gain: 0.9 }) },

  // --- mecanico ---
  { id: 'mechanical', name: 'Metrónomo mecánico', family: 'mech', render: mechanical }
];

export const VOICE_MAP: ReadonlyMap<string, VoiceDef> = new Map(VOICES.map((v) => [v.id, v]));

export function getVoice(id: string): VoiceDef {
  return VOICE_MAP.get(id) ?? VOICES[0];
}
