/**
 * Biblioteca: lo detectado y lo dado de alta a mano, todo local.
 *
 * Busqueda, orden manual por arrastre y modos de ordenacion. El orden
 * manual es UN modo, no una capa sobre los demas: reordenar a mano
 * dentro de una lista ordenada por titulo no significa nada, asi que la
 * empunadura solo arrastra en "Mi orden".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatTimeSignature,
  meterLabel,
  subdivisionsPerPulse,
  type TimeSignature
} from '../dsp/meter';
import { optionsFor } from '../metronome/grooves';
import { DEFAULT_PACK_ID } from '../metronome/packs';
import { SORT_LABELS, useApp, type SortMode } from '../state/store';
import type { Song } from '../data/db';
import { MeterPicker, TapTempo } from './components';
import { useDragReorder } from './useDragReorder';

const SORT_MODES: SortMode[] = ['manual', 'title', 'bpm', 'recent'];

export function LibraryScreen() {
  const loaded = useApp((s) => s.loaded);
  const loadLibrary = useApp((s) => s.loadLibrary);
  const openSong = useApp((s) => s.openSong);
  const go = useApp((s) => s.go);
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const sortMode = useApp((s) => s.sortMode);
  const setSortMode = useApp((s) => s.setSortMode);
  const total = useApp((s) => s.songs.length);
  // Se resuscribe a `songs` para recalcular cuando cambia el orden.
  const songs = useApp((s) => s.songs);
  const visibleSongs = useApp((s) => s.visibleSongs);

  const reorderTo = useApp((s) => s.reorderTo);
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<Song | null>(null);

  useEffect(() => {
    if (!loaded) void loadLibrary();
  }, [loaded, loadLibrary]);

  const visible = visibleSongs();
  void songs;
  const reorderable = sortMode === 'manual';

  const commit = useCallback(
    (from: number, to: number) => {
      const song = visible[from];
      if (song) void reorderTo(song.id, to);
    },
    [visible, reorderTo]
  );
  const drag = useDragReorder(visible.length, commit);

  if (adding) return <ManualForm onDone={() => setAdding(false)} />;

  return (
    <div className="flex flex-1 flex-col gap-3 px-5 pt-2 pb-8">
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

      {total > 0 && (
        <>
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por título"
              type="search"
              className="w-full rounded-lg border border-line bg-surface py-2.5 pr-10 pl-4 outline-none placeholder:text-muted focus:border-signal"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                className="absolute top-1/2 right-2 -translate-y-1/2 px-2 py-1 text-muted"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SORT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSortMode(mode)}
                className={
                  'rounded border px-3 py-1.5 text-sm transition-colors ' +
                  (mode === sortMode
                    ? 'border-signal bg-signal-dim text-signal'
                    : 'border-line bg-surface text-muted')
                }
              >
                {SORT_LABELS[mode]}
              </button>
            ))}
          </div>

          {!reorderable ? (
            <p className="text-xs text-muted">Cambia a «Mi orden» para reordenar a mano.</p>
          ) : (
            visible.length > 1 && (
              <p className="text-xs text-muted">
                Arrastra desde los puntos para mover. Para más opciones, mantén pulsada una canción
                o tócala con dos dedos en el trackpad.
              </p>
            )
          )}
        </>
      )}

      {total === 0 ? (
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
      ) : visible.length === 0 ? (
        <p className="mt-6 text-center text-muted">Nada coincide con «{query}».</p>
      ) : (
        <ul ref={drag.listRef} className="flex flex-col gap-2">
          {visible.map((song, index) => (
            <SongRow
              key={song.id}
              song={song}
              index={index}
              count={visible.length}
              draggable={reorderable}
              isDragging={drag.dragging === index}
              onGrab={(event) => drag.begin(index, event)}
              onOpen={() => openSong(song.id)}
              onOptions={() => setMenuFor(song)}
            />
          ))}
        </ul>
      )}

      {menuFor && <OptionsSheet song={menuFor} onClose={() => setMenuFor(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fila                                                                */
/* ------------------------------------------------------------------ */

