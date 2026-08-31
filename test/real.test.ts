/**
 * Fixtures REALES: grabaciones de canciones de verdad, anotadas a mano.
 *
 * El corpus sintetico mide el mecanismo; esto mide el mundo. Un motor
 * que puntua 100 % en sintetico y falla aqui esta sobreajustado a su
 * propio generador — que es exactamente lo que destapo la grabacion de
 * Chrome del 30-08-2026.
 *
 * Los WAV no van al repositorio (gitignore). Cada test se salta si su
 * fixture no esta, y el manifiesto de abajo documenta que audio es y
 * que se espera de el.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TempoEngine, type DetectionResult } from '../src/dsp/engine';
import { HeuristicArbiter } from '../src/arbiter';
import { accuracy2 } from './metrics';
import { readWav } from './wavread';

const FIXTURES = join(__dirname, 'fixtures', 'real');

interface RealFixture {
  file: string;
  /** Negras por minuto, como lo muestra la app. */
  quarterBpm: number;
  /** Tolerancia relativa: canciones reales no van a click perfecto. */
  tolerance: number;
  meter: string;
  notes: string;
}

const MANIFEST: RealFixture[] = [
  {
    file: 'chrome-68-200-48k.wav',
    quarterBpm: 200,
    tolerance: 0.05,
    meter: '6/8',
    notes: 'El mismo audio a 48 kHz, la frecuencia tipica del microfono en Windows.'
  },
  {
    file: 'chrome-68-200-room.wav',
    quarterBpm: 200,
    tolerance: 0.05,
    meter: '6/8',
    notes:
      'Simulacion del camino altavoces-sala-microfono: recorte de graves, eco corto, ' +
      'compresion y limitador. Reproduce las condiciones de la sesion en vivo.'
  },
  {
    file: 'chrome-68-200.wav',
    quarterBpm: 200,
    tolerance: 0.05,
    meter: '6/8',
    notes:
      'Grabacion de pantalla de Chrome (30-08-2026): cancion en 6/8 a ~200 negras. ' +
      'La app en vivo mostro 57.9·2/4, 110.8·3/4 y 125.3·6/8 — el caso que motivo la reescritura.'
  }
];

interface Reading {
  at: number;
  bpm: number;
  meter: string;
  stage: string;
  beats: number;
}

function runTimeline(samples: Float32Array, sampleRate: number): Reading[] {
  const engine = new TempoEngine(sampleRate, {
    arbiter: new HeuristicArbiter(),
    updateIntervalMs: 250
  });
  const readings: Reading[] = [];
  const block = 2048;
  for (let i = 0; i < samples.length; i += block) {
    const chunk = samples.subarray(i, Math.min(samples.length, i + block));
    const result: DetectionResult | null = engine.push(chunk, i / sampleRate);
    if (result) {
      readings.push({
        at: i / sampleRate,
        bpm: result.bpm,
        meter: result.meter.beatsPerBar + '/' + result.meter.beatUnit,
        stage: result.stage,
        beats: result.beatsCounted
      });
    }
  }
  return readings;
}

function printTimeline(label: string, readings: Reading[]): void {
  const lines = ['', '=== ' + label + ' ==='];
  // Una linea por segundo, para leer la trayectoria de un vistazo.
  let lastSecond = -1;
  for (const r of readings) {
    const second = Math.floor(r.at);
    if (second === lastSecond) continue;
    lastSecond = second;
    lines.push(
      '  ' +
        r.at.toFixed(1).padStart(5) +
        ' s   ' +
        r.bpm.toFixed(1).padStart(6) +
        ' ♩  ' +
        r.meter.padEnd(5) +
        r.stage.padEnd(12) +
        r.beats + ' beats'
    );
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

describe('recuperacion tras un cambio de tempo', () => {
  // Reproduce el patron de la sesion en vivo del 30-08: el motor llego
  // ENGANCHADO a un pulso de ~84 (los fotogramas lo muestran) y el
  // estribillo real a pulso 133 no lograba desalojarlo. Aqui: 14 s del
  // mismo audio ralentizado a 0.63x (pulso ~84) y de golpe el audio
  // real. El motor tiene que soltar la hipotesis vieja y reengancharse.
  const lead = join(FIXTURES, 'chrome-68-200-slowlead.wav');
  const chorus = join(FIXTURES, 'chrome-68-200-48k.wav');

  it.skipIf(!existsSync(lead) || !existsSync(chorus))('suelta un lock viejo en pocos segundos', () => {
    const a = readWav(lead);
    const b = readWav(chorus);
    expect(a.sampleRate).toBe(b.sampleRate);
    const samples = new Float32Array(a.samples.length + b.samples.length);
    samples.set(a.samples, 0);
    samples.set(b.samples, a.samples.length);
    const changeAt = a.samples.length / a.sampleRate;

    const readings = runTimeline(samples, a.sampleRate);
    printTimeline('slowlead(0.63x) + estribillo — cambio en ' + changeAt.toFixed(1) + ' s', readings);

    // Cuanto tardo, tras el cambio, en dar 200 +-5 % de forma sostenida.
    const target = 200;
    let recoveredAt: number | null = null;
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (r.at < changeAt) continue;
      const rest = readings.slice(i);
      if (rest.every((x) => Math.abs(x.bpm - target) / target <= 0.05)) {
        recoveredAt = r.at;
        break;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      '  recuperado ' +
        (recoveredAt === null ? 'NUNCA' : 'a los ' + (recoveredAt - changeAt).toFixed(1) + ' s del cambio')
    );

    expect(recoveredAt).not.toBeNull();
    // 2.3 s medidos hoy; 5 deja margen sin permitir otra regresion a
    // la deriva de un minuto de la sesion del 30-08.
    expect(recoveredAt! - changeAt).toBeLessThanOrEqual(5);
    expect(readings[readings.length - 1].meter).toBe('6/8');
  });
});

describe('fixtures reales', () => {
  for (const fixture of MANIFEST) {
    const path = join(FIXTURES, fixture.file);
    const exists = existsSync(path);

    it.skipIf(!exists)(fixture.file + ' → ' + fixture.quarterBpm + ' ♩ en ' + fixture.meter, () => {
      const wav = readWav(path);
      const readings = runTimeline(wav.samples, wav.sampleRate);
      printTimeline(
        fixture.file + ' (' + wav.seconds.toFixed(1) + ' s) — esperado ' + fixture.quarterBpm + ' ♩ ' + fixture.meter,
        readings
      );

      expect(readings.length).toBeGreaterThan(4);
      const final = readings[readings.length - 1];

      // El criterio principal: la cifra FINAL en el nivel correcto.
      const rel = Math.abs(final.bpm - fixture.quarterBpm) / fixture.quarterBpm;
      // eslint-disable-next-line no-console
      console.log(
        '  final ' + final.bpm.toFixed(1) + ' ♩ ' + final.meter +
        '  (error ' + (rel * 100).toFixed(1) + ' %, metrica esperada ' + fixture.meter + ')'
      );

      expect(rel).toBeLessThanOrEqual(fixture.tolerance);
      expect(final.meter).toBe(fixture.meter);
      // Y sin errores de octava por el camino final: la segunda mitad de
      // la escucha debe mantenerse en el mismo nivel metrico.
      const half = readings.slice(Math.floor(readings.length / 2));
      const stable = half.every((r) => accuracy2(r.bpm, fixture.quarterBpm, 0.08));
      expect(stable).toBe(true);
    });
  }
});
