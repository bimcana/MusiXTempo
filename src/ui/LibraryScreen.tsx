/**
 * Biblioteca: lo detectado y lo dado de alta a mano, todo local.
 */

import { useEffect, useState } from 'react';
import { formatTimeSignature, meterLabel, subdivisionsPerPulse, type TimeSignature } from '../dsp/meter';
import { optionsFor } from '../metronome/grooves';
import { DEFAULT_PACK_ID } from '../metronome/packs';
import { useApp } from '../state/store';
import { MeterPicker, TapTempo } from './components';

export function LibraryScreen() {
  const songs = useApp((s) => s.songs);
  const loaded = useApp((s) => s.loaded);
  const loadLibrary = useApp((s) => s.loadLibrary);
  const openSong = useApp((s) => s.openSong);
  const removeSong = useApp((s) => s.removeSong);
  const go = useApp((s) => s.go);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!loaded) void loadLibrary();
  }, [loaded, loadLibrary]);

  if (adding) return <ManualForm onDone={() => setAdding(false)} />;

  return (
    <div className="flex min-h-full flex-col gap-4 px-5 pt-2 pb-8">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Biblioteca</h1>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-lg border border-signal bg-signal-dim px-4 py-2 text-sm text-signal"
        >
          + Añadir
        </button>
      </header>

      {songs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="max-w-xs text-muted">
            Todavía no hay nada. Detecta una canción o añádela a mano.
          </p>
          <button
            type="button"
            onClick={() => go('listen')}
            className="rounded-lg border border-line bg-surface px-5 py-2.5 text-sm"
          >
            Ir a escuchar
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {songs.map((song) => (
            <li key={song.id}>
              <div className="flex items-stretch gap-2">
                <button
                  type="button"
                  onClick={() => openSong(song.id)}
                  className="flex flex-1 items-center justify-between rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors active:border-signal"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{song.title}</span>
                    <span className="text-xs text-muted">
                      {song.source === 'manual' ? 'A mano' : 'Detectada'}
                      {song.source === 'detected' &&
                        ' · ' + Math.round(song.confidence * 100) + ' % confianza'}
                    </span>
                  </span>
                  <span className="ml-3 shrink-0 text-right">
                    <span className="tabular block text-xl font-semibold">
                      {song.bpm.toFixed(1)}
                    </span>
                    <span className="text-xs text-signal">{meterLabel(song.meter)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void removeSong(song.id)}
                  aria-label={'Borrar ' + song.title}
                  className="w-12 shrink-0 rounded-lg border border-line bg-surface text-muted active:border-danger active:text-danger"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ManualForm({ onDone }: { onDone: () => void }) {
  const addManual = useApp((s) => s.addManual);
  const openSong = useApp((s) => s.openSong);

  const [title, setTitle] = useState('');
  const [bpm, setBpm] = useState(120);
  const [meter, setMeter] = useState<TimeSignature>({ beatsPerBar: 4, beatUnit: 4 });

  const compound = subdivisionsPerPulse(meter) === 3;

  const submit = async () => {
    const grooves = optionsFor(meter);
    const id = await addManual({
      title: title.trim() || 'Sin título',
      bpm,
      bpmAlt: bpm * subdivisionsPerPulse(meter),
      meter,
      subdivision: compound ? 'ternary' : 'binary',
      confidence: 1,
      packId: DEFAULT_PACK_ID,
      grooveId: (grooves.find((g) => !g.id.startsWith('click-')) ?? grooves[0]).id
    });
    onDone();
    openSong(id);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 px-5 pt-2 pb-8">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted"
        >
          ← Volver
        </button>
        <h1 className="text-lg font-semibold">Añadir a mano</h1>
      </header>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Título"
        className="w-full rounded-lg border border-line bg-surface px-4 py-3 outline-none placeholder:text-muted focus:border-signal"
      />

      <div className="flex flex-col items-center gap-2">
        <div className="flex items-baseline gap-3">
          <span className="tabular text-5xl font-semibold">{bpm.toFixed(1)}</span>
          <span className="text-sm tracking-[0.18em] text-muted uppercase">BPM</span>
        </div>
        {compound && (
          <span className="tabular text-sm text-muted">
            = {(bpm * 3).toFixed(1)} corcheas · {formatTimeSignature(meter)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setBpm((v) => Math.max(20, v - 1))}
          className="h-11 w-11 shrink-0 rounded-lg border border-line bg-surface text-xl"
        >
          −
        </button>
        <input
          type="range"
          min={30}
          max={260}
          step={0.5}
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          className="h-11 flex-1 accent-[#f5b33f]"
          aria-label="Tempo"
        />
        <button
          type="button"
          onClick={() => setBpm((v) => Math.min(400, v + 1))}
          className="h-11 w-11 shrink-0 rounded-lg border border-line bg-surface text-xl"
        >
          +
        </button>
      </div>

      <TapTempo onTempo={(value) => setBpm(Math.round(value * 10) / 10)} />

      <MeterPicker value={meter} onChange={setMeter} />

      <button
        type="button"
        onClick={submit}
        className="mt-auto w-full rounded-lg border border-signal bg-signal-dim py-3.5 text-sm tracking-[0.14em] text-signal uppercase"
      >
        Guardar
      </button>
    </div>
  );
}
