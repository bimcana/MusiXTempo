/**
 * Generador de corpus sintetico.
 *
 * Renderiza audio con BPM, metrica y subdivision conocidos POR
 * CONSTRUCCION — no anotados a mano, exactos. Es lo que permite medir la
 * precision del motor en vez de opinar sobre ella.
 *
 * REGLA DEL CORPUS: el audio debe contener realmente la informacion que
 * la etiqueta afirma. Un patron cuyo primer y tercer tiempo son
 * identicos no es un 4/4 detectable, es un 2/4 — y etiquetarlo 4/4 solo
 * ensena al motor a adivinar. Por eso los patrones llevan acento en el
 * uno, variacion de bombo dentro del compas y armonia que cambia por
 * compas: las tres pistas que un baterista usa de verdad.
 *
 * Sintesis en JS puro, sin Web Audio: los tests corren en Node.
 */

export type Subdivision = 'binary' | 'ternary';

export interface Pattern {
  kick: number[];
  snare: number[];
  hat: number[];
}

export interface PieceSpec {
  id: string;
  /** Pulso sentido en BPM. En compuesto, la negra con puntillo. */
  bpm: number;
  pulsesPerBar: number;
  subdivision: Subdivision;
  stepsPerBar: number;
  pattern: Pattern;
  expectedMeter: { beatsPerBar: number; beatUnit: number };
}

export interface RenderOptions {
  sampleRate?: number;
  seconds?: number;
  /** Desviacion tipica del jitter de timing, en segundos. */
  humanizeSec?: number;
  /** Deriva de tempo a lo largo de la pieza, en fraccion. */
  drift?: number;
  /** Ruido de sala, amplitud. */
  noise?: number;
  /** Cola de reverberacion, 0..1. */
  reverb?: number;
  kit?: 'acoustic' | 'clicks' | 'hands';
  /** Bajo armonico que cambia de acorde por compas. */
  bass?: boolean;
  seed?: number;
  gain?: number;
}

/* ------------------------------------------------------------------ */
/* Aleatoriedad reproducible                                           */
/* ------------------------------------------------------------------ */

export function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ */
/* Voces                                                               */
/* ------------------------------------------------------------------ */

type Voice = (out: Float32Array, start: number, sr: number, amp: number, rng: () => number) => void;

const kick: Voice = (out, start, sr, amp) => {
  const dur = Math.floor(sr * 0.28);
  for (let i = 0; i < dur; i++) {
    const p = start + i;
    if (p >= out.length) break;
    const t = i / sr;
    const env = Math.exp(-t * 16);
    const f = 45 + 85 * Math.exp(-t * 42);
    const click = i < sr * 0.004 ? Math.exp(-t * 700) * 0.35 : 0;
    out[p] += amp * (env * Math.sin(2 * Math.PI * f * t) + click);
  }
};

const snare: Voice = (out, start, sr, amp, rng) => {
  const dur = Math.floor(sr * 0.2);
  let lp = 0;
  for (let i = 0; i < dur; i++) {
    const p = start + i;
    if (p >= out.length) break;
    const t = i / sr;
    const env = Math.exp(-t * 26);
    const n = rng() * 2 - 1;
    lp = lp * 0.55 + n * 0.45;
    const noise = (n - lp) * 0.9;
    const body =
      0.35 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 40) +
      0.22 * Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t * 45);
    out[p] += amp * env * (noise + body);
  }
};

/**
 * Hi-hat. Por encima de amp 1.1 se abre: mas cola y mas brillo. Es como
 * un baterista marca el uno, y es la pista que hace que un 4/4 se
 * distinga de un 2/4.
 */
const hat: Voice = (out, start, sr, amp, rng) => {
  const open = amp > 1.1;
  const decay = open ? 26 : 95;
  const dur = Math.floor(sr * (open ? 0.22 : 0.06));
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < dur; i++) {
    const p = start + i;
    if (p >= out.length) break;
    const t = i / sr;
    const env = Math.exp(-t * decay);
    const n = rng() * 2 - 1;
    hp = 0.88 * (hp + n - prev);
    prev = n;
    out[p] += amp * env * hp * 0.55;
  }
};

