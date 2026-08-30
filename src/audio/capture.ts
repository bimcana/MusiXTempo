/**
 * Captura de microfono.
 *
 * El AudioWorklet SOLO copia bloques y los manda fuera. No analiza nada:
 * cualquier calculo pesado en el hilo de audio se oye como cortes.
 */

/**
 * El worklet va como texto y se carga desde un Blob. Asi no depende de
 * como el bundler resuelva rutas ni de donde este desplegada la app,
 * que es la fuente habitual de que `addModule` falle solo en produccion.
 */
const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.blockSize) || 2048;
    this.buffer = new Float32Array(size);
    this.count = 0;
    this.startTime = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      if (this.count === 0) this.startTime = currentTime + i / sampleRate;
      this.buffer[this.count++] = channel[i];
      if (this.count === this.buffer.length) {
        const copy = this.buffer.slice(0);
        this.port.postMessage({ samples: copy, time: this.startTime }, [copy.buffer]);
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('musixtempo-tap', TapProcessor);
`;

export interface CaptureHandlers {
  onBlock: (samples: Float32Array, audioTime: number) => void;
  onError?: (error: Error) => void;
}

export type MicPermission = 'granted' | 'denied' | 'unsupported' | 'insecure';

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly handlers: CaptureHandlers) {}

  static supportCheck(): MicPermission | null {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // Sin HTTPS el navegador ni siquiera expone getUserMedia.
      if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure';
      return 'unsupported';
    }
    return null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  get running(): boolean {
    return this.node !== null;
  }

  /** Debe llamarse desde un gesto del usuario: iOS no arranca audio sin el. */
  async start(): Promise<void> {
    if (this.node) return;

    const problem = MicCapture.supportCheck();
    if (problem === 'insecure') {
      throw new Error('El microfono necesita HTTPS. Abre la app por https:// o localhost.');
    }
    if (problem === 'unsupported') {
      throw new Error('Este navegador no permite acceder al microfono.');
    }

    // Estas tres constraints NO son opcionales. El procesado de voz que
    // iOS y Android aplican por defecto esta hecho para aplastar todo lo
    // que no sea habla, y destruiria el analisis ritmico.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      },
      video: false
    });

    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    await this.ctx.resume();

    if (!this.ctx.audioWorklet) {
      throw new Error('Este navegador no soporta AudioWorklet.');
    }

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'musixtempo-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { blockSize: 2048 }
    });

    this.node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; time: number }>) => {
      this.handlers.onBlock(event.data.samples, event.data.time);
    };
    this.node.onprocessorerror = () => {
      this.handlers.onError?.(new Error('El procesador de audio se detuvo.'));
    };

    this.source.connect(this.node);
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}
