/**
 * Une la captura de microfono con el worker de analisis. Es la unica
 * pieza que la interfaz necesita conocer para detectar.
 */

import type { DetectionResult } from '../dsp/engine';
import type { FromWorker, ToWorker } from '../worker/protocol';
import { MicCapture } from './capture';

export interface DetectorHandlers {
  onResult: (result: DetectionResult) => void;
  onError: (error: Error) => void;
}

export class Detector {
  private worker: Worker | null = null;
  private capture: MicCapture | null = null;

  constructor(private readonly handlers: DetectorHandlers) {}

  get running(): boolean {
    return this.capture?.running ?? false;
  }

  get audioContext(): AudioContext | null {
    return this.capture?.audioContext ?? null;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), {
      type: 'module'
    });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      if (event.data.type === 'result') this.handlers.onResult(event.data.result);
    };
    this.worker.onerror = () => {
      this.handlers.onError(new Error('El analisis de audio fallo.'));
    };

    this.capture = new MicCapture({
      onBlock: (samples, time) => {
        // El buffer se transfiere, no se copia: cero coste por bloque.
        const message: ToWorker = { type: 'samples', samples, time };
        this.worker?.postMessage(message, [samples.buffer]);
      },
      onError: this.handlers.onError
    });

    try {
      await this.capture.start();
    } catch (error) {
      this.stop();
      throw error;
    }

    const init: ToWorker = { type: 'init', sampleRate: this.capture.sampleRate };
    this.worker.postMessage(init);
  }

  stop(): void {
    this.capture?.stop();
    this.worker?.terminate();
    this.capture = null;
    this.worker = null;
  }
}
