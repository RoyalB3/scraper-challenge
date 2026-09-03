/** Constantes del sitio y valores por defecto del scraper. */

export const SITE = {
  origin: 'https://pjett.trf5.jus.br',
  /** Formulario de busqueda (`fPP`) de la consulta publica. */
  searchPath: '/pjeconsulta/ConsultaPublica/listView.seam',
  /** Ficha de un proceso; se abre con `?ca=<token>`. */
  detailPath: '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam',
} as const;

export const SEARCH_URL = `${SITE.origin}${SITE.searchPath}`;
export const DETAIL_URL = `${SITE.origin}${SITE.detailPath}`;

/**
 * Tope duro de la consulta publica: nunca devuelve mas de 30 procesos por
 * consulta y no ofrece paginacion sobre ese listado. Para cubrir mas procesos
 * hay que fragmentar la busqueda (ver el barrido diario en `index.ts`).
 */
export const SEARCH_RESULT_CAP = 30;

/** Ids de las tablas del detalle. Son estables entre versiones del PJe. */
export const DETAIL_TABLES = {
  poloAtivo: 'processoPartesPoloAtivoResumidoList',
  poloPassivo: 'processoPartesPoloPassivoResumidoList',
  movimentacoes: 'processoEvento',
  documentos: 'processoDocumentoGridTab',
} as const;

export const DEFAULTS = {
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** Espera minima entre peticiones: el sitio es lento y limita por tasa. */
  minDelayMs: 900,
  maxRetries: 5,
  retryBaseMs: 2_000,
  retryMaxMs: 60_000,
  timeoutMs: 120_000,
  outputDir: 'output',
} as const;