const click: Voice = (out, start, sr, amp) => {
  const dur = Math.floor(sr * 0.03);
  const freq = amp > 1.1 ? 1800 : 1200;
  for (let i = 0; i < dur; i++) {
    const p = start + i;
    if (p >= out.length) break;
    const t = i / sr;
    out[p] += amp * Math.exp(-t * 160) * Math.sin(2 * Math.PI * freq * t);
  }
};

const clap: Voice = (out, start, sr, amp, rng) => {
  const dur = Math.floor(sr * 0.16);
  let prev = 0;
  let hp = 0;
  for (let i = 0; i < dur; i++) {
    const p = start + i;
    if (p >= out.length) break;
    const t = i / sr;
    const bursts =
      Math.exp(-t * 60) +
      0.6 * Math.exp(-Math.abs(t - 0.011) * 260) +
      0.4 * Math.exp(-Math.abs(t - 0.022) * 260);
    const n = rng() * 2 - 1;
    hp = 0.8 * (hp + n - prev);
    prev = n;
    out[p] += amp * bursts * hp * 0.5;
  }
};

/** Nota de bajo con armonicos: aporta el cambio de croma por compas. */
function bassNote(out: Float32Array, start: number, sr: number, freq: number, dur: number, amp: number): void {
  const n = Math.floor(dur * sr);
  for (let i = 0; i < n; i++) {
    const p = start + i;
    if (p >= out.length) break;
    const t = i / sr;
    const env = Math.min(1, t * 90) * Math.exp(-t * 3.2);
    out[p] +=
      amp *
      env *
      (Math.sin(2 * Math.PI * freq * t) +
        0.4 * Math.sin(4 * Math.PI * freq * t) +
        0.18 * Math.sin(6 * Math.PI * freq * t));
  }
}

interface Kit {
  kick: Voice;
  snare: Voice;
  hat: Voice;
}

const KITS: Record<NonNullable<RenderOptions['kit']>, Kit> = {
  acoustic: { kick, snare, hat },
  clicks: { kick: click, snare: click, hat: click },
  hands: { kick: clap, snare: clap, hat: clap }
};

/* ------------------------------------------------------------------ */
/* Ayudas de metrica                                                   */
/* ------------------------------------------------------------------ */

export function subdivisionCount(s: Subdivision): number {
  return s === 'ternary' ? 3 : 2;
}

export function meterOf(pulsesPerBar: number, subdivision: Subdivision) {
  if (subdivision === 'ternary') return { beatsPerBar: pulsesPerBar * 3, beatUnit: 8 };
  if (pulsesPerBar === 7) return { beatsPerBar: 7, beatUnit: 8 };
  return { beatsPerBar: pulsesPerBar, beatUnit: 4 };
}

