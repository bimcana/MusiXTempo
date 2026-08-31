/**
 * Selector de sonido del metronomo.
 *
 * Con 35 sonidos, una lista plana obliga a recorrerla entera cada vez.
 * Los favoritos suben arriba del todo, asi que los cuatro o cinco que
 * uno usa de verdad quedan siempre a la vista sin buscar.
 *
 * La marca de favorito vive DENTRO de cada fila y no cierra la hoja al
 * pulsarla: marcar varios de golpe es el caso normal, y cerrar tras cada
 * marca convertiria una tarea en cinco.
 */

import { useState } from 'react';
import { PACKS, PACK_FAMILIES, findPack, type Pack } from '../metronome/packs';
import { useApp } from '../state/store';
import { CircleCheck, Sheet } from './components';

export function SoundPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const favorites = useApp((s) => s.favoriteSounds);
  const toggleFavorite = useApp((s) => s.toggleFavoriteSound);
  const current = findPack(value);

  const groups: { name: string; packs: Pack[] }[] = [];
  const favoritePacks = favorites
    .map((id) => PACKS.find((p) => p.id === id))
    .filter((p): p is Pack => Boolean(p));
  if (favoritePacks.length > 0) groups.push({ name: 'Favoritos', packs: favoritePacks });

  for (const family of PACK_FAMILIES) {
    // Un favorito sigue apareciendo en su familia: quitarlo de ahi
    // rompe la memoria de donde estaba.
    const packs = PACKS.filter((p) => p.family === family);
    if (packs.length > 0) groups.push({ name: family, packs });
  }

  return (
    <div>
      <div className="mb-1.5 text-[0.65rem] tracking-[0.14em] text-muted uppercase">Sonido</div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between rounded-lg border border-line bg-surface px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate">{current.name}</span>
          <span className="block truncate text-xs text-muted">{current.description}</span>
        </span>
        <span className="ml-3 shrink-0 text-signal" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <Sheet title="Sonido" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <section key={group.name}>
                <h3 className="mb-1.5 text-[0.65rem] tracking-[0.14em] text-muted uppercase">
                  {group.name}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {group.packs.map((pack) => (
                    <li key={group.name + ':' + pack.id} className="flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onChange(pack.id);
                          setOpen(false);
                        }}
                        aria-current={pack.id === value ? 'true' : undefined}
                        className={
                          'flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors ' +
                          (pack.id === value
                            ? 'border-signal bg-signal-dim'
                            : 'border-line bg-surface-2')
                        }
                      >
                        <span
                          className={
                            'block truncate ' + (pack.id === value ? 'text-signal' : 'text-ink')
                          }
                        >
                          {pack.name}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {pack.description}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleFavorite(pack.id)}
                        aria-pressed={favorites.includes(pack.id)}
                        aria-label={
                          (favorites.includes(pack.id) ? 'Quitar de favoritos: ' : 'Marcar como favorito: ') +
                          pack.name
                        }
                        className={
                          'flex w-12 shrink-0 items-center justify-center rounded-lg border transition-colors ' +
                          (favorites.includes(pack.id)
                            ? 'border-signal bg-surface-2 text-signal'
                            : 'border-line bg-surface-2 text-muted')
                        }
                      >
                        <CircleCheck on={favorites.includes(pack.id)} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}
