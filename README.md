# MusixTempo

Escucha lo que suena y dice **a qué velocidad va y en qué compás está**. PWA instalable, sin
publicación en tiendas, sin cuenta y sin nube.

El objetivo principal es el tempo. El nombre de la canción es secundario y llega en la Fase 2.

---

## Estado

**Fase 1 completa**: detectar → guardar → tocar.

| Escenario | Accuracy 1 | Accuracy 2 | Métrica exacta | Recall 6/8 | Recall 4/4 |
|---|---|---|---|---|---|
| Material completo (30 piezas) | **100 %** | 100 % | 86,7 % | **100 %** | 70 % |
| Solo batería, sin armonía | 96,7 % | 100 % | 50,0 % | 87,5 % | 10 % |
| Sala hostil (ruido, reverb, deriva) | 70,0 % | 100 % | — | — | — |
| Tarareo, sin ataques percusivos | **85,7 %** | 100 % | — | — | — |
| Intro floja + banda entera a 140 | ✓ 140,1 | — | 4/4 | — | — |
| 6/8 contra 4/4 con swing | — | — | **6 de 6** | — | — |

Error medio de tempo: **0,06 %**. *Accuracy 1* = dentro del ±4 % del BPM real; *Accuracy 2* =
tolera errores de octava y de ratio 3. Son las métricas estándar del campo, no inventadas aquí.

Sobre el `4/4 → 2/4` sin armonía: con el bombo cayendo igual en los tiempos 1 y 3 y sin nada
tonal, un 4/4 y un 2/4 **suenan igual**. Leerlo como 2/4 no es un fallo del motor, es la lectura
honesta del audio. Subir ese umbral solo le enseñaría a adivinar.

---

## Biblioteca

Buscador por título (insensible a mayúsculas y acentos) y **reordenación por arrastre** desde la
empuñadura de seis puntos: la fila sigue al dedo y las demás se apartan en vivo, así que una
canción va del final al principio en **un solo gesto**, no una posición por toque. Con
autodesplazamiento al acercarse a los bordes, para listas más largas que la pantalla.

Todo el movimiento se aplica como `transform` directamente sobre el DOM — React no vuelve a
renderizar en ningún frame del arrastre. Un reorder que provoque un render por movimiento de
dedo se siente pegajoso en móvil, que es justo lo que el control existe para evitar.

Menú de acciones por **pulsación larga** (móvil), **toque con dos dedos en el trackpad** o clic
derecho (escritorio), o el botón `⋯`, con *Mover arriba* (encabeza la lista), *Mover abajo* (al
final) y *Borrar*. El gesto se escucha en la **fila entera**, no solo sobre el título: en un
trackpad el toque puede caer sobre la empuñadura o sobre `⋯`, y ahí también debe abrir el cuadro
en vez del menú nativo del navegador.

Con teclado, las flechas sobre la empuñadura mueven de una en una: es el único modo preciso, y
sin puntero no hay arrastre.

Cuatro modos de ordenación: **Mi orden**, **Título**, **BPM** y **Reciente**, recordados entre
sesiones. El orden manual es *un modo*, no una capa sobre los demás: reordenar a mano dentro de
una lista alfabética no significa nada, así que la empuñadura solo arrastra en «Mi orden» y la
pantalla lo dice en vez de dejarla muerta. Mover a un extremo desde el menú cambia de modo
automáticamente para que el efecto se vea.

La posición vive en un campo `order` con huecos de mil entre canciones, así que soltar una fila
escribe **una** fila; solo se renumera la lista cuando el hueco entre dos vecinas se agota.

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

### La cifra es una media, no la última lectura

`BeatAccumulator` acumula cada beat de la sesión como un par (índice, instante) y ajusta **una**
recta por mínimos cuadrados sobre todos ellos — lo que hace alguien que marca el pulso sobre la
canción y promedia. Con sumas incrementales, así que no crece en memoria y la precisión solo
mejora cuanto más escuchas.

Tres decisiones hacen que eso ayude en vez de estorbar:

- **La hipótesis se elige siempre sobre la ventana actual.** Probé también promediar el
  tempograma y empeoró: promediar la curva refuerza por igual el periodo real y su armónico al
  doble, y ahí se pierde el desempate de octava.
- **El promedio refina, nunca contradice.** Si se aleja más de un 6 % de la hipótesis viva, se
  ignora: perpetuar la media sería arrastrar un error antiguo en vez de corregirlo.
