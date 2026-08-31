/**
 * Metrica = agrupacion x subdivision. Codigo PURO.
 *
 * Dos preguntas independientes:
 *   subdivision  cada pulso se parte en dos o en tres
 *   agrupacion   cuantos pulsos entran en un compas
 *
 * El cruce de ambas respuestas *es* la metrica. El caso duro, 6/8 contra
 * 4/4 con swing, es ternario en los dos: lo separa la agrupacion, 2
 * frente a 4, y el patron de graves.
 */

import { clamp, lerpAt, mean, stdev } from './core';

export type Subdivision = 'binary' | 'ternary';

export interface TimeSignature {
  beatsPerBar: number;
  beatUnit: number;
}

export interface MeterInput {
  /** Curva de onset normalizada. */
  onsetZ: Float32Array;
  /** Energia de la banda grave por trama, misma longitud que onsetZ. */
  lowEnergy: Float32Array;
  /**
   * Brillo relativo por trama (proporcion de agudo sobre el total). Un
   * charles abierto o un crash en el uno es de las marcas de downbeat
   * mas fiables de la bateria, y es lo unico que separa un 4/4 de un 2/4
   * cuando el bombo cae igual en los tiempos 1 y 3. Va como RATIO y no
   * como energia para no contar el acento dos veces junto al cue grave.
   */
  brightness: Float32Array;
  /** Croma aplanado: 12 valores por trama. */
  chroma: Float32Array;
  /** Indices de trama de cada beat. */
  beats: Int32Array;
  /** Periodo del pulso en tramas. */
  period: number;
}

export interface MeterAnalysis {
  subdivision: Subdivision;
  /** Contraste entre las dos hipotesis de subdivision, 0..1. */
  subdivisionScore: number;
  /** Pulsos por compas: 2, 3, 4, 5, 6 o 7. */
  pulsesPerBar: number;
  /** Indice del beat que es downbeat, dentro de `beats`. */
  downbeatIndex: number;
  /** Contraste de la mejor agrupacion frente a la media, 0..1. */
  groupingScore: number;
  /**
   * Cuanto pesa la mitad del pulso frente al pulso, 0..1+. Un pulso de
   * verdad es metricamente MAS fuerte que su subdivision; si empatan, el
   * candidato va un nivel por debajo del real. Es el discriminante que
   * evita el error de media velocidad.
   */
  halfRatio: number;
  /** Lo mismo para los tercios. */
  thirdRatio: number;
  /** Perfil medio de un pulso, en 24 puntos. Util para depurar. */
  profile: Float32Array;
}

/** Resolucion del perfil de pulso: divisible por 2, 3, 4, 6 y 8. */
const PROFILE_RES = 24;

/**
 * Perfil medio de un pulso: se remuestrea el intervalo entre beats
 * consecutivos sobre una rejilla fija y se promedia. Con 24 puntos, la
 * mitad cae exacta en 12 y los tercios en 8 y 16 — sin errores de
 * redondeo que confundan binario con ternario.
 */
export function beatProfile(onsetZ: Float32Array, beats: Int32Array): Float32Array {
  const profile = new Float32Array(PROFILE_RES);
  if (beats.length < 2) return profile;

  let count = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = beats[i];
    const b = beats[i + 1];
    const span = b - a;
    if (span < PROFILE_RES / 4) continue;
    for (let p = 0; p < PROFILE_RES; p++) {
      profile[p] += lerpAt(onsetZ, a + (span * p) / PROFILE_RES);
    }
    count++;
  }
  if (count > 0) for (let p = 0; p < PROFILE_RES; p++) profile[p] /= count;
  return profile;
}

/**
 * Compara la energia en las mitades contra la de los tercios.
 * En 24 puntos: mitad = 12; tercios = 8 y 16; cuartos = 6 y 18.
 */
export function analyzeSubdivision(profile: Float32Array): {
  subdivision: Subdivision;
  score: number;
  binary: number;
  ternary: number;
} {
  const at = (i: number) => Math.max(0, profile[i % PROFILE_RES]);

  const binary = at(12) + 0.5 * (at(6) + at(18));
  const ternary = at(8) + at(16);

  const total = binary + ternary;
  const contrast = total > 1e-9 ? Math.abs(ternary - binary) / total : 0;

  // El binario es el caso por defecto: hace falta una ventaja clara del
  // ternario para declararlo, porque un 4/4 recto con semicorcheas
  // siempre deja algo de energia cerca de los tercios.
  const subdivision: Subdivision = ternary > binary * 1.12 ? 'ternary' : 'binary';
  return { subdivision, score: clamp(contrast, 0, 1), binary, ternary };
}

