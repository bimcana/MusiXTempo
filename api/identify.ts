/**
 * Identificacion de cancion. Corre en el servidor por una sola razon:
 * la clave del proveedor no puede viajar al navegador.
 *
 * Escrita contra la API estandar Request/Response, asi que funciona
 * igual en Vercel Edge, Netlify Edge y Cloudflare Workers sin cambios.
 *
 * Variables de entorno (ver .env.example):
 *   SONGID_PROVIDER            acrcloud | audd   (opcional: se deduce)
 *   ACRCLOUD_HOST              p. ej. identify-eu-west-1.acrcloud.com
 *   ACRCLOUD_ACCESS_KEY
 *   ACRCLOUD_ACCESS_SECRET
 *   AUDD_API_TOKEN
 *
 * Sin ninguna clave responde 501 y la app muestra "no configurada", que
 * es distinto de "no encontrada" y el usuario merece saber cual es.
 */

import type { IdentifyResult, SongMatch, StreamingLinks } from '../src/songid/types';

export const config = { runtime: 'edge' };

/** Un fragmento de 12 s a 12 kHz ronda los 300 KB; el doble ya es abuso. */
const MAX_BODY_BYTES = 2_000_000;

type Env = Record<string, string | undefined>;

function readEnv(): Env {
  // Cada runtime expone el entorno a su manera.
  const globals = globalThis as unknown as {
    process?: { env?: Env };
    Deno?: { env: { toObject(): Env } };
  };
  if (globals.process?.env) return globals.process.env;
  if (globals.Deno) return globals.Deno.env.toObject();
  return {};
}

const json = (body: IdentifyResult, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ status: 'error', message: 'Método no permitido.' }, 405);
  }

  const env = readEnv();
  const provider = pickProvider(env);
  if (!provider) return json({ status: 'unconfigured' }, 501);

  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0) {
    return json({ status: 'error', message: 'Fragmento vacío.' }, 400);
  }
  if (audio.byteLength > MAX_BODY_BYTES) {
    return json({ status: 'error', message: 'Fragmento demasiado grande.' }, 413);
  }

  try {
    const result =
      provider === 'acrcloud' ? await identifyWithAcrCloud(audio, env) : await identifyWithAudd(audio, env);
    // Con la cancion identificada y la clave de GetSongBPM presente, se
    // cruza con el catalogo: BPM, tonalidad y compas "oficiales" junto a
    // lo medido. Si el catalogo falla, el resultado va sin el — nunca
    // se pierde una identificacion por un extra.
    if (result.status === 'found' && env.GETSONGBPM_API_KEY) {
      try {
        result.match.catalog = await lookupCatalog(result.match.artist, result.match.title, env);
      } catch {
        /* el catalogo es opcional */
      }
    }
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fallo desconocido.';
    return json({ status: 'error', message }, 502);
  }
}

async function lookupCatalog(
  artist: string,
  title: string,
  env: Env
): Promise<SongMatch['catalog']> {
  const base = env.GETSONGBPM_BASE ?? 'https://api.getsong.co';
  const lookup = 'song:' + title + ' artist:' + artist;
  const url =
    base + '/search/?api_key=' + encodeURIComponent(env.GETSONGBPM_API_KEY!) +
    '&type=both&lookup=' + encodeURIComponent(lookup);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as {
    search?: { tempo?: string; time_sig?: string; key_of?: string; open_key?: string; uri?: string }[];
  };
  const hit = Array.isArray(payload.search) ? payload.search[0] : undefined;
  if (!hit) return undefined;
  return {
    bpm: hit.tempo ? Number(hit.tempo) : undefined,
    timeSignature: hit.time_sig,
    keyOf: hit.key_of,
    openKey: hit.open_key,
    uri: hit.uri
  };
}

function pickProvider(env: Env): 'acrcloud' | 'audd' | null {
  const explicit = env.SONGID_PROVIDER?.toLowerCase();
  if (explicit === 'acrcloud' || explicit === 'audd') return explicit;
  if (env.ACRCLOUD_ACCESS_KEY && env.ACRCLOUD_ACCESS_SECRET && env.ACRCLOUD_HOST) return 'acrcloud';
  if (env.AUDD_API_TOKEN) return 'audd';
  return null;
}

