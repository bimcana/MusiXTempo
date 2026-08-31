/**
 * Busqueda en el catalogo: BPM, tonalidad y compas por NOMBRE, sin
 * audio. Complementa la medicion — el catalogo dice a cuanto se grabo;
 * el motor mide a cuanto suena — y cada resultado se guarda a la
 * biblioteca con un toque, listo para el metronomo.
 *
 * Datos de GetSongBPM; su API gratuita exige el enlace de atribucion
 * que se muestra al pie.
 */

import { useEffect, useRef, useState } from 'react';
import { quartersPerPulse, subdivisionsPerPulse, type TimeSignature } from '../dsp/meter';
import { optionsFor } from '../metronome/grooves';
import { DEFAULT_PACK_ID } from '../metronome/packs';
import { useApp } from '../state/store';

interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  uri?: string;
  bpm?: number;
  timeSignature?: string;
  keyOf?: string;
  openKey?: string;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'found'; songs: CatalogSong[] }
  | { kind: 'not-found' }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string };

/** "4/4" del catalogo → nuestra cifra; si no se entiende, 4/4. */
function parseMeter(text: string | undefined): TimeSignature {
  const match = text?.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return { beatsPerBar: 4, beatUnit: 4 };
  const beats = Number(match[1]);
  const unit = Number(match[2]);
  if (beats < 1 || beats > 15 || (unit !== 2 && unit !== 4 && unit !== 8)) {
    return { beatsPerBar: 4, beatUnit: 4 };
  }
  return { beatsPerBar: beats, beatUnit: unit };
}

export function SearchScreen() {
  const addManual = useApp((s) => s.addManual);
  const openSong = useApp((s) => s.openSong);

  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const search = async () => {
    const term = query.trim();
    if (!term) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'busy' });

    try {
      const response = await fetch(
        new URL('api/songbpm?q=' + encodeURIComponent(term), document.baseURI).toString(),
        { signal: controller.signal }
      );
      const contentType = response.headers.get('content-type') ?? '';
      // Un host estatico sin la funcion devuelve el index.html: eso es
      // "no configurado", no un error de sintaxis.
      if (!contentType.includes('application/json') || response.status === 501) {
        setState({ kind: 'unconfigured' });
        return;
      }
      const payload = await response.json();
      if (payload.status === 'found') setState({ kind: 'found', songs: payload.songs });
      else if (payload.status === 'not-found') setState({ kind: 'not-found' });
      else if (payload.status === 'unconfigured') setState({ kind: 'unconfigured' });
      else setState({ kind: 'error', message: payload.message ?? 'Fallo del catálogo.' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState({ kind: 'error', message: 'Sin conexión con el catálogo.' });
    }
  };

  const save = async (song: CatalogSong) => {
    const meter = parseMeter(song.timeSignature);
    const bpm = song.bpm && song.bpm > 0 ? song.bpm : 120;
    const pulse = bpm / quartersPerPulse(meter);
    const grooves = optionsFor(meter);
    const id = await addManual({
      title: song.artist + ' — ' + song.title,
      bpm,
      bpmPulse: pulse,
      bpmAlt: pulse * subdivisionsPerPulse(meter),
      meter,
      subdivision: subdivisionsPerPulse(meter) === 3 ? 'ternary' : 'binary',
      confidence: 1,
      packId: DEFAULT_PACK_ID,
      grooveId: (grooves.find((g) => !g.id.startsWith('click-')) ?? grooves[0]).id
    });
    openSong(id);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 px-5 pt-4 pb-6">
      <header>
        <h1 className="text-lg font-semibold">Buscar en el catálogo</h1>
        <p className="mt-1 text-sm text-muted">
          BPM, tonalidad y compás por nombre, sin escuchar nada.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Título o artista"
          type="search"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-4 py-3 outline-none placeholder:text-muted focus:border-signal"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-signal bg-signal-dim px-5 text-sm tracking-[0.14em] text-signal uppercase"
        >
          Buscar
        </button>
      </form>

      {state.kind === 'busy' && <p className="text-sm text-muted">Buscando…</p>}

      {state.kind === 'not-found' && (
        <p className="text-sm text-muted">
          <strong className="text-ink">No encontrada</strong> en el catálogo. Prueba con «artista
          título», o mídela en Escuchar.
        </p>
      )}

      {state.kind === 'unconfigured' && (
        <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          La búsqueda por catálogo aún no está configurada (falta la clave de GetSongBPM en el
          servidor). Todo lo demás funciona igual.
        </div>
      )}

      {state.kind === 'error' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <span className="text-sm text-muted">{state.message}</span>
          <button type="button" onClick={() => void search()} className="shrink-0 text-xs text-signal">
            Reintentar
          </button>
        </div>
      )}

      {state.kind === 'found' && (
        <ul className="flex flex-col gap-2">
          {state.songs.map((song) => (
            <li key={song.id}>
              <button
                type="button"
                onClick={() => void save(song)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors active:border-signal"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{song.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {song.artist}
                    {song.keyOf ? ' · ' + song.keyOf + (song.openKey ? ' (' + song.openKey + ')' : '') : ''}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block text-xl font-semibold">
                    {song.bpm ? song.bpm.toFixed(0) : '—'}
                  </span>
                  <span className="text-xs text-signal">{song.timeSignature ?? ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-auto pt-2 text-center text-xs text-muted">
        Datos de tempo y tonalidad de{' '}
        <a
          href="https://getsongbpm.com"
          target="_blank"
          rel="noreferrer noopener"
          className="text-signal underline"
        >
          GetSongBPM
        </a>
      </p>
    </div>
  );
}
