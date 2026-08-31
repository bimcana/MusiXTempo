/**
 * Packs de sonido.
 *
 * Un pack mapea ROLES a voces. El scheduler solo conoce roles, y un slot
 * puede ser una voz sintetizada o un sample remoto sin que nada mas
 * cambie: anadir tus propios WAV es soltar un pack con URLs, sin tocar
 * el motor.
 *
 * La lista sigue el vocabulario de los clicks de un DAW — Click II de
 * Pro Tools, Klopfgeist de Logic, los click sounds de Cubase — y va
 * agrupada por familia para que el desplegable se pueda recorrer sin
 * leerlo entero.
 */

import type { Role } from './grooves';
import { DEFAULT_PARAMS, type VoiceParams, getVoice } from './voices';

export type PackSlot =
  | { kind: 'synth'; voiceId: string; params?: Partial<VoiceParams> }
  | { kind: 'sample'; url: string; gain?: number };

export type PackFamily = 'Clicks' | 'Madera' | 'Metal' | 'Láminas' | 'Percusión' | 'Kit' | 'Mecánico';

export interface Pack {
  id: string;
  name: string;
  family: PackFamily;
  description: string;
  slots: Record<Role, PackSlot>;
}

const synth = (voiceId: string, params?: Partial<VoiceParams>): PackSlot => ({
  kind: 'synth',
  voiceId,
  params
});

/** Kit por defecto bajo los packs de click, para que los grooves suenen igual. */
const DEFAULT_KIT = {
  kick: synth('kick808'),
  snare: synth('snare808'),
  hat: synth('hatClosed')
};

/**
 * Un pack de click: la misma voz en los tres roles de pulso, separada
 * por altura. Es como suena un click de DAW — no cambia de timbre entre
 * el uno y el resto, cambia de tono.
 */
function clickPack(
  id: string,
  name: string,
  family: PackFamily,
  description: string,
  voiceId: string,
  kit: Partial<Record<'kick' | 'snare' | 'hat', PackSlot>> = {}
): Pack {
  return {
    id,
    name,
    family,
    description,
    slots: {
      accent: synth(voiceId),
      beat: synth(voiceId, { gain: 0.7 }),
      sub: synth(voiceId, { gain: 0.38, tune: -5, decay: 0.7 }),
      ...DEFAULT_KIT,
      ...kit
    }
  };
}

