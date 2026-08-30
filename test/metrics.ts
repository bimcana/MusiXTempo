/**
 * Metricas estandar del campo, no inventadas.
 *
 *   Accuracy 1  el BPM cae dentro del +-4 % del real
 *   Accuracy 2  igual, pero tolerando error de octava y de ratio 3
 *
 * La metrica se mide como matriz de confusion, con la celda 6/8 <-> 4/4
 * vigilada explicitamente: es la que de verdad importa aqui.
 */

export const TOLERANCE = 0.04;

export function withinTolerance(est: number, ref: number, tol = TOLERANCE): boolean {
  if (!Number.isFinite(est) || est <= 0 || ref <= 0) return false;
  return Math.abs(est - ref) / ref <= tol;
}

/** Accuracy 1: el tempo exacto, sin indulgencias. */
export function accuracy1(est: number, ref: number, tol = TOLERANCE): boolean {
  return withinTolerance(est, ref, tol);
}

/** Accuracy 2: acepta mitad, doble, tercio y triple del tempo real. */
export function accuracy2(est: number, ref: number, tol = TOLERANCE): boolean {
  const ratios = [1, 2, 0.5, 3, 1 / 3, 1.5, 2 / 3];
  return ratios.some((r) => withinTolerance(est, ref * r, tol));
}

/** Cual fue el error de octava, si lo hubo. Devuelve null si acerto. */
export function octaveError(est: number, ref: number, tol = TOLERANCE): string | null {
  if (withinTolerance(est, ref, tol)) return null;
  const named: [number, string][] = [
    [2, 'x2'],
    [0.5, '/2'],
    [3, 'x3'],
    [1 / 3, '/3'],
    [1.5, 'x1.5'],
    [2 / 3, 'x2/3']
  ];
  for (const [r, label] of named) if (withinTolerance(est, ref * r, tol)) return label;
  return 'otro';
}

export interface Meterish {
  beatsPerBar: number;
  beatUnit: number;
}

export function meterKey(m: Meterish): string {
  return m.beatsPerBar + '/' + m.beatUnit;
}

/** Matriz de confusion sobre cifras de compas. */
export class MeterConfusion {
  private readonly cells = new Map<string, number>();
  private readonly rows = new Set<string>();
  private readonly cols = new Set<string>();
  private total = 0;
  private correct = 0;

  add(expected: Meterish, got: Meterish | null): void {
    const e = meterKey(expected);
    const g = got ? meterKey(got) : '(sin resultado)';
    this.rows.add(e);
    this.cols.add(g);
    this.cells.set(e + '|' + g, (this.cells.get(e + '|' + g) ?? 0) + 1);
    this.total++;
    if (e === g) this.correct++;
  }

  cell(expected: string, got: string): number {
    return this.cells.get(expected + '|' + got) ?? 0;
  }

  /** Aciertos sobre una cifra concreta, p. ej. "6/8". */
  recall(expected: string): number {
    let hit = 0;
    let n = 0;
    for (const [key, count] of this.cells) {
      const [e, g] = key.split('|');
      if (e !== expected) continue;
      n += count;
      if (g === expected) hit += count;
    }
    return n === 0 ? 1 : hit / n;
  }

  get accuracy(): number {
    return this.total === 0 ? 0 : this.correct / this.total;
  }

  toTable(): string {
    const cols = [...this.cols].sort();
    const width = Math.max(12, ...cols.map((c) => c.length + 2));
    const head = 'esperado \\ obtenido'.padEnd(22) + cols.map((c) => c.padStart(width)).join('');
    const lines = [head];
    for (const r of [...this.rows].sort()) {
      let line = r.padEnd(22);
      for (const c of cols) {
        const v = this.cell(r, c);
        line += (v === 0 ? '.' : String(v)).padStart(width);
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}

export interface TempoReport {
  total: number;
  acc1: number;
  acc2: number;
  meanAbsPercent: number;
  failures: string[];
}

export class TempoScorer {
  private total = 0;
  private hits1 = 0;
  private hits2 = 0;
  private sumPct = 0;
  readonly failures: string[] = [];

  add(id: string, est: number | null, ref: number): void {
    this.total++;
    if (est === null || !Number.isFinite(est)) {
      this.failures.push(id + ': sin resultado (esperado ' + ref + ')');
      return;
    }
    const ok1 = accuracy1(est, ref);
    const ok2 = accuracy2(est, ref);
    if (ok1) this.hits1++;
    if (ok2) this.hits2++;
    this.sumPct += Math.abs(est - ref) / ref;
    if (!ok1) {
      const oct = octaveError(est, ref);
      this.failures.push(
        id + ': ' + est.toFixed(1) + ' vs ' + ref + (oct ? ' (' + oct + ')' : '')
      );
    }
  }

  report(): TempoReport {
    return {
      total: this.total,
      acc1: this.total ? this.hits1 / this.total : 0,
      acc2: this.total ? this.hits2 / this.total : 0,
      meanAbsPercent: this.total ? (this.sumPct / this.total) * 100 : 0,
      failures: this.failures
    };
  }
}
