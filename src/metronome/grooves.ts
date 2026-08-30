/**
 * Grooves declarativos. Un groove es DATOS, no codigo: anadir uno nuevo
 * es anadir un objeto a un array.
 */

import type { Subdivision, TimeSignature } from '../dsp/meter';
import { pulsesPerBar, subdivisionsPerPulse } from '../dsp/meter';

/** Roles que un pack puede sonorizar. El groove nunca nombra una voz. */
export type Role = 'accent' | 'beat' | 'sub' | 'kick' | 'snare' | 'hat';

export interface Groove {
  id: string;
  name: string;
  pulsesPerBar: number;
  subdivision: Subdivision;
  /** Pasos por compas. Siempre multiplo de pulsesPerBar. */
  stepsPerBar: number;
  /** Velocidad 0..1 por paso, para cada rol presente. */
  tracks: Partial<Record<Role, number[]>>;
}

/**
 * Click plano para cualquier metrica: acento en el uno, pulso en el
 * resto y, opcionalmente, la subdivision marcada por debajo.
 */
export function makeClickGroove(
  pulses: number,
  subdivision: Subdivision,
  withSubdivisions: boolean
): Groove {
  const sub = subdivision === 'ternary' ? 3 : 2;
  const steps = pulses * sub;
  const accent = new Array<number>(steps).fill(0);
  const beat = new Array<number>(steps).fill(0);
  const subs = new Array<number>(steps).fill(0);

  for (let s = 0; s < steps; s++) {
    if (s === 0) accent[s] = 1;
    else if (s % sub === 0) beat[s] = 0.85;
    else if (withSubdivisions) subs[s] = 0.4;
  }

  const tracks: Partial<Record<Role, number[]>> = { accent, beat };
  if (withSubdivisions) tracks.sub = subs;

  return {
    id: 'click-' + pulses + '-' + subdivision + (withSubdivisions ? '-sub' : ''),
    name: withSubdivisions ? 'Click con subdivisión' : 'Click',
    pulsesPerBar: pulses,
    subdivision,
    stepsPerBar: steps,
    tracks
  };
}

/**
 * Grooves de kit. Los patrones son de bateria real, no rellenos: el
 * acento del charles marca el uno y el bombo varia entre la primera y la
 * segunda mitad del compas, que es como suena un compas de verdad.
 */
