# MusixTempo — Motor de Tempo y Métrica (v1)

- **Fecha:** 2026-08-30
- **Estado:** Aprobado
- **Fase:** 1 de 3

---

## 1. Objetivo

Aplicación web instalable (PWA) que escucha por micrófono y determina, con la mayor precisión
y rapidez posibles, **el tempo (BPM) y la métrica** de lo que suena. Guarda los resultados en
una biblioteca local y los reproduce con un metrónomo de sonidos sintetizados y grooves de
batería.

**Prioridad explícita:** el tempo es el objetivo principal. El nombre de la canción es
secundario y queda fuera de v1 (Fase 2).

**Requisito diferencial:** debe funcionar con *cualquier* patrón continuo, no solo música
comercial. Tarareo, percusión de mano y patrones a capela son casos de primera clase, no
excepciones toleradas.

**Métricas de interés:** 4/4 y 6/8 con atención especial; 3/4, 2/4, 12/8, 5/4 y 7/8 soportadas.

---

## 2. Decisiones tomadas y por qué

| Decisión | Elección | Razón |
|---|---|---|
| Plataforma | PWA instalable | Sin publicación, sin Mac, sin revisión. En móvil el audio acaba siendo micrófono en cualquier caso. |
| Captura | Micrófono | iOS no permite a terceros capturar audio del sistema. Android bloquea la captura de apps de música. Shazam en móvil también usa el micrófono. |
| BPM en compás compuesto | Pulso sentido como titular + subdivisión debajo | `60 · 6/8` grande, `= 180 corcheas` pequeño. Elimina la ambigüedad de raíz. |
| Motor | Híbrido: DSP clásico + árbitro | Decisión del usuario. El clásico cubre tarareo y offline; el árbitro sube el techo en música comercial. |
| Licencias de modelo | Diseñar en seguro | Solo MIT/Apache/BSD o modelo propio. No cierra la puerta a uso comercial. |
| Sonidos | Sintetizados + sistema de packs | Cero assets, cero riesgo legal, 15 familias paramétricas. Packs de samples enchufables después. |
| Modos | Mutuamente excluyentes | Detectar = solo escucha. Metrónomo = solo suena. Elimina realimentación y compensación de latencia. |

---

## 3. Producto

### 3.1 Pantallas

**① Escuchar.** Botón grande. Al pulsarlo arranca el micrófono y aparece un indicador de pulso
vivo.

- ~2 s → número en gris etiquetado **provisional**
- ~5-6 s → número sólido (**estable**)
- ~8-10 s → métrica confirmada (**refinado**)

El estado visual del número *es* la confianza. Mientras el usuario siga escuchando, el motor
sigue afinando.

**② Resultado.** BPM grande + métrica. En compás compuesto: `60 · 6/8` con `= 180 corcheas`
debajo. Corrección de octava a un toque (`×2` / `÷2`). Botones `Guardar` / `Descartar`. El
título lo escribe el usuario (Fase 2 lo automatiza).

**③ Biblioteca + Metrónomo.** Lista de canciones guardadas (título, BPM, métrica). Al tocar una
se abre el metrónomo ya cargado con su tempo y compás, con selector de sonido y groove. Botón
`+` para alta manual (nombre, tap tempo o BPM numérico, métrica).

### 3.2 Contrato de salida del motor

```ts
interface DetectionResult {
  bpm: number;                    // pulso sentido, decimal
  bpmAlt: number;                 // representación alternativa (subdivisión)
  meter: { beatsPerBar: number; beatUnit: number };
  subdivision: 'binary' | 'ternary';
  confidence: number;             // 0..1
  nextBeatAt: number;             // reloj de AudioContext
  nextDownbeatAt: number;
  stage: 'provisional' | 'stable' | 'refined';
  elapsedMs: number;
  clipping: boolean;
}
```

Todo lo demás en la aplicación consume exclusivamente este objeto.

---

## 4. Motor de detección

### 4.1 Captura

`getUserMedia` con `echoCancellation: false`, `noiseSuppression: false`,
`autoGainControl: false`. **No negociable**: el DSP de voz que iOS y Android aplican por
defecto está diseñado para aplastar todo lo que no sea habla y destruiría el análisis rítmico.

Un `AudioWorklet` únicamente copia bloques a un búfer circular; no analiza nada. Todo el DSP
vive en un `Worker`, de modo que ni el render a 60 fps ni una pasada pesada puedan provocar
cortes de audio. Remuestreo a 22.05 kHz mono: nada por encima de 11 kHz aporta información
rítmica y ahorra la mitad del trabajo.

### 4.2 Frontend de características (~86 tramas/s)

1. STFT de ~46 ms (1024 muestras) con salto de 11.6 ms (256 muestras)
2. Banco log-mel de ~48 bandas
3. **Blanqueo adaptativo por banda** (máximo móvil) → invariante al nivel y al color de sala
4. Tres detectores de onset sumados con pesos:

