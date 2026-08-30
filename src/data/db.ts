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
  createdAt: number;
  updatedAt: number;
}

interface MusixTempoDB extends DBSchema {
  songs: {
    key: string;
    value: Song;
    indexes: { 'by-created': number };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<MusixTempoDB>> | null = null;

function db(): Promise<IDBPDatabase<MusixTempoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MusixTempoDB>('musixtempo', 1, {
      upgrade(database) {
        const songs = database.createObjectStore('songs', { keyPath: 'id' });
        songs.createIndex('by-created', 'createdAt');
        database.createObjectStore('settings');
      }
    });
  }
  return dbPromise;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export async function listSongs(): Promise<Song[]> {
  const all = await (await db()).getAllFromIndex('songs', 'by-created');
  return all.reverse();
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
