/**
 * Captura del audio del sistema (escritorio).
 *
 * La sesion en vivo del 30-08 demostro el problema del microfono cuando
 * la musica suena EN LA MISMA maquina: el altavoz al aire, la sala, y
 * sobre todo el cancelador de eco del sistema — que trata la musica
 * reproducida como eco a eliminar y entrega un residuo destrozado. El
 * mismo audio, capturado digitalmente, dio 199.8 con 0.1 % de error.
 *
 * En Chrome y Edge de escritorio, getDisplayMedia permite capturar el
 * audio de una pestana o del sistema: senal digital limpia, sin
 * microfono, sin sala y sin cancelador. Es el modo correcto cuando la
 * musica suena en el mismo equipo; el microfono queda para cuando suena
 * fuera.
 */

export function systemCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    'getDisplayMedia' in navigator.mediaDevices
  );
}

export interface SystemStream {
  stream: MediaStream;
  stop: () => void;
}

/**
 * Pide compartir pestana/pantalla CON audio. Lanza errores con mensajes
 * ya listos para pantalla, porque cada fallo tiene un remedio distinto
 * y el usuario tiene que saber cual.
 */
export async function requestSystemAudio(): Promise<SystemStream> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // El video es obligatorio en la API aunque solo interese el audio.
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      // Sugerencias que Chrome entiende (y otros ignoran sin romperse).
      ...({ systemAudio: 'include', selfBrowserSurface: 'include', preferCurrentTab: false } as object)
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('Captura cancelada. Elige una pestaña o pantalla y acepta.');
    }
    throw new Error('Este navegador no permite capturar el audio del sistema.');
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      'La captura llegó sin audio. En el diálogo, elige la pestaña donde suena la música y activa «Compartir audio».'
    );
  }

  // El video no se usa: pararlo apaga el indicador de grabacion de la
  // pestana... en realidad Chrome mantiene la sesion mientras viva el
  // audio, y detener el video ahorra el coste de esos fotogramas.
  for (const track of stream.getVideoTracks()) track.stop();

  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  // Si el usuario corta desde la barra del navegador, el track muere:
  // el consumidor puede escucharlo via onended del track de audio.
  return { stream, stop };
}
