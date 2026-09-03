import * as cheerio from 'cheerio';

import { DETAIL_URL, SEARCH_RESULT_CAP, SEARCH_URL } from '../config';
import type { HttpClient } from '../http/HttpClient';
import { extractSearchAction, extractViewState } from '../jsf/parse';
import type { ProcessSummary, SearchCriteria, SearchResult } from '../types';
import { Logger } from '../util/logger';
import { extractNumeroProcesso, parseResultCount, squash } from '../util/text';

/** Campos del formulario `fPP` con sus valores por defecto (los del navegador). */
const BASE_FIELDS: Array<[string, string]> = [
  ['fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso', ''],
  ['mascaraProcessoReferenciaRadio', 'on'],
  ['fPP:j_id162:processoReferenciaInput', ''],
  ['fPP:dnp:nomeParte', ''],
  ['fPP:j_id180:nomeAdv', ''],
  ['fPP:j_id189:classeJudicial', ''],
  ['fPP:j_id189:sgbClasseJudicial_selection', ''],
  ['tipoMascaraDocumento', 'on'],
  ['fPP:dpDec:documentoParte', ''],
  ['fPP:Decoration:numeroOAB', ''],
  ['fPP:Decoration:j_id223', ''],
  ['fPP:Decoration:estadoComboOAB', 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue'],
  ['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate', ''],
  ['fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate', ''],
  ['fPP', 'fPP'],
  ['autoScroll', ''],
];

/** Mapea cada criterio del scraper al campo del formulario que lo representa. */
const CRITERIA_FIELDS: Record<keyof SearchCriteria, string> = {
  numeroProcesso: 'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso',
  nomeParte: 'fPP:dnp:nomeParte',
  nomeAdvogado: 'fPP:j_id180:nomeAdv',
  classeJudicial: 'fPP:j_id189:classeJudicial',
  documentoParte: 'fPP:dpDec:documentoParte',
  dataInicio: 'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate',
  dataFim: 'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate',
};

/**
 * Ejecuta busquedas contra el formulario `fPP` de la consulta publica.
 *
 * El flujo replica exactamente lo que hace el navegador:
 *   1. GET de la pagina para obtener `javax.faces.ViewState` y la accion A4J.
 *   2. POST del formulario completo con el parametro de accion.
 *   3. La respuesta AJAX trae el fragmento con la tabla de resultados.
 */
export class SearchClient {
  private readonly log: Logger;

  constructor(
    private readonly http: HttpClient,
    logger: Logger,
  ) {
    this.log = logger.child('search');
  }

  async search(criteria: SearchCriteria): Promise<SearchResult> {
    const page = await this.http.get(SEARCH_URL);
    const viewState = extractViewState(page.text);
    const action = extractSearchAction(page.text);

    const fields = buildFields(criteria, viewState, action.actionParam, action.ajaxRequest);
    this.log.debug(`Buscando con ${describeCriteria(criteria)}`);

    const response = await this.http.postForm(SEARCH_URL, fields, {
      headers: { Referer: SEARCH_URL },
    });

    const total = parseResultCount(response.text) ?? 0;
    const processos = parseRows(response.text);

    if (processos.length !== total) {
      this.log.debug(`El sitio informa ${total} resultados y se parsearon ${processos.length} filas`);
    }

    return {
      criteria,
      total,
      truncated: total >= SEARCH_RESULT_CAP,
      processos,
    };
  }
}

function buildFields(
  criteria: SearchCriteria,
  viewState: string,
  actionParam: string,
  ajaxRequest: string,
): Array<[string, string]> {
  const values = new Map(BASE_FIELDS);
  for (const [key, field] of Object.entries(CRITERIA_FIELDS)) {
    const value = criteria[key as keyof SearchCriteria];
    if (value !== undefined && value !== '') values.set(field, value);
  }

  return [
    ['AJAXREQUEST', ajaxRequest],
    ...[...values.entries()],
    ['javax.faces.ViewState', viewState],
    [actionParam, actionParam],
    ['AJAX:EVENTS_COUNT', '1'],
  ];
}

/**
 * Lee las filas de `fPP:processosTable`.
 *
 * Estructura de cada fila:
 *   celda 0 -> boton "Ver Detalhes" con la URL del detalle en el `onclick`;
 *   celda 1 -> clase judicial, luego un `<a><b>sigla numero - asunto</b></a>`
 *              y despues el texto de las partes ("ACTOR X DEMANDADO");
 *   celda 2 -> ultima movimentacion.
 */
function parseRows(html: string): ProcessSummary[] {
  const $ = cheerio.load(html);
  const rows: ProcessSummary[] = [];

  $('table[id$="processosTable"] tbody[id$=":tb"] > tr').each((_, el) => {
    const $row = $(el);
    const cells = $row.children('td');
    if (cells.length < 2) return;

    const ca = extractCa($row.html() ?? '');
    if (!ca) return;

    const $main = cells.eq(1);
    const $link = $main.find('a').filter((_i, a) => $(a).find('b').length > 0).first();
    const boldText = squash($link.find('b').first().text());
    const numeroProcesso = extractNumeroProcesso(boldText);
    const siglaClasse = boldText.split(/\s+/)[0] ?? null;
    const assunto = boldText.includes(' - ')
      ? squash(boldText.split(' - ').slice(1).join(' - '))
      : null;

    // Texto suelto antes del enlace = clase judicial; despues del enlace = partes.
    const anchorNode = $link.get(0);
    const before: string[] = [];
    const after: string[] = [];
    let seenAnchor = false;
    $main.contents().each((_i, node) => {
      if (node === anchorNode) {
        seenAnchor = true;
        return;
      }
      const text = squash($(node).text());
      if (!text) return;
      (seenAnchor ? after : before).push(text);
    });

    rows.push({
      ca,
      detailUrl: `${DETAIL_URL}?ca=${ca}`,
      numeroProcesso,
      siglaClasse: siglaClasse === '' ? null : siglaClasse,
      classeJudicial: squash(before.join(' ')) || null,
      assunto,
      partes: squash(after.join(' ')) || null,
      ultimaMovimentacao: cells.length > 2 ? squash(cells.eq(2).text()) || null : null,
    });
  });

  return rows;
}

function extractCa(rowHtml: string): string | null {
  const m = rowHtml.match(/DetalheProcessoConsultaPublica\/listView\.seam\?ca=([0-9a-fA-F]+)/);
  return m?.[1] ?? null;
}

function describeCriteria(criteria: SearchCriteria): string {
  const parts = Object.entries(criteria)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}="${String(value)}"`);
  return parts.length > 0 ? parts.join(', ') : '(sin criterios)';
}
