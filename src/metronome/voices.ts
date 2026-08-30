/**
 * Voces sintetizadas. Cero bytes de assets, cero riesgo de licencia.
 *
 * Cada voz es una funcion pura que arma su grafo de audio, lo programa
 * en un instante exacto y se autodestruye. Todas tienen tono, decaimiento
 * y brillo parametricos: no son 18 sonidos, son 18 familias.
 */

export interface VoiceParams {
  /** Ganancia base, 0..1. */
  gain: number;
  /** Acento: normalmente el primer tiempo del compas. */
  accent: boolean;
  /** Transporte en semitonos, -12..12. */
  tune: number;
  /** Multiplicador de decaimiento, 0.4..2.5. */
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

export interface VoiceDef {
  id: string;
  name: string;
  family: 'click' | 'perc' | 'kit';
  render: VoiceRender;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
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
 * Envolvente percusiva: ataque casi instantaneo y caida exponencial.
 * `exponentialRampToValueAtTime` no admite el cero, de ahi el suelo.
 */
function percEnv(
  ctx: BaseAudioContext,
  time: number,
  peak: number,
  decay: number
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.01, decay));
  return g;
}

function tone(
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

const accentGain = (p: VoiceParams): number => p.gain * (p.accent ? 1 : 0.62);

/* ------------------------------------------------------------------ */
/* Familia: clicks                                                     */
/* ------------------------------------------------------------------ */

const click: VoiceRender = (ctx, out, time, p) => {
  const base = p.accent ? 1600 : 1050;
  const d = 0.035 * p.decay;
  const g = percEnv(ctx, time, accentGain(p), d);
  tone(ctx, 'sine', semis(base, p.tune), time, d).connect(g);
  g.connect(out);
};

const beep: VoiceRender = (ctx, out, time, p) => {
  const base = p.accent ? 1320 : 880;
  const d = 0.055 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.55, d);
  const lp = filter(ctx, 'lowpass', 1200 + p.tone * 4500);
  tone(ctx, 'square', semis(base, p.tune), time, d).connect(lp);
  lp.connect(g);
  g.connect(out);
};

const blip: VoiceRender = (ctx, out, time, p) => {
  const base = p.accent ? 2000 : 1400;
  const d = 0.028 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.8, d);
  tone(ctx, 'triangle', semis(base, p.tune), time, d).connect(g);
  g.connect(out);
};

/* ------------------------------------------------------------------ */
/* Familia: percusion                                                  */
/* ------------------------------------------------------------------ */

/** Ratios inarmonicos: es lo que hace que suene a madera y no a nota. */
const woodblock: VoiceRender = (ctx, out, time, p) => {
  const base = semis(p.accent ? 1180 : 880, p.tune);
  const d = 0.05 * p.decay;
  const g = percEnv(ctx, time, accentGain(p), d);
  for (const [ratio, level] of [
    [1, 1],
    [2.71, 0.4],
    [4.13, 0.18]
  ] as const) {
    const v = ctx.createGain();
    v.gain.value = level;
    tone(ctx, 'sine', base * ratio, time, d).connect(v);
    v.connect(g);
  }
  const hp = filter(ctx, 'highpass', 700);
  const nGain = percEnv(ctx, time, accentGain(p) * 0.25, 0.012);
  noise(ctx, time, 0.02).connect(hp);
  hp.connect(nGain);
  nGain.connect(out);
  g.connect(out);
};

const clave: VoiceRender = (ctx, out, time, p) => {
  const base = semis(p.accent ? 2500 : 2200, p.tune);
  const d = 0.045 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.9, d);
  tone(ctx, 'sine', base, time, d).connect(g);
  const second = ctx.createGain();
  second.gain.value = 0.3;
  tone(ctx, 'sine', base * 1.47, time, d).connect(second);
  second.connect(g);
  g.connect(out);
};

