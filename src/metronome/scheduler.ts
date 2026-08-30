/**
 * Scheduler del metronomo.
 *
 * `setInterval` derrapa decenas de milisegundos y hace inservible un
 * metronomo. El patron correcto son DOS relojes: un temporizador grueso
 * que despierta cada 25 ms y mira 200 ms hacia delante, y el reloj de
 * audio, contra el que se programa cada golpe con precision de muestra.
 *
 * Lo visual se dibuja aparte, calculando *donde deberia estar el pulso
 * ahora* — nunca pintando cuando suena, que es lo que hace que los
 * metronomos web se vean desincronizados.
 */

import type { TimeSignature } from '../dsp/meter';
import { pulsesPerBar } from '../dsp/meter';
import { findGroove, type Groove, type Role } from './grooves';
import { PackPlayer, findPack } from './packs';
import { unlockIosAudio } from '../audio/ios-unlock';

const TIMER_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.2;
const HISTORY = 96;

export interface StepEvent {
  bar: number;
  step: number;
  /** Indice del pulso si el paso cae en uno; -1 si es una subdivision. */
  pulse: number;
  isDownbeat: boolean;
  time: number;
}

export interface Position {
  bar: number;
  pulse: number;
  /** Avance dentro del compas, 0..1. */
  phase: number;
}

const ROLE_ORDER: Role[] = ['accent', 'beat', 'sub', 'kick', 'snare', 'hat'];

export class Metronome {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private player: PackPlayer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private groove: Groove;
  private meter: TimeSignature;
  private packId: string;

  private bpmValue = 120;
  private volumeValue = 0.8;

  private nextStepTime = 0;
  private step = 0;
  private bar = 0;
  private history: StepEvent[] = [];

  private listeners = new Set<(event: StepEvent) => void>();

  constructor(meter: TimeSignature, grooveId: string, packId: string) {
    this.meter = meter;
    this.groove = findGroove(grooveId, meter);
    this.packId = packId;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get bpm(): number {
    return this.bpmValue;
  }

  get grooveId(): string {
    return this.groove.id;
  }

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  onStep(listener: (event: StepEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setTempo(bpm: number): void {
    this.bpmValue = Math.max(20, Math.min(400, bpm));
  }

  setVolume(volume: number): void {
    this.volumeValue = Math.max(0, Math.min(1, volume));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volumeValue, this.ctx.currentTime, 0.02);
    }
  }

  setMeter(meter: TimeSignature): void {
    this.meter = meter;
    this.groove = findGroove(this.groove.id, meter);
    this.resetBar();
  }

  setGroove(grooveId: string): void {
    this.groove = findGroove(grooveId, this.meter);
    this.resetBar();
  }

  setPack(packId: string): void {
    this.packId = packId;
    this.player?.setPack(findPack(packId));
    void this.player?.preload();
  }

  /** Debe llamarse desde un gesto del usuario: iOS lo exige. */
  async start(): Promise<void> {
    if (this.running) return;

    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volumeValue;
      this.master.connect(this.ctx.destination);
      this.player = new PackPlayer(this.ctx, findPack(this.packId));
    }

    unlockIosAudio();
    await this.ctx.resume();
    await this.player?.preload();

    this.step = 0;
    this.bar = 0;
    this.history = [];
    this.nextStepTime = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.tick(), TIMER_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.history = [];
  }

  /** Libera el contexto de audio. Llamar al desmontar la pantalla. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.player = null;
  }

  private resetBar(): void {
    this.step = 0;
    this.history = [];
  }

  private get stepDuration(): number {
    const barSeconds = (pulsesPerBar(this.meter) * 60) / this.bpmValue;
    return barSeconds / this.groove.stepsPerBar;
  }

  private tick(): void {
    const ctx = this.ctx;
    const master = this.master;
    const player = this.player;
    if (!ctx || !master || !player) return;

    // Si la pestana estuvo en segundo plano, el temporizador no corrio y
    // nextStepTime se quedo muy atras. Recolocarlo evita una rafaga de
    // golpes atrasados al volver.
    if (this.nextStepTime < ctx.currentTime - 0.5) {
      this.nextStepTime = ctx.currentTime + 0.05;
      this.step = 0;
    }

    while (this.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      this.scheduleStep(this.nextStepTime);
      this.nextStepTime += this.stepDuration;
      this.step++;
      if (this.step >= this.groove.stepsPerBar) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private scheduleStep(time: number): void {
    const master = this.master!;
    const player = this.player!;
    const step = this.step;
    const sub = this.groove.stepsPerBar / this.groove.pulsesPerBar;
    const onPulse = step % sub === 0;
    const pulse = onPulse ? step / sub : -1;
    const isDownbeat = step === 0;

    for (const role of ROLE_ORDER) {
      const track = this.groove.tracks[role];
      const velocity = track?.[step] ?? 0;
      if (velocity > 0) player.trigger(role, master, time, velocity, isDownbeat);
    }

    const event: StepEvent = { bar: this.bar, step, pulse, isDownbeat, time };
    this.history.push(event);
    if (this.history.length > HISTORY) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Donde esta el pulso AHORA, segun el reloj de audio. La interfaz
   * llama a esto desde `requestAnimationFrame`; no reacciona a eventos,
   * que es lo que produce el desfase visual tipico.
   */
  positionNow(): Position | null {
    const ctx = this.ctx;
    if (!ctx || this.history.length === 0) return null;
    const now = ctx.currentTime;

    let current: StepEvent | null = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].time <= now) {
        current = this.history[i];
        break;
      }
    }
    if (!current) return null;

    const dur = this.stepDuration;
    const stepsPerBar = this.groove.stepsPerBar;
    const within = (now - current.time) / dur;
    const phase = ((current.step + within) % stepsPerBar) / stepsPerBar;
    const sub = stepsPerBar / this.groove.pulsesPerBar;
    const pulse = Math.floor((current.step + within) / sub) % this.groove.pulsesPerBar;

    return { bar: current.bar, pulse, phase: Math.max(0, Math.min(1, phase)) };
  }

  /** Numero de pulsos del compas actual, para dibujar los indicadores. */
  get pulses(): number {
    return this.groove.pulsesPerBar;
  }
}
