/**
 * Estado de la aplicacion. Deliberadamente pequeno: todo lo que va a
 * 60 fps (indicador de pulso, rejilla del groove) vive FUERA de React,
 * en canvas contra el reloj de audio.
 */

import { create } from 'zustand';
import type { DetectionResult } from '../dsp/engine';
import {
  ORDER_GAP,
  deleteSong,
  listSongs,
  newId,
  orderBounds,
  putSong,
  readSetting,
  writeSetting,
  type Song
} from '../data/db';
import type { StreamingLinks } from '../songid/types';
import { DEFAULT_PACK_ID } from '../metronome/packs';
import { optionsFor } from '../metronome/grooves';

export type Screen = 'listen' | 'library' | 'metronome';

/**
 * `manual` es el orden que el usuario construye con las flechas. Los
 * demas modos son vistas: reordenar a mano dentro de una lista ordenada
 * por titulo no significa nada, asi que las flechas solo actuan en
 * `manual`.
 */
export type SortMode = 'manual' | 'title' | 'bpm' | 'recent';

export const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Mi orden',
  title: 'Título',
  bpm: 'BPM',
  recent: 'Reciente'
};

/** Compara ignorando mayusculas y acentos: "Bailé" encuentra "baile". */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

interface AppState {
  screen: Screen;
  songs: Song[];
  activeSongId: string | null;
  pending: DetectionResult | null;
  loaded: boolean;
  query: string;
  sortMode: SortMode;

