/**
 * Implementaciones del arbitro.
 *
 *   NullArbiter       no hace nada. Para tests y para apagarlo.
 *   HeuristicArbiter  el que entra en v1.
 *   NeuralArbiter     slot listo, pendiente del spike de licencias.
 */

import { clamp, lerpAt } from '../dsp/core';
import { computeTempogram, tempoPrior } from '../dsp/tempo';
import type { ArbiterInput, ArbiterVerdict, TempoArbiter } from './types';

export * from './types';

/** No opina. El motor clasico decide solo. */
export class NullArbiter implements TempoArbiter {
  readonly id = 'null';
  async arbitrate(): Promise<ArbiterVerdict | null> {
    return null;
  }
}

/**
 * Arbitro heuristico: no es una red, pero tampoco repite el trabajo del
 * clasico. Aporta dos cosas que el clasico no tiene:
 *
 *   1. Una ventana mas larga (~12 s frente a 8 s). Un tempo real sigue
 *      ahi al mirar mas lejos; un artefacto de una ventana concreta, no.
 *   2. Una prueba explicita de nivel metrico: un candidato que es en
 *      realidad la subdivision de otro deja huella — su doble o su
 *      triple tambien puntua alto en la ventana larga.
 */
export class HeuristicArbiter implements TempoArbiter {
  readonly id = 'heuristic-v1';

  async arbitrate(input: ArbiterInput): Promise<ArbiterVerdict | null> {
    const { candidates, chosenIndex, longOnset, frameRate } = input;
    if (candidates.length === 0) return null;
    // Sin ventana larga no hay nada que anadir sobre el clasico.
    if (longOnset.length < frameRate * 6) return null;

    const long = computeTempogram(longOnset, frameRate, 12);
    const adjust: number[] = [];

    for (const c of candidates) {
      const lag = c.lag;
      let a = 0;

      // (1) Persistencia en la ventana larga.
      const longSalience = lag < long.salience.length ? lerpAt(long.salience, lag) : 0;
      a += 0.22 * (longSalience - c.salience);

      // (2) Nivel metrico. Si el doble o el triple de este candidato
      // puntua claramente mas alto en la ventana larga, este candidato
      // es probablemente una subdivision, no el pulso.
      const parentPenalty = Math.max(
        salienceAt(long.salience, lag * 2) - longSalience,
        salienceAt(long.salience, lag * 3) - longSalience
      );
      if (parentPenalty > 0.12) a -= 0.18 * clamp(parentPenalty, 0, 1);

      // Y al reves: si su mitad o su tercio puntua mucho mas, este
      // candidato es demasiado lento.
      const childPenalty = Math.max(
        salienceAt(long.salience, lag / 2) - longSalience,
        salienceAt(long.salience, lag / 3) - longSalience
      );
      if (childPenalty > 0.25) a -= 0.12 * clamp(childPenalty, 0, 1);

      // (3) Un pulso de verdad tiene subdivisiones claras. Que no las
      // tenga es sintoma de estar en el nivel equivocado.
      if (c.subdivisionScore < 0.08) a -= 0.06;

      // (4) Prior perceptual, con poco peso: aqui solo desempata.
      a += 0.05 * (tempoPrior(c.bpm) - 0.5);

      adjust.push(a);
    }

    // Acuerdo: cuanto conserva el elegido su ventaja tras el ajuste.
    let bestAfter = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i].score + adjust[i];
      if (s > bestAfter) {
        bestAfter = s;
        bestIdx = i;
      }
    }
    const chosenAfter = candidates[chosenIndex].score + adjust[chosenIndex];
    const agreement =
      bestIdx === chosenIndex ? 1 : clamp(1 - (bestAfter - chosenAfter) / 0.25, 0, 1);

    return { adjust, agreement, arbiterId: this.id };
  }
}

function salienceAt(salience: Float32Array, lag: number): number {
  if (lag < 1 || lag >= salience.length - 1) return 0;
  return lerpAt(salience, lag);
}

/**
 * Slot para el arbitro neuronal. Queda deliberadamente sin implementar:
 * el spike de licencias decide si carga un modelo permisivo, si entrena
 * el propio con el corpus sintetico, o si no llega nada y el heuristico
 * se queda. Hasta entonces se comporta como el nulo — nunca miente.
 */
export class NeuralArbiter implements TempoArbiter {
  readonly id = 'neural-pending';
  async arbitrate(): Promise<ArbiterVerdict | null> {
    return null;
  }
}

export function defaultArbiter(): TempoArbiter {
  return new HeuristicArbiter();
}
