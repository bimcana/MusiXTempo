/**
 * Pantalla de escucha.
 *
 * El estado visual del numero ES la confianza: gris mientras es
 * provisional, solido cuando se asienta. La app no finge saber lo que
 * todavia no sabe.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Detector } from '../audio/detector';
import type { DetectionResult } from '../dsp/engine';
import { pulsesPerBar } from '../dsp/meter';
import { useApp } from '../state/store';
import { BpmDisplay, LevelMeter, PulseCanvas, type PulseState } from './components';

type Phase = 'idle' | 'listening' | 'result';

export function ListenScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [octaveShift, setOctaveShift] = useState(1);

  const detectorRef = useRef<Detector | null>(null);
  const resultRef = useRef<DetectionResult | null>(null);
  const saveDetection = useApp((s) => s.saveDetection);
  const openSong = useApp((s) => s.openSong);

  useEffect(() => {
    return () => detectorRef.current?.stop();
  }, []);

  const start = async () => {
    setError(null);
    setResult(null);
    resultRef.current = null;
    setOctaveShift(1);

    const detector = new Detector({
      onResult: (r) => {
        resultRef.current = r;
        setResult(r);
      },
      onError: (e) => setError(e.message)
    });
    detectorRef.current = detector;

    try {
      await detector.start();
      setPhase('listening');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        message.includes('Permission') || message.includes('NotAllowed')
          ? 'Sin permiso de micrófono. Actívalo en los ajustes del navegador y vuelve a intentarlo.'
          : message
      );
      detector.stop();
      detectorRef.current = null;
    }
  };

  const stop = () => {
    detectorRef.current?.stop();
    detectorRef.current = null;
    setPhase(resultRef.current ? 'result' : 'idle');
  };

  const readPulse = useCallback((): PulseState | null => {
    const ctx = detectorRef.current?.audioContext;
    const r = resultRef.current;
    if (!ctx || !r || r.bpm <= 0) return null;
    const period = 60 / r.bpm;
    const pulses = pulsesPerBar(r.meter);
    const barDuration = period * pulses;
    const elapsed = ctx.currentTime - r.nextDownbeatAt;
    const wrapped = ((elapsed % barDuration) + barDuration) % barDuration;
    const phaseValue = wrapped / barDuration;
    return {
      phase: phaseValue,
      pulse: Math.floor(phaseValue * pulses) % pulses,
      pulses,
      active: true
    };
  }, []);

  const shown = result
    ? {
        ...result,
        bpm: result.bpm * octaveShift,
        bpmAlt: result.bpmAlt * octaveShift
      }
    : null;

  const save = async () => {
    if (!shown) return;
    const id = await saveDetection(title, shown);
    setPhase('idle');
    setResult(null);
    resultRef.current = null;
    setTitle('');
    openSong(id);
  };

  const discard = () => {
    setPhase('idle');
    setResult(null);
    resultRef.current = null;
    setTitle('');
  };

  return (
    <div className="flex min-h-full flex-col items-center px-5 pt-4 pb-8">
      {error && (
        <div className="mb-4 w-full max-w-md rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {phase === 'idle' && !result && (
        <div className="flex flex-1 flex-col items-center justify-center gap-8">
          <p className="max-w-xs text-center text-muted">
            Pon la música cerca del micrófono. También vale un tarareo, si es continuo.
          </p>
          <button
            type="button"
            onClick={start}
            className="flex h-44 w-44 flex-col items-center justify-center gap-2 rounded-full border-2 border-signal bg-signal-dim text-signal transition-transform active:scale-95"
          >
            <span className="text-4xl leading-none">●</span>
            <span className="text-sm tracking-[0.18em] uppercase">Escuchar</span>
          </button>
        </div>
      )}

      {phase === 'listening' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <PulseCanvas read={readPulse} size={190} />

          {shown ? (
            <BpmDisplay
              bpm={shown.bpm}
              bpmAlt={shown.bpmAlt}
              meter={shown.meter}
              meterLabel={shown.meterLabel}
              stage={shown.stage}
              confidence={shown.confidence}
              dim={shown.stage === 'provisional'}
            />
          ) : (
            <p className="tabular text-muted">Escuchando…</p>
          )}

          <LevelMeter level={result?.level ?? 0} clipping={result?.clipping ?? false} />

          <button
            type="button"
            onClick={stop}
            className="rounded-full border border-line bg-surface px-8 py-3 text-sm tracking-[0.18em] uppercase"
          >
            Parar
          </button>

          <p className="max-w-xs text-center text-xs text-muted">
            Sigue escuchando: cuanto más tiempo, más afina.
          </p>
        </div>
      )}

      {phase === 'result' && shown && (
        <div className="flex w-full max-w-md flex-1 flex-col justify-center gap-6">
          <BpmDisplay
            bpm={shown.bpm}
            bpmAlt={shown.bpmAlt}
            meter={shown.meter}
            meterLabel={shown.meterLabel}
            stage={shown.stage}
            confidence={shown.confidence}
          />

          <div className="flex items-center justify-center gap-3">
            <span className="text-xs tracking-[0.14em] text-muted uppercase">Octava</span>
            <button
              type="button"
              onClick={() => setOctaveShift((v) => v / 2)}
              className="rounded border border-line bg-surface px-4 py-2 text-sm"
            >
              ÷2
            </button>
            <button
              type="button"
              onClick={() => setOctaveShift(1)}
              className="rounded border border-line bg-surface px-4 py-2 text-sm"
            >
              Original
            </button>
            <button
              type="button"
              onClick={() => setOctaveShift((v) => v * 2)}
              className="rounded border border-line bg-surface px-4 py-2 text-sm"
            >
              ×2
            </button>
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título de la canción"
            className="w-full rounded-lg border border-line bg-surface px-4 py-3 outline-none placeholder:text-muted focus:border-signal"
          />

          <div className="flex gap-3">
            <button
              type="button"
              onClick={discard}
              className="flex-1 rounded-lg border border-line bg-surface py-3 text-sm tracking-[0.14em] text-muted uppercase"
            >
              Descartar
            </button>
            <button
              type="button"
              onClick={save}
              className="flex-1 rounded-lg border border-signal bg-signal-dim py-3 text-sm tracking-[0.14em] text-signal uppercase"
            >
              Guardar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