export function makePiece(
  id: string,
  bpm: number,
  pulsesPerBar: number,
  subdivision: Subdivision,
  pattern: Pattern
): PieceSpec {
  return {
    id,
    bpm,
    pulsesPerBar,
    subdivision,
    stepsPerBar: pattern.hat.length,
    pattern,
    expectedMeter: meterOf(pulsesPerBar, subdivision)
  };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/** Progresion de acordes por compas, en semitonos sobre la tonica. */
// Un acorde por compas. Si la armonia cambiase cada dos compases, ese
// ciclo competiria con la metrica: en 6/8 daria un falso 4 y el corpus
// estaria midiendo un artefacto suyo en vez del motor.
const PROGRESSION = [0, 5, 3, 7];
const BASS_ROOT = 65.41; // Do2

export function renderPiece(piece: PieceSpec, opts: RenderOptions = {}): Float32Array {
  const sr = opts.sampleRate ?? 44100;
  const seconds = opts.seconds ?? 14;
  const humanize = opts.humanizeSec ?? 0.006;
  const drift = opts.drift ?? 0;
  const noise = opts.noise ?? 0.003;
  const reverb = opts.reverb ?? 0.12;
  const kit = KITS[opts.kit ?? 'acoustic'];
  const withBass = opts.bass ?? true;
  const rng = makeRng(opts.seed ?? 12345);

  const out = new Float32Array(Math.floor(sr * seconds));
  const barSec = (piece.pulsesPerBar * 60) / piece.bpm;
  const stepSec = barSec / piece.stepsPerBar;
  const amps = { kick: 0.95, snare: 0.72, hat: 0.3 };

  let t = 0.25;
  let bar = 0;
  while (t < seconds && bar < 2000) {
    const progress = t / seconds;
    const localStep = stepSec * (1 - drift * progress);

    if (withBass) {
      const semi = PROGRESSION[bar % PROGRESSION.length];
      const freq = BASS_ROOT * Math.pow(2, semi / 12);
      const jitter = gaussian(rng) * humanize;
      bassNote(out, Math.max(0, Math.floor((t + jitter) * sr)), sr, freq, localStep * piece.stepsPerBar * 0.95, 0.3);
    }

    for (let s = 0; s < piece.stepsPerBar; s++) {
      const nominal = t + s * localStep;
      if (nominal >= seconds) break;
      const jitter = humanize > 0 ? gaussian(rng) * humanize : 0;
      const at = Math.max(0, Math.floor((nominal + jitter) * sr));

      if (piece.pattern.kick[s]) kit.kick(out, at, sr, amps.kick * piece.pattern.kick[s], rng);
      if (piece.pattern.snare[s]) kit.snare(out, at, sr, amps.snare * piece.pattern.snare[s], rng);
      if (piece.pattern.hat[s]) kit.hat(out, at, sr, amps.hat * piece.pattern.hat[s], rng);
    }

    t += localStep * piece.stepsPerBar;
    bar++;
  }

  applyRoom(out, sr, reverb, noise, rng);
  applyGain(out, opts.gain ?? 0.7);
  return out;
}

/* ------------------------------------------------------------------ */
/* Tarareo                                                             */
/* ------------------------------------------------------------------ */

export interface HummingSpec {
  id: string;
  bpm: number;
  pulsesPerBar: number;
  subdivision: Subdivision;
  /**
   * Ritmo melodico: duracion de cada nota en pasos. La suma debe cubrir
   * un compas entero. Las notas largas caen en los tiempos fuertes, que
   * es lo que le da pulso a un tarareo real.
   */
  rhythm: number[];
  /** Grados de la escala, uno por nota. */
  degrees: number[];
  expectedMeter: { beatsPerBar: number; beatUnit: number };
}

export function makeHumming(
  id: string,
  bpm: number,
  pulsesPerBar: number,
  subdivision: Subdivision,
  rhythm: number[],
  degrees: number[]
): HummingSpec {
  return { id, bpm, pulsesPerBar, subdivision, rhythm, degrees, expectedMeter: meterOf(pulsesPerBar, subdivision) };
}

/**
 * Tarareo: sin un solo ataque percusivo. La envolvente sube y baja, asi
 * que el flujo espectral apenas se entera; lo unico que marca el ritmo
 * es el cambio de altura. Es el caso que hunde a los modelos entrenados
 * con pop, y la razon de que el motor lleve un detector de croma.
 */
export function renderHumming(spec: HummingSpec, opts: RenderOptions = {}): Float32Array {
  const sr = opts.sampleRate ?? 44100;
  const seconds = opts.seconds ?? 16;
  const humanize = opts.humanizeSec ?? 0.012;
  const noise = opts.noise ?? 0.004;
  const rng = makeRng(opts.seed ?? 777);
  const out = new Float32Array(Math.floor(sr * seconds));

  const stepsPerBar = spec.rhythm.reduce((a, b) => a + b, 0);
  const barSec = (spec.pulsesPerBar * 60) / spec.bpm;
  const stepSec = barSec / stepsPerBar;

  const scale = [0, 2, 3, 5, 7, 8, 10, 12];
  const base = 196; // Sol3
  let phase = 0;
  let t = 0.3;
  let bar = 0;

  while (t < seconds && bar < 1000) {
    let stepInBar = 0;
    for (let n = 0; n < spec.rhythm.length; n++) {
      const noteSteps = spec.rhythm[n];
      const startSec = t + stepInBar * stepSec;
      if (startSec >= seconds) break;

      const degree = spec.degrees[(bar * spec.degrees.length + n) % spec.degrees.length];
      const f0 = base * Math.pow(2, scale[((degree % scale.length) + scale.length) % scale.length] / 12);

      const jitter = gaussian(rng) * humanize;
      const start = Math.max(0, Math.floor((startSec + jitter) * sr));
      const dur = Math.floor(noteSteps * stepSec * sr * 0.94);
      // El primer tiempo del compas se canta algo mas fuerte. Sin eso, un
      // tarareo no tiene downbeat que detectar.
      const accent = stepInBar === 0 ? 1.0 : 0.78;

      for (let i = 0; i < dur; i++) {
        const p = start + i;
        if (p >= out.length) break;
        const x = i / dur;
        const env = Math.pow(Math.sin(Math.PI * Math.min(1, x)), 1.3);
        const vib = 1 + 0.006 * Math.sin((2 * Math.PI * 5.2 * i) / sr);
        phase += (2 * Math.PI * f0 * vib) / sr;
        out[p] +=
          0.5 * accent * env * (Math.sin(phase) + 0.32 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase));
      }
      stepInBar += noteSteps;
    }
    t += stepsPerBar * stepSec;
    bar++;
  }

  applyRoom(out, sr, opts.reverb ?? 0.08, noise, rng);
  applyGain(out, opts.gain ?? 0.7);
  return out;
}

