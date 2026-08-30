/**
 * El corpus. Aqui se mide si el motor es preciso, en vez de opinarlo.
 *
 * Los umbrales de abajo son un contrato de regresion: un cambio que los
 * baje rompe la build. Sin esto, "mejorar la precision" es una opinion.
 */

import { describe, expect, it } from 'vitest';
import { analyzeBuffer } from '../src/dsp/engine';
import { HeuristicArbiter } from '../src/arbiter';
import { MeterConfusion, TempoScorer } from './metrics';
import {
  defaultCorpus,
  hummingCorpus,
  makePiece,
  PATTERNS,
  renderHumming,
  renderPiece
} from './synth';

const SR = 44100;
const engineOpts = () => ({ arbiter: new HeuristicArbiter(), updateIntervalMs: 500 });

/**
 * Umbrales fijados justo por debajo de lo que el motor logra hoy: dejan
 * margen para el ruido del renderizado, pero cualquier regresion real
 * los cruza y rompe la build.
 *
 * Nota sobre `drumsOnlyMeter`, deliberadamente bajo: con bombo identico
 * en los tiempos 1 y 3 y sin nada armonico, un 4/4 y un 2/4 suenan
 * igual. Leerlo como 2/4 no es un fallo del motor, es la lectura honesta
 * del audio — y subir este umbral solo le ensenaria a adivinar.
 */
const THRESHOLDS = {
  acc1: 0.93,
  acc2: 0.98,
  meterAccuracy: 0.85,
  recall68: 0.9,
  recall44: 0.7,
  drumsOnlyAcc1: 0.9,
  drumsOnlyMeter: 0.4,
  drumsOnlyRecall68: 0.8,
  hostileAcc2: 0.95,
  hummingAcc1: 0.6,
  hummingAcc2: 0.95
};

