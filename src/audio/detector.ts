/**
 * Une la captura de microfono con el worker de analisis. Es la unica
 * pieza que la interfaz necesita conocer para detectar.
 */

import type { DetectionResult } from '../dsp/engine';
import type { FromWorker, ToWorker } from '../worker/protocol';
import { MicCapture } from './capture';
import { requestSystemAudio, type SystemStream } from './system-capture';

export interface DetectorHandlers {
  onResult: (result: DetectionResult) => void;
  onError: (error: Error) => void;
}

/** Segundos de audio que se guardan para poder identificar la cancion. */
const SNIPPET_SECONDS = 12;

export type CaptureMode = 'mic' | 'system';

export class Detector {
  private worker: Worker | null = null;
  private capture: MicCapture | null = null;
  private system: SystemStream | null = null;

  /**
   * Buffer circular con los ultimos segundos de audio EN CRUDO. Se llena
   * copiando cada bloque antes de transferirlo al worker — la
   * transferencia deja el original vacio, asi que despues ya no habria
   * nada que enviar a identificar.
   *
   * Sobrevive a `stop()` a proposito: la identificacion ocurre cuando el
   * usuario ya paro de escuchar, para no competir nunca con el motor de
   * tempo.
   */
  private snippet: Float32Array | null = null;
  private snippetWrite = 0;
  private snippetFilled = 0;
  private snippetRate = 44100;

  constructor(private readonly handlers: DetectorHandlers) {}

  private appendSnippet(samples: Float32Array): void {
    const ring = this.snippet;
    if (!ring) return;
    const n = ring.length;
    for (let i = 0; i < samples.length; i++) {
      ring[this.snippetWrite] = samples[i];
      this.snippetWrite = (this.snippetWrite + 1) % n;
    }
    this.snippetFilled = Math.min(n, this.snippetFilled + samples.length);
  }

  /** Copia cronologica de lo escuchado, lista para identificar. */
  snapshot(): { samples: Float32Array; sampleRate: number } | null {
    const ring = this.snippet;
    // Menos de tres segundos no da para un fingerprint fiable.
    if (!ring || this.snippetFilled < this.snippetRate * 3) return null;
    const count = this.snippetFilled;
    const out = new Float32Array(count);
    const start = (this.snippetWrite - count + ring.length * 2) % ring.length;
    for (let i = 0; i < count; i++) out[i] = ring[(start + i) % ring.length];
    return { samples: out, sampleRate: this.snippetRate };
  }

  get running(): boolean {
    return this.capture?.running ?? false;
  }

  get audioContext(): AudioContext | null {
    return this.capture?.audioContext ?? null;
  }

  async start(mode: CaptureMode = 'mic'): Promise<void> {
    if (this.running) return;

    // El dialogo de captura va ANTES de montar nada: si el usuario
    // cancela, no queda un worker huerfano que desmontar.
    if (mode === 'system') {
      this.system = await requestSystemAudio();
    }

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
        this.appendSnippet(samples);
        // El buffer se transfiere, no se copia: cero coste por bloque.
        const message: ToWorker = { type: 'samples', samples, time };
        this.worker?.postMessage(message, [samples.buffer]);
      },
      onError: this.handlers.onError
    });

    try {
      await this.capture.start(this.system?.stream);
    } catch (error) {
      this.stop();
      throw error;
    }

    this.snippetRate = this.capture.sampleRate;
    this.snippet = new Float32Array(Math.ceil(SNIPPET_SECONDS * this.snippetRate));
    this.snippetWrite = 0;
    this.snippetFilled = 0;

    const init: ToWorker = { type: 'init', sampleRate: this.capture.sampleRate };
    this.worker.postMessage(init);
  }

  /** Reenvia al motor el pulso que el usuario esta marcando a mano. */
  sendTapReference(bpm: number, quality: number): void {
    const message: ToWorker = { type: 'tap-reference', bpm, quality };
    this.worker?.postMessage(message);
  }

  stop(): void {
    this.capture?.stop();
    this.system?.stop();
    this.worker?.terminate();
    this.capture = null;
    this.system = null;
    this.worker = null;
  }
}
