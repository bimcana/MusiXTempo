/**
 * Presupuesto de tiempo real.
 *
 * El motor analiza cada `updateIntervalMs`. Si UNA pasada de analisis
 * tarda mas que ese intervalo, el worker no llega: los bloques de audio
 * siguen entrando cada ~46 ms, la cola crece sin limite y lo que se ve
 * en pantalla es de hace segundos. Se siente como lentitud, pero no lo
 * es — es una deuda que no para de crecer.
 *
 * Estas pruebas miden esa deuda y cuanto tarda la cifra en asentarse.
 */

import { describe, expect, it } from 'vitest';
import { TempoEngine } from '../src/dsp/engine';
import { HeuristicArbiter } from '../src/arbiter';
import { quartersPerPulse } from '../src/dsp/meter';
import { defaultCorpus, renderPiece } from './synth';

const SR = 44100;
const BLOCK = 2048;

interface Trace {
  /** Milisegundos de CPU por pasada de analisis. */
  analyses: number[];
  /** Milisegundos de CPU totales por segundo de audio. */
  cpuPerAudioSecond: number;
  /** Segundo de audio en el que aparece el primer numero. */
  firstResultAt: number;
  /** Segundo a partir del cual el BPM ya no se mueve mas de un 1 %. */
  settledAt: number | null;
  finalBpm: number | null;
  targetBpm: number;
}

function trace(bpm: number, updateIntervalMs: number): Trace {
  const piece = defaultCorpus().find((p) => p.bpm === bpm) ?? defaultCorpus()[0];
  // El corpus etiqueta el pulso sentido; la app muestra negras.
  const targetBpm = piece.bpm * quartersPerPulse(piece.expectedMeter);
  const audio = renderPiece(piece, { sampleRate: SR, seconds: 20, seed: 4242 });
  const engine = new TempoEngine(SR, { arbiter: new HeuristicArbiter(), updateIntervalMs });

  const analyses: number[] = [];
  const readings: { at: number; bpm: number }[] = [];
  let total = 0;

  for (let i = 0; i < audio.length; i += BLOCK) {
    const chunk = audio.subarray(i, Math.min(audio.length, i + BLOCK));
    const t0 = performance.now();
    const result = engine.push(chunk, i / SR);
    const dt = performance.now() - t0;
    total += dt;
    // Solo las pasadas caras son analisis; el resto es extraer features.
    if (dt > 1.5) analyses.push(dt);
    if (result) readings.push({ at: i / SR, bpm: result.bpm });
  }

  const audioSeconds = audio.length / SR;
  const finalBpm = readings.length ? readings[readings.length - 1].bpm : null;

  let settledAt: number | null = null;
  if (finalBpm) {
    for (let i = 0; i < readings.length; i++) {
      if (readings.slice(i).every((r) => Math.abs(r.bpm - finalBpm) / finalBpm <= 0.01)) {
        settledAt = readings[i].at;
        break;
      }
    }
  }

  return {
    analyses,
    cpuPerAudioSecond: total / audioSeconds,
    firstResultAt: readings.length ? readings[0].at : Infinity,
    settledAt,
    finalBpm,
    targetBpm
  };
}

function report(label: string, t: Trace, budgetMs: number): void {
  const sorted = [...t.analyses].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '=== ' + label + ' ===',
      '  Analisis           ' + t.analyses.length,
      '  CPU por pasada     p50 ' + p50.toFixed(1) + ' ms · p95 ' + p95.toFixed(1) + ' ms · max ' + worst.toFixed(1) + ' ms',
      '  Presupuesto        ' + budgetMs + ' ms   -> ' + (p95 <= budgetMs ? 'DENTRO' : 'EXCEDIDO x' + (p95 / budgetMs).toFixed(1)),
      '  CPU / s de audio   ' + t.cpuPerAudioSecond.toFixed(1) + ' ms  (' + ((t.cpuPerAudioSecond / 1000) * 100).toFixed(1) + ' % de un nucleo)',
      '  Primer numero      ' + t.firstResultAt.toFixed(2) + ' s',
      '  Se asienta         ' + (t.settledAt === null ? 'nunca' : t.settledAt.toFixed(2) + ' s'),
      '  Final              ' + (t.finalBpm?.toFixed(1) ?? '—') + ' vs ' + t.targetBpm
    ].join('\n')
  );
}

describe('presupuesto de tiempo real', () => {
  it('una pasada de analisis cabe en su propio intervalo', () => {
    const t = trace(120, 250);
    report('120 BPM · intervalo 250 ms', t, 250);

    const sorted = [...t.analyses].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

    // Si el p95 se acerca al intervalo, el worker acumula retraso en
    // cuanto la maquina esta ocupada con cualquier otra cosa.
    expect(p95).toBeLessThan(250 * 0.5);
  });

  it('el coste total deja el hilo libre para el resto de la app', () => {
    const t = trace(96, 250);
    report('96 BPM · coste total', t, 250);
    // Menos del 25 % de un nucleo por segundo de audio.
    expect(t.cpuPerAudioSecond).toBeLessThan(250);
  });

  it('la cifra se asienta pronto y no sigue bailando', () => {
    const t = trace(132, 250);
    report('132 BPM · convergencia', t, 250);
    expect(t.firstResultAt).toBeLessThan(3);
    expect(t.settledAt).not.toBeNull();
    expect(t.settledAt!).toBeLessThan(10);
  });
});
