# Scraper de la Consulta Pública del PJe — TRF5

Scraper en **TypeScript**, hecho **sin automatización de navegador** (solo `axios` + `cheerio`), para la
consulta pública del Processo Judicial Eletrônico del Tribunal Regional Federal da 5ª Região:

<https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam>

Recorre las búsquedas, extrae la ficha completa de cada proceso (datos, partes, movimientos y documentos,
paginando cada tabla) y descarga los documentos asociados, con reintentos y *backoff* exponencial ante
errores **429 Too Many Requests**.

---

## Requisitos

- Node.js >= 18
- npm

## Instalación

```bash
git clone https://github.com/RoyalB3/scraper-challenge
cd scraper-challenge
npm install
```

## Uso

```bash
# Búsqueda por nombre de parte, descargando como máximo 5 documentos por proceso
npm run scrape -- --nome-parte "MARIA SILVA" --max-pdfs 5

# Barrido de un rango de fechas, día por día (forma recomendada de cubrir un período)
npm run scrape -- --data-inicio 01/08/2026 --data-fim 31/08/2026 --sweep-days

# Solo metadatos, sin descargar documentos
npm run scrape -- --nome-parte "MARIA SILVA" --skip-pdfs

# Reintentar únicamente las descargas que quedaron registradas como fallidas
npm run retry:failed

# Ayuda completa
npm run scrape -- --help
```

> El separador `--` es necesario para que npm pase los argumentos al script y no los consuma.

### Scripts disponibles

| Script | Qué hace |
| --- | --- |
| `npm run scrape` | Ejecuta el scraper (alias de `npm start`) |
| `npm run retry:failed` | Reintenta las descargas registradas en `output/failed-downloads.ndjson` |
| `npm run build` | Compila TypeScript a `dist/` |
| `npm run typecheck` | Verifica tipos sin emitir |
| `npm run test:429` | Verifica el manejo de 429 contra un servidor local |

### Opciones

**Criterios de búsqueda** (se necesita al menos uno; el sitio ignora las búsquedas vacías):

| Opción | Descripción |
| --- | --- |
| `--numero-processo <n>` | Número único CNJ, ej. `0001223-51.1994.4.05.8300` |
| `--nome-parte <texto>` | Nombre de una parte. El sitio exige **dos palabras o más** |
| `--nome-advogado <texto>` | Nombre del abogado |
| `--classe <texto>` | Clase judicial exacta, ej. `APELAÇÃO CÍVEL` |
| `--documento-parte <n>` | CPF o CNPJ de la parte |
| `--data-inicio` / `--data-fim` | Rango de fecha de distribución, `dd/MM/yyyy` |
| `--sweep-days` | Recorre el rango **día por día**, una búsqueda por día |

**Alcance y salida:**

| Opción | Descripción |
| --- | --- |
| `--max-processos <n>` | Tope de procesos en esta corrida |
| `--max-pdfs <n>` | Tope de documentos a descargar por proceso |
| `--skip-pdfs` | Solo metadatos, sin descargar documentos |
| `--comprovantes` | Descarga también el comprobante de protocolo en PDF de cada documento |
| `--force` | Reprocesa procesos ya guardados y vuelve a bajar archivos existentes |
| `--retry-failed` | Reintenta solo las descargas fallidas registradas |
| `--out <ruta>` | Directorio de salida (por defecto `output/`) |

**Red y trazas:**

| Opción | Descripción |
| --- | --- |
| `--delay <ms>` | Espera mínima entre peticiones (por defecto `900`) |
| `--max-retries <n>` | Reintentos ante 429/5xx (por defecto `5`) |
| `--log-level <nivel>` | `debug` \| `info` \| `warn` \| `error` |

---

## Salida

```
output/
├── processos.ndjson            # una línea JSON por proceso (apto para streaming)
├── processos/<numero>.json     # la misma ficha, una por archivo, indentada
├── documentos/
│   └── <numero-processo>/
│       ├── <numero>_<fecha>_<documento>_<id>.pdf
│       ├── <numero>_<fecha>_<documento>_<id>.html
│       └── <numero>_<fecha>_<documento>_<id>_comprovante.pdf
├── failed-downloads.ndjson     # bitácora de descargas fallidas (para --retry-failed)
└── state.json                  # procesos ya extraídos, para reanudar
```

El nombre de cada archivo lleva el número del proceso, la fecha del documento en formato ISO
(`yyyy-MM-dd`, para que el orden alfabético coincida con el cronológico), el nombre del documento y su
identificador interno, que garantiza unicidad dentro del proceso.

Ejemplo de ficha extraída (recortado):

