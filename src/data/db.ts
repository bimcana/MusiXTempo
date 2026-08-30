/**
 * Biblioteca local. IndexedDB, sin cuenta y sin nube: un local de ensayo
 * no siempre tiene cobertura, y estos datos no son de nadie mas.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Subdivision, TimeSignature } from '../dsp/meter';

export interface Song {
  id: string;
  title: string;
  /** Pulso sentido. */
  bpm: number;
  /** La subdivision: corcheas, o corcheas de tresillo en compuesto. */
  bpmAlt: number;
  meter: TimeSignature;
  subdivision: Subdivision;
  /** Confianza de la deteccion, 0..1. En alta manual, 1. */
  confidence: number;
  packId: string;
  grooveId: string;
  source: 'detected' | 'manual';
  /**
   * Posicion en el orden manual. Menor va antes. Se deja hueco entre
   * valores para que mover al principio o al final sea escribir UNA
   * fila, no renumerar la biblioteca entera.
   */
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface MusixTempoDB extends DBSchema {
  songs: {
    key: string;
    value: Song;
    indexes: { 'by-created': number; 'by-order': number };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<MusixTempoDB>> | null = null;

function db(): Promise<IDBPDatabase<MusixTempoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MusixTempoDB>('musixtempo', 2, {
      async upgrade(database, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const songs = database.createObjectStore('songs', { keyPath: 'id' });
          songs.createIndex('by-created', 'createdAt');
          database.createObjectStore('settings');
        }
        if (oldVersion < 2) {
          const store = tx.objectStore('songs');
          store.createIndex('by-order', 'order');
          // Las canciones que ya existian heredan el orden que tenian en
          // pantalla: de mas reciente a mas antigua.
          const existing = await store.getAll();
          existing.sort((a, b) => b.createdAt - a.createdAt);
          let position = 0;
          for (const song of existing) {
            await store.put({ ...song, order: position++ * ORDER_GAP });
          }
        }
      }
    });
  }
  return dbPromise;
}

/** Separacion entre posiciones consecutivas del orden manual. */
export const ORDER_GAP = 1000;

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export async function listSongs(): Promise<Song[]> {
  const all = await (await db()).getAll('songs');
  return all.sort((a, b) => a.order - b.order);
}

/** Rango de posiciones ocupado, para insertar al principio o al final. */
export function orderBounds(songs: readonly Song[]): { first: number; last: number } {
  if (songs.length === 0) return { first: 0, last: 0 };
  let first = Infinity;
  let last = -Infinity;
  for (const song of songs) {
    if (song.order < first) first = song.order;
    if (song.order > last) last = song.order;
  }
  return { first, last };
}

export async function getSong(id: string): Promise<Song | undefined> {
  return (await db()).get('songs', id);
}

export async function putSong(song: Song): Promise<void> {
  await (await db()).put('songs', { ...song, updatedAt: Date.now() });
}

export async function deleteSong(id: string): Promise<void> {
  await (await db()).delete('songs', id);
}

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const value = await (await db()).get('settings', key);
  return (value as T) ?? fallback;
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', value, key);
}
