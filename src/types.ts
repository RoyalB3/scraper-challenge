/**
 * Tipos de dominio del scraper de la Consulta Publica del PJe (TRF5).
 *
 * El vocabulario del sitio es portugues (processo, polo, movimentacao,
 * documento); se mantiene tal cual para que el JSON generado sea trazable
 * contra la pagina original.
 */

/** Criterios aceptados por el formulario de busqueda `fPP`. */
export interface SearchCriteria {
  /** Numero unico CNJ, ej. `0001223-51.1994.4.05.8300`. */
  numeroProcesso?: string;
  /** Nombre de una parte. El sitio exige al menos dos palabras. */
  nomeParte?: string;
  /** Nombre del abogado. */
  nomeAdvogado?: string;
  /** Clase judicial exacta, ej. `APELACAO CIVEL`. */
  classeJudicial?: string;
  /** CPF/CNPJ de la parte (solo digitos o con mascara). */
  documentoParte?: string;
  /** Inicio del rango de fecha de distribucion, formato `dd/MM/yyyy`. */
  dataInicio?: string;
  /** Fin del rango de fecha de distribucion, formato `dd/MM/yyyy`. */
  dataFim?: string;
}

/** Fila de la tabla de resultados de la busqueda. */
export interface ProcessSummary {
  /** Token `ca` que identifica al proceso en la consulta publica. */
  ca: string;
  /** URL absoluta del detalle. */
  detailUrl: string;
  numeroProcesso: string | null;
  siglaClasse: string | null;
  classeJudicial: string | null;
  assunto: string | null;
  partes: string | null;
  ultimaMovimentacao: string | null;
}

/** Resultado completo de una busqueda. */
export interface SearchResult {
  criteria: SearchCriteria;
  /** Total informado por el sitio ("N resultados encontrados"). */
  total: number;
  /**
   * `true` cuando el total alcanza el tope duro del sitio (30). En ese caso
   * hay resultados que la consulta publica no expone y conviene acotar mas
   * los criterios (ver `DaySweep` en el README).
   */
  truncated: boolean;
  processos: ProcessSummary[];
}

/** Representante (abogado, defensoria, procuradoria) de una parte. */
export interface Representative {
  descricao: string;
  nome: string | null;
  oab: string | null;
  documento: string | null;
  papel: string | null;
}

/** Participante de un polo (activo o pasivo). */
export interface Party {
  descricao: string;
  nome: string | null;
  documento: string | null;
  papel: string | null;
  situacao: string | null;
  representantes: Representative[];
}

/** Movimiento procesal. */
export interface Movement {
  dataHora: string | null;
  descricao: string;
  documento: string | null;
}

/**
 * Documento adjunto al proceso.
 *
 * El PJe expone dos formatos distintos y el scraper los distingue:
 *  - `pdf`  : documento binario, descargable directamente (`downloadUrl`);
 *  - `html` : documento redactado en el sistema, que solo se sirve renderizado
 *             como HTML (`viewerUrl`); no existe un PDF equivalente publico.
 * Ademas, algunos documentos tienen un comprobante de protocolo en PDF
 * (`comprovanteUrl`), que es una pieza distinta del documento en si.
 */
export interface ProcessDocument {
  /** Texto completo del enlace, ej. `17/06/2025 13:27:12 - Despacho (Despacho)`. */
  titulo: string;
  dataHora: string | null;
  nome: string | null;
  tipo: string | null;
  /** Formato en que el sitio publica el documento. */
  formato: 'pdf' | 'html' | 'desconhecido';
  /** Tamano declarado en el `title` del enlace, ej. `1,50 Kb`. */
  tamanho: string | null;
  idBin: string | null;
  idProcessoDocumento: string | null;
  numeroDocumento: string | null;
  nomeArquivo: string | null;
  /** URL del PDF binario (redirige a `download.seam`). */
  downloadUrl: string | null;
  /** URL del visor HTML, para los documentos sin version binaria. */
  viewerUrl: string | null;
  /** URL del comprobante de protocolo en PDF, cuando el documento lo tiene. */
  comprovanteUrl: string | null;
}

/** Ficha completa de un proceso. */
export interface ProcessDetail {
  ca: string;
  detailUrl: string;
  numeroProcesso: string | null;
  /** Todos los campos de la cabecera, tal como los rotula el sitio. */
  dados: Record<string, string>;
  poloAtivo: Party[];
  poloPassivo: Party[];
  movimentacoes: Movement[];
  documentos: ProcessDocument[];
  /** Totales informados por el sitio para cada sub-tabla. */
  totais: {
    poloAtivo: number | null;
    poloPassivo: number | null;
    movimentacoes: number | null;
    documentos: number | null;
  };
  /** Momento de la extraccion, ISO-8601. */
  scrapedAt: string;
}

/** Resultado de la descarga de un documento. */
export interface DownloadOutcome {
  status: 'downloaded' | 'skipped' | 'failed';
  /** Formato efectivamente guardado. */
  formato?: 'pdf' | 'html';
  filePath?: string;
  bytes?: number;
  reason?: string;
  attempts?: number;
}

/** Registro de una descarga fallida, persistido para reintentos posteriores. */
export interface FailedDownload {
  numeroProcesso: string | null;
  ca: string;
  documento: string;
  downloadUrl: string;
  /** Formato esperado del recurso que fallo. */
  formato: 'pdf' | 'html';
  /** Fecha y nombre del documento: reconstruyen el mismo nombre de archivo al reintentar. */
  dataHora: string | null;
  nome: string | null;
  idProcessoDocumento: string | null;
  reason: string;
  httpStatus: number | null;
  attempts: number;
  failedAt: string;
}