/* ------------------------------------------------------------------ */
/* Sala                                                                */
/* ------------------------------------------------------------------ */

function applyRoom(out: Float32Array, sr: number, reverb: number, noise: number, rng: () => number): void {
  if (reverb > 0) {
    const delays = [Math.floor(sr * 0.037), Math.floor(sr * 0.053)];
    const fb = [reverb * 0.6, reverb * 0.45];
    for (let d = 0; d < delays.length; d++) {
      const dl = delays[d];
      for (let i = dl; i < out.length; i++) out[i] += out[i - dl] * fb[d];
    }
  }
  if (noise > 0) {
    for (let i = 0; i < out.length; i++) out[i] += (rng() * 2 - 1) * noise;
  }
}

function applyGain(out: Float32Array, gain: number): void {
  let peak = 1e-9;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const k = gain / peak;
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.tanh(out[i] * k * 1.15) * 0.92;
  }
}

/* ------------------------------------------------------------------ */
/* Patrones                                                            */
/* ------------------------------------------------------------------ */

/**
 * Cada patron cumple la regla del corpus: el acento del hat marca el uno
 * (>1.1 abre el charles) y el bombo varia entre la primera y la segunda
 * mitad del compas. Sin eso, la etiqueta afirma mas de lo que el audio
 * contiene.
 */
const P = {
  // 4/4, 8 pasos. Bombo en 1, 3 y la "y" de 3: rompe la simetria de mitades.
  rock44: {
    kick: [1, 0, 0, 0, 1, 0.85, 0, 0],
    snare: [0, 0, 1, 0, 0, 0, 1, 0],
    hat: [1.35, 0.55, 0.92, 0.55, 1.0, 0.55, 0.92, 0.6]
  },
  pop44: {
    kick: [1, 0, 0, 0.55, 1, 0, 0, 0],
    snare: [0, 0, 1, 0, 0, 0, 1, 0.4],
    hat: [1.3, 0.6, 0.9, 0.6, 0.98, 0.6, 0.9, 0.55]
  },
  // 12/8 shuffle, 12 pasos = 4 pulsos x 3.
  shuffle44: {
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.7],
    snare: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0],
    hat: [1.35, 0, 0.62, 0.92, 0, 0.62, 1.0, 0, 0.62, 0.92, 0, 0.66]
  },
  blues128: {
    kick: [1, 0, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 0.7],
    snare: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0],
    hat: [1.35, 0, 0.6, 0.9, 0, 0.6, 1.02, 0, 0.6, 0.9, 0, 0.6]
  },
  // 6/8, 6 pasos = 2 pulsos x 3. Charles en las seis corcheas: eso es lo
  // que lo hace ternario de forma audible.
  ballad68: {
    kick: [1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 1, 0, 0],
    hat: [1.35, 0.5, 0.52, 0.88, 0.5, 0.54]
  },
  // 6/8 con poca percusion: el caso mas dificil. Aun asi las seis
  // corcheas estan ahi, tenues — sin ellas no seria 6/8 ni para un humano.
  sparse68: {
    kick: [1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0.45, 0, 0],
    hat: [0.55, 0.2, 0.22, 0.4, 0.2, 0.22]
  },
  waltz34: {
    kick: [1, 0, 0, 0, 0, 0.4],
    snare: [0, 0, 1, 0, 1, 0],
    hat: [1.35, 0.5, 0.9, 0.5, 0.9, 0.5]
  },
  march24: {
    kick: [1, 0, 0, 0.55],
    snare: [0, 0, 1, 0],
    hat: [1.35, 0.6, 0.9, 0.6]
  },
  odd54: {
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0.5],
    snare: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    hat: [1.35, 0.55, 0.9, 0.55, 0.95, 0.55, 0.9, 0.55, 0.9, 0.55]
  }
};

