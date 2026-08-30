/**
 * Interruptor de silencio de iOS.
 *
 * Safari silencia Web Audio cuando el interruptor fisico del iPhone esta
 * en silencio. El truco conocido es reproducir un elemento <audio> mudo
 * en bucle: eso empuja a iOS a tratar la pagina como reproduccion de
 * medios y no como sonido de interfaz.
 *
 * Es un truco, no una garantia. Si Apple lo ha cerrado, el usuario
 * tendra que subir el switch — y la app se lo dice, en vez de fingir que
 * el problema no existe.
 */

/** WAV de 0.1 s en silencio, incrustado para no depender de la red. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

let element: HTMLAudioElement | null = null;
let attempted = false;

export function unlockIosAudio(): void {
  if (typeof document === 'undefined') return;

  if (!element) {
    element = document.createElement('audio');
    element.src = SILENT_WAV;
    element.loop = true;
    element.volume = 0;
    element.setAttribute('playsinline', 'true');
    element.setAttribute('aria-hidden', 'true');
    element.style.display = 'none';
    document.body.appendChild(element);
  }

  attempted = true;
  void element.play().catch(() => {
    /* Sin gesto de usuario todavia; se reintenta en el siguiente. */
  });
}

export function releaseIosAudio(): void {
  element?.pause();
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ se presenta como Mac, de ahi la comprobacion tactil.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function unlockAttempted(): boolean {
  return attempted;
}
