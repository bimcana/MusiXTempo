/**
 * Cliente de identificacion. Manda el fragmento a la funcion serverless
 * y devuelve el resultado normalizado.
 *
 * El navegador nunca ve la clave del proveedor, y tampoco sabe cual es:
 * eso vive entero en el servidor.
 */

import type { IdentifyResult } from './types';
import { prepareSnippet } from './wav';

/** Ruta de la funcion serverless. Relativa, para que funcione en cualquier despliegue. */
const ENDPOINT = 'api/identify';

export interface IdentifyOptions {
  /** Corta el intento si el proveedor tarda demasiado. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function identifySnippet(
  samples: Float32Array,
  sampleRate: number,
  options: IdentifyOptions = {}
): Promise<IdentifyResult> {
  if (samples.length === 0) return { status: 'error', message: 'No hay audio que identificar.' };

  const snippet = prepareSnippet(samples, sampleRate);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  options.signal?.addEventListener('abort', () => controller.abort());

  try {
    const response = await fetch(new URL(ENDPOINT, document.baseURI).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Sample-Rate': String(snippet.sampleRate)
      },
      body: snippet.blob,
      signal: controller.signal
    });

    // Sin funcion desplegada, un host estatico devuelve el index.html en
    // vez de un 404. Comprobar el tipo evita intentar leerlo como JSON y
    // reportar un error de sintaxis que no dice nada al usuario.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { status: 'unconfigured' };
    }
    if (response.status === 501) return { status: 'unconfigured' };
    if (!response.ok) {
      return { status: 'error', message: 'El servicio respondió ' + response.status + '.' };
    }
    return (await response.json()) as IdentifyResult;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { status: 'error', message: 'La identificación tardó demasiado.' };
    }
    return { status: 'error', message: 'Sin conexión con el servicio de identificación.' };
  } finally {
    clearTimeout(timeout);
  }
}
