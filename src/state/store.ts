/**
 * Estado de la aplicacion. Deliberadamente pequeno: todo lo que va a
 * 60 fps (indicador de pulso, rejilla del groove) vive FUERA de React,
 * en canvas contra el reloj de audio.
 */

import { create } from 'zustand';
import type { DetectionResult } from '../dsp/engine';
import { deleteSong, listSongs, newId, putSong, type Song } from '../data/db';
import { DEFAULT_PACK_ID } from '../metronome/packs';
import { optionsFor } from '../metronome/grooves';

export type Screen = 'listen' | 'library' | 'metronome';

interface AppState {
  screen: Screen;
  songs: Song[];
  activeSongId: string | null;
  /** Ultimo resultado de deteccion aun sin guardar ni descartar. */
  pending: DetectionResult | null;
  loaded: boolean;

  go: (screen: Screen) => void;
  loadLibrary: () => Promise<void>;
  setPending: (result: DetectionResult | null) => void;
  saveDetection: (title: string, result: DetectionResult) => Promise<string>;
  addManual: (input: Omit<Song, 'id' | 'createdAt' | 'updatedAt' | 'source'>) => Promise<string>;
  updateSong: (song: Song) => Promise<void>;
  removeSong: (id: string) => Promise<void>;
  openSong: (id: string) => void;
  activeSong: () => Song | null;
}

export const useApp = create<AppState>((set, get) => ({
  screen: 'listen',
  songs: [],
  activeSongId: null,
  pending: null,
  loaded: false,

  go: (screen) => set({ screen }),

  loadLibrary: async () => {
    set({ songs: await listSongs(), loaded: true });
  },

  setPending: (pending) => set({ pending }),

  saveDetection: async (title, result) => {
    const grooves = optionsFor(result.meter);
    const song: Song = {
      id: newId(),
      title: title.trim() || 'Sin título',
      bpm: result.bpm,
      bpmAlt: result.bpmAlt,
      meter: result.meter,
      subdivision: result.subdivision,
      confidence: result.confidence,
      packId: DEFAULT_PACK_ID,
      // El primer groove de kit si existe; si no, el click plano.
      grooveId: (grooves.find((g) => !g.id.startsWith('click-')) ?? grooves[0]).id,
      source: 'detected',
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
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await putSong(song);
    set({ songs: [song, ...get().songs] });
    return song.id;
  },

  updateSong: async (song) => {
    await putSong(song);
    set({ songs: get().songs.map((s) => (s.id === song.id ? { ...song, updatedAt: Date.now() } : s)) });
  },

  removeSong: async (id) => {
    await deleteSong(id);
    set({
      songs: get().songs.filter((s) => s.id !== id),
      activeSongId: get().activeSongId === id ? null : get().activeSongId
    });
  },

  openSong: (id) => set({ activeSongId: id, screen: 'metronome' }),

  activeSong: () => get().songs.find((s) => s.id === get().activeSongId) ?? null
}));