  go: (screen: Screen) => void;
  loadLibrary: () => Promise<void>;
  setPending: (result: DetectionResult | null) => void;
  setQuery: (query: string) => void;
  setSortMode: (mode: SortMode) => void;
  visibleSongs: () => Song[];
  saveDetection: (
    title: string,
    result: DetectionResult,
    links?: StreamingLinks
  ) => Promise<string>;
  addManual: (
    input: Omit<Song, 'id' | 'createdAt' | 'updatedAt' | 'source' | 'order'>
  ) => Promise<string>;
  updateSong: (song: Song) => Promise<void>;
  removeSong: (id: string) => Promise<void>;
  moveSong: (id: string, direction: -1 | 1) => Promise<void>;
  reorderTo: (id: string, targetIndex: number) => Promise<void>;
  moveToEdge: (id: string, edge: 'top' | 'bottom') => Promise<void>;
  openSong: (id: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  screen: 'listen',
  songs: [],
  activeSongId: null,
  pending: null,
  loaded: false,
  query: '',
  sortMode: 'manual',

  go: (screen) => set({ screen }),

  loadLibrary: async () => {
    const [songs, sortMode] = await Promise.all([
      listSongs(),
      readSetting<SortMode>('sortMode', 'manual')
    ]);
    set({ songs, sortMode, loaded: true });
  },

  setPending: (pending) => set({ pending }),

  setQuery: (query) => set({ query }),

  setSortMode: (sortMode) => {
    set({ sortMode });
    void writeSetting('sortMode', sortMode);
  },

  visibleSongs: () => {
    const { songs, query, sortMode } = get();
    const needle = normalize(query);
    const filtered = needle ? songs.filter((s) => normalize(s.title).includes(needle)) : songs;

    const sorted = [...filtered];
    switch (sortMode) {
      case 'title':
        sorted.sort((a, b) => normalize(a.title).localeCompare(normalize(b.title), 'es'));
        break;
      case 'bpm':
        sorted.sort((a, b) => a.bpm - b.bpm);
        break;
      case 'recent':
        sorted.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'manual':
        sorted.sort((a, b) => a.order - b.order);
        break;
    }
    return sorted;
  },

  saveDetection: async (title, result, links) => {
    const grooves = optionsFor(result.meter);
    const song: Song = {
      id: newId(),
      title: title.trim() || 'Sin título',
      bpm: result.bpm,
      bpmPulse: result.bpmPulse,
      bpmAlt: result.bpmAlt,
      meter: result.meter,
      subdivision: result.subdivision,
      confidence: result.confidence,
      packId: DEFAULT_PACK_ID,
      grooveId: (grooves.find((g) => !g.id.startsWith('click-')) ?? grooves[0]).id,
      source: 'detected',
      links,
      order: orderBounds(get().songs).first - ORDER_GAP,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await putSong(song);
    set({ songs: [song, ...get().songs], pending: null });
    return song.id;
  },

  addManual: async (input) => {
    const song: Song = {
      ...input,
      id: newId(),
      source: 'manual',
      order: orderBounds(get().songs).first - ORDER_GAP,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await putSong(song);
    set({ songs: [song, ...get().songs] });
    return song.id;
  },

  updateSong: async (song) => {
    await putSong(song);
    set({
      songs: get().songs.map((s) => (s.id === song.id ? { ...song, updatedAt: Date.now() } : s))
    });
  },

  removeSong: async (id) => {
    await deleteSong(id);
    set({
      songs: get().songs.filter((s) => s.id !== id),
      activeSongId: get().activeSongId === id ? null : get().activeSongId
    });
  },

  /**
   * Intercambia la posicion con el vecino. Se opera sobre la lista
   * VISIBLE, no sobre la completa: si hay una busqueda activa, "arriba"
   * significa el vecino que el usuario esta viendo.
   */
  moveSong: async (id, direction) => {
    const visible = get().visibleSongs();
    const index = visible.findIndex((s) => s.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= visible.length) return;

    const a = visible[index];
    const b = visible[target];
    const swapped = get().songs.map((s) => {
      if (s.id === a.id) return { ...s, order: b.order };
      if (s.id === b.id) return { ...s, order: a.order };
      return s;
    });
    set({ songs: swapped });
    await Promise.all([
      putSong({ ...a, order: b.order }),
      putSong({ ...b, order: a.order })
    ]);
  },

  /**
   * Coloca la cancion en una posicion concreta de la lista visible. Es
   * lo que usa el arrastre: se mueve TANTO como el dedo recorra, no una
   * posicion por gesto.
   *
   * El nuevo `order` es el punto medio entre los dos vecinos del destino.
   * Cuando el hueco se agota tras muchos reordenamientos, se renumera la
   * lista entera una vez y se vuelve a intentar.
   */
  reorderTo: async (id, targetIndex) => {
    const visible = get().visibleSongs();
    const from = visible.findIndex((s) => s.id === id);
    if (from < 0 || targetIndex === from) return;

    const target = Math.max(0, Math.min(visible.length - 1, targetIndex));
    const without = visible.filter((s) => s.id !== id);
    const before = without[target - 1];
    const after = without[target];

    let order: number;
    if (!before) order = (after?.order ?? 0) - ORDER_GAP;
    else if (!after) order = before.order + ORDER_GAP;
    else order = (before.order + after.order) / 2;

    // Sin hueco entre vecinos, el punto medio deja de separar: hay que
    // renumerar antes de colocar.
    if (before && after && Math.abs(after.order - before.order) < 2) {
      const spread = without.map((song, index) => ({ ...song, order: index * ORDER_GAP }));
      const b = spread[target - 1];
      const a = spread[target];
      const moved = {
        ...visible[from],
        order: a ? (b.order + a.order) / 2 : b.order + ORDER_GAP
      };
      const byId = new Map(spread.map((song) => [song.id, song] as const));
      byId.set(moved.id, moved);
      set({ songs: get().songs.map((song) => byId.get(song.id) ?? song) });
      await Promise.all([...spread, moved].map((song) => putSong(song)));
      return;
    }

    const moved = { ...visible[from], order };
    set({ songs: get().songs.map((song) => (song.id === id ? moved : song)) });
    await putSong(moved);
  },

  moveToEdge: async (id, edge) => {
    const songs = get().songs;
    const song = songs.find((s) => s.id === id);
    if (!song) return;
    const { first, last } = orderBounds(songs);
    const order = edge === 'top' ? first - ORDER_GAP : last + ORDER_GAP;
    const moved = { ...song, order };
    set({ songs: songs.map((s) => (s.id === id ? moved : s)) });
    await putSong(moved);
  },

  openSong: (id) => set({ activeSongId: id, screen: 'metronome' })
}));