function SongRow(props: {
  song: Song;
  index: number;
  count: number;
  draggable: boolean;
  isDragging: boolean;
  onGrab: (event: React.PointerEvent) => void;
  onOpen: () => void;
  onOptions: () => void;
}) {
  const moveSong = useApp((s) => s.moveSong);
  const { song, index, count, draggable, isDragging } = props;

  // Pulsacion larga: 500 ms sin soltar ni arrastrar. Se marca que
  // disparo para que el `click` que llega despues no abra la cancion.
  const timer = useRef<number | null>(null);
  const firedLong = useRef(false);

  const cancelHold = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const startHold = () => {
    firedLong.current = false;
    cancelHold();
    timer.current = window.setTimeout(() => {
      firedLong.current = true;
      if (navigator.vibrate) navigator.vibrate(12);
      props.onOptions();
    }, 500);
  };

  useEffect(() => cancelHold, []);

  return (
    <li
      // El menu contextual se escucha en la fila entera, no solo en el
      // titulo: en un trackpad el toque con dos dedos puede caer sobre
      // la empunadura o sobre el boton de opciones, y ahi tambien tiene
      // que abrir el cuadro en vez del menu nativo del navegador.
      onContextMenu={(event) => {
        event.preventDefault();
        if (!isDragging) props.onOptions();
      }}
      className={'relative flex items-stretch gap-2' + (isDragging ? ' opacity-95' : '')}
    >
      <GripHandle
        disabled={!draggable}
        active={isDragging}
        label={'Reordenar ' + song.title}
        position={index + 1}
        total={count}
        onPointerDown={(event) => {
          if (!draggable || event.button !== 0) return;
          event.preventDefault();
          props.onGrab(event);
        }}
        onKeyDown={(event) => {
          // El teclado sigue moviendo de uno en uno: es el unico modo
          // preciso, y el arrastre no existe sin puntero.
          if (!draggable) return;
          if (event.key === 'ArrowUp' && index > 0) {
            event.preventDefault();
            void moveSong(song.id, -1);
          } else if (event.key === 'ArrowDown' && index < count - 1) {
            event.preventDefault();
            void moveSong(song.id, 1);
          }
        }}
      />

      <button
        type="button"
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onClick={() => {
          if (firedLong.current) {
            firedLong.current = false;
            return;
          }
          props.onOpen();
        }}
        className="flex flex-1 items-center justify-between rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors active:border-signal"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{song.title}</span>
          <span className="text-xs text-muted">
            {song.source === 'manual' ? 'A mano' : 'Detectada'}
            {song.source === 'detected' && ' · ' + Math.round(song.confidence * 100) + ' % confianza'}
          </span>
        </span>
        <span className="ml-3 shrink-0 text-right">
          <span className="tabular block text-xl font-semibold">{song.bpm.toFixed(1)}</span>
          <span className="text-xs text-signal">{meterLabel(song.meter)}</span>
        </span>
      </button>

      <button
        type="button"
        onClick={props.onOptions}
        aria-label={'Opciones de ' + song.title}
        className="w-10 shrink-0 rounded-lg border border-line bg-surface text-lg text-muted"
      >
        ⋯
      </button>
    </li>
  );
}

/**
 * Empunadura de seis puntos: la senal universal de "esto se arrastra".
 * Dos columnas por tres filas, sin flechas — porque no mueve un paso por
 * toque, mueve lo que el dedo recorra.
 *
 * `touch-action: none` es obligatorio: sin el, el navegador se queda el
 * gesto vertical para desplazar la pagina y el arrastre nunca empieza.
 */
function GripHandle(props: {
  disabled: boolean;
  active: boolean;
  label: string;
  position: number;
  total: number;
  onPointerDown: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-label={props.label}
      aria-describedby={undefined}
      title={props.disabled ? undefined : 'Arrastra para mover'}
      onPointerDown={props.onPointerDown}
      onKeyDown={props.onKeyDown}
      style={{ touchAction: 'none' }}
      className={
        'flex w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ' +
        (props.disabled
          ? 'border-line-soft bg-surface'
          : props.active
            ? 'border-signal bg-signal-dim'
            : 'border-line bg-surface-2 active:border-signal')
      }
    >
      <span className="sr-only">
        {props.position} de {props.total}
      </span>
      <span className="grid grid-cols-2 gap-[4px]" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={
              'block h-[3.5px] w-[3.5px] rounded-full ' +
              (props.disabled ? 'bg-line' : props.active ? 'bg-signal' : 'bg-muted')
            }
          />
        ))}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Hoja de opciones                                                    */
/* ------------------------------------------------------------------ */

function OptionsSheet({ song, onClose }: { song: Song; onClose: () => void }) {
  const moveToEdge = useApp((s) => s.moveToEdge);
  const removeSong = useApp((s) => s.removeSong);
  const sortMode = useApp((s) => s.sortMode);
  const setSortMode = useApp((s) => s.setSortMode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const jump = async (edge: 'top' | 'bottom') => {
    // Mover al extremo solo se ve si la lista esta en orden manual, asi
    // que se cambia de modo en vez de dejar al usuario sin feedback.
    if (sortMode !== 'manual') setSortMode('manual');
    await moveToEdge(song.id, edge);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="safe-bottom relative mx-auto w-full max-w-lg rounded-t-2xl border-t border-line bg-surface p-4">
        <p className="mb-3 truncate px-1 text-sm text-muted">{song.title}</p>
        <div className="flex flex-col gap-1.5">
          <SheetItem
            title="Mover arriba"
            hint="Encabeza la lista"
            onClick={() => void jump('top')}
          />
          <SheetItem
            title="Mover abajo"
            hint="Al final de la lista"
            onClick={() => void jump('bottom')}
          />
          <SheetItem
            title="Borrar"
            hint="No se puede deshacer"
            danger
            onClick={() => {
              void removeSong(song.id);
              onClose();
            }}
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-lg border border-line bg-surface-2 py-3 text-sm tracking-[0.14em] text-muted uppercase"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

function SheetItem(props: {
  title: string;
  hint: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        'rounded-lg border border-line bg-surface-2 px-4 py-3 text-left transition-colors active:border-signal ' +
        (props.danger ? 'text-danger' : '')
      }
    >
      <span className="block font-medium">{props.title}</span>
      <span className="block text-xs text-muted">{props.hint}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Alta manual                                                         */
/* ------------------------------------------------------------------ */

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
