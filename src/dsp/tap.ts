/**
 * Tap tempo por regresion. Codigo PURO.
 *
 * El tap clasico promedia los ultimos intervalos, y por eso baila: cada
 * toque nuevo pesa igual que toda la historia. Aqui se hace lo que hace
 * BPM Tapper y lo mismo que el motor hace con los beats detectados:
 * ajustar UNA recta por minimos cuadrados a todos los toques de la
 * tanda. El error humano de cada toque (+-30 ms tipicos) se promedia
 * hacia cero, y la precision MEJORA cuanto mas marcas — con 16 toques
 * el error del promedio baja a unos pocos milisegundos.
 *
 * Detalles que lo hacen robusto de verdad:
 *  - Los indices se asignan por redondeo contra el periodo estimado:
 *    saltarse un pulso (marcar 1 de cada 2) no rompe nada.
 *  - Un toque atipico (residuo > 30 % del periodo) queda fuera del
 *    ajuste pero no lo descarrila.
 *  - Una pausa larga arranca tanda nueva.
 */

export interface TapEstimate {
  bpm: number;
  /** Toques de la tanda actual. */
  count: number;
  /** Error tipico de cada toque respecto a la recta, en ms. */
  jitterMs: number;
  /** 0..1: cuanto confiar en la cifra (crece con toques y regularidad). */
  quality: number;
}

const MAX_TAPS = 96;

export class TapTrainer {
  private times: number[] = [];
  private period = 0;

  /** Anade un toque (ms, reloj monotono) y devuelve la estimacion. */
  add(tMs: number): TapEstimate | null {
    const list = this.times;

    if (list.length > 0) {
      const gap = tMs - list[list.length - 1];
      // Pausa larga = tanda nueva. El umbral se adapta al tempo: a 40
      // BPM un pulso dura 1.5 s y no es una pausa.
      const limit = Math.max(2000, this.period * 2.6);
      if (gap > limit) this.reset();
    }

    this.times.push(tMs);
    if (this.times.length > MAX_TAPS) this.times.shift();

    return this.estimate();
  }

  reset(): void {
    this.times = [];
    this.period = 0;
  }

  get count(): number {
    return this.times.length;
  }

  estimate(): TapEstimate | null {
    const t = this.times;
    if (t.length < 2) return null;

    if (t.length === 2) {
      const period = t[1] - t[0];
      if (period < 150 || period > 3000) return null;
      this.period = period;
      return { bpm: 60000 / period, count: 2, jitterMs: 0, quality: 0.2 };
    }

    // Periodo de arranque: mediana de los intervalos, inmune a un toque
    // suelto mal dado.
    const intervals: number[] = [];
    for (let i = 1; i < t.length; i++) intervals.push(t[i] - t[i - 1]);
    intervals.sort((a, b) => a - b);
    let period = this.period || intervals[intervals.length >> 1];
    if (period < 150 || period > 3000) period = intervals[intervals.length >> 1];

    // Dos pasadas: ajustar, echar atipicos, reajustar.
    for (let pass = 0; pass < 2; pass++) {
      let n = 0;
      let sk = 0;
      let st = 0;
      let skk = 0;
      let skt = 0;
      const t0 = t[0];

      for (let i = 0; i < t.length; i++) {
        // Indice por redondeo: marcar 1 de cada 2 pulsos da indices
        // 0,2,4... y la pendiente sigue siendo el periodo del pulso.
        const k = Math.round((t[i] - t0) / period);
        if (pass === 1) {
          const predicted = t0 + k * period;
          if (Math.abs(t[i] - predicted) > period * 0.3) continue;
        }
        n++;
        sk += k;
        st += t[i];
        skk += k * k;
        skt += k * t[i];
      }

      if (n < 3) break;
      const denom = n * skk - sk * sk;
      if (Math.abs(denom) < 1e-9) break;
      const slope = (n * skt - sk * st) / denom;
      if (slope > 150 && slope < 3000) period = slope;
    }

    this.period = period;

    // Jitter: rms de los residuos de los toques aceptados.
    const t0 = t[0];
    let sse = 0;
    let kept = 0;
    let interceptSum = 0;
    for (let i = 0; i < t.length; i++) {
      const k = Math.round((t[i] - t0) / period);
      const r = t[i] - (t0 + k * period);
      if (Math.abs(r) > period * 0.3) continue;
      interceptSum += r;
      kept++;
    }
    const intercept = kept > 0 ? interceptSum / kept : 0;
    for (let i = 0; i < t.length; i++) {
      const k = Math.round((t[i] - t0) / period);
      const r = t[i] - (t0 + intercept + k * period);
      if (Math.abs(r) > period * 0.3) continue;
      sse += r * r;
    }
    const jitterMs = kept > 1 ? Math.sqrt(sse / kept) : 0;

    // Calidad: crece con los toques (hasta ~12) y cae con el jitter
    // relativo. Un tap humano decente ronda el 3-5 % del periodo.
    const countFactor = Math.min(1, kept / 12);
    const jitterFactor = Math.max(0, 1 - (jitterMs / period) * 8);
    return {
      bpm: 60000 / period,
      count: t.length,
      jitterMs: Math.round(jitterMs * 10) / 10,
      quality: Math.max(0.05, countFactor * jitterFactor)
    };
  }
}
