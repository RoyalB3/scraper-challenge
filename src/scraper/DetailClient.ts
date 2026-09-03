import * as cheerio from 'cheerio';

import { DETAIL_TABLES, DETAIL_URL, SITE } from '../config';
import type { HttpClient } from '../http/HttpClient';
import {
  extractDataScroller,
  extractSliderPaginator,
  extractViewState,
  indexOfTable,
} from '../jsf/parse';
import type { Movement, Party, ProcessDetail, ProcessDocument, Representative } from '../types';
import { Logger } from '../util/logger';
import { nullIfEmpty, parseResultCount, squash } from '../util/text';

/** Tope de seguridad por si el servidor informara un numero de paginas absurdo. */
const MAX_PAGES = 200;

/** Conjunto de nodos devuelto por `$(...)`; evita depender de los tipos de domhandler. */
type Nodes = ReturnType<cheerio.CheerioAPI>;

/**
 * Extrae la ficha completa de un proceso.
 *
 * La ficha se abre con `GET ...listView.seam?ca=<token>` y sus cuatro tablas
 * (polo activo, polo pasivo, movimientos y documentos) se paginan por AJAX
 * dentro de la misma sesion y conversacion de Seam. Por eso todo el recorrido
 * de un proceso se hace de forma secuencial y sin intercalar otro proceso.
 */
export class DetailClient {
  private readonly log: Logger;

  constructor(
    private readonly http: HttpClient,
    logger: Logger,
  ) {
    this.log = logger.child('detalhe');
  }

