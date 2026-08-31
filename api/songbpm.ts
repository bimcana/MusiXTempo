/**
 * Busqueda en el catalogo de GetSongBPM: BPM, tonalidad y compas por
 * NOMBRE de cancion, sin audio. Es lo que la app de referencia usa en
 * su pestana Search, y complementa la medicion: el catalogo dice a
 * cuanto se grabo; el motor mide a cuanto esta sonando.
 *
 * Corre en el servidor por la misma razon que identify.ts: la clave no
 * puede viajar al navegador. La API de GetSongBPM es gratuita pero
 * exige un enlace de atribucion visible — la interfaz lo muestra.
 *
 * Variables de entorno:
 *   GETSONGBPM_API_KEY
 *   GETSONGBPM_BASE       opcional, por defecto https://api.getsong.co
 */

export const config = { runtime: 'edge' };

interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  uri?: string;
  bpm?: number;
  timeSignature?: string;
  keyOf?: string;
  openKey?: string;
}

type SearchResponse =
  | { status: 'found'; songs: CatalogSong[] }
  | { status: 'not-found' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string };

type Env = Record<string, string | undefined>;

function readEnv(): Env {
  const globals = globalThis as unknown as {
    process?: { env?: Env };
    Deno?: { env: { toObject(): Env } };
  };
  if (globals.process?.env) return globals.process.env;
  if (globals.Deno) return globals.Deno.env.toObject();
  return {};
}

const json = (body: SearchResponse, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // El catalogo no cambia por minutos: cachear ahorra cuota de API.
      'cache-control': 'public, max-age=3600'
    }
  });

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return json({ status: 'error', message: 'Falta el término de búsqueda.' }, 400);
  if (query.length > 120) return json({ status: 'error', message: 'Búsqueda demasiado larga.' }, 400);

  const env = readEnv();
  const apiKey = env.GETSONGBPM_API_KEY;
  if (!apiKey) return json({ status: 'unconfigured' }, 501);

  const base = env.GETSONGBPM_BASE ?? 'https://api.getsong.co';
  const target =
    base + '/search/?api_key=' + encodeURIComponent(apiKey) +
    '&type=song&limit=10&lookup=' + encodeURIComponent(query);

  try {
    const response = await fetch(target, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      return json({ status: 'error', message: 'El catálogo respondió ' + response.status + '.' }, 502);
    }
    const payload = (await response.json()) as GsbSearch;
    const raw = payload.search;
    // La API devuelve un objeto {error} en vez de lista cuando no hay nada.
    if (!Array.isArray(raw) || raw.length === 0) return json({ status: 'not-found' });

    const songs: CatalogSong[] = raw.slice(0, 10).map((s) => ({
      id: s.id ?? '',
      title: s.title ?? 'Desconocido',
      artist: s.artist?.name ?? 'Desconocido',
      uri: s.uri,
      bpm: s.tempo ? Number(s.tempo) : undefined,
      timeSignature: s.time_sig ?? undefined,
      keyOf: s.key_of ?? undefined,
      openKey: s.open_key ?? undefined
    }));
    return json({ status: 'found', songs });
  } catch {
    return json({ status: 'error', message: 'Sin conexión con el catálogo.' }, 502);
  }
}

interface GsbSearch {
  search?: {
    id?: string;
    title?: string;
    uri?: string;
    tempo?: string;
    time_sig?: string;
    key_of?: string;
    open_key?: string;
    artist?: { name?: string };
  }[];
}