/** Coseno entre dos vectores de croma. */
function chromaCosine(chroma: Float32Array, i: number, j: number): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let c = 0; c < 12; c++) {
    const a = chroma[i * 12 + c];
    const b = chroma[j * 12 + c];
    dot += a * b;
    na += a * a;
    nb += b * b;
  }
  const d = Math.sqrt(na * nb);
  return d > 1e-9 ? dot / d : 1;
}

function zNormalize(values: number[]): number[] {
  const m = mean(values);
  const s = stdev(values) || 1e-9;
  return values.map((v) => (v - m) / s);
}

/**
 * Construye la pista de "cuan downbeat es este beat" combinando tres
 * pistas independientes: peso en la banda grave, fuerza del ataque y
 * cambio armonico respecto al beat anterior.
 */
/**
 * Pesos de las cuatro pistas de downbeat. El brillo pesa poco a
 * proposito: en un patron con bombo en el uno y caja en el dos va en
 * contrafase con la pista de graves, porque el bombo es energia grave
 * pura y hunde el ratio mientras la caja, de banda ancha, lo dispara.
 * Agregado sobre el intervalo entero deja de marcar la caja y pasa a
 * medir el color del compas, que es para lo que sirve.
 */
const CUE_WEIGHTS = { low: 0.4, bright: 0.12, hit: 0.24, harm: 0.24 };

export function buildDownbeatCues(input: MeterInput): number[] {
  const { onsetZ, lowEnergy, brightness, chroma, beats, period } = input;
  if (beats.length < 4) return [];

  const win = Math.max(1, Math.round(period * 0.12));
  const nFrames = Math.floor(chroma.length / 12);

  const low: number[] = [];
  const bright: number[] = [];
  const hit: number[] = [];
  const harm: number[] = [];

  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];

    // El ataque se mide en el instante: es un pico, no un promedio.
    let bestOnset = -Infinity;
    for (let t = b - win; t <= b + win; t++) {
      if (t < 0 || t >= onsetZ.length) continue;
      if (onsetZ[t] > bestOnset) bestOnset = onsetZ[t];
    }
    hit.push(Number.isFinite(bestOnset) ? bestOnset : 0);

    // Peso y color se agregan sobre el INTERVALO completo hasta el
    // siguiente beat. Lo que distingue la primera mitad de un compas de
    // la segunda suele estar entre los tiempos — un bombo en la "y" de
    // 3, un relleno — y muestreando solo en el instante del beat eso no
    // se ve nunca.
    const end = i + 1 < beats.length ? beats[i + 1] : b + Math.round(period);
    let lowSum = 0;
    let brightSum = 0;
    let n = 0;
    for (let t = b; t < end; t++) {
      if (t < 0 || t >= lowEnergy.length) continue;
      lowSum += lowEnergy[t];
      brightSum += brightness[t];
      n++;
    }
    low.push(n > 0 ? lowSum / n : 0);
    bright.push(n > 0 ? brightSum / n : 0);

    const cur = Math.min(nFrames - 1, Math.max(0, b));
    const prev = Math.min(nFrames - 1, Math.max(0, b - Math.round(period)));
    harm.push(nFrames > 0 ? 1 - chromaCosine(chroma, cur, prev) : 0);
  }

  const zl = zNormalize(low);
  const zb = zNormalize(bright);
  const zh = zNormalize(hit);
  const za = zNormalize(harm);
  const w = CUE_WEIGHTS;
  return zl.map((_, i) => w.low * zl[i] + w.bright * zb[i] + w.hit * zh[i] + w.harm * za[i]);
}

/** Cuanto favorece la practica musical a cada agrupacion. */
const GROUPING_PRIOR: Record<number, number> = {
  2: 0.86,
  3: 0.92,
  4: 1.0,
  5: 0.6,
  6: 0.72,
  7: 0.58
};