export const GROOVES: Groove[] = [
  {
    id: 'rock-44',
    name: 'Rock',
    pulsesPerBar: 4,
    subdivision: 'binary',
    stepsPerBar: 8,
    tracks: {
      kick: [1, 0, 0, 0, 0.95, 0.8, 0, 0],
      snare: [0, 0, 1, 0, 0, 0, 1, 0],
      hat: [1, 0.5, 0.75, 0.5, 0.85, 0.5, 0.75, 0.55]
    }
  },
  {
    id: 'pop-44',
    name: 'Pop',
    pulsesPerBar: 4,
    subdivision: 'binary',
    stepsPerBar: 8,
    tracks: {
      kick: [1, 0, 0, 0.55, 0.95, 0, 0, 0],
      snare: [0, 0, 1, 0, 0, 0, 1, 0.35],
      hat: [1, 0.55, 0.75, 0.55, 0.85, 0.55, 0.75, 0.5]
    }
  },
  {
    id: 'sixteen-44',
    name: 'Semicorcheas',
    pulsesPerBar: 4,
    subdivision: 'binary',
    stepsPerBar: 16,
    tracks: {
      kick: [1, 0, 0, 0, 0, 0, 0.7, 0, 0.9, 0, 0, 0, 0, 0.6, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.3],
      hat: [1, 0.4, 0.6, 0.4, 0.8, 0.4, 0.6, 0.4, 0.85, 0.4, 0.6, 0.4, 0.8, 0.4, 0.6, 0.45]
    }
  },
  {
    id: 'shuffle-44',
    name: 'Shuffle',
    pulsesPerBar: 4,
    subdivision: 'ternary',
    stepsPerBar: 12,
    tracks: {
      kick: [1, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0.65],
      snare: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0],
      hat: [1, 0, 0.6, 0.8, 0, 0.6, 0.85, 0, 0.6, 0.8, 0, 0.62]
    }
  },
  {
    id: 'blues-128',
    name: 'Blues 12/8',
    pulsesPerBar: 4,
    subdivision: 'ternary',
    stepsPerBar: 12,
    tracks: {
      kick: [1, 0, 0, 0, 0, 0.5, 0.95, 0, 0, 0, 0, 0.6],
      snare: [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0],
      hat: [1, 0.35, 0.6, 0.85, 0.35, 0.6, 0.9, 0.35, 0.6, 0.85, 0.35, 0.6]
    }
  },
  {
    id: 'ballad-68',
    name: 'Balada 6/8',
    pulsesPerBar: 2,
    subdivision: 'ternary',
    stepsPerBar: 6,
    tracks: {
      kick: [1, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 1, 0, 0],
      hat: [1, 0.5, 0.52, 0.82, 0.5, 0.54]
    }
  },
  {
    id: 'march-68',
    name: 'Marcha 6/8',
    pulsesPerBar: 2,
    subdivision: 'ternary',
    stepsPerBar: 6,
    tracks: {
      kick: [1, 0, 0, 0.7, 0, 0],
      snare: [0, 0, 0.5, 0, 0, 0.5],
      hat: [1, 0.55, 0.55, 0.85, 0.55, 0.55]
    }
  },
  {
    id: 'waltz-34',
    name: 'Vals',
    pulsesPerBar: 3,
    subdivision: 'binary',
    stepsPerBar: 6,
    tracks: {
      kick: [1, 0, 0, 0, 0, 0.4],
      snare: [0, 0, 0.9, 0, 0.9, 0],
      hat: [1, 0.5, 0.8, 0.5, 0.8, 0.5]
    }
  },
  {
    id: 'jazz-34',
    name: 'Jazz 3/4',
    pulsesPerBar: 3,
    subdivision: 'ternary',
    stepsPerBar: 9,
    tracks: {
      kick: [0.5, 0, 0, 0, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0.6, 0, 0, 0, 0, 0.45],
      hat: [1, 0, 0.5, 0.8, 0, 0.55, 0.85, 0, 0.5]
    }
  },
  {
    id: 'march-24',
    name: 'Marcha',
    pulsesPerBar: 2,
    subdivision: 'binary',
    stepsPerBar: 4,
    tracks: {
      kick: [1, 0, 0, 0.5],
      snare: [0, 0, 1, 0],
      hat: [1, 0.55, 0.8, 0.55]
    }
  },
  {
    id: 'odd-54',
    name: 'Cinco por cuatro',
    pulsesPerBar: 5,
    subdivision: 'binary',
    stepsPerBar: 10,
    tracks: {
      kick: [1, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.5],
      snare: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      hat: [1, 0.5, 0.75, 0.5, 0.8, 0.5, 0.75, 0.5, 0.75, 0.5]
    }
  },
  {
    id: 'odd-78',
    name: 'Siete por ocho',
    pulsesPerBar: 7,
    subdivision: 'binary',
    stepsPerBar: 7,
    tracks: {
      kick: [1, 0, 0.8, 0, 0.8, 0, 0],
      snare: [0, 0, 0, 0.9, 0, 0, 0.7],
      hat: [1, 0.5, 0.8, 0.5, 0.8, 0.5, 0.7]
    }
  }
];

/** Los grooves que encajan con una cifra de compas concreta. */
export function groovesFor(sig: TimeSignature): Groove[] {
  const pulses = pulsesPerBar(sig);
  const sub: Subdivision = subdivisionsPerPulse(sig) === 3 ? 'ternary' : 'binary';
  return GROOVES.filter((g) => g.pulsesPerBar === pulses && g.subdivision === sub);
}

/** Catalogo completo para una metrica: clicks primero, luego los kits. */
export function optionsFor(sig: TimeSignature): Groove[] {
  const pulses = pulsesPerBar(sig);
  const sub: Subdivision = subdivisionsPerPulse(sig) === 3 ? 'ternary' : 'binary';
  return [makeClickGroove(pulses, sub, false), makeClickGroove(pulses, sub, true), ...groovesFor(sig)];
}

export function findGroove(id: string, sig: TimeSignature): Groove {
  const all = optionsFor(sig);
  return all.find((g) => g.id === id) ?? all[0];
}
