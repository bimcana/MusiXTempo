# MusixTempo

Escucha lo que suena y dice **a qué velocidad va y en qué compás está**. PWA instalable, sin
publicación en tiendas, sin cuenta y sin nube.

El objetivo principal es el tempo. El nombre de la canción es secundario y llega en la Fase 2.

---

## Estado

**Fase 1 completa**: detectar → guardar → tocar.

| Escenario | Accuracy 1 | Accuracy 2 | Métrica exacta | Recall 6/8 | Recall 4/4 |
|---|---|---|---|---|---|
| Material completo (30 piezas) | **96,7 %** | 100 % | **90,0 %** | **100 %** | 80 % |
| Solo batería, sin armonía | 93,3 % | 100 % | 46,7 % | 87,5 % | 0 % |
| Sala hostil (ruido, reverb, deriva) | 70,0 % | 100 % | — | — | — |
| Tarareo, sin ataques percusivos | 71,4 % | 100 % | — | — | — |
| 6/8 contra 4/4 con swing | — | — | **6 de 6** | — | — |

Error medio de tempo: **1,84 %**. *Accuracy 1* = dentro del ±4 % del BPM real; *Accuracy 2* =
tolera errores de octava y de ratio 3. Son las métricas estándar del campo, no inventadas aquí.

Sobre el `4/4 → 2/4` sin armonía: con el bombo cayendo igual en los tiempos 1 y 3 y sin nada
tonal, un 4/4 y un 2/4 **suenan igual**. Leerlo como 2/4 no es un fallo del motor, es la lectura
honesta del audio. Subir ese umbral solo le enseñaría a adivinar.

---

## Arrancar

```bash
npm install
npm run dev
```

Otros comandos:

```bash
npm test          # suite completa: 21 pruebas
npm run corpus    # solo el corpus, con el informe detallado
npm run build     # bundle de producción + service worker
npm run icons     # regenera los iconos PWA
```

## Instalar en el móvil

El micrófono **exige HTTPS**. En local funciona `localhost`; para probar en el teléfono hace
falta un túnel o un despliegue.

1. Despliega a Vercel o Netlify (plan gratuito, desde el repositorio).
2. Abre la URL **en Safari** (iOS) o Chrome (Android).
3. Compartir → *Añadir a pantalla de inicio*.

Para iterar contra el móvil durante el desarrollo, un túnel de Cloudflare contra el Vite local.
iOS rechaza certificados autofirmados, así que no hay atajo por ahí.

**Limitación conocida de iOS:** Safari silencia Web Audio cuando el interruptor lateral del
iPhone está en silencio. La app implementa el truco del `<audio>` mudo para forzar la categoría
de sesión, pero si Apple lo ha cerrado habrá que subir el switch. No hay alternativa desde una
web, y la app lo dice en pantalla en lugar de fingir que el problema no existe.

---

## Arquitectura

```
src/
  dsp/         PURO — sin DOM, sin Web Audio, sin async
    core        FFT, autocorrelación, diezmado, estadística
    features    STFT → mel blanqueado → tres detectores de onset
    tempo       tempograma, candidatos, rastreo de beats, ajuste por mínimos cuadrados
    meter       subdivisión × agrupación → cifra de compás
    engine      orquestador → DetectionResult
  arbiter/     interfaz + nulo + heurístico (+ neuronal, pendiente)
  audio/       captura de micrófono, worklet, desbloqueo de iOS
  worker/      todo el DSP corre aquí
  metronome/   voces sintetizadas, grooves, packs, scheduler
  data/        IndexedDB
  ui/          React
test/          corpus sintético + métricas
```

**La frontera que sostiene el proyecto:** `src/dsp/` es código puro. Entra un `Float32Array`,
sale un objeto. Se prueba en Node sin navegador, sin mocks y sin flakiness — y eso es lo que
hace posible medir la precisión en vez de opinar sobre ella.

### Cómo decide el motor

Tempo y métrica **no** se deciden en cascada: se puntúan juntos. Un candidato de tempo que en
realidad es la subdivisión de otro se delata porque sus propias subdivisiones son borrosas y su
agrupación, difusa. Sin esa evaluación conjunta, una balada en 6/8 se detecta como 180 BPM en
lugar de 60.

Tres decisiones concretas que resultaron ser las que más movieron la aguja:

- **Discriminante de octava.** Un pulso real pesa más que su subdivisión. Cuando pesan lo
  mismo, el candidato va un nivel por debajo del beat. Sin este término el motor se iba
  sistemáticamente a media velocidad, porque a medio tempo el beat verdadero cae justo en la
  mitad y la evidencia de subdivisión sale, engañosamente, perfecta.
- **Agregación por intervalo.** Lo que distingue la primera mitad de un compás de la segunda
  suele estar *entre* los tiempos — un bombo en la "y" de 3, un relleno. Muestreando solo en el
  instante del beat eso no se ve nunca.
- **Test anidado de agrupación.** Para que haya 4/4 y no 2/4, el tiempo 1 tiene que pesar más
  que el 3. Es el mismo test que separa un 12/8 de un 6/8, y corrige el sesgo de que agrupar en
  4 tenga el doble de fases candidatas que agrupar en 2.

### En compás compuesto se muestran las dos lecturas

Grande el pulso sentido, pequeño la subdivisión: `60 · 6/8` con `= 180 corcheas` debajo. Es la
ambigüedad que hace fallar a casi todas las apps de BPM, y se elimina de raíz mostrando ambas.

### Sonidos

Todo sintetizado en Web Audio: **cero bytes de assets, cero riesgo de licencia**, 19 voces
paramétricas en tono, decaimiento y brillo. Un *pack* mapea roles (`accent`, `beat`, `sub`,
`kick`, `snare`, `hat`) a voces sintéticas **o** a URLs de samples, y el scheduler no distingue
cuál es cuál: añadir tus propios WAV es soltar un pack con URLs, sin tocar el motor.

El scheduler usa dos relojes — un temporizador grueso de 25 ms que mira 200 ms hacia delante, y
el reloj de audio contra el que se programa cada golpe. La precisión resultante es de muestra.

---

## Qué queda fuera de la Fase 1

- **Fase 2** — Identificación de canción: fingerprinting en la nube con enlaces a Spotify, Apple
  Music y YouTube Music, y «No encontrada» cuando no exista. Nunca compite por recursos con la
  detección de tempo.
- **Fase 3** — Metrónomo avanzado: subdivisiones, polirritmia, setlists, entrenador de tempo. Y
  el click sonando encima de música en vivo, con auriculares.
- **Árbitro neuronal.** El slot está listo detrás de la interfaz `TempoArbiter`; en v1 entra el
  árbitro heurístico. Falta el spike de licencias: los buenos modelos de beat-tracking suelen
  llevar cláusulas no comerciales sobre los pesos. Si ninguno pasa el filtro, se entrena uno
  propio con el corpus sintético — que ya genera decenas de miles de ejemplos etiquetados por
  construcción.

El diseño completo está en
[`docs/superpowers/specs/`](docs/superpowers/specs/2026-08-30-musixtempo-motor-tempo-design.md).
