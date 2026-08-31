/**
 * Tap tempo como pantalla propia.
 *
 * Es la herramienta mas vieja del oficio y la unica que funciona sin
 * microfono, sin permisos y sin cancion: el baterista marca y la app
 * mide. Superficie enorme, numero enorme, y guardar a un toque.
 */

import { useRef, useState } from 'react';
import { TapTrainer, type TapEstimate } from '../dsp/tap';
import { quartersPerPulse, subdivisionsPerPulse, type TimeSignature } from '../dsp/meter';
import { optionsFor } from '../metronome/grooves';
import { DEFAULT_PACK_ID } from '../metronome/packs';
import { useApp } from '../state/store';
import { MeterPicker } from './components';

export function TapScreen() {
  const addManual = useApp((s) => s.addManual);
  const openSong = useApp((s) => s.openSong);

  const [estimate, setEstimate] = useState<TapEstimate | null>(null);
  const [count, setCount] = useState(0);
  const [meter, setMeter] = useState<TimeSignature>({ beatsPerBar: 4, beatUnit: 4 });
  const trainer = useRef(new TapTrainer());
  const flashRef = useRef<HTMLDivElement>(null);

  const bpm = estimate ? Math.round(estimate.bpm * 10) / 10 : null;

  const tap = () => {
    // Regresion sobre TODOS los toques de la tanda (estilo BPM Tapper):
    // el error humano de cada toque se promedia hacia cero y la cifra se
    // afina cuanto mas se marca, en vez de bailar con cada toque nuevo.
    const est = trainer.current.add(performance.now());
    setEstimate(est);
    setCount(trainer.current.count);

    // Destello sin pasar por el ciclo de render: el feedback del toque
    // tiene que ser instantaneo o el tap se siente esponjoso.
    const el = flashRef.current;
    if (el) {
      el.style.opacity = '1';
      requestAnimationFrame(() => {
        el.style.transition = 'opacity 220ms ease-out';
        el.style.opacity = '0';
        setTimeout(() => (el.style.transition = ''), 240);
      });
    }
    if (navigator.vibrate) navigator.vibrate(6);
  };

  const reset = () => {
    trainer.current.reset();
    setEstimate(null);
    setCount(0);
  };

  const save = async () => {
    if (!bpm) return;
    const grooves = optionsFor(meter);
    const pulse = bpm / quartersPerPulse(meter);
    const id = await addManual({
      title: 'Tap ' + bpm.toFixed(0) + ' BPM',
      bpm,
      bpmPulse: pulse,
      bpmAlt: pulse * subdivisionsPerPulse(meter),
      meter,
      subdivision: subdivisionsPerPulse(meter) === 3 ? 'ternary' : 'binary',
      confidence: 1,
      packId: DEFAULT_PACK_ID,
      grooveId: (grooves.find((g) => !g.id.startsWith('click-')) ?? grooves[0]).id
    });
    reset();
    openSong(id);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 px-5 pt-4 pb-6">
      <button
        type="button"
        onPointerDown={tap}
        className="relative flex min-h-[46vh] flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border border-line bg-surface select-none"
      >
        <div
          ref={flashRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-signal-dim opacity-0"
        />
        {bpm === null ? (
          <>
            <span className="text-5xl" aria-hidden="true">
              👆
            </span>
            <span className="mt-4 text-sm tracking-[0.18em] text-muted uppercase">
              Toca el pulso aquí
            </span>
            {count > 0 && <span className="tabular mt-2 text-muted">{count}/3</span>}
          </>
        ) : (
          <>
            <span className="tabular text-8xl font-semibold">{bpm.toFixed(1)}</span>
            <span className="mt-1 text-sm tracking-[0.2em] text-muted uppercase">BPM ♩</span>
            <span className="tabular mt-2 text-xs text-muted">
              {count} toques · ±{estimate ? estimate.jitterMs.toFixed(0) : 0} ms de error humano
              promediado · sigue marcando para afinar
            </span>
          </>
        )}
      </button>

      <MeterPicker value={meter} onChange={setMeter} />

      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="flex-1 rounded-lg border border-line bg-surface py-3 text-sm tracking-[0.14em] text-muted uppercase"
        >
          Reiniciar
        </button>
        <button
          type="button"
          onClick={save}
          disabled={bpm === null}
          className={
            'flex-1 rounded-lg border py-3 text-sm tracking-[0.14em] uppercase ' +
            (bpm === null
              ? 'border-line-soft bg-surface text-line'
              : 'border-signal bg-signal-dim text-signal')
          }
        >
          Guardar
        </button>
      </div>
    </div>
  );
}
