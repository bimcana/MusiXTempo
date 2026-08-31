/**
 * Piezas compartidas de interfaz.
 *
 * Todo lo que se mueve a 60 fps se dibuja en canvas contra el reloj de
 * audio, fuera del ciclo de render de React. React nunca deberia estar
 * en el camino de una animacion sincronizada con sonido.
 */

import { useEffect, useRef, useState } from 'react';
import type { DetectionStage } from '../dsp/engine';
import { formatTimeSignature, type TimeSignature } from '../dsp/meter';
import { TapTrainer } from '../dsp/tap';

/* ------------------------------------------------------------------ */
/* Lectura de BPM                                                      */
/* ------------------------------------------------------------------ */

const STAGE_LABEL: Record<DetectionStage, string> = {
  provisional: 'Provisional',
  stable: 'Estable',
  refined: 'Refinado'
};

export function BpmDisplay(props: {
  /** Negras por minuto: el titular. */
  bpm: number;
  /** Pulso sentido: lo que se cuenta con el pie. */
  bpmPulse: number;
  bpmAlt: number;
  meter: TimeSignature;
  meterLabel: string;
  stage?: DetectionStage;
  confidence?: number;
  dim?: boolean;
}) {
  // En compas simple el pulso ES la negra, y repetir el numero solo
  // anade ruido. En compuesto son cosas distintas y hay que decirlo.
  const compound = props.bpmPulse > 0 && Math.abs(props.bpmPulse - props.bpm) > 0.15;

  return (
    <div className="flex flex-col items-center">
      <div
        className={
          'tabular font-semibold leading-none tracking-tight transition-colors duration-300 ' +
          (props.dim ? 'text-muted' : 'text-ink')
        }
        style={{ fontSize: 'clamp(4.5rem, 24vw, 8rem)' }}
      >
        {props.bpm.toFixed(1)}
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-sm tracking-[0.2em] text-muted uppercase">BPM ♩</span>
        <span
          className={
            'tabular rounded px-2 py-0.5 text-lg font-semibold ' +
            (props.dim ? 'bg-surface-2 text-muted' : 'bg-signal-dim text-signal')
          }
        >
          {props.meterLabel}
        </span>
      </div>

      {/* El titular son negras, la convencion de cualquier DAW y lo que
          se teclea en un click. Pero en compas compuesto la negra no es
          lo que cuentas con el pie, asi que el pulso sentido va justo
          debajo: sin eso, 6/8 significa dos cosas distintas segun quien
          lo lea. */}
      {compound && (
        <div className="tabular mt-2 text-sm text-muted">
          pulso {props.bpmPulse.toFixed(1)} · {props.bpmAlt.toFixed(1)} corcheas
        </div>
      )}
      {!compound && (
        <div className="tabular mt-2 text-sm text-muted">
          = {props.bpmAlt.toFixed(1)} corcheas
        </div>
      )}

      {props.stage && (
        <div className="mt-4 flex items-center gap-2">
          <ConfidenceBar value={props.confidence ?? 0} />
          <span className="text-xs tracking-[0.14em] text-muted uppercase">
            {STAGE_LABEL[props.stage]}
          </span>
        </div>
      )}
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
      <div
        className="h-full rounded-full bg-signal transition-[width] duration-300"
        style={{ width: Math.round(Math.max(0, Math.min(1, value)) * 100) + '%' }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Indicador de pulso                                                  */
/* ------------------------------------------------------------------ */

export interface PulseState {
  /** Avance dentro del compas, 0..1. */
  phase: number;
  pulse: number;
  pulses: number;
  active: boolean;
}

/**
 * Anillo de pulso. Se redibuja en cada frame preguntando "donde deberia
 * estar el pulso ahora", no reaccionando a eventos — que es lo que hace
 * que un metronomo web se vea desfasado del sonido que emite.
 */
export function PulseCanvas({ read, size = 200 }: { read: () => PulseState | null; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const draw = () => {
      const state = readRef.current();
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.38;

      ctx.clearRect(0, 0, w, h);

      // Aro base
      ctx.strokeStyle = '#262f38';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      if (!state || !state.active) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // Arco recorrido del compas
      const start = -Math.PI / 2;
      ctx.strokeStyle = '#f5b33f';
      ctx.lineWidth = 3 * dpr;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, start + state.phase * Math.PI * 2);
      ctx.stroke();

      // Marcas de pulso, con el uno mas grande
      for (let i = 0; i < state.pulses; i++) {
        const angle = start + (i / state.pulses) * Math.PI * 2;
        const px = cx + Math.cos(angle) * radius;
        const py = cy + Math.sin(angle) * radius;
        const isCurrent = i === state.pulse;
        const r = (i === 0 ? 7 : 5) * dpr * (isCurrent ? 1.5 : 1);
        ctx.fillStyle = isCurrent ? '#ffc96b' : i === 0 ? '#8d98a6' : '#39434e';
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Numero del pulso en curso. El peso NO se escala por dpr: solo el
      // tamano. Un `font-weight: 1200` es invalido y el canvas cae en
      // silencio a una fuente por defecto diminuta.
      ctx.fillStyle = '#e6eaef';
      ctx.font = '600 ' + Math.round(size * 0.26 * dpr) + 'px ' + getComputedStyle(canvas).fontFamily;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(state.pulse + 1), cx, cy + 2 * dpr);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={canvasRef} style={{ width: size, height: size }} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Rejilla de pasos                                                    */
/* ------------------------------------------------------------------ */

export function StepGrid(props: {
  tracks: { label: string; steps: number[] }[];
  stepsPerBar: number;
  stepsPerPulse: number;
  read: () => number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const readRef = useRef(props.read);
  readRef.current = props.read;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let raf = 0;
    let previous = -1;

    const tick = () => {
      const step = readRef.current();
      if (step !== previous) {
        const cells = wrap.querySelectorAll<HTMLElement>('[data-step]');
        for (const cell of cells) {
          const isNow = Number(cell.dataset.step) === step;
          cell.style.outline = isNow ? '2px solid #f5b33f' : 'none';
          cell.style.outlineOffset = isNow ? '1px' : '0';
        }
        previous = step ?? -1;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={wrapRef} className="flex flex-col gap-1.5">
      {props.tracks.map((track) => (
        <div key={track.label} className="grid grid-cols-[3.2rem_1fr] items-center gap-2">
          <span className="text-[0.65rem] tracking-[0.08em] text-muted uppercase">{track.label}</span>
          <div className="flex gap-1">
            {Array.from({ length: props.stepsPerBar }, (_, i) => {
              const velocity = track.steps[i] ?? 0;
              const isPulse = i % props.stepsPerPulse === 0;
              return (
                <div
                  key={i}
                  data-step={i}
                  className={
                    'h-6 flex-1 rounded-sm border transition-colors ' +
                    (velocity > 0
                      ? 'border-signal'
                      : isPulse
                        ? 'border-line bg-surface-2'
                        : 'border-line-soft bg-surface')
                  }
                  style={
                    velocity > 0
                      ? { background: 'rgba(245, 179, 63, ' + (0.25 + velocity * 0.7) + ')' }
                      : undefined
                  }
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Controles                                                           */
/* ------------------------------------------------------------------ */

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div>
      {props.label && (
        <div className="mb-1.5 text-[0.65rem] tracking-[0.14em] text-muted uppercase">
          {props.label}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => props.onChange(option.value)}
            className={
              'rounded border px-3 py-1.5 text-sm transition-colors ' +
              (option.value === props.value
                ? 'border-signal bg-signal-dim text-signal'
                : 'border-line bg-surface text-muted hover:text-ink')
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Hoja inferior. Es el mismo patron que ya usa la biblioteca para sus
 * acciones, y a diferencia de un `<select>` nativo deja meter controles
 * dentro de cada fila — que es lo que hace falta para marcar favoritos
 * sin salir de la lista.
 */
export function Sheet(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={props.onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="safe-bottom relative mx-auto flex max-h-[78vh] w-full max-w-lg flex-col rounded-t-2xl border-t border-line bg-surface">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-sm tracking-[0.14em] text-muted uppercase">{props.title}</h2>
          <button type="button" onClick={props.onClose} className="px-2 py-1 text-sm text-signal">
            Listo
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{props.children}</div>
      </div>
    </div>
  );
}

/**
 * Marca circular de favorito. Se dibuja en SVG y no con un caracter,
 * para que el relleno y el trazo respondan al tema sin depender de como
 * cada sistema renderice un emoji.
 */
export function CircleCheck({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" className="shrink-0">
      <circle
        cx="12"
        cy="12"
        r="10"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
      />
      {on && (
        <path
          d="M7.4 12.4l3.1 3.1 6.1-6.4"
          fill="none"
          stroke="#0e1216"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const METER_CHOICES: TimeSignature[] = [
  { beatsPerBar: 4, beatUnit: 4 },
  { beatsPerBar: 6, beatUnit: 8 },
  { beatsPerBar: 3, beatUnit: 4 },
  { beatsPerBar: 2, beatUnit: 4 },
  { beatsPerBar: 12, beatUnit: 8 },
  { beatsPerBar: 9, beatUnit: 8 },
  { beatsPerBar: 5, beatUnit: 4 },
  { beatsPerBar: 7, beatUnit: 8 }
];

export function MeterPicker(props: { value: TimeSignature; onChange: (m: TimeSignature) => void }) {
  return (
    <Segmented
      label="Métrica"
      value={formatTimeSignature(props.value)}
      options={METER_CHOICES.map((m) => ({
        value: formatTimeSignature(m),
        label: formatTimeSignature(m)
      }))}
      onChange={(key) => {
        const found = METER_CHOICES.find((m) => formatTimeSignature(m) === key);
        if (found) props.onChange(found);
      }}
    />
  );
}

/**
 * Tap tempo por regresion sobre toda la tanda (TapTrainer): el error
 * humano de cada toque se promedia hacia cero, y un toque mal dado
 * queda fuera del ajuste sin descarrilar la cifra.
 */
export function TapTempo({ onTempo }: { onTempo: (bpm: number) => void }) {
  const trainer = useRef(new TapTrainer());
  const [count, setCount] = useState(0);

  const tap = () => {
    const estimate = trainer.current.add(performance.now());
    setCount(trainer.current.count);
    if (estimate && estimate.count >= 3) onTempo(estimate.bpm);
  };

  return (
    <button
      type="button"
      onClick={tap}
      className="w-full rounded-lg border border-line bg-surface-2 py-4 text-center text-sm tracking-[0.14em] uppercase transition-colors active:border-signal active:text-signal"
    >
      {count < 3 ? 'Toca el pulso · ' + count + '/3' : 'Toca para afinar'}
    </button>
  );
}

export function LevelMeter({ level, clipping }: { level: number; clipping: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-32 overflow-hidden rounded-full bg-surface-2">
        <div
          className={'h-full transition-[width] duration-100 ' + (clipping ? 'bg-danger' : 'bg-ok')}
          style={{ width: Math.round(Math.min(1, level) * 100) + '%' }}
        />
      </div>
      {clipping && <span className="text-xs text-danger">Saturando · aleja el micro</span>}
    </div>
  );
}