const rim: VoiceRender = (ctx, out, time, p) => {
  const d = 0.05 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.85, d);
  const bp = filter(ctx, 'bandpass', semis(1700, p.tune), 3);
  noise(ctx, time, d).connect(bp);
  bp.connect(g);
  const body = ctx.createGain();
  body.gain.value = 0.4;
  tone(ctx, 'triangle', semis(420, p.tune), time, 0.03).connect(body);
  body.connect(g);
  g.connect(out);
};

/** Las dos cuadradas desafinadas del 808: 587 y 845 Hz. */
const cowbell: VoiceRender = (ctx, out, time, p) => {
  const d = 0.32 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.55, d);
  const bp = filter(ctx, 'bandpass', 2640, 1.6);
  tone(ctx, 'square', semis(587, p.tune), time, d).connect(bp);
  tone(ctx, 'square', semis(845, p.tune), time, d).connect(bp);
  bp.connect(g);
  g.connect(out);
};

const shaker: VoiceRender = (ctx, out, time, p) => {
  const d = 0.055 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.7, d);
  const hp = filter(ctx, 'highpass', 5200 + p.tone * 3000);
  noise(ctx, time, d).connect(hp);
  hp.connect(g);
  g.connect(out);
};

const tambourine: VoiceRender = (ctx, out, time, p) => {
  const d = 0.16 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.55, d);
  const hp = filter(ctx, 'highpass', 6000);
  const bp = filter(ctx, 'bandpass', 9000, 1.2);
  noise(ctx, time, d).connect(hp);
  hp.connect(bp);
  bp.connect(g);
  g.connect(out);
};

const bell: VoiceRender = (ctx, out, time, p) => {
  const base = semis(p.accent ? 2100 : 1750, p.tune);
  const d = 0.9 * p.decay;
  const g = percEnv(ctx, time, accentGain(p) * 0.3, d);
  for (const [ratio, level] of [
    [1, 1],
    [2.76, 0.5],
    [5.4, 0.25],
    [8.93, 0.12]
  ] as const) {
    const v = ctx.createGain();
    v.gain.value = level;
    tone(ctx, 'sine', base * ratio, time, d).connect(v);
    v.connect(g);
  }
  g.connect(out);
};

const stick: VoiceRender = (ctx, out, time, p) => {
  const d = 0.03 * p.decay;
  const g = percEnv(ctx, time, accentGain(p), d);
  const bp = filter(ctx, 'bandpass', semis(2400, p.tune), 1.2);
  noise(ctx, time, d).connect(bp);
  bp.connect(g);
  g.connect(out);
};

/* ------------------------------------------------------------------ */
/* Familia: kit                                                        */
/* ------------------------------------------------------------------ */

/** Seno con barrido de tono descendente mas click de ataque. */
function kick(startHz: number, endHz: number, sweep: number, clickAmt: number): VoiceRender {
  return (ctx, out, time, p) => {
    const d = 0.34 * p.decay;
    const g = percEnv(ctx, time, accentGain(p), d);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(semis(startHz, p.tune), time);
    o.frequency.exponentialRampToValueAtTime(semis(endHz, p.tune), time + sweep);
    o.start(time);
    o.stop(time + d + 0.05);
    o.connect(g);

    if (clickAmt > 0) {
      const cg = percEnv(ctx, time, accentGain(p) * clickAmt, 0.006);
      const hp = filter(ctx, 'highpass', 1200);
      noise(ctx, time, 0.01).connect(hp);
      hp.connect(cg);
      cg.connect(out);
    }
    g.connect(out);
  };
}

/** Ruido paso banda mas dos tonos de cuerpo, con envolventes separadas. */
function snare(bodyHz: number, noiseHz: number, snap: number): VoiceRender {
  return (ctx, out, time, p) => {
    const d = 0.19 * p.decay;

    const ng = percEnv(ctx, time, accentGain(p) * (0.6 + snap * 0.4), d);
    const bp = filter(ctx, 'bandpass', noiseHz + p.tone * 2000, 0.8);
    noise(ctx, time, d).connect(bp);
    bp.connect(ng);
    ng.connect(out);

    const bg = percEnv(ctx, time, accentGain(p) * 0.5, d * 0.55);
    tone(ctx, 'triangle', semis(bodyHz, p.tune), time, d).connect(bg);
    const second = ctx.createGain();
    second.gain.value = 0.6;
    tone(ctx, 'triangle', semis(bodyHz * 1.78, p.tune), time, d).connect(second);
    second.connect(bg);
    bg.connect(out);
  };
}

