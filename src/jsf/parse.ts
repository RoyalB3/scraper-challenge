/**
 * Utilidades para leer los artefactos de JSF / RichFaces 3.3 (Ajax4jsf) que el
 * PJe genera. El sitio no expone ninguna API: la navegacion se hace replicando
 * los POST que dispara `A4J.AJAX.Submit` en el navegador.
 *
 * Todos los identificadores (`j_id123`, ...) son generados por el servidor y
 * cambian entre versiones y entre vistas, por eso nunca se codifican fijos:
 * siempre se extraen del HTML recibido.
 */

/** Parametros necesarios para reproducir un `A4J.AJAX.Submit`. */
export interface A4JAction {
  /** Nombre del parametro que identifica la accion, ej. `fPP:j_id244`. */
  actionParam: string;
  /**
   * Valor de `AJAXREQUEST`. Es `_viewRoot` salvo que el componente declare un
   * `containerId`, en cuyo caso el servidor exige ese id (de lo contrario
   * responde una actualizacion vacia).
   */
  ajaxRequest: string;
}

/** Paginador `rich:inputNumberSlider` (movimientos y documentos del detalle). */
export interface SliderPaginator extends A4JAction {
  /** Id del formulario que envuelve al slider. */
  formId: string;
  /** Nombre del campo que lleva el numero de pagina. */
  fieldName: string;
  minPage: number;
  maxPage: number;
}

/** Paginador `rich:datascroller` (listas de partes del detalle). */
export interface DataScrollerPaginator extends A4JAction {
  formId: string;
  /** Nombre del parametro que recibe el numero de pagina. */
  scrollerParam: string;
  maxPage: number;
}

/**
 * Lee el `javax.faces.ViewState`. En las respuestas AJAX el valor vigente es el
 * que viaja dentro de `<span id="ajax-view-state">`, por eso tiene prioridad.
 */
export { indexOfTable };

export function extractViewState(html: string): string {
  const ajax = html.match(
    /<span id="ajax-view-state">[\s\S]*?name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/i,
  );
  if (ajax?.[1]) return ajax[1];
  const plain = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/i);
  if (plain?.[1]) return plain[1];
  throw new Error('No se encontro javax.faces.ViewState en la respuesta');
}

/**
 * Extrae la accion de busqueda. El boton "Pesquisar" delega en la funcion
 * `executarPesquisa()` (interpuesta por el reCAPTCHA, hoy deshabilitado en el
 * sitio), y es esa funcion la que lleva el parametro real de la accion.
 */
export function extractSearchAction(html: string): A4JAction {
  const fn = html.match(/executarPesquisa\s*=\s*function\s*\(\)\s*\{[\s\S]*?\}\s*\)\s*\}/);
  const source = fn?.[0] ?? html.match(/<input[^>]*id="fPP:searchProcessos"[^>]*>/)?.[0];
  if (!source) throw new Error('No se encontro la accion de busqueda en el formulario fPP');
  return parseA4JAction(source);
}

/**
 * Lee `'parameters':{'X':'Y'}` y `'containerId':'Z'` de una llamada a
 * `A4J.AJAX.Submit`, tolerando las comillas escapadas (`\'`) que RichFaces usa
 * cuando el fragmento va anidado dentro de otro atributo.
 */
export function parseA4JAction(source: string): A4JAction {
  const normalized = source.replace(/\\'/g, "'");
  const params = normalized.match(/'parameters'\s*:\s*\{\s*'([^']+)'/);
  if (!params?.[1]) throw new Error('No se pudo leer el parametro de accion A4J');
  const container = normalized.match(/'containerId'\s*:\s*'([^']+)'/);
  return {
    actionParam: params[1],
    ajaxRequest: container?.[1] ?? '_viewRoot',
  };
}

/**
 * Ubica una tabla por el sufijo de su id. Los ids del PJe llevan el prefijo del
 * formulario contenedor (`j_id146:processoEvento`), que cambia entre vistas.
 */
function indexOfTable(html: string, tableIdSuffix: string): number {
  const m = html.match(new RegExp(`id="[^"]*${escapeRegExp(tableIdSuffix)}"`));
  return m?.index ?? -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Localiza el slider de paginacion que sigue a una tabla dada.
 * Devuelve `null` cuando la tabla cabe en una sola pagina.
 */
export function extractSliderPaginator(html: string, tableId: string): SliderPaginator | null {
  const start = indexOfTable(html, tableId);
  if (start < 0) return null;
  const region = html.slice(start);
  const slider = region.match(/new Richfaces\.Slider\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\}\s*\)/);
  if (!slider?.[1] || !slider[2]) return null;

  const fieldName = slider[1];
  const config = slider[2];
  const minPage = Number.parseInt(readJsOption(config, 'minValue') ?? '1', 10);
  const maxPage = Number.parseInt(readJsOption(config, 'maxValue') ?? '1', 10);
  const action = parseA4JAction(config);
  const formId = fieldName.slice(0, fieldName.lastIndexOf(':'));

  return {
    ...action,
    formId,
    fieldName,
    minPage: Number.isNaN(minPage) ? 1 : minPage,
    maxPage: Number.isNaN(maxPage) ? 1 : maxPage,
  };
}

/**
 * Localiza el `rich:datascroller` que sigue a una tabla dada.
 * Devuelve `null` cuando la tabla cabe en una sola pagina.
 */
export function extractDataScroller(html: string, tableId: string): DataScrollerPaginator | null {
  const start = indexOfTable(html, tableId);
  if (start < 0) return null;
  const region = html.slice(start);
  const scroller = region.match(
    /new Richfaces\.Datascroller\(\s*'([^']+)'\s*,\s*function\s*\(event\)\s*\{([\s\S]*?)\}\s*\)\s*;?\s*<\/script>/,
  );
  if (!scroller?.[1] || !scroller[2]) return null;

  const scrollerParam = scroller[1];
  const body = scroller[2];
  const action = parseA4JAction(body);
  const formId = scrollerParam.slice(0, scrollerParam.lastIndexOf(':'));

  // El scroller no publica el total de paginas: se toma el mayor numero listado.
  const scrollerRegion = region.slice(0, region.indexOf('new Richfaces.Datascroller('));
  const pages = [...scrollerRegion.matchAll(/'rich:datascroller:onscroll',\s*\{'page':\s*'(\d+)'\}/g)]
    .map((m) => Number.parseInt(m[1] ?? '1', 10))
    .filter((n) => !Number.isNaN(n));
  const maxPage = pages.length > 0 ? Math.max(...pages) : 1;

  return { ...action, formId, scrollerParam, maxPage };
}

function readJsOption(config: string, name: string): string | null {
  const m = config.match(new RegExp(`'${name}'\\s*:\\s*'([^']*)'`));
  return m?.[1] ?? null;
}