| Detector | Cubre |
|---|---|
| Flujo espectral por bandas | Ataques percusivos: bombo, caja, hats |
| Dominio complejo (fase + magnitud) | Ataques suaves: cuerdas, sintetizadores, pads |
| Cambio de f0 / tono | **Tarareo**: sin ataque, solo nota nueva |

### 4.3 Estimación de tempo

Ventana deslizante de 8 s, refresco cada 100 ms.

1. Autocorrelación de la curva de onsets × banco de peines → tempograma robusto
2. **Tempograma cíclico** (plegado por octavas) → separa *qué ratio* de *qué octava*
3. Prior perceptual log-normal centrado en ~120 BPM
4. Interpolación parabólica del pico → ~±0.3 BPM
5. **La cifra final no sale del pico**: sale de ajustar una recta por mínimos cuadrados a los
   tiempos de beat de toda la ventana → ±0.1 BPM

### 4.4 Fase, downbeat y métrica

- Programación dinámica (Ellis) sobre la curva de onsets → tiempos de beat
- Para cada `(longitud de compás ∈ {2,3,4,5,7}, fase)` se puntúan patrones sincronizados al
  beat: energía de graves, novedad espectral, cambio de croma. Gana el mejor.
- **Test de subdivisión**: energía de la ACF en `T/2` frente a `T/3` → binario o ternario

**Métrica = agrupación × subdivisión:**

| Agrupación | Subdivisión | Métrica |
|---|---|---|
| 2 | ternario | **6/8** |
| 4 | binario | **4/4** |
| 3 | binario | 3/4 |
| 4 | ternario | 12/8 |
| 2 | binario | 2/4 |
| 5 / 7 | binario | 5/4 / 7/8 |

**El caso duro es 6/8 contra 4/4 con swing**: ambos son ternarios. Los separa la agrupación
(2 contra 4) y el patrón de graves. Por eso la agrupación de compás no es un extra opcional,
es lo que hace que 6/8 funcione.

### 4.5 Escalonado

| t | Estado | Qué hay |
|---|---|---|
| ~2 s | `provisional` | ACF sobre ventana corta |
| ~5-6 s | `stable` | Tempograma completo + fase |
| ~8-10 s | `refined` | Métrica + árbitro |

### 4.6 Árbitro

Interfaz de dos métodos, detrás de la cual el motor no sabe qué hay:

```ts
interface TempoArbiter {
  readonly id: string;
  arbitrate(input: ArbiterInput): Promise<ArbiterVerdict | null>;
}
```

Corre de fondo cada ~4 s sin bloquear. Entrada: 12 s de espectrograma mel + hipótesis top-N del
clásico. Salida: distribución sobre octava de tempo y sobre métrica, fusionada bayesianamente
con el clásico. **Si discrepa fuerte, baja la confianza en lugar de inventar un ganador.**

Implementaciones:

- `NullArbiter` — no hace nada. Para tests y para desactivar el árbitro.
- `HeuristicArbiter` — arbitraje no neuronal sobre las hipótesis del clásico. **Es lo que entra
  en v1.**
- `NeuralArbiter` — pendiente del spike de licencias y del entrenamiento. Slot listo.

---

## 5. Metrónomo, grooves y biblioteca

### 5.1 Scheduler

`setInterval` derrapa decenas de milisegundos y hace inservible un metrónomo. Patrón correcto,
dos relojes:

- Temporizador grueso cada 25 ms que mira **200 ms hacia delante**
- Cada golpe se programa con `start(t)` en tiempos exactos de `AudioContext.currentTime`

Precisión resultante: de muestra. El indicador visual se dibuja aparte con `rAF`, calculando
*dónde debería estar el pulso ahora* contra el reloj de audio — nunca "pintar cuando suena".

### 5.2 Voces sintetizadas

Cada voz es una función pura `(ctx, time, params) => void` que arma su grafo y se autodestruye.

| Voz | Construcción |
|---|---|
| Click / beep | Oscilador + envolvente exponencial ~30 ms, dos alturas |
| Woodblock / clave / rim | 2-3 osciladores en ratios inarmónicos + ruido filtrado |
| Cowbell | Dos cuadradas desafinadas (587/845 Hz) → paso banda |
| Shaker | Ruido blanco → paso alto → envolvente rápida |
| Kick | Seno con barrido 120→45 Hz + click de ataque |
| Snare | Ruido paso banda + dos tonos de cuerpo, envolventes separadas |
| Hi-hat | Seis cuadradas en ratios metálicos → paso alto → closed/open |

Todas con tono, decaimiento y brillo paramétricos: **15 familias, cero bytes de assets**.

### 5.3 Grooves declarativos

```ts
{ id: 'rock-basic', meter: '4/4', stepsPerBar: 8,
  kick:  [1,0,0,0, 1,0,0,0],
  snare: [0,0,1,0, 0,0,1,0],
  hat:   [1,1,1,1, 1,1,1,1] }
```