/**
 * Prueba cada (agrupacion, fase) y se queda con la que mas separa los
 * downbeats del resto.
 *
 * El detalle que decide si esto funciona: agrupar en B prueba B fases y
 * se queda con la mejor, asi que agrupar en 4 tiene el doble de intentos
 * que agrupar en 2, y en 7 tiene siete. Con ruido, las agrupaciones
 * grandes ganan por puro sesgo de seleccion — y ahi es donde un 6/8 se
 * convierte en 12/8 y aparecen 7/8 de la nada. Se corrige descontando el
 * maximo esperado del ruido sobre B intentos, que crece con la raiz de
 * 2·ln(B). Como los cues vienen en unidades z, el error tipico del
 * contraste sale directamente de los tamanos de las dos muestras.
 */
/**
 * Evidencia de que agrupar en `b` aporta algo sobre agrupar en su
 * divisor `d`. Compara los downbeats de `b` contra sus HERMANOS: las
 * posiciones que `d` tambien considera fuertes pero `b` no.
 *
 * Traducido a lo que oye un baterista: para que haya 4/4 y no 2/4, el
 * tiempo 1 tiene que pesar mas que el 3. Si pesan igual, el compas es de
 * dos y decir cuatro es inventar. Es el mismo test que separa un 12/8 de
 * un 6/8. Devuelve un estadistico tipo t.
 */
function nestedEvidence(cues: number[], b: number, phase: number, d: number): number {
  const on: number[] = [];
  const siblings: number[] = [];
  for (let i = 0; i < cues.length; i++) {
    if (i % b === phase) on.push(cues[i]);
    else if (i % d === phase % d) siblings.push(cues[i]);
  }
  if (on.length < 2 || siblings.length < 2) return 0;
  const stderr = Math.sqrt(1 / on.length + 1 / siblings.length);
  return (mean(on) - mean(siblings)) / stderr;
}

/**
 * Correccion de sesgo de seleccion. Las B fases no son independientes
 * (particionan los mismos datos), asi que el maximo esperado del ruido
 * es bastante menor que el de B normales independientes: de ahi el
 * factor. Con el factor completo todo colapsa a la agrupacion mas
 * pequena; sin el, las grandes ganan gratis.
 */
const PHASE_BIAS_FACTOR = 0.5;

/** Cuanta ventaja hace falta para justificar el nivel superior. */
const NESTED_THRESHOLD = 0.6;

export function analyzeGrouping(cues: number[]): {
  pulsesPerBar: number;
  phase: number;
  score: number;
} {
  if (cues.length < 6) return { pulsesPerBar: 4, phase: 0, score: 0 };

  let bestB = 4;
  let bestPhase = 0;
  let bestScore = -Infinity;
  let bestAdjusted = 0;

  for (const b of [2, 3, 4, 5, 6, 7]) {
    if (cues.length < b * 2) continue;
    const bias = PHASE_BIAS_FACTOR * Math.sqrt(2 * Math.log(b));

    for (let p = 0; p < b; p++) {
      let onSum = 0;
      let onN = 0;
      let offSum = 0;
      let offN = 0;
      for (let i = 0; i < cues.length; i++) {
        if (i % b === p) {
          onSum += cues[i];
          onN++;
        } else {
          offSum += cues[i];
          offN++;
        }
      }
      if (onN < 2 || offN < 2) continue;

      const raw = onSum / onN - offSum / offN;
      const stderr = Math.sqrt(1 / onN + 1 / offN);
      const adjusted = raw - bias * stderr;
      const score = adjusted * GROUPING_PRIOR[b];

      if (score > bestScore) {
        bestScore = score;
        bestB = b;
        bestPhase = p;
        bestAdjusted = adjusted;
      }
    }
  }

  // Degradacion a nivel anidado. Si agrupar en 4 no separa el tiempo 1
  // del 3, no hay 4/4: hay 2/4. Se aplica en cadena, asi que 6 puede
  // bajar a 3 y 4 a 2, pero nunca por debajo de 2.
  while (bestB % 2 === 0 && bestB / 2 >= 2) {
    const divisor = bestB / 2;
    if (nestedEvidence(cues, bestB, bestPhase, divisor) >= NESTED_THRESHOLD) break;
    bestB = divisor;
    bestPhase = bestPhase % divisor;
  }

  // El contraste esta en unidades z; ~1.2 tras el descuento ya es una
  // agrupacion nitida.
  return { pulsesPerBar: bestB, phase: bestPhase, score: clamp(bestAdjusted / 1.2, 0, 1) };
}

