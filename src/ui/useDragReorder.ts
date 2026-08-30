/**
 * Reordenacion por arrastre.
 *
 * La fila sigue al dedo y las demas se apartan en vivo. Todo el
 * movimiento se aplica como `transform` directamente sobre el DOM: React
 * no vuelve a renderizar en ningun frame del arrastre, igual que el
 * indicador de pulso. Un reorder que provoque un render por movimiento
 * de dedo se siente pegajoso en movil, y eso es justo lo que hay que
 * evitar en el control que existe para no ir de uno en uno.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Margen desde el borde donde la lista empieza a desplazarse sola. */
const AUTOSCROLL_EDGE = 72;
const AUTOSCROLL_SPEED = 14;

interface DragState {
  from: number;
  to: number;
  pointerId: number;
  startY: number;
  lastY: number;
  /** Geometria de las filas congelada al empezar. */
  tops: number[];
  heights: number[];
  height: number;
  gap: number;
}

export interface DragReorder {
  listRef: React.RefObject<HTMLUListElement | null>;
  /** Indice que se esta arrastrando, o null. */
  dragging: number | null;
  begin: (index: number, event: React.PointerEvent) => void;
}

export function useDragReorder(
  count: number,
  onCommit: (from: number, to: number) => void
): DragReorder {
  const listRef = useRef<HTMLUListElement | null>(null);
  const stateRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const [dragging, setDragging] = useState<number | null>(null);

  const rows = useCallback((): HTMLElement[] => {
    const list = listRef.current;
    if (!list) return [];
    return Array.from(list.children) as HTMLElement[];
  }, []);

  /** Coloca cada fila donde le toca segun el destino actual. */
  const paint = useCallback(() => {
    const state = stateRef.current;
    if (!state) return;
    const items = rows();
    const shift = state.height + state.gap;

    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      if (i === state.from) {
        el.style.transform = 'translateY(' + (state.lastY - state.startY) + 'px)';
        continue;
      }
      let offset = 0;
      if (state.to > state.from && i > state.from && i <= state.to) offset = -shift;
      else if (state.to < state.from && i >= state.to && i < state.from) offset = shift;
      el.style.transform = offset ? 'translateY(' + offset + 'px)' : '';
    }
  }, [rows]);

  /** Sobre que fila esta el dedo, usando la geometria congelada. */
  const resolveTarget = useCallback((clientY: number): number => {
    const state = stateRef.current;
    if (!state) return 0;
    const center = clientY - state.startY + state.tops[state.from] + state.height / 2;
    for (let i = 0; i < state.tops.length; i++) {
      if (center < state.tops[i] + state.heights[i]) return i;
    }
    return state.tops.length - 1;
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const state = stateRef.current;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      stateRef.current = null;
      setDragging(null);

      for (const el of rows()) {
        el.style.transform = '';
        el.style.transition = '';
        el.style.zIndex = '';
      }
      if (state && commit && state.to !== state.from) onCommit(state.from, state.to);
    },
    [onCommit, rows]
  );

  useEffect(() => {
    if (dragging === null) return;

    const onMove = (event: PointerEvent) => {
      const state = stateRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      event.preventDefault();
      state.lastY = event.clientY;
      state.to = resolveTarget(event.clientY);
      paint();

      // Autodesplazamiento al acercarse a los bordes: sin esto no se
      // puede mover una cancion mas alla de lo que cabe en pantalla.
      const viewport = window.innerHeight;
      let velocity = 0;
      if (event.clientY < AUTOSCROLL_EDGE) {
        velocity = -AUTOSCROLL_SPEED * (1 - event.clientY / AUTOSCROLL_EDGE);
      } else if (event.clientY > viewport - AUTOSCROLL_EDGE) {
        velocity = AUTOSCROLL_SPEED * (1 - (viewport - event.clientY) / AUTOSCROLL_EDGE);
      }

      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (velocity !== 0) {
        const step = () => {
          if (!stateRef.current) return;
          window.scrollBy(0, velocity);
          stateRef.current.to = resolveTarget(stateRef.current.lastY);
          paint();
          rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
      }
    };

    const onUp = (event: PointerEvent) => {
      if (stateRef.current && event.pointerId !== stateRef.current.pointerId) return;
      finish(true);
    };
    const onCancel = () => finish(false);

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [dragging, finish, paint, resolveTarget]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const begin = useCallback(
    (index: number, event: React.PointerEvent) => {
      if (count < 2) return;
      const items = rows();
      if (items.length !== count) return;

      const rects = items.map((el) => el.getBoundingClientRect());
      const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;

      stateRef.current = {
        from: index,
        to: index,
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        tops: rects.map((r) => r.top),
        heights: rects.map((r) => r.height),
        height: rects[index].height,
        gap
      };

      for (let i = 0; i < items.length; i++) {
        // La fila arrastrada no interpola: debe pegarse al dedo. Las
        // demas si, para que apartarse se lea como un movimiento.
        items[i].style.transition = i === index ? 'none' : 'transform 140ms ease';
        if (i === index) items[i].style.zIndex = '20';
      }

      if (navigator.vibrate) navigator.vibrate(8);
      setDragging(index);
    },
    [count, rows]
  );

  return { listRef, dragging, begin };
}
