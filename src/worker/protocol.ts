import type { DetectionResult } from '../dsp/engine';

export type ToWorker =
  | { type: 'init'; sampleRate: number }
  | { type: 'samples'; samples: Float32Array; time: number }
  | { type: 'tap-reference'; bpm: number; quality: number }
  | { type: 'reset' };

export type FromWorker =
  | { type: 'ready'; frameRate: number }
  | { type: 'result'; result: DetectionResult };
