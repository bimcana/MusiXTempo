/**
 * Pantalla de escucha.
 *
 * El estado visual del numero ES la confianza: gris mientras es
 * provisional, solido cuando se asienta. La app no finge saber lo que
 * todavia no sabe.
 *
 * La identificacion de cancion se lanza al PARAR, nunca mientras
 * escucha: el tempo es el objetivo principal y no comparte recursos con
 * nada.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Detector } from '../audio/detector';
import type { DetectionResult } from '../dsp/engine';
import { pulsesPerBar } from '../dsp/meter';
import { identifySnippet } from '../songid/client';
import type { IdentifyResult, StreamingLinks } from '../songid/types';
import { useApp } from '../state/store';
import { BpmDisplay, LevelMeter, PulseCanvas, type PulseState } from './components';

type Phase = 'idle' | 'listening' | 'result';

export function ListenScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [octaveShift, setOctaveShift] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [identifying, setIdentifying] = useState(false);
  const [identity, setIdentity] = useState<IdentifyResult | null>(null);

  const detectorRef = useRef<Detector | null>(null);
  const resultRef = useRef<DetectionResult | null>(null);
  const snapshotRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null);
  const saveDetection = useApp((s) => s.saveDetection);
  const openSong = useApp((s) => s.openSong);

  useEffect(() => () => detectorRef.current?.stop(), []);

  // Cronometro propio: el `elapsedMs` del motor solo llega con cada
  // resultado, y entre resultados la pantalla quedaria congelada.
  useEffect(() => {
    if (phase !== 'listening') return;
    const started = performance.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(performance.now() - started), 100);
    return () => clearInterval(id);
  }, [phase]);

  const start = async () => {
    setError(null);
    setResult(null);
    setIdentity(null);
    resultRef.current = null;
    snapshotRef.current = null;
    setOctaveShift(1);
    setTitle('');

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

  const runIdentification = useCallback(async () => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    setIdentifying(true);
    try {
      const outcome = await identifySnippet(snapshot.samples, snapshot.sampleRate);
      setIdentity(outcome);
      if (outcome.status === 'found') {
        setTitle((current) => current || outcome.match.artist + ' — ' + outcome.match.title);
      }
    } finally {
      setIdentifying(false);
    }
  }, []);

  const stop = () => {
    // El fragmento se toma ANTES de parar: `stop()` libera la captura y
    // con ella el audio que habria que enviar a identificar.
    snapshotRef.current = detectorRef.current?.snapshot() ?? null;
    detectorRef.current?.stop();
    detectorRef.current = null;

    if (!resultRef.current) {
      setPhase('idle');
      return;
    }
    setPhase('result');
    void runIdentification();
  };

  const readPulse = useCallback((): PulseState | null => {
    const ctx = detectorRef.current?.audioContext;
    const r = resultRef.current;
    if (!ctx || !r || r.bpmPulse <= 0) return null;
    const period = 60 / r.bpmPulse;
    const pulses = pulsesPerBar(r.meter);
    const barDuration = period * pulses;
    const sinceDownbeat = ctx.currentTime - r.nextDownbeatAt;
    const wrapped = ((sinceDownbeat % barDuration) + barDuration) % barDuration;
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
        bpmPulse: result.bpmPulse * octaveShift,
        bpmAlt: result.bpmAlt * octaveShift
      }
    : null;

  const save = async () => {
    if (!shown) return;
    const links = identity?.status === 'found' ? identity.match.links : undefined;
    const id = await saveDetection(title, shown, links);
    setPhase('idle');
    setResult(null);
    resultRef.current = null;
    setTitle('');
    setIdentity(null);
    openSong(id);
  };

  const discard = () => {
    setPhase('idle');
    setResult(null);
    resultRef.current = null;
    setTitle('');
    setIdentity(null);
  };

  return (
    <div className="flex flex-1 flex-col items-center px-5 pt-4 pb-8">
      {error && (
        <div className="mb-4 w-full max-w-md rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {phase === 'idle' && (
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
              bpmPulse={shown.bpmPulse}
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

          {/* La media en curso, a la vista. Sin esto la app parece
              parada mientras acumula, que es justo cuando mas trabaja. */}
          <p className="tabular text-xs text-muted">
            {(elapsed / 1000).toFixed(1)} s escuchando
            {result && result.beatsCounted > 0
              ? ' · promedio sobre ' + result.beatsCounted + ' pulsos'
              : ''}
          </p>

          <button
            type="button"
            onClick={stop}
            className="rounded-full border border-line bg-surface px-8 py-3 text-sm tracking-[0.18em] uppercase"
          >
            Parar
          </button>

          <p className="max-w-xs text-center text-xs text-muted">
            Sigue escuchando: la cifra es la media de todos los pulsos, no la última lectura.
          </p>
        </div>
      )}

      {phase === 'result' && shown && (
        <div className="flex w-full max-w-md flex-1 flex-col justify-center gap-5">
          <BpmDisplay
            bpm={shown.bpm}
            bpmPulse={shown.bpmPulse}
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

          <Identification
            state={identity}
            busy={identifying}
            onRetry={() => void runIdentification()}
          />

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

/* ------------------------------------------------------------------ */
/* Identificacion                                                      */
/* ------------------------------------------------------------------ */

const PLATFORMS: { key: keyof StreamingLinks; label: string }[] = [
  { key: 'spotify', label: 'Spotify' },
  { key: 'appleMusic', label: 'Apple Music' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'deezer', label: 'Deezer' }
];

function Identification(props: {
  state: IdentifyResult | null;
  busy: boolean;
  onRetry: () => void;
}) {
  if (props.busy) {
    return (
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
        Identificando la canción…
      </div>
    );
  }
  if (!props.state) return null;

  if (props.state.status === 'found') {
    const { match } = props.state;
    const links = PLATFORMS.filter((p) => match.links[p.key]);
    return (
      <div className="rounded-lg border border-signal/40 bg-surface px-4 py-3">
        <p className="truncate font-medium">{match.title}</p>
        <p className="truncate text-sm text-muted">
          {match.artist}
          {match.album ? ' · ' + match.album : ''}
        </p>
        {links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {links.map((p) => (
              <a
                key={p.key}
                href={match.links[p.key]}
                target="_blank"
                rel="noreferrer noopener"
                className="rounded border border-line px-2.5 py-1 text-xs text-signal no-underline"
              >
                {p.label}
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (props.state.status === 'not-found') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <span className="text-sm text-muted">
          <strong className="text-ink">No encontrada</strong> en las plataformas. Escribe el título
          tú.
        </span>
        <button type="button" onClick={props.onRetry} className="shrink-0 text-xs text-signal">
          Reintentar
        </button>
      </div>
    );
  }

  if (props.state.status === 'unconfigured') {
    // Distinto de "no encontrada", y el usuario merece saber cual es.
    return (
      <p className="text-xs text-muted">
        Identificación de canción no configurada. El tempo funciona igual: no depende de la nube.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <span className="text-sm text-muted">{props.state.message}</span>
      <button type="button" onClick={props.onRetry} className="shrink-0 text-xs text-signal">
        Reintentar
      </button>
    </div>
  );
}