v1: rock 4/4, shuffle 4/4, balada 6/8, vals 3/4, marcha 2/4 y click plano por métrica. Ampliar
es añadir objetos a un array.

### 5.4 Packs

Un pack es un manifiesto que mapea **roles** (`accent`, `beat`, `sub`, `kick`, `snare`, `hat`)
a voces sintéticas **o** a URLs de samples. El motor no distingue. Añadir samples propios es
soltar un pack con URLs, sin tocar el scheduler. Los samples se cachean en IndexedDB.

### 5.5 Biblioteca

IndexedDB local. Sin cuenta, sin nube.

```ts
interface Song {
  id: string; title: string;
  bpm: number; bpmAlt: number;
  meter: { beatsPerBar: number; beatUnit: number };
  subdivision: 'binary' | 'ternary';
  confidence: number;
  packId: string; grooveId: string;
  source: 'detected' | 'manual';
  createdAt: number;
}
```

Alta manual con tap tempo: **mediana de los últimos 8 toques descartando atípicos**, no promedio.

---

## 6. Plataforma

**Stack:** Vite + TypeScript + React 19 + Tailwind v4. `vite-plugin-pwa`, `idb`, Zustand, Vitest.

**DSP en TypeScript plano, sin WASM en v1.** FFT de 1024 + 48 bandas mel + tres detectores a
86 tramas/s es trabajo trivial para V8 con `Float32Array`. Si el perfilado en Android de gama
media dice lo contrario, la frontera está limpia para mover los bucles calientes a WASM.

**Todo lo que va a 60 fps vive fuera de React**: canvas con refs y `rAF`.

### 6.1 Frontera arquitectónica

`src/dsp/` es **código puro**: sin DOM, sin Web Audio, sin async. Entra `Float32Array`, sale un
objeto. Se prueba en Node sin navegador, sin mocks y sin flakiness. Es lo que hace posible medir
la precisión de verdad.

```
src/
  audio/       captura, búfer circular, worklet
  dsp/         PURO — fft, melbank, onset, tempogram, beat-tracker, meter
  arbiter/     interfaz + null + heuristic (+ neural, pendiente)
  worker/      analysis.worker.ts
  metronome/   scheduler, voices, grooves, packs
  data/        IndexedDB
  ui/          React
  test/        corpus sintético + métricas
```

### 6.2 Cómo medimos "el más preciso"

- **Corpus sintético generado por el propio motor de grooves**: cientos de piezas con BPM,
  métrica y subdivisión conocidos *por construcción*. Con humanización de timing, deriva de
  tempo, kits distintos, ruido de sala, reverb y saturación. Más tarareo sintético (curvas de f0
  con vibrato y portamento).
- **Métricas estándar del campo**: *Accuracy 1* (±4 % del BPM real), *Accuracy 2* (tolera octava
  y ratio 3), F-measure de beats, y la métrica como **matriz de confusión** con la celda
  6/8 ↔ 4/4 vigilada explícitamente.
- **Umbral de regresión en CI**: un cambio que baje Accuracy 1 o empeore la celda 6/8 rompe la
  build.
- Grabaciones reales anotadas a mano en `test/fixtures/real/`.

### 6.3 Instalación

HTTPS es obligatorio o no hay micrófono. Deploy a Vercel o Netlify → abrir la URL **en Safari** →
Compartir → Añadir a pantalla de inicio. Para pruebas en móvil durante desarrollo, túnel de
Cloudflare contra el Vite local (iOS rechaza certificados autofirmados).

**Limitación conocida de iOS:** Safari silencia Web Audio con el interruptor físico de silencio.
Se implementa el truco del `<audio>` mudo en bucle para forzar la categoría de sesión a
*playback*; si Apple lo ha cerrado, el usuario debe subir el switch. No hay alternativa desde una
web.

---

## 7. Riesgos

1. **Árbitro neuronal.** No hay garantía de que exista un modelo permisivo que merezca la pena.
   Escalera: spike acotado → entrenar el nuestro con el corpus sintético → el clásico va solo.
   **En ningún escenario nos quedamos sin producto.**
2. **Micrófonos de móvil con AGC apagado.** Un micro barato con música fuerte satura. Mitigación:
   detección de recorte con aviso en pantalla.
3. **6/8 con poca percusión.** Una balada de piano en 6/8 es el caso más difícil del problema. Es
   donde apuntan el detector de f0 y la agrupación de compás, y donde el corpus debe apretar.

---

## 8. Fuera de alcance de v1

- Identificación de canción (**Fase 2**: fingerprinting en la nube + enlaces a Spotify /
  Apple Music / YouTube Music, con "No encontrada" cuando no exista)
- Subdivisiones, polirritmia, setlists, entrenador de tempo (**Fase 3**)
- Click sobre música sonando en vivo, con auriculares (**Fase 3**)
- Sincronización en la nube
- Captura de audio de sistema en escritorio