export const PATTERNS = P;

/**
 * Version suave de un patron: sin bombo ni caja, solo textura tenue.
 * Es la intro de medio tiempo lento del mundo — y el caso que arrastra
 * la cifra si el motor promedia lecturas en vez de evidencia.
 */
export function soften(pattern: Pattern): Pattern {
  return {
    kick: pattern.kick.map(() => 0),
    snare: pattern.snare.map(() => 0),
    hat: pattern.hat.map((v, i) => (i === 0 ? Math.min(0.5, v * 0.35) : v * 0.18))
  };
}

/**
 * Arreglo por secciones: intro floja, entrada de bateria, etc. Concatena
 * los tramos tal cual, sin fundido, porque un cambio de seccion es un
 * cambio real y el motor tiene que aguantarlo.
 */
export function renderArrangement(
  sections: { piece: PieceSpec; seconds: number }[],
  opts: RenderOptions = {}
): Float32Array {
  const sr = opts.sampleRate ?? 44100;
  const parts = sections.map((section, i) =>
    renderPiece(section.piece, { ...opts, sampleRate: sr, seconds: section.seconds, seed: (opts.seed ?? 1) + i * 7919 })
  );
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Corpus por defecto: cobertura ancha, con carga extra en 4/4 y 6/8. */
export function defaultCorpus(): PieceSpec[] {
  const pieces: PieceSpec[] = [];
  for (const bpm of [72, 88, 100, 120, 132, 148, 168]) {
    pieces.push(makePiece('rock44-' + bpm, bpm, 4, 'binary', P.rock44));
  }
  for (const bpm of [92, 116, 140]) {
    pieces.push(makePiece('pop44-' + bpm, bpm, 4, 'binary', P.pop44));
  }
  for (const bpm of [55, 62, 70, 80, 92]) {
    pieces.push(makePiece('ballad68-' + bpm, bpm, 2, 'ternary', P.ballad68));
  }
  for (const bpm of [58, 68, 78]) {
    pieces.push(makePiece('sparse68-' + bpm, bpm, 2, 'ternary', P.sparse68));
  }
  for (const bpm of [82, 96, 112]) {
    pieces.push(makePiece('shuffle44-' + bpm, bpm, 4, 'ternary', P.shuffle44));
  }
  for (const bpm of [76, 100]) {
    pieces.push(makePiece('blues128-' + bpm, bpm, 4, 'ternary', P.blues128));
  }
  for (const bpm of [110, 138, 160]) {
    pieces.push(makePiece('waltz34-' + bpm, bpm, 3, 'binary', P.waltz34));
  }
  for (const bpm of [96, 120]) {
    pieces.push(makePiece('march24-' + bpm, bpm, 2, 'binary', P.march24));
  }
  for (const bpm of [120, 150]) {
    pieces.push(makePiece('odd54-' + bpm, bpm, 5, 'binary', P.odd54));
  }
  return pieces;
}

/** Melodias de tarareo. El ritmo pone las notas largas en los tiempos fuertes. */
export function hummingCorpus(): HummingSpec[] {
  return [
    // 4/4 en corcheas: negra, dos corcheas, negra, negra.
    makeHumming('hum-44-96', 96, 4, 'binary', [2, 1, 1, 2, 2], [0, 2, 3, 4, 2]),
    makeHumming('hum-44-120', 120, 4, 'binary', [2, 2, 1, 1, 2], [4, 2, 3, 4, 0]),
    makeHumming('hum-44-72', 72, 4, 'binary', [2, 1, 1, 2, 2], [0, 1, 2, 4, 3]),
    makeHumming('hum-44-144', 144, 4, 'binary', [2, 2, 2, 2], [0, 3, 4, 2]),
    makeHumming('hum-34-132', 132, 3, 'binary', [2, 2, 2], [0, 4, 2]),
    // 6/8: negra con puntillo y luego corchea + negra.
    makeHumming('hum-68-66', 66, 2, 'ternary', [3, 1, 2], [0, 3, 4]),
    makeHumming('hum-68-80', 80, 2, 'ternary', [3, 2, 1], [4, 2, 0])
  ];
}
