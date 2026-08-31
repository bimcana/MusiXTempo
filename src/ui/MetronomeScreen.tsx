/**
 * Metronomo de una cancion guardada.
 *
 * Modos mutuamente excluyentes: aqui solo suena, nunca escucha. Eso
 * elimina de raiz la realimentacion del propio click y la compensacion
 * de latencia contra la sala.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pulsesPerBar, quartersPerPulse, subdivisionsPerPulse } from '../dsp/meter';
import { optionsFor } from '../metronome/grooves';
import { PACKS } from '../metronome/packs';
import { Metronome } from '../metronome/scheduler';
import { isIos } from '../audio/ios-unlock';
import { useApp } from '../state/store';
import type { Song } from '../data/db';
import { PulseCanvas, Segmented, StepGrid, TapTempo, type PulseState } from './components';

export function MetronomeScreen({ song }: { song: Song }) {
  const updateSong = useApp((s) => s.updateSong);
  const go = useApp((s) => s.go);

  const [bpm, setBpm] = useState(song.bpm);
  const [grooveId, setGrooveId] = useState(song.grooveId);
  const [packId, setPackId] = useState(song.packId);
  const [volume, setVolume] = useState(0.8);
  const [running, setRunning] = useState(false);

  const metronomeRef = useRef<Metronome | null>(null);
  if (!metronomeRef.current) {
    metronomeRef.current = new Metronome(song.meter, song.grooveId, song.packId);
  }
  const metronome = metronomeRef.current;

  const grooves = useMemo(() => optionsFor(song.meter), [song.meter]);
  const groove = useMemo(
    () => grooves.find((g) => g.id === grooveId) ?? grooves[0],
    [grooves, grooveId]
  );

  // El usuario ve y edita NEGRAS; el scheduler necesita el pulso
  // sentido, que en compas compuesto no es lo mismo.
  const quartersPer = quartersPerPulse(song.meter);
  const pulseBpm = bpm / quartersPer;

  useEffect(() => () => metronome.dispose(), [metronome]);
  useEffect(() => metronome.setTempo(pulseBpm), [metronome, pulseBpm]);
  useEffect(() => metronome.setVolume(volume), [metronome, volume]);
  useEffect(() => metronome.setGroove(grooveId), [metronome, grooveId]);
  useEffect(() => metronome.setPack(packId), [metronome, packId]);

  const toggle = async () => {
    if (running) {
      metronome.stop();
      setRunning(false);
    } else {
      await metronome.start();
      setRunning(true);
    }
  };

  // Persistir los ajustes solo al salir: guardar en cada toque del
  // deslizador escribiria en IndexedDB decenas de veces por segundo.
  const persist = useCallback(() => {
    if (bpm !== song.bpm || grooveId !== song.grooveId || packId !== song.packId) {
      void updateSong({ ...song, bpm, grooveId, packId });
    }
  }, [bpm, grooveId, packId, song, updateSong]);

  // La referencia se actualiza en cada render, pero el efecto se
  // registra UNA vez. Con `[persist]` como dependencia, React ejecutaria
  // la limpieza — es decir, guardaria — cada vez que cambia el tempo,
  // que es exactamente lo que este codigo dice evitar.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => () => persistRef.current(), []);

  const readPulse = useCallback((): PulseState | null => {
    const position = metronome.positionNow();
    if (!position) return null;
    return {
      phase: position.phase,
      pulse: position.pulse,
      pulses: pulsesPerBar(song.meter),
      active: metronome.running
    };
  }, [metronome, song.meter]);

  const readStep = useCallback((): number | null => {
    const position = metronome.positionNow();
    if (!position || !metronome.running) return null;
    return Math.floor(position.phase * groove.stepsPerBar) % groove.stepsPerBar;
  }, [metronome, groove.stepsPerBar]);

  const stepsPerPulse = groove.stepsPerBar / groove.pulsesPerBar;
  const tracks = (['kick', 'snare', 'hat', 'accent', 'beat', 'sub'] as const)
    .filter((role) => groove.tracks[role])
    .map((role) => ({ label: ROLE_LABEL[role], steps: groove.tracks[role] ?? [] }));

  const compound = subdivisionsPerPulse(song.meter) === 3;

  return (
    <div className="flex min-h-full flex-col gap-6 px-5 pt-2 pb-8">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            persist();
            go('library');
          }}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted"
        >
          ← Biblioteca
        </button>
        <h1 className="truncate text-lg font-semibold">{song.title}</h1>
      </header>

      <div className="flex flex-col items-center gap-4">
        <PulseCanvas read={readPulse} size={176} />

        <div className="flex items-baseline gap-3">
          <span className="tabular text-6xl font-semibold">{Math.round(bpm)}</span>
          <span className="text-sm tracking-[0.18em] text-muted uppercase">BPM ♩</span>
          <span className="rounded bg-signal-dim px-2 py-0.5 text-signal">
            {song.meter.beatsPerBar}/{song.meter.beatUnit}
          </span>
        </div>
        {compound && (
          <span className="tabular text-sm text-muted">
            pulso {pulseBpm.toFixed(1)} · {Math.round(pulseBpm * 3)} corcheas
          </span>
        )}

        <button
          type="button"
          onClick={toggle}
          className={
            'w-40 rounded-full border-2 py-4 text-sm tracking-[0.18em] uppercase transition-transform active:scale-95 ' +
            (running
              ? 'border-line bg-surface text-ink'
              : 'border-signal bg-signal-dim text-signal')
          }
        >
          {running ? 'Parar' : 'Tocar'}
        </button>
      </div>

      <div className="flex flex-col gap-3">
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
      </div>

      <StepGrid
        tracks={tracks}
        stepsPerBar={groove.stepsPerBar}
        stepsPerPulse={stepsPerPulse}
        read={readStep}
      />

      <Segmented
        label="Groove"
        value={grooveId}
        options={grooves.map((g) => ({ value: g.id, label: g.name }))}
        onChange={setGrooveId}
      />

      <Segmented
        label="Sonido"
        value={packId}
        options={PACKS.map((p) => ({ value: p.id, label: p.name }))}
        onChange={setPackId}
      />

      <div>
        <div className="mb-1.5 text-[0.65rem] tracking-[0.14em] text-muted uppercase">Volumen</div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="h-11 w-full accent-[#f5b33f]"
          aria-label="Volumen"
        />
      </div>

      {isIos() && (
        <p className="text-xs leading-relaxed text-muted">
          En iPhone, Safari silencia el audio web si el interruptor lateral está en silencio. Si no
          oyes nada, súbelo.
        </p>
      )}
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  kick: 'Bombo',
  snare: 'Caja',
  hat: 'Charles',
  accent: 'Acento',
  beat: 'Pulso',
  sub: 'Sub'
};