```json
{
  "ca": "db5f7732...",
  "numeroProcesso": "0001223-51.1994.4.05.8300",
  "dados": {
    "Número Processo": "0001223-51.1994.4.05.8300",
    "Data da Distribuição": "21/10/2025",
    "Classe Judicial": "APELAÇÃO / REMESSA NECESSÁRIA (1728)",
    "Assunto": "DIREITO PREVIDENCIÁRIO (195) - ...",
    "Jurisdição": "TRF5",
    "Órgão Julgador Colegiado": "1ª Turma",
    "Órgão Julgador": "Gab 1 - Des. ROBERTO WANDERLEY"
  },
  "poloAtivo": [
    {
      "nome": "APULCRO DE MENEZES",
      "documento": "006.822.094-49",
      "papel": "APELANTE",
      "situacao": "Ativo",
      "representantes": [
        { "nome": "LUIZ GUILHERME GASPAR ANTUNES", "oab": "PE2898-A", "papel": "ADVOGADO" }
      ]
    }
  ],
  "poloPassivo": [ "..." ],
  "movimentacoes": [
    { "dataHora": "25/07/2026 00:02:03", "descricao": "Decorrido prazo de ..." }
  ],
  "documentos": [
    {
      "titulo": "17/06/2025 13:27:12 - Despacho (Despacho)",
      "dataHora": "17/06/2025 13:27:12",
      "nome": "Despacho",
      "tipo": "Despacho",
      "formato": "pdf",
      "tamanho": "1,50 Kb",
      "idProcessoDocumento": "4182973",
      "downloadUrl": "https://pjett.trf5.jus.br/..."
    }
  ],
  "totais": { "poloAtivo": 65, "poloPassivo": 1, "movimentacoes": 65, "documentos": 23 }
}
```

---

## Cómo funciona el sitio (lo que hubo que descubrir)

El PJe es una aplicación **JSF 1.2 + Seam + RichFaces 3.3 (Ajax4jsf)**. No expone ninguna API: toda la
navegación son *postbacks* de formularios. El scraper reproduce exactamente los `POST` que dispara
`A4J.AJAX.Submit` en el navegador.

**1. Búsqueda.** El botón «Pesquisar» no ejecuta la acción: llama a `executarReCaptcha()`, que hoy tiene el
reCAPTCHA desactivado (`if (false)`) y delega en `executarPesquisa()`. Es **esa función**, y no el botón,
la que lleva el parámetro real de la acción A4J. El identificador (`fPP:j_id244`) es generado por el
servidor y cambia entre versiones, así que se extrae del HTML en cada corrida en vez de codificarlo fijo.

**2. Tope de 30 resultados.** La consulta pública nunca devuelve más de 30 procesos por búsqueda y no
ofrece paginación sobre ese listado. Cuando una búsqueda llega a 30, el scraper lo advierte por log:
hay resultados que el sitio no está mostrando. La forma de cubrir un período completo es fragmentar la
búsqueda, y para eso está `--sweep-days`, que emite una consulta por día.

**3. Ficha del proceso.** Cada fila del resultado trae un token opaco `ca`, y la ficha se abre con
`GET .../DetalheProcessoConsultaPublica/listView.seam?ca=<token>`.

**4. Paginación interna.** Las cuatro tablas de la ficha se paginan por AJAX, con dos componentes
distintos que hubo que tratar por separado:

- *Polo ativo* y *polo passivo* usan un `rich:datascroller` (el parámetro lleva el número de página);
- *movimentações* y *documentos* usan un `rich:inputNumberSlider` (la página va en el campo del slider).

Detalle clave: el slider declara un `containerId`, y el servidor exige ese valor en el parámetro
`AJAXREQUEST`. Enviando el `_viewRoot` habitual, la respuesta llega vacía y sin ningún error visible.

**5. Documentos.** El PJe publica dos formatos, y el scraper los distingue en el campo `formato`:

- **`pdf`** — documento binario. Su enlace responde un `302` hacia `download.seam?cid=...`, que entrega
  el PDF. Se guarda como `.pdf`.
- **`html`** — documento redactado dentro del sistema, servido únicamente renderizado por
  `documentoSemLoginHTML.seam`. **No existe un PDF equivalente público**; se guarda como `.html` para no
  perderlo silenciosamente. Este visor solo responde dentro de la conversación de Seam que abre la ficha,
  por eso `--retry-failed` reabre la ficha antes de reintentar uno de estos.

Algunos documentos tienen además un comprobante de protocolo en PDF (`reportReciboPDF.seam`), que es una
pieza distinta del documento; se descarga solo con `--comprovantes`.

**6. Codificación.** Las páginas completas llegan en **ISO-8859-1** y las respuestas AJAX en **UTF-8**.
El cliente HTTP decodifica según el charset que declara cada respuesta, y codifica los formularios en
ISO-8859-1, como hace el navegador.

