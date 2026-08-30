/// <reference lib="webworker" />
/**
 * Todo el DSP vive aqui. Ni el render a 60 fps ni una pasada de analisis
 * pesada pueden interferir con el otro, porque nunca comparten hilo.
 */

import { defaultArbiter } from '../arbiter';
import { TempoEngine } from '../dsp/engine';
import type { FromWorker, ToWorker } from './protocol';

let engine: TempoEngine | null = null;

const post = (message: FromWorker): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      engine = new TempoEngine(message.sampleRate, { arbiter: defaultArbiter() });
      post({ type: 'ready', frameRate: engine.frameRate });
      break;

    case 'samples': {
      if (!engine) return;
      const result = engine.push(message.samples, message.time);
      if (result) post({ type: 'result', result });
      break;
    }

    case 'reset':
      engine?.reset();
      break;
  }
};
