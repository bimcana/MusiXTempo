/**
 * Identificacion de cancion (Fase 2).
 *
 * El motor de Shazam no es accesible desde una web: ShazamKit es un SDK
 * nativo y no existe API REST publica. Lo que si existe son motores de
 * fingerprinting equivalentes — ACRCloud, AudD — con API de servidor.
 *
 * Estos tipos son el contrato NORMALIZADO entre el navegador y la
 * funcion serverless. El cliente no sabe que proveedor hay detras: manda
 * audio y recibe esto. Cambiar de proveedor es una variable de entorno.
 */

export interface StreamingLinks {
  spotify?: string;
  appleMusic?: string;
  youtube?: string;
  deezer?: string;
}

export interface SongMatch {
  title: string;
  artist: string;
  album?: string;
  releaseDate?: string;
  artworkUrl?: string;
  /** Como esta catalogada en cada plataforma. */
  links: StreamingLinks;
  /** Confianza del proveedor, 0..1, si la da. */
  score?: number;
  provider: string;
}

export type IdentifyResult =
  /** Encontrada y catalogada. */
  | { status: 'found'; match: SongMatch }
  /** El proveedor respondio, pero no la reconoce. Es el "No encontrada". */
  | { status: 'not-found' }
  /** No hay clave configurada. No es un fallo: es que aun no esta puesto. */
  | { status: 'unconfigured' }
  /** Fallo de red o del proveedor. */
  | { status: 'error'; message: string };

/** Etiqueta para pantalla de cada estado. */
export function describeResult(result: IdentifyResult): string {
  switch (result.status) {
    case 'found':
      return result.match.artist + ' — ' + result.match.title;
    case 'not-found':
      return 'No encontrada';
    case 'unconfigured':
      return 'Identificación no configurada';
    case 'error':
      return 'No se pudo identificar';
  }
}