---

## Manejo de errores 429

Toda la política vive en `src/http/HttpClient.ts`, de modo que la heredan por igual las búsquedas, las
fichas y las descargas:

1. **Limitador de tasa propio.** Se respeta una espera mínima entre peticiones (`--delay`, 900 ms por
   defecto) para no forzar al servidor de entrada.
2. **Detección.** Se reintenta ante `429`, ante `5xx` transitorios (500, 502, 503, 504), ante `408`/`425`
   y ante errores de red o timeouts.
3. **Backoff exponencial con jitter.** La espera crece `2s → 4s → 8s → 16s → 32s`, con un tope de 60 s y
   un jitter de ±25 % para no reintentar todo en el mismo instante.
4. **`Retry-After`.** Si el servidor indica cuánto esperar, se respeta ese valor (acotado a 5 minutos)
   en lugar del backoff calculado.
5. **Freno global.** Un `429` no solo retrasa la petición que lo recibió: también atrasa el turno de las
   siguientes, para que el scraper baje el ritmo en conjunto.
6. **Continuidad.** Agotados los reintentos, el documento se registra en `output/failed-downloads.ndjson`
   con su URL, su motivo y la cantidad de intentos, y **el scraper sigue con el siguiente documento**;
   un proceso que falle por completo tampoco interrumpe la corrida.
7. **Reintento posterior.** `npm run retry:failed` vuelve a intentar solo lo que quedó pendiente y
   reescribe la bitácora con lo que siga fallando.

Además, cada PDF se valida por su firma (`%PDF-`) antes de guardarse: si el servidor responde una página
de error con estado 200, se trata como fallo y no se guarda un archivo corrupto.

### Verificación

Como el 429 depende de la carga del sitio, el manejo se verifica contra un servidor local que lo simula:

```bash
npm run test:429
```

```
ok  reintenta y se recupera tras 429 transitorios
ok  respeta la cabecera Retry-After
ok  agota los reintentos y lanza RateLimitError
ok  el backoff crece de forma exponencial

4/4 verificaciones de rate limiting superadas
```

---

## Robustez

- **Reanudable.** `output/state.json` registra los procesos ya extraídos; una corrida interrumpida
  retoma donde quedó. Los archivos ya descargados se omiten (salvo `--force`).
- **Escritura incremental.** Cada proceso se persiste apenas se extrae (append a NDJSON), así que una
  interrupción no pierde lo ya obtenido.
- **Sin identificadores codificados a mano.** Los `j_idNNN` de JSF cambian entre vistas y versiones:
  todos se leen del HTML recibido.
- **Aislamiento de fallos.** Un documento que falla no aborta el proceso; un proceso que falla no aborta
  la corrida.
- **Topes de seguridad.** La paginación tiene un límite de páginas para no quedar en bucle si el servidor
  informara un total inconsistente.

---

## Estructura del proyecto

```
src/
├── index.ts                  # orquestación: búsquedas → fichas → descargas
├── cli.ts                    # parseo de argumentos
├── config.ts                 # URLs, ids de tablas y valores por defecto
├── types.ts                  # tipos del dominio
├── http/
│   ├── HttpClient.ts         # sesión, rate limiting, charsets, reintentos y 429
│   └── errors.ts             # errores tipados del scraper
├── jsf/
│   └── parse.ts              # ViewState, acciones A4J, sliders y datascrollers
├── scraper/
│   ├── SearchClient.ts       # formulario fPP y tabla de resultados
│   ├── DetailClient.ts       # ficha del proceso y paginación de sus tablas
│   └── DocumentDownloader.ts # descarga de PDFs y documentos HTML
├── storage/
│   ├── ResultStore.ts        # NDJSON + JSON por proceso
│   ├── FailureLog.ts         # bitácora de descargas fallidas
│   └── StateStore.ts         # estado para reanudar
└── util/                     # logger, fechas, texto y temporización
test/
└── rate-limit.test.ts        # verificación del manejo de 429
```

---

## Notas y limitaciones

- La consulta pública no muestra procesos bajo secreto de justicia (art. 1º, párrafo único, de la
  Resolución nº 121 del CNJ), ni devuelve más de 30 resultados por búsqueda.
- El campo «nome da parte» exige dos palabras o más: una sola palabra devuelve cero resultados.
- Los documentos en formato HTML se guardan tal como los sirve el sitio, con el marco de la página
  incluido. Se prefirió conservar la respuesta íntegra antes que recortarla con heurísticas frágiles.
- Descargar todo el acervo requiere dejar el scraper corriendo un tiempo largo: con la espera mínima por
  defecto, el ritmo es de aproximadamente una petición por segundo, deliberadamente conservador.
