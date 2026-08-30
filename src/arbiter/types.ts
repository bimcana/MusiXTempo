/**
 * El arbitro: una interfaz de dos metodos detras de la cual el motor no
 * sabe que hay. Se sustituye o se apaga sin tocar nada mas.
 *
 * Su trabajo NO es decidir el tempo. Es revisar las hipotesis que el
 * motor clasico ya construyo y decir cuales le parecen mejores, mirando
 * evidencia que el clasico no miro. Si discrepa fuerte, el motor baja la
 * confianza en lugar de inventar un ganador.
 */

import type { Subdivision } from '../dsp/meter';

export interface ArbiterCandidate {
  bpm: number;
  lag: number;
  salience: number;
  subdivision: Subdivision;
  pulsesPerBar: number;
  subdivisionScore: number;
  groupingScore: number;
  beatSalience: number;
  /** Puntuacion total que le dio el motor clasico. */
  score: number;
}

export interface ArbiterInput {
  frameRate: number;
  candidates: ArbiterCandidate[];
  /** Indice del candidato que el clasico eligio. */
  chosenIndex: number;
  /**
   * Curva de onset sobre una ventana mas larga que la del clasico
   * (~12 s). Es la evidencia adicional que justifica que exista arbitro.
   */
  longOnset: Float32Array;
  /** Espectrograma mel aplanado, para un arbitro neuronal. */
  mel?: Float32Array;
  nMels?: number;
}

export interface ArbiterVerdict {
  /** Ajuste aditivo a la puntuacion de cada candidato, mismo orden. */
  adjust: number[];
  /** Cuanto coincide con la eleccion del clasico, 0..1. */
  agreement: number;
  arbiterId: string;
}

export interface TempoArbiter {
  readonly id: string;
  arbitrate(input: ArbiterInput): Promise<ArbiterVerdict | null>;
}