  async fetch(ca: string): Promise<ProcessDetail> {
    const url = `${DETAIL_URL}?ca=${ca}`;
    const page = await this.http.get(url);
    const html = page.text;

    const $ = cheerio.load(html);
    const dados = parseDadosProcesso($);

    const poloAtivo = await this.collectScrollerPages(html, DETAIL_TABLES.poloAtivo, url, parseParties);
    const poloPassivo = await this.collectScrollerPages(
      html,
      DETAIL_TABLES.poloPassivo,
      url,
      parseParties,
    );
    const movimentacoes = await this.collectSliderPages(
      html,
      DETAIL_TABLES.movimentacoes,
      url,
      parseMovements,
    );
    const documentos = await this.collectSliderPages(
      html,
      DETAIL_TABLES.documentos,
      url,
      parseDocuments,
    );

    return {
      ca,
      detailUrl: url,
      numeroProcesso: dados['Numero Processo'] ?? dados['Número Processo'] ?? null,
      dados,
      poloAtivo,
      poloPassivo,
      movimentacoes,
      documentos,
      totais: {
        poloAtivo: countFor(html, DETAIL_TABLES.poloAtivo),
        poloPassivo: countFor(html, DETAIL_TABLES.poloPassivo),
        movimentacoes: countFor(html, DETAIL_TABLES.movimentacoes),
        documentos: countFor(html, DETAIL_TABLES.documentos),
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * Recorre una tabla paginada por `rich:inputNumberSlider` (movimientos y
   * documentos): la pagina 1 ya viene en el HTML inicial y el resto se pide por
   * AJAX enviando el numero de pagina en el campo del slider.
   */
  private async collectSliderPages<T>(
    firstPageHtml: string,
    tableId: string,
    referer: string,
    parse: (html: string, tableId: string) => T[],
  ): Promise<T[]> {
    const items = parse(firstPageHtml, tableId);
    const slider = extractSliderPaginator(firstPageHtml, tableId);
    if (!slider || slider.maxPage <= slider.minPage) return items;

    let viewState = extractViewState(firstPageHtml);
    const lastPage = Math.min(slider.maxPage, MAX_PAGES);

    for (let page = slider.minPage + 1; page <= lastPage; page += 1) {
      const fields: Array<[string, string]> = [
        ['AJAXREQUEST', slider.ajaxRequest],
        [slider.fieldName, String(page)],
        [slider.formId, slider.formId],
        ['autoScroll', ''],
        ['javax.faces.ViewState', viewState],
        [slider.actionParam, slider.actionParam],
        ['AJAX:EVENTS_COUNT', '1'],
      ];
      const response = await this.http.postForm(DETAIL_URL, fields, {
        headers: { Referer: referer },
      });
      const pageItems = parse(response.text, tableId);
      this.log.debug(`${tableId}: pagina ${page}/${lastPage} con ${pageItems.length} filas`);
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      viewState = safeViewState(response.text, viewState);
    }

    return items;
  }

  /**
   * Recorre una tabla paginada por `rich:datascroller` (listas de partes).
   * El scroller solo muestra una ventana de numeros de pagina, asi que se
   * re-lee el paginador en cada respuesta para descubrir las siguientes.
   */
  private async collectScrollerPages<T>(
    firstPageHtml: string,
    tableId: string,
    referer: string,
    parse: (html: string, tableId: string) => T[],
  ): Promise<T[]> {
    const items = parse(firstPageHtml, tableId);
    let scroller = extractDataScroller(firstPageHtml, tableId);
    if (!scroller || scroller.maxPage <= 1) return items;

    let viewState = extractViewState(firstPageHtml);
    const seen = new Set<number>([1]);

    for (let page = 2; page <= MAX_PAGES; page += 1) {
      if (page > scroller.maxPage) break;
      if (seen.has(page)) continue;
      seen.add(page);

      const fields: Array<[string, string]> = [
        ['AJAXREQUEST', scroller.ajaxRequest],
        [scroller.formId, scroller.formId],
        [scroller.scrollerParam, String(page)],
        ['ajaxSingle', scroller.scrollerParam],
        ['autoScroll', ''],
        ['javax.faces.ViewState', viewState],
        ['AJAX:EVENTS_COUNT', '1'],
      ];
      const response = await this.http.postForm(DETAIL_URL, fields, {
        headers: { Referer: referer },
      });
      const pageItems = parse(response.text, tableId);
      this.log.debug(`${tableId}: pagina ${page}/${scroller.maxPage} con ${pageItems.length} filas`);
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      viewState = safeViewState(response.text, viewState);
      // El scroller de la respuesta puede revelar paginas que antes no listaba.
      scroller = extractDataScroller(response.text, tableId) ?? scroller;
    }

    return items;
  }
}

function safeViewState(html: string, fallback: string): string {
  try {
    return extractViewState(html);
  } catch {
    return fallback;
  }
}

/** Lee el "N resultados encontrados" que sigue a una tabla. */
function countFor(html: string, tableId: string): number | null {
  const start = indexOfTable(html, tableId);
  if (start < 0) return null;
  return parseResultCount(html.slice(start, start + 200_000));
}

/**
 * Cabecera del proceso: cada campo es un `.propertyView` con `.name label`
 * (rotulo) y `.value` (valor). Un bloque agrupa varios campos con `<b>rotulo</b>`
 * seguido del valor, y esos se aplanan al mismo diccionario.
 */
function parseDadosProcesso($: cheerio.CheerioAPI): Record<string, string> {
  const dados: Record<string, string> = {};

  $('[id$="processoTrfViewView"] .propertyView, [id*="processoTrfViewView"] .propertyView').each(
    (_, el) => {
      const $el = $(el);
      const label = squash($el.find('.name label').first().text());
      const $value = $el.find('.value').first();

      const inlineFields = parseInlineFields($, $value);
      if (Object.keys(inlineFields).length > 0) {
        Object.assign(dados, inlineFields);
        if (label) {
          const rest = squash($value.text());
          if (rest) dados[label] = rest;
        }
        return;
      }

      const value = squash($value.text());
      if (label && value) dados[label] = value;
    },
  );

  return dados;
}

/** Aplana bloques del tipo `<b>Rotulo</b><br/>valor<br/><b>Otro</b><br/>valor`. */
function parseInlineFields($: cheerio.CheerioAPI, $value: Nodes): Record<string, string> {
  const out: Record<string, string> = {};
  const $bolds = $value.find('b');
  if ($bolds.length === 0) return out;

  $bolds.each((_, b) => {
    const label = squash($(b).text());
    if (!label) return;
    const parts: string[] = [];
    let node = b.next;
    while (node) {
      const $node = $(node);
      if (node.type === 'tag' && node.name === 'b') break;
      const text = squash($node.text());
      if (text) parts.push(text);
      node = node.next;
    }
    const value = squash(parts.join(' '));
    if (value) out[label] = value;
  });

  return out;
}

/**
 * Filas de un polo. Las partes principales llevan `.text-bold`; las filas
 * siguientes sin esa clase son sus representantes (abogados, procuradorias) y
 * se anidan bajo la ultima parte leida.
 *
 * Cada celda incluye un `<style>` y un `<ul>` con datos accesorios (defensoria,
 * procuradoria); se separan del texto del participante antes de interpretarlo.
 */
function parseParties(html: string, tableId: string): Party[] {
  const $ = cheerio.load(html);
  const parties: Party[] = [];

  $(`table[id$="${tableId}"] tbody[id$=":tb"] > tr`).each((_, el) => {
    const $row = $(el);
    const cells = $row.children('td');
    if (cells.length === 0) return;

    const $cell = cells.eq(0).clone();
    const extras = $cell
      .find('ul li')
      .map((_i, li) => squash($(li).text()))
      .get()
      .filter((text) => text !== '');
    $cell.find('style, script, ul').remove();

    const descricao = squash($cell.text());
    if (!descricao) return;

    const situacao = cells.length > 1 ? nullIfEmpty(cells.eq(1).text()) : null;
    const isPrincipal = cells.eq(0).find('.text-bold').length > 0;
    const representantes = extras.map((text) => buildRepresentative(text));

    if (isPrincipal || parties.length === 0) {
      parties.push({ descricao, ...splitParticipant(descricao), situacao, representantes });
      return;
    }

    const parent = parties[parties.length - 1];
    if (!parent) return;
    parent.representantes.push(buildRepresentative(descricao), ...representantes);
  });

  return parties;
}

/** `NOMBRE - CPF: 000.000.000-00 (APELANTE)` -> nombre / documento / papel. */
function splitParticipant(descricao: string): {
  nome: string | null;
  documento: string | null;
  papel: string | null;
} {
  const papel = descricao.match(/\(([^)]+)\)\s*$/)?.[1] ?? null;
  const withoutRole = descricao.replace(/\s*\([^)]*\)\s*$/, '');
  const docMatch = withoutRole.match(/(CPF|CNPJ):\s*([\d./-]+)/i);
  const documento = docMatch?.[2] ?? null;
  const nome = squash(withoutRole.split(/\s+-\s+(?:CPF|CNPJ|OAB)/i)[0] ?? withoutRole);
  return { nome: nome || null, documento, papel };
}

function buildRepresentative(descricao: string): Representative {
  const base = splitParticipant(descricao);
  const oab = descricao.match(/OAB\s+([A-Z]{2}\d+[-\w]*)/i)?.[1] ?? null;
  return { descricao, ...base, oab };
}

/** Filas de movimientos: `dd/MM/yyyy HH:mm:ss - descripcion` mas un documento opcional. */
function parseMovements(html: string, tableId: string): Movement[] {
  const $ = cheerio.load(html);
  const movements: Movement[] = [];

  $(`table[id$="${tableId}"] tbody[id$=":tb"] > tr`).each((_, el) => {
    const cells = $(el).children('td');
    if (cells.length === 0) return;
    const raw = squash(cells.eq(0).text());
    if (!raw) return;

    const m = raw.match(/^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*-\s*([\s\S]*)$/);
    movements.push({
      dataHora: m?.[1] ?? null,
      descricao: m?.[2] ? squash(m[2]) : raw,
      documento: cells.length > 1 ? nullIfEmpty(cells.eq(1).text()) : null,
    });
  });

  return movements;
}

/**
 * Filas de documentos.
 *
 * El PJe usa dos variantes de enlace segun como este almacenado el documento:
 *
 *  1. Binario: `<a href="listView.seam?idBin=..&idProcessoDocumento=..&actionMethod=..">`.
 *     Ese GET responde un 302 hacia `download.seam`, que entrega el PDF.
 *  2. HTML: `onclick="openPopUp('<id>popUpDocumento', 'documentoSemLoginHTML.seam?ca=..&idProcessoDoc=..')"`.
 *     Devuelve el documento renderizado como HTML; no hay PDF equivalente.
 *
 * La columna "Certidao" puede traer ademas el comprobante de protocolo en PDF
 * (`reportReciboPDF.seam`), que se registra aparte.
 */
function parseDocuments(html: string, tableId: string): ProcessDocument[] {
  const $ = cheerio.load(html);
  const documents: ProcessDocument[] = [];

  $(`table[id$="${tableId}"] tbody[id$=":tb"] > tr`).each((_, el) => {
    const cells = $(el).children('td');
    if (cells.length === 0) return;

    const $cell = cells.eq(0).clone();
    // Texto solo para lectores de pantalla ("Visualizar documentos"): no es parte del titulo.
    $cell.find('.sr-only').remove();
    const titulo = squash($cell.text());
    if (!titulo) return;

    const $link = cells.eq(0).find('a').first();
    const binaryHref = cells.eq(0).find('a[href*="idProcessoDocumento"]').attr('href') ?? null;
    const binaryUrl = binaryHref ? new URL(binaryHref, SITE.origin) : null;
    const viewerUrl = extractPopUpUrl($link.attr('onclick') ?? '', 'popUpDocumento');
    const comprovanteUrl = extractPopUpUrl(squash(cells.eq(1).html() ?? ''), 'popUpComprovante');

    const title = squash($link.attr('title') ?? '');
    const m = titulo.match(/^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*-\s*(.*?)\s*(?:\(([^()]*)\))?$/);

    documents.push({
      titulo,
      dataHora: m?.[1] ?? null,
      nome: m?.[2] ? squash(m[2]) : titulo,
      tipo: m?.[3] ? squash(m[3]) : null,
      formato: binaryUrl ? 'pdf' : viewerUrl ? 'html' : 'desconhecido',
      tamanho: title.match(/\(([^)]*)\)\s*$/)?.[1] ?? null,
      idBin: binaryUrl?.searchParams.get('idBin') ?? null,
      idProcessoDocumento:
        binaryUrl?.searchParams.get('idProcessoDocumento') ??
        (viewerUrl ? new URL(viewerUrl).searchParams.get('idProcessoDoc') : null),
      numeroDocumento: binaryUrl?.searchParams.get('numeroDocumento') ?? null,
      nomeArquivo: binaryUrl?.searchParams.get('nomeArqProcDocBin') ?? null,
      downloadUrl: binaryUrl ? binaryUrl.toString() : null,
      viewerUrl,
      comprovanteUrl,
    });
  });

  return documents;
}

/** Lee la URL que `openPopUp('<n><nombre>', '<url>')` abre en una ventana nueva. */
function extractPopUpUrl(source: string, popupName: string): string | null {
  const decoded = source.replace(/&amp;/g, '&');
  const m = decoded.match(new RegExp(`openPopUp\\('[^']*${popupName}'\\s*,\\s*'([^']+)'`));
  const raw = m?.[1];
  if (!raw || raw === 'about:blank' || raw === '') return null;
  return new URL(raw, SITE.origin).toString();
}