- **Ni la adherencia ni la media arrancan antes de 3,5 s.** Antes de eso la ventana cubre poco
  más de un periodo, y premiar esa hipótesis congelaría una suposición mal informada.

### El BPM se expresa en negras

Todos los DAW expresan el tempo en negras por minuto sea cual sea el compás, y es lo que un
baterista teclea en su click. En 4/4 no cambia nada; en 6/8 la negra va una vez y media más
rápida que el pulso sentido, que se muestra justo debajo junto a las corcheas. El metrónomo
marca el **pulso**, no la negra.

### Sonidos

**35 sonidos en 7 familias**, en un desplegable agrupado: clicks digitales, madera, metal,
láminas, percusión, kits de batería y metrónomo mecánico. La lista sigue el vocabulario de los
clicks de un DAW — Click II de Pro Tools, Klopfgeist de Logic, los click sounds de Cubase —
porque es el que un músico ya conoce.

Todo sintetizado en Web Audio: **cero bytes de assets, cero riesgo de licencia**. Y casi todo
sale de cuatro generadores paramétricos, no de 35 funciones: un woodblock, una clave, un
cencerro y un agogo son el *mismo* grafo con otros ratios de parciales.

| Generador | De dónde salen |
|---|---|
| `tone` | Beeps, pings, blips |
| `mallet` | Madera, metal, láminas — cambia los ratios de parciales |
| `noiseHit` | Shakers, aros, platillos, cajas |
| `sweep` | Bombos y toms |

Un *pack* mapea roles (`accent`, `beat`, `sub`, `kick`, `snare`, `hat`) a voces sintéticas **o**
a URLs de samples, y el scheduler no distingue cuál es cuál: añadir tus propios WAV es soltar un
pack con URLs, sin tocar el motor.

El scheduler usa dos relojes — un temporizador grueso de 25 ms que mira 200 ms hacia delante, y
el reloj de audio contra el que se programa cada golpe. La precisión resultante es de muestra.

---

## Identificación de canción

**El motor de Shazam no es accesible desde una web.** ShazamKit es un SDK nativo y no existe API
REST pública; Apple cerró la antigua API de desarrolladores tras comprar Shazam. Lo que sí hay
son motores de fingerprinting equivalentes con API de servidor.

La capa está construida y es **agnóstica de proveedor**. El navegador manda un fragmento de
audio a una función serverless y recibe un resultado normalizado — nunca ve la clave, y ni
siquiera sabe qué proveedor hay detrás. Cambiar de uno a otro es una variable de entorno.

Soportados: **ACRCloud** (el más sólido con micrófono en una sala) y **AudD** (API más simple).
Configúralo en `.env.local` para desarrollo y en el panel de Vercel o Netlify para producción
— ver [`.env.example`](.env.example). La función vive en [`api/identify.ts`](api/identify.ts) y
está escrita contra la API estándar `Request`/`Response`, así que corre igual en Vercel Edge,
Netlify Edge y Cloudflare Workers.

Tres detalles de diseño:

- **Se lanza al parar, nunca mientras escucha.** El tempo es el objetivo principal y no comparte
  recursos con nada.
- **«No configurada» y «No encontrada» son estados distintos**, y la pantalla lo dice. Sin clave,
  el tempo funciona exactamente igual: no depende de la nube.
- El fragmento se remuestrea a ~12 kHz mono antes de enviarlo. Los motores de fingerprinting
  trabajan de sobra a esa frecuencia, y baja el envío de más de un mega a unos 300 KB — que en
  datos móviles es la diferencia entre útil e inaceptable.

---

## Qué queda fuera de la Fase 1

- **Fase 3** — Metrónomo avanzado: subdivisiones, polirritmia, setlists, entrenador de tempo. Y
  el click sonando encima de música en vivo, con auriculares.
- **Árbitro neuronal.** El slot está listo detrás de la interfaz `TempoArbiter`; en v1 entra el
  árbitro heurístico. Falta el spike de licencias: los buenos modelos de beat-tracking suelen
  llevar cláusulas no comerciales sobre los pesos. Si ninguno pasa el filtro, se entrena uno
  propio con el corpus sintético — que ya genera decenas de miles de ejemplos etiquetados por
  construcción.

El diseño completo está en
[`docs/superpowers/specs/`](docs/superpowers/specs/2026-08-30-musixtempo-motor-tempo-design.md).
