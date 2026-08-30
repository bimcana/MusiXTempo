/**
 * Packs de sonido.
 *
 * Un pack mapea ROLES a voces. El scheduler solo conoce roles, y un
 * slot puede ser una voz sintetizada o un sample remoto sin que nada
 * mas cambie: anadir tus propios WAV es soltar un pack con URLs, sin
 * tocar una linea del motor.
 */

import type { Role } from './grooves';
import { DEFAULT_PARAMS, type VoiceParams, getVoice } from './voices';

export type PackSlot =
  | { kind: 'synth'; voiceId: string; params?: Partial<VoiceParams> }
  | { kind: 'sample'; url: string; gain?: number };

export interface Pack {
  id: string;
  name: string;
  description: string;
  slots: Record<Role, PackSlot>;
}

const synth = (voiceId: string, params?: Partial<VoiceParams>): PackSlot => ({
  kind: 'synth',
  voiceId,
  params
});

export const PACKS: Pack[] = [
  {
    id: 'classic',
    name: 'Clásico',
    description: 'El click de toda la vida, con kit 808 debajo.',
    slots: {
      accent: synth('blip', { tune: 2 }),
      beat: synth('click'),
      sub: synth('click', { gain: 0.4, tune: -5 }),
      kick: synth('kick808'),
      snare: synth('snare808'),
      hat: synth('hatClosed')
    }
  },
  {
    id: 'wood',
    name: 'Madera',
    description: 'Woodblock y clave. Corta bien encima de una banda.',
    slots: {
      accent: synth('clave'),
      beat: synth('woodblock'),
      sub: synth('stick', { gain: 0.45 }),
      kick: synth('kickAcoustic'),
      snare: synth('rim'),
      hat: synth('shaker')
    }
  },
  {
    id: 'electro',
    name: 'Electro',
    description: 'Beeps limpios y kit 909.',
    slots: {
      accent: synth('beep', { tune: 5, tone: 0.8 }),
      beat: synth('beep'),
      sub: synth('blip', { gain: 0.4 }),
      kick: synth('kick909'),
      snare: synth('snare909'),
      hat: synth('hatClosed', { tone: 0.8 })
    }
  },
  {
    id: 'acoustic',
    name: 'Acústico',
    description: 'Baqueta y bombo acústico. El más cercano a una batería.',
    slots: {
      accent: synth('stick', { tune: 4 }),
      beat: synth('stick'),
      sub: synth('stick', { gain: 0.35, tune: -7 }),
      kick: synth('kickAcoustic'),
      snare: synth('snare808', { tone: 0.65 }),
      hat: synth('hatClosed', { decay: 0.85 })
    }
  },
  {
    id: 'perc',
    name: 'Percusión',
    description: 'Cencerro, pandereta y palmadas.',
    slots: {
      accent: synth('cowbell'),
      beat: synth('clave', { gain: 0.7 }),
      sub: synth('shaker', { gain: 0.45 }),
      kick: synth('kick808', { tune: 3, decay: 0.7 }),
      snare: synth('clap'),
      hat: synth('tambourine')
    }
  },
  {
    id: 'bells',
    name: 'Campanas',
    description: 'Suave, para ensayar sin fatiga auditiva.',
    slots: {
      accent: synth('bell', { tune: 5 }),
      beat: synth('bell', { gain: 0.6 }),
      sub: synth('blip', { gain: 0.3 }),
      kick: synth('kick808', { decay: 1.3 }),
      snare: synth('rim'),
      hat: synth('shaker', { gain: 0.5 })
    }
  }
];

export const DEFAULT_PACK_ID = 'classic';

export function findPack(id: string): Pack {
  return PACKS.find((p) => p.id === id) ?? PACKS[0];
}

/**
 * Resuelve los slots de un pack a algo disparable. Los samples se
 * descargan y decodifican una vez y se quedan en memoria; si uno falla,
 * el rol cae a su voz sintetizada equivalente en lugar de enmudecer.
 */
export class PackPlayer {
  private readonly buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private pack: Pack
  ) {}

  get id(): string {
    return this.pack.id;
  }

  setPack(pack: Pack): void {
    this.pack = pack;
    this.loading = null;
  }

  /** Precarga los samples del pack, si los tiene. Los synth no hacen nada. */
  async preload(): Promise<void> {
    if (this.loading) return this.loading;
    const urls = Object.values(this.pack.slots)
      .filter((s): s is Extract<PackSlot, { kind: 'sample' }> => s.kind === 'sample')
      .map((s) => s.url)
      .filter((u) => !this.buffers.has(u));

    this.loading = Promise.all(
      urls.map(async (url) => {
        try {
          const response = await fetch(url);
          const data = await response.arrayBuffer();
          this.buffers.set(url, await this.ctx.decodeAudioData(data));
        } catch {
          /* Se queda sin buffer y el rol cae a la voz sintetizada. */
        }
      })
    ).then(() => undefined);

    return this.loading;
  }

  trigger(role: Role, out: AudioNode, time: number, velocity: number, accent: boolean): void {
    const slot = this.pack.slots[role];
    if (!slot) return;

    if (slot.kind === 'sample') {
      const buffer = this.buffers.get(slot.url);
      if (buffer) {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        const g = this.ctx.createGain();
        g.gain.value = velocity * (slot.gain ?? 1) * (accent ? 1 : 0.75);
        src.connect(g);
        g.connect(out);
        src.start(time);
        return;
      }
    }

    const voiceId = slot.kind === 'synth' ? slot.voiceId : fallbackVoice(role);
    const overrides = slot.kind === 'synth' ? slot.params : undefined;
    const params: VoiceParams = {
      ...DEFAULT_PARAMS,
      ...overrides,
      gain: (overrides?.gain ?? DEFAULT_PARAMS.gain) * velocity,
      accent
    };
    getVoice(voiceId).render(this.ctx, out, time, params);
  }
}

function fallbackVoice(role: Role): string {
  switch (role) {
    case 'kick':
      return 'kick808';
    case 'snare':
      return 'snare808';
    case 'hat':
      return 'hatClosed';
    case 'accent':
      return 'blip';
    default:
      return 'click';
  }
}
