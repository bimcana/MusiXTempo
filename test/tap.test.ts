/**
 * TapTrainer: el promedio por regresion tiene que hacer exactamente lo
 * prometido — que el error humano se promedie hacia cero y que la
 * precision MEJORE cuanto mas se marca.
 */

import { describe, expect, it } from 'vitest';
import { TapTrainer } from '../src/dsp/tap';
import { TempoEngine } from '../src/dsp/engine';
import { HeuristicArbiter } from '../src/arbiter';
import { makePiece, PATTERNS, renderPiece, makeRng } from './synth';

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe('TapTrainer', () => {
  it('promedia el error humano: con 20 toques clava 120 a pesar de +-25 ms', () => {
    const rng = makeRng(42);
    const trainer = new TapTrainer();
    const period = 500; // 120 BPM
    let estimate = null;
    for (let i = 0; i < 20; i++) {
      estimate = trainer.add(1000 + i * period + gaussian(rng) * 25);
    }
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.bpm - 120)).toBeLessThan(1.2);
    expect(estimate!.quality).toBeGreaterThan(0.5);
  });

  it('la precision mejora con mas toques', () => {
    // Misma semilla de jitter, dos longitudes de tanda: el error del
    // promedio con 24 toques debe ser menor que con 5.
    const runs = [5, 24].map((count) => {
      const rng = makeRng(777);
      const trainer = new TapTrainer();
      let est = null;
      for (let i = 0; i < count; i++) {
        est = trainer.add(500 + i * 400 + gaussian(rng) * 30);
      }
      return Math.abs(est!.bpm - 150);
    });
    expect(runs[1]).toBeLessThanOrEqual(runs[0]);
    expect(runs[1]).toBeLessThan(1.5);
  });

  it('un toque atipico no descarrila la cifra', () => {
    const trainer = new TapTrainer();
    let estimate = null;
    for (let i = 0; i < 12; i++) {
      // El toque 6 llega 180 ms tarde: un tropiezo humano tipico.
      const late = i === 6 ? 180 : 0;
      estimate = trainer.add(1000 + i * 500 + late);
    }
    expect(Math.abs(estimate!.bpm - 120)).toBeLessThan(2);
  });

  it('marcar un pulso de cada dos sigue midiendo el pulso, no la mitad', () => {
    const trainer = new TapTrainer();
    let estimate = null;
    // Arranque a pulso completo para fijar el periodo...
    for (let i = 0; i < 4; i++) estimate = trainer.add(1000 + i * 500);
    // ...y luego el usuario se salta pulsos alternos.
    for (let i = 6; i < 16; i += 2) estimate = trainer.add(1000 + i * 500);
    expect(Math.abs(estimate!.bpm - 120)).toBeLessThan(1.5);
  });

  it('una pausa larga arranca tanda nueva', () => {
    const trainer = new TapTrainer();
    for (let i = 0; i < 6; i++) trainer.add(1000 + i * 500);
    trainer.add(20000);
    expect(trainer.count).toBe(1);
  });
});

describe('prior de tap en el motor', () => {
  it('el tap del usuario corrige un error de octava conocido', () => {
    // sparse68 a 58 de pulso sin armonia: el corpus documenta que el
    // motor lo lee al doble. Con el usuario marcando 58, tiene que caer
    // al nivel correcto: 87 negras (58 x 1.5 en compas compuesto).
    const piece = makePiece('sparse68-58', 58, 2, 'ternary', PATTERNS.sparse68);
    const audio = renderPiece(piece, {
      sampleRate: 44100,
      seconds: 16,
      humanizeSec: 0.006,
      noise: 0.004,
      reverb: 0.12,
      bass: false,
      seed: hash('sparse68-58seco')
    });

    const run = (withTap: boolean) => {
      const engine = new TempoEngine(44100, {
        arbiter: new HeuristicArbiter(),
        updateIntervalMs: 500
      });
      const block = 4096;
      for (let i = 0; i < audio.length; i += block) {
        const t = i / 44100;
        // El usuario empieza a marcar a los 4 s, como haria en la app.
        if (withTap && t > 4 && t < 4.2) engine.setTapReference(58, 0.8);
        if (withTap && t > 8 && t < 8.2) engine.setTapReference(58, 0.9);
        engine.push(audio.subarray(i, Math.min(audio.length, i + block)), t);
      }
      return engine.latest;
    };

    const sinTap = run(false);
    const conTap = run(true);

    // eslint-disable-next-line no-console
    console.log(
      '  sin tap: ' + sinTap?.bpm.toFixed(1) + ' ♩ · con tap(58): ' + conTap?.bpm.toFixed(1) + ' ♩'
    );

    expect(conTap).not.toBeNull();
    // 58 de pulso ternario agrupado en 2 → 87 negras.
    expect(Math.abs(conTap!.bpm - 87)).toBeLessThan(87 * 0.05);
  });

  it('el prior dirige de verdad: marcar otro nivel mueve al motor a ese nivel', () => {
    // La prueba de que el empujon tiene fuerza: el mismo audio, pero el
    // usuario marca las corcheas agrupadas de a dos (116) en vez del
    // pulso sentido (58). El motor debe seguirle al nivel marcado — el
    // tap manda sobre la ambiguedad de octava, que para eso existe.
    const piece = makePiece('sparse68-58', 58, 2, 'ternary', PATTERNS.sparse68);
    const audio = renderPiece(piece, {
      sampleRate: 44100,
      seconds: 16,
      humanizeSec: 0.006,
      noise: 0.004,
      reverb: 0.12,
      bass: false,
      seed: hash('sparse68-58seco')
    });

    const engine = new TempoEngine(44100, {
      arbiter: new HeuristicArbiter(),
      updateIntervalMs: 500
    });
    const block = 4096;
    for (let i = 0; i < audio.length; i += block) {
      const t = i / 44100;
      if (t > 4 && t < 4.2) engine.setTapReference(116, 0.9);
      if (t > 8 && t < 8.2) engine.setTapReference(116, 0.9);
      if (t > 12 && t < 12.2) engine.setTapReference(116, 0.9);
      engine.push(audio.subarray(i, Math.min(audio.length, i + block)), t);
    }
    const result = engine.latest;
    // eslint-disable-next-line no-console
    console.log('  marcando 116: pulso detectado ' + result?.bpmPulse.toFixed(1));
    expect(result).not.toBeNull();
    expect(Math.abs(result!.bpmPulse - 116)).toBeLessThan(116 * 0.06);
  });
});

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