export const PACKS: Pack[] = [
  // --- Clicks digitales ---
  clickPack('click', 'Click', 'Clicks', 'El click de toda la vida.', 'click'),
  clickPack('beep', 'Beep', 'Clicks', 'Cuadrada filtrada, estilo Cubase.', 'beep'),
  clickPack('blip', 'Blip', 'Clicks', 'Triangular corta, muy limpia.', 'blip'),
  clickPack('ping', 'Ping', 'Clicks', 'Agudo con cola. Corta sobre banda fuerte.', 'ping'),
  clickPack('pip', 'Pip', 'Clicks', 'Lo más breve posible. Casi un tick.', 'pip'),
  clickPack('noiseClick', 'Click de ruido', 'Clicks', 'Sin altura definida: no choca con la tonalidad.', 'noiseClick'),

  // --- Madera ---
  clickPack('woodblock', 'Woodblock', 'Madera', 'El clásico de Logic. Corta sin ser estridente.', 'woodblock'),
  clickPack('woodblockLow', 'Woodblock grave', 'Madera', 'Más cuerpo, menos fatiga en ensayos largos.', 'woodblockLow'),
  clickPack('templeBlock', 'Temple block', 'Madera', 'Madera hueca, cálido.', 'templeBlock'),
  clickPack('clave', 'Clave', 'Madera', 'Seco y muy agudo. Atraviesa cualquier mezcla.', 'clave'),
  clickPack('castanet', 'Castañuela', 'Madera', 'Ataque brevísimo, sin altura.', 'castanet'),
  clickPack('stick', 'Baquetas', 'Madera', 'Dos baquetas. Lo más parecido a contar en vivo.', 'stick', {
    kick: synth('kickAcoustic'),
    snare: synth('rim')
  }),
  clickPack('rim', 'Rim', 'Madera', 'Aro de caja, con algo de cuerpo.', 'rim'),
  clickPack('sidestick', 'Cross-stick', 'Madera', 'Baqueta cruzada sobre el parche.', 'sidestick', {
    kick: synth('kickAcoustic'),
    snare: synth('snare808', { tone: 0.65 })
  }),

  // --- Metal ---
  clickPack('bell', 'Campana', 'Metal', 'Suave y con cola. Para ensayar sin fatiga.', 'bell'),
  clickPack('cowbell', 'Cencerro', 'Metal', 'El 808 de siempre. Imposible de perder.', 'cowbell'),
  {
    id: 'agogo',
    name: 'Agogo',
    family: 'Metal',
    description: 'Dos campanas: aguda en el uno, grave en el resto.',
    slots: {
      accent: synth('agogoHigh'),
      beat: synth('agogoLow'),
      sub: synth('agogoLow', { gain: 0.35, decay: 0.6 }),
      ...DEFAULT_KIT
    }
  },
  clickPack('triangle', 'Triángulo', 'Metal', 'Cola larga y brillante.', 'triangle'),
  clickPack('cymbal', 'Platillo', 'Metal', 'Ruido metálico ancho.', 'cymbal'),

  // --- Láminas ---
  clickPack('marimba', 'Marimba', 'Láminas', 'Con altura y cuerpo. Estilo Click II.', 'marimba'),
  clickPack('vibraphone', 'Vibráfono', 'Láminas', 'Cola larga, muy poco agresivo.', 'vibraphone'),
  clickPack('glockenspiel', 'Glockenspiel', 'Láminas', 'Brillante y penetrante.', 'glockenspiel'),
  clickPack('kalimba', 'Kalimba', 'Láminas', 'Cálido, con ataque de púa.', 'kalimba'),

  // --- Percusión ---
  clickPack('shaker', 'Shaker', 'Percusión', 'Sin altura, muy discreto.', 'shaker'),
  clickPack('cabasa', 'Cabasa', 'Percusión', 'Como un shaker con más grano.', 'cabasa'),
  clickPack('tambourine', 'Pandereta', 'Percusión', 'Brillante y con cola.', 'tambourine'),
  clickPack('clap', 'Palmada', 'Percusión', 'Tres reflexiones, como una palmada real.', 'clap'),
  clickPack('snap', 'Chasquido', 'Percusión', 'Chasquido de dedos, muy corto.', 'snap'),
  clickPack('conga', 'Conga', 'Percusión', 'Parche grave con ataque de mano.', 'conga'),
  clickPack('bongo', 'Bongo', 'Percusión', 'Parche agudo, seco.', 'bongo'),

  // --- Kit de batería ---
  {
    id: 'kit808',
    name: 'Kit 808',
    family: 'Kit',
    description: 'Caja de ritmos clásica.',
    slots: {
      accent: synth('blip', { tune: 2 }),
      beat: synth('click'),
      sub: synth('click', { gain: 0.38, tune: -5 }),
      kick: synth('kick808'),
      snare: synth('snare808'),
      hat: synth('hatClosed')
    }
  },
  {
    id: 'kit909',
    name: 'Kit 909',
    family: 'Kit',
    description: 'Más ataque y más brillo que el 808.',
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
    id: 'kitAcoustic',
    name: 'Kit acústico',
    family: 'Kit',
    description: 'Lo más cercano a una batería real.',
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
    id: 'kitLatin',
    name: 'Kit latino',
    family: 'Kit',
    description: 'Congas, bongos y cencerro.',
    slots: {
      accent: synth('cowbell'),
      beat: synth('clave', { gain: 0.7 }),
      sub: synth('shaker', { gain: 0.45 }),
      kick: synth('conga', { tune: -5 }),
      snare: synth('bongo'),
      hat: synth('cabasa')
    }
  },

  // --- Mecánico ---
  clickPack('mechanical', 'Metrónomo mecánico', 'Mecánico', 'Tic y tac de madera, como el de cuerda.', 'mechanical')
];

export const PACK_FAMILIES: PackFamily[] = [
  'Clicks',
  'Madera',
  'Metal',
  'Láminas',
  'Percusión',
  'Kit',
  'Mecánico'
];

export const DEFAULT_PACK_ID = 'click';

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
