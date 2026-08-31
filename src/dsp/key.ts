/**
 * Estimacion de tonalidad. Codigo PURO.
 *
 * El croma por trama ya se calcula para el analisis de compas: estimar
 * la tonalidad solo cuesta acumularlo a lo largo de la escucha y
 * correlacionarlo con los perfiles de Krumhansl-Kessler — los pesos
 * medidos experimentalmente de cuanto "pertenece" cada nota a una
 * tonalidad. 24 correlaciones de 12 puntos: gratis.
 *
 * Se reporta en tres notaciones: nombre clasico (C#m), Camelot (12A) y
 * Open Key (5m), porque el publico DJ vive en las dos ultimas.
 */

/** Perfiles de Krumhansl-Kessler (1982), mayor y menor desde Do. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface KeyEstimate {
  /** Nombre clasico: "C#m", "F". */
  name: string;
  tonic: string;
  mode: 'major' | 'minor';
  /** Notacion Camelot: "8B", "12A". */
  camelot: string;
  /** Notacion Open Key: "1d", "5m". */
  openKey: string;
  /** Separacion entre la mejor y la segunda hipotesis, 0..1. */
  confidence: number;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom > 1e-12 ? num / denom : 0;
}

/**
 * Posicion en el circulo de quintas partiendo de Do mayor / La menor.
 * Es lo unico que hace falta para Camelot y Open Key: ambas notaciones
 * SON el circulo de quintas con etiquetas distintas.
 */
function fifthsIndex(tonic: number, mode: 'major' | 'minor'): number {
  // Cuantas quintas separan la tonica de Do (mayor) o de La (menor).
  const reference = mode === 'major' ? 0 : 9;
  // Multiplicar por 7 (una quinta = 7 semitonos) invierte el circulo.
  return (((tonic - reference) * 7) % 12 + 12) % 12;
}

export function estimateKey(chroma: ArrayLike<number>): KeyEstimate | null {
  if (chroma.length !== 12) return null;
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total < 1e-6) return null;

  const observed: number[] = [];
  for (let i = 0; i < 12; i++) observed.push(chroma[i]);

  let best = -Infinity;
  let second = -Infinity;
  let bestTonic = 0;
  let bestMode: 'major' | 'minor' = 'major';

  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
    for (let tonic = 0; tonic < 12; tonic++) {
      // Rotar el PERFIL en vez del croma: mismo resultado, sin copias.
      let score = 0;
      {
        const rotated: number[] = [];
        for (let i = 0; i < 12; i++) rotated.push(profile[(((i - tonic) % 12) + 12) % 12]);
        score = pearson(observed, rotated);
      }
      if (score > best) {
        second = best;
        best = score;
        bestTonic = tonic;
        bestMode = mode;
      } else if (score > second) {
        second = score;
      }
    }
  }

  const fifths = fifthsIndex(bestTonic, bestMode);
  // Camelot: 8B = Do mayor, 8A = La menor; avanza 1 por quinta.
  const camelotNumber = ((fifths + 7) % 12) + 1;
  // Open Key: 1d = Do mayor, 1m = La menor.
  const openKeyNumber = fifths + 1;

  return {
    name: NOTE_NAMES[bestTonic] + (bestMode === 'minor' ? 'm' : ''),
    tonic: NOTE_NAMES[bestTonic],
    mode: bestMode,
    camelot: camelotNumber + (bestMode === 'major' ? 'B' : 'A'),
    openKey: openKeyNumber + (bestMode === 'major' ? 'd' : 'm'),
    confidence: Math.max(0, Math.min(1, (best - second) * 4))
  };
}