/** Seis cuadradas en ratios metalicos, filtradas en paso alto. */
function hat(open: boolean): VoiceRender {
  return (ctx, out, time, p) => {
    const d = (open ? 0.36 : 0.055) * p.decay;
    const g = percEnv(ctx, time, accentGain(p) * (open ? 0.42 : 0.5), d);
    const hp = filter(ctx, 'highpass', 7000 + p.tone * 3000);
    const bp = filter(ctx, 'bandpass', 10000, 0.7);
    const base = semis(320, p.tune);
    for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
      tone(ctx, 'square', base * r, time, d).connect(hp);
    }
    hp.connect(bp);
    bp.connect(g);
    g.connect(out);
  };
}

const clap: VoiceRender = (ctx, out, time, p) => {
  const bp = filter(ctx, 'bandpass', 1400 + p.tone * 900, 1.1);
  // Tres reflexiones cortas y una cola: es lo que hace que una palmada
  // suene a palmada y no a un golpe de ruido.
  for (const [offset, level] of [
    [0, 1],
    [0.011, 0.75],
    [0.022, 0.55]
  ] as const) {
    const g = percEnv(ctx, time + offset, accentGain(p) * 0.5 * level, 0.014);
    noise(ctx, time + offset, 0.02).connect(bp);
    bp.connect(g);
    g.connect(out);
  }
  const tail = percEnv(ctx, time + 0.03, accentGain(p) * 0.22, 0.13 * p.decay);
  noise(ctx, time + 0.03, 0.16).connect(bp);
  bp.connect(tail);
  tail.connect(out);
};

/* ------------------------------------------------------------------ */
/* Catalogo                                                            */
/* ------------------------------------------------------------------ */

export const VOICES: VoiceDef[] = [
  { id: 'click', name: 'Click', family: 'click', render: click },
  { id: 'beep', name: 'Beep', family: 'click', render: beep },
  { id: 'blip', name: 'Blip', family: 'click', render: blip },
  { id: 'woodblock', name: 'Woodblock', family: 'perc', render: woodblock },
  { id: 'clave', name: 'Clave', family: 'perc', render: clave },
  { id: 'rim', name: 'Rim', family: 'perc', render: rim },
  { id: 'cowbell', name: 'Cencerro', family: 'perc', render: cowbell },
  { id: 'shaker', name: 'Shaker', family: 'perc', render: shaker },
  { id: 'tambourine', name: 'Pandereta', family: 'perc', render: tambourine },
  { id: 'bell', name: 'Campana', family: 'perc', render: bell },
  { id: 'stick', name: 'Baqueta', family: 'perc', render: stick },
  { id: 'kick808', name: 'Bombo 808', family: 'kit', render: kick(120, 45, 0.09, 0.25) },
  { id: 'kick909', name: 'Bombo 909', family: 'kit', render: kick(180, 52, 0.05, 0.55) },
  { id: 'kickAcoustic', name: 'Bombo acustico', family: 'kit', render: kick(95, 48, 0.05, 0.7) },
  { id: 'snare808', name: 'Caja 808', family: 'kit', render: snare(185, 1800, 0.4) },
  { id: 'snare909', name: 'Caja 909', family: 'kit', render: snare(210, 3200, 0.85) },
  { id: 'clap', name: 'Palmada', family: 'kit', render: clap },
  { id: 'hatClosed', name: 'Charles cerrado', family: 'kit', render: hat(false) },
  { id: 'hatOpen', name: 'Charles abierto', family: 'kit', render: hat(true) }
];

export const VOICE_MAP: ReadonlyMap<string, VoiceDef> = new Map(VOICES.map((v) => [v.id, v]));

export function getVoice(id: string): VoiceDef {
  return VOICE_MAP.get(id) ?? VOICES[0];
}