/* ------------------------------------------------------------------ */
/* ACRCloud                                                            */
/* ------------------------------------------------------------------ */

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function identifyWithAcrCloud(audio: ArrayBuffer, env: Env): Promise<IdentifyResult> {
  const host = env.ACRCLOUD_HOST!;
  const accessKey = env.ACRCLOUD_ACCESS_KEY!;
  const accessSecret = env.ACRCLOUD_ACCESS_SECRET!;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const uri = '/v1/identify';
  // El orden de estas seis lineas es parte del protocolo: cualquier
  // cambio produce una firma valida en apariencia y rechazada por ACR.
  const stringToSign = ['POST', uri, accessKey, 'audio', '1', timestamp].join('\n');
  const signature = await hmacSha1Base64(accessSecret, stringToSign);

  const form = new FormData();
  form.append('sample', new Blob([audio], { type: 'audio/wav' }), 'sample.wav');
  form.append('sample_bytes', String(audio.byteLength));
  form.append('access_key', accessKey);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('timestamp', timestamp);

  const response = await fetch('https://' + host + uri, { method: 'POST', body: form });
  if (!response.ok) throw new Error('ACRCloud respondió ' + response.status);

  const payload = (await response.json()) as AcrResponse;
  const code = payload.status?.code;
  // 1001 es "no hay coincidencia": no es un fallo, es la respuesta.
  if (code === 1001) return { status: 'not-found' };
  if (code !== 0) return { status: 'error', message: payload.status?.msg ?? 'ACRCloud rechazó la petición.' };

  const music = payload.metadata?.music?.[0];
  if (!music) return { status: 'not-found' };

  const external = music.external_metadata ?? {};
  const links: StreamingLinks = {};
  if (external.spotify?.track?.id) links.spotify = 'https://open.spotify.com/track/' + external.spotify.track.id;
  if (external.deezer?.track?.id) links.deezer = 'https://www.deezer.com/track/' + external.deezer.track.id;
  if (external.youtube?.vid) links.youtube = 'https://www.youtube.com/watch?v=' + external.youtube.vid;
  if (external.apple_music?.url) links.appleMusic = external.apple_music.url;

  const match: SongMatch = {
    title: music.title ?? 'Desconocido',
    artist: music.artists?.map((a) => a.name).filter(Boolean).join(', ') || 'Desconocido',
    album: music.album?.name,
    releaseDate: music.release_date,
    links,
    score: typeof music.score === 'number' ? music.score / 100 : undefined,
    provider: 'acrcloud'
  };
  return { status: 'found', match };
}

interface AcrResponse {
  status?: { code?: number; msg?: string };
  metadata?: {
    music?: {
      title?: string;
      score?: number;
      release_date?: string;
      artists?: { name?: string }[];
      album?: { name?: string };
      external_metadata?: {
        spotify?: { track?: { id?: string } };
        deezer?: { track?: { id?: string } };
        youtube?: { vid?: string };
        apple_music?: { url?: string };
      };
    }[];
  };
}

/* ------------------------------------------------------------------ */
/* AudD                                                                */
/* ------------------------------------------------------------------ */

async function identifyWithAudd(audio: ArrayBuffer, env: Env): Promise<IdentifyResult> {
  const form = new FormData();
  form.append('api_token', env.AUDD_API_TOKEN!);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'sample.wav');
  form.append('return', 'apple_music,spotify,deezer');

  const response = await fetch('https://api.audd.io/', { method: 'POST', body: form });
  if (!response.ok) throw new Error('AudD respondió ' + response.status);

  const payload = (await response.json()) as AuddResponse;
  if (payload.status !== 'success') {
    return { status: 'error', message: payload.error?.error_message ?? 'AudD rechazó la petición.' };
  }
  const result = payload.result;
  if (!result) return { status: 'not-found' };

  const links: StreamingLinks = {};
  if (result.spotify?.external_urls?.spotify) links.spotify = result.spotify.external_urls.spotify;
  if (result.apple_music?.url) links.appleMusic = result.apple_music.url;
  if (result.deezer?.link) links.deezer = result.deezer.link;
  if (result.song_link && !links.spotify) links.spotify = result.song_link;

  const match: SongMatch = {
    title: result.title ?? 'Desconocido',
    artist: result.artist ?? 'Desconocido',
    album: result.album,
    releaseDate: result.release_date,
    artworkUrl: result.apple_music?.artwork?.url?.replace('{w}x{h}', '300x300'),
    links,
    provider: 'audd'
  };
  return { status: 'found', match };
}

interface AuddResponse {
  status?: string;
  error?: { error_message?: string };
  result?: {
    artist?: string;
    title?: string;
    album?: string;
    release_date?: string;
    song_link?: string;
    spotify?: { external_urls?: { spotify?: string } };
    deezer?: { link?: string };
    apple_music?: { url?: string; artwork?: { url?: string } };
  } | null;
}