/**
 * Peso relativo de la mitad y de los tercios frente al propio pulso.
 *
 * El perfil viene en unidades z, asi que puede ser negativo: se mide
 * sobre el suelo del perfil, no sobre cero. El pulso se toma como el
 * maximo del entorno de la posicion 0, para que un desfase de una trama
 * no falsee la comparacion.
 */
export function subdivisionRatios(profile: Float32Array): { half: number; third: number } {
  let floor = Infinity;
  for (let i = 0; i < profile.length; i++) if (profile[i] < floor) floor = profile[i];
  if (!Number.isFinite(floor)) return { half: 0, third: 0 };

  const at = (i: number) => profile[((i % PROFILE_RES) + PROFILE_RES) % PROFILE_RES] - floor;
  const beat = Math.max(at(0), at(1), at(-1));
  if (beat < 1e-6) return { half: 0, third: 0 };

  const half = at(12) / beat;
  const third = Math.max(at(8), at(16)) / beat;
  return { half, third };
}

export function analyzeMeter(input: MeterInput): MeterAnalysis {
  const profile = beatProfile(input.onsetZ, input.beats);
  const sub = analyzeSubdivision(profile);
  const ratios = subdivisionRatios(profile);
  const cues = buildDownbeatCues(input);
  const grouping = analyzeGrouping(cues);

  return {
    subdivision: sub.subdivision,
    subdivisionScore: sub.score,
    pulsesPerBar: grouping.pulsesPerBar,
    downbeatIndex: grouping.phase,
    groupingScore: grouping.score,
    halfRatio: ratios.half,
    thirdRatio: ratios.third,
    profile
  };
}

/* ------------------------------------------------------------------ */
/* Traduccion a cifra de compas                                        */
/* ------------------------------------------------------------------ */

/**
 * En compas compuesto el pulso sentido es la negra con puntillo, asi que
 * cada pulso vale tres corcheas: 2 pulsos -> 6/8, 3 -> 9/8, 4 -> 12/8.
 */
export function toTimeSignature(pulsesPerBar: number, subdivision: Subdivision): TimeSignature {
  if (subdivision === 'ternary') {
    return { beatsPerBar: pulsesPerBar * 3, beatUnit: 8 };
  }
  if (pulsesPerBar === 7) return { beatsPerBar: 7, beatUnit: 8 };
  return { beatsPerBar: pulsesPerBar, beatUnit: 4 };
}

/** Cuantos pulsos sentidos tiene un compas. Inversa de la anterior. */
export function pulsesPerBar(sig: TimeSignature): number {
  if (sig.beatUnit === 8) {
    return sig.beatsPerBar % 3 === 0 ? sig.beatsPerBar / 3 : sig.beatsPerBar;
  }
  return sig.beatsPerBar;
}

/** Corcheas por pulso: 3 en compuesto, 2 en simple. */
export function subdivisionsPerPulse(sig: TimeSignature): number {
  return sig.beatUnit === 8 && sig.beatsPerBar % 3 === 0 ? 3 : 2;
}

/**
 * Cuantas negras dura un pulso sentido.
 *
 * Todos los DAW expresan el tempo en negras por minuto sea cual sea el
 * compas, y es tambien lo que un baterista teclea en su click. En
 * compuesto el pulso es una negra con puntillo, que son una negra y
 * media: de ahi el 1.5. En un 7/8 el pulso es una corchea, media negra.
 */
export function quartersPerPulse(sig: TimeSignature): number {
  if (sig.beatUnit === 8) return sig.beatsPerBar % 3 === 0 ? 1.5 : 0.5;
  if (sig.beatUnit === 2) return 2;
  return 1;
}

export function formatTimeSignature(sig: TimeSignature): string {
  return sig.beatsPerBar + '/' + sig.beatUnit;
}

/**
 * Etiqueta que un baterista reconoce. Un 12/8 es, en la practica, un
 * 4/4 con swing, y conviene decirlo asi.
 */
export function meterLabel(sig: TimeSignature): string {
  const base = formatTimeSignature(sig);
  if (sig.beatUnit === 8 && sig.beatsPerBar === 12) return base + ' · shuffle en 4';
  if (sig.beatUnit === 8 && sig.beatsPerBar === 9) return base + ' · compuesto en 3';
  return base;
}