describe('corpus sintetico', () => {
  it('acierta tempo y metrica en material completo', () => {
    const pieces = defaultCorpus();
    const tempo = new TempoScorer();
    const meters = new MeterConfusion();

    for (const piece of pieces) {
      const audio = renderPiece(piece, {
        sampleRate: SR,
        seconds: 14,
        humanizeSec: 0.006,
        noise: 0.004,
        reverb: 0.12,
        bass: true,
        seed: hash(piece.id)
      });
      const result = analyzeBuffer(audio, SR, engineOpts());
      tempo.add(piece.id, result?.bpm ?? null, piece.bpm);
      meters.add(piece.expectedMeter, result?.meter ?? null);
    }

    const report = tempo.report();
    printReport('completo', report, meters);

    expect(report.acc1).toBeGreaterThanOrEqual(THRESHOLDS.acc1);
    expect(report.acc2).toBeGreaterThanOrEqual(THRESHOLDS.acc2);
    expect(meters.accuracy).toBeGreaterThanOrEqual(THRESHOLDS.meterAccuracy);
    expect(meters.recall('6/8')).toBeGreaterThanOrEqual(THRESHOLDS.recall68);
    expect(meters.recall('4/4')).toBeGreaterThanOrEqual(THRESHOLDS.recall44);
  });

  it('no depende de la armonia: solo bateria, sin bajo', () => {
    const pieces = defaultCorpus();
    const tempo = new TempoScorer();
    const meters = new MeterConfusion();

    for (const piece of pieces) {
      const audio = renderPiece(piece, {
        sampleRate: SR,
        seconds: 14,
        humanizeSec: 0.006,
        noise: 0.004,
        reverb: 0.12,
        bass: false,
        seed: hash(piece.id + 'seco')
      });
      const result = analyzeBuffer(audio, SR, engineOpts());
      tempo.add(piece.id, result?.bpm ?? null, piece.bpm);
      meters.add(piece.expectedMeter, result?.meter ?? null);
    }

    const report = tempo.report();
    printReport('solo bateria', report, meters);
    expect(report.acc1).toBeGreaterThanOrEqual(THRESHOLDS.drumsOnlyAcc1);
    expect(meters.accuracy).toBeGreaterThanOrEqual(THRESHOLDS.drumsOnlyMeter);
    // El ternario si debe sobrevivir sin armonia: sale del propio patron
    // de charles, no del bajo.
    expect(meters.recall('6/8')).toBeGreaterThanOrEqual(THRESHOLDS.drumsOnlyRecall68);
  });

  it('aguanta condiciones de sala hostiles', () => {
    const pieces = defaultCorpus().filter((_, i) => i % 3 === 0);
    const tempo = new TempoScorer();

    for (const piece of pieces) {
      const audio = renderPiece(piece, {
        sampleRate: SR,
        seconds: 14,
        humanizeSec: 0.018, // baterista impreciso
        drift: 0.03, // acelera un 3 % a lo largo de la toma
        noise: 0.02, // sala ruidosa
        reverb: 0.32, // sala viva
        gain: 0.98, // al borde del recorte
        seed: hash(piece.id + 'hostil')
      });
      const result = analyzeBuffer(audio, SR, engineOpts());
      tempo.add(piece.id, result?.bpm ?? null, piece.bpm);
    }

    const report = tempo.report();
    printReport('sala hostil', report, null);
    // Con deriva de tempo real el "tempo correcto" ya no es un unico
    // numero, asi que aqui manda Accuracy 2.
    expect(report.acc2).toBeGreaterThanOrEqual(THRESHOLDS.hostileAcc2);
  });

  it('detecta el pulso de un tarareo, sin un solo ataque percusivo', () => {
    const specs = hummingCorpus();
    const tempo = new TempoScorer();

    for (const spec of specs) {
      const audio = renderHumming(spec, {
        sampleRate: SR,
        seconds: 16,
        humanizeSec: 0.014,
        noise: 0.005,
        seed: hash(spec.id)
      });
      const result = analyzeBuffer(audio, SR, engineOpts());
      tempo.add(spec.id, result?.bpm ?? null, spec.bpm);
    }

    const report = tempo.report();
    printReport('tarareo', report, null);
    expect(report.acc1).toBeGreaterThanOrEqual(THRESHOLDS.hummingAcc1);
    expect(report.acc2).toBeGreaterThanOrEqual(THRESHOLDS.hummingAcc2);
  });

  it('separa 6/8 de 4/4 con swing, que es el caso duro', () => {
    // Los dos son ternarios. Solo los distingue la agrupacion: 2 contra 4.
    const pieces = [
      makePiece('duro-68-64', 64, 2, 'ternary', PATTERNS.ballad68),
      makePiece('duro-68-72', 72, 2, 'ternary', PATTERNS.ballad68),
      makePiece('duro-68-84', 84, 2, 'ternary', PATTERNS.ballad68),
      makePiece('duro-shuffle-88', 88, 4, 'ternary', PATTERNS.shuffle44),
      makePiece('duro-shuffle-104', 104, 4, 'ternary', PATTERNS.shuffle44),
      makePiece('duro-blues-92', 92, 4, 'ternary', PATTERNS.blues128)
    ];

    const meters = new MeterConfusion();
    let ternaryHits = 0;
    const rows: string[] = [];

    for (const piece of pieces) {
      const audio = renderPiece(piece, {
        sampleRate: SR,
        seconds: 16,
        humanizeSec: 0.008,
        noise: 0.005,
        bass: true,
        seed: hash(piece.id)
      });
      const result = analyzeBuffer(audio, SR, engineOpts());
      meters.add(piece.expectedMeter, result?.meter ?? null);
      if (result?.subdivision === 'ternary') ternaryHits++;
      rows.push(
        '  ' +
          piece.id.padEnd(20) +
          'esperado ' +
          (piece.expectedMeter.beatsPerBar + '/' + piece.expectedMeter.beatUnit).padEnd(6) +
          '@' +
          String(piece.bpm).padEnd(5) +
          '->  ' +
          (result ? result.meterLabel.padEnd(22) + '@' + result.bpm.toFixed(1) : 'sin resultado')
      );
    }

    log(
      '\n=== 6/8 contra shuffle ===\n' +
        rows.join('\n') +
        '\n  ternario detectado en ' +
        ternaryHits +
        '/' +
        pieces.length +
        '\n' +
        meters.toTable()
    );

    // Lo primero es no confundir ternario con binario.
    expect(ternaryHits).toBe(pieces.length);
    // Y despues, acertar la agrupacion en la mayoria.
    expect(meters.accuracy).toBeGreaterThanOrEqual(0.83);
  });
});

function printReport(
  label: string,
  report: ReturnType<TempoScorer['report']>,
  meters: MeterConfusion | null
): void {
  const lines = [
    '',
    '=== ' + label + ' (' + report.total + ' piezas) ===',
    '  Accuracy 1      ' + (report.acc1 * 100).toFixed(1) + ' %',
    '  Accuracy 2      ' + (report.acc2 * 100).toFixed(1) + ' %',
    '  Error medio     ' + report.meanAbsPercent.toFixed(2) + ' %'
  ];
  if (meters) {
    lines.push('  Metrica exacta  ' + (meters.accuracy * 100).toFixed(1) + ' %');
    lines.push('  Recall 6/8      ' + (meters.recall('6/8') * 100).toFixed(1) + ' %');
    lines.push('  Recall 4/4      ' + (meters.recall('4/4') * 100).toFixed(1) + ' %');
    lines.push(meters.toTable());
  }
  if (report.failures.length) {
    lines.push('  Fallos de Accuracy 1:');
    for (const f of report.failures) lines.push('    - ' + f);
  }
  log(lines.join('\n'));
}

function log(s: string): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
