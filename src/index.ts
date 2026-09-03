#!/usr/bin/env node
/**
 * Punto de entrada del scraper de la Consulta Publica del PJe (TRF5).
 *
 * Flujo general:
 *   1. Se arma una o varias busquedas segun los criterios de la linea de comandos.
 *   2. Cada busqueda devuelve hasta 30 procesos (tope duro del sitio).
 *   3. De cada proceso se extrae la ficha completa, paginando sus cuatro tablas.
 *   4. De cada documento se descarga su PDF (o su version HTML, cuando el
 *      sitio no publica binario), con reintentos y backoff ante 429.
 *   5. Todo se persiste incrementalmente para poder reanudar o reintentar.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { parseArgs, type CliOptions } from './cli';
import { DEFAULTS, DETAIL_URL, SEARCH_RESULT_CAP } from './config';
import { HttpClient } from './http/HttpClient';
import { DetailClient } from './scraper/DetailClient';
import { DocumentDownloader } from './scraper/DocumentDownloader';
import { SearchClient } from './scraper/SearchClient';
import { FailureLog } from './storage/FailureLog';
import { ResultStore } from './storage/ResultStore';
import { StateStore } from './storage/StateStore';
import type { FailedDownload, ProcessDetail, SearchCriteria } from './types';
import { eachDay } from './util/dates';
import { Logger } from './util/logger';

interface RunTotals {
  buscas: number;
  processos: number;
  documentos: number;
  pdfsDescargados: number;
  htmlDescargados: number;
  omitidos: number;
  fallidos: number;
  busquedasTruncadas: number;
}

async function main(): Promise<void> {
  let options: CliOptions | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!options) return; // se mostro la ayuda

  const logger = new Logger(options.logLevel);
  const outputDir = path.resolve(options.outputDir);
  await fs.mkdir(outputDir, { recursive: true });

  const http = new HttpClient({
    minDelayMs: options.minDelayMs,
    maxRetries: options.maxRetries,
    retryBaseMs: DEFAULTS.retryBaseMs,
    retryMaxMs: DEFAULTS.retryMaxMs,
    timeoutMs: DEFAULTS.timeoutMs,
    userAgent: DEFAULTS.userAgent,
    logger,
  });

  const failures = new FailureLog(outputDir);
  const downloader = new DocumentDownloader(
    http,
    {
      baseDir: path.join(outputDir, 'documentos'),
      skipExisting: !options.force,
      comprovantes: options.comprovantes,
    },
    logger,
  );

  if (options.retryFailed) {
    await retryFailedDownloads(http, failures, downloader, logger);
    return;
  }

  const store = new ResultStore(outputDir);
  await store.init();
  const state = new StateStore(outputDir);
  await state.load();
  if (state.size > 0) {
    logger.info(`Estado previo: ${state.size} proceso(s) ya extraido(s)`);
  }

  const search = new SearchClient(http, logger);
  const detail = new DetailClient(http, logger);

  const totals: RunTotals = {
    buscas: 0,
    processos: 0,
    documentos: 0,
    pdfsDescargados: 0,
    htmlDescargados: 0,
    omitidos: 0,
    fallidos: 0,
    busquedasTruncadas: 0,
  };

  const started = Date.now();
  logger.info(`Salida en ${outputDir}`);

  outer: for (const criteria of buildSearches(options)) {
    totals.buscas += 1;
    const result = await search.search(criteria);
    logger.info(`Busqueda ${describe(criteria)}: ${result.total} resultado(s)`);

    if (result.truncated) {
      totals.busquedasTruncadas += 1;
      logger.warn(
        `La busqueda alcanzo el tope de ${SEARCH_RESULT_CAP} resultados del sitio; acote mas los criterios (por ejemplo, con --sweep-days) para no perder procesos`,
      );
    }

    for (const summary of result.processos) {
      if (options.maxProcessos !== null && totals.processos >= options.maxProcessos) {
        logger.info(`Se alcanzo --max-processos=${options.maxProcessos}; se detiene el recorrido`);
        break outer;
      }
      if (!options.force && state.has(summary.ca)) {
        logger.debug(`Ya extraido, se omite: ${summary.numeroProcesso ?? summary.ca}`);
        continue;
      }

      try {
        const ficha = await detail.fetch(summary.ca);
        totals.processos += 1;
        totals.documentos += ficha.documentos.length;
        logger.info(
          `Proceso ${ficha.numeroProcesso ?? summary.ca}: ` +
            `${ficha.poloAtivo.length + ficha.poloPassivo.length} parte(s), ` +
            `${ficha.movimentacoes.length} movimiento(s), ` +
            `${ficha.documentos.length} documento(s)`,
        );

        if (!options.skipPdfs) {
          await downloadDocuments(ficha, options, downloader, failures, totals, logger);
        }

        await store.save(ficha);
        await state.add(summary.ca);
      } catch (error) {
        logger.error(
          `Fallo el proceso ${summary.numeroProcesso ?? summary.ca}: ${message(error)}. Se continua con el siguiente.`,
        );
      }
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  logger.info(
    `Fin en ${seconds}s | busquedas: ${totals.buscas} (truncadas: ${totals.busquedasTruncadas}) | ` +
      `procesos: ${totals.processos} | documentos: ${totals.documentos} | ` +
      `PDFs: ${totals.pdfsDescargados}, HTML: ${totals.htmlDescargados}, ` +
      `omitidos: ${totals.omitidos}, fallidos: ${totals.fallidos}`,
  );
  if (totals.fallidos > 0) {
    logger.warn(`Descargas fallidas registradas en ${failures.file}. Reintente con: npm run retry:failed`);
  }
}

/** Descarga los PDFs de un proceso, registrando los fallos sin abortar la corrida. */
async function downloadDocuments(
  ficha: ProcessDetail,
  options: CliOptions,
  downloader: DocumentDownloader,
  failures: FailureLog,
  totals: RunTotals,
  logger: Logger,
): Promise<void> {
  const limit = options.maxPdfs ?? ficha.documentos.length;
  const documentos = ficha.documentos.slice(0, limit);

  for (const documento of documentos) {
    const outcome = await downloader.download(ficha.numeroProcesso, documento, ficha.detailUrl);

    if (outcome.status === 'downloaded') {
      if (outcome.formato === 'html') totals.htmlDescargados += 1;
      else totals.pdfsDescargados += 1;
      continue;
    }
    if (outcome.status === 'skipped') {
      totals.omitidos += 1;
      continue;
    }

    totals.fallidos += 1;
    logger.warn(`No se pudo descargar "${documento.titulo}": ${outcome.reason ?? 'motivo desconocido'}`);
    const failedUrl = documento.downloadUrl ?? documento.viewerUrl;
    if (failedUrl) {
      await failures.record({
        numeroProcesso: ficha.numeroProcesso,
        ca: ficha.ca,
        documento: documento.titulo,
        downloadUrl: failedUrl,
        formato: outcome.formato ?? 'pdf',
        dataHora: documento.dataHora,
        nome: documento.nome,
        idProcessoDocumento: documento.idProcessoDocumento,
        reason: outcome.reason ?? 'desconocido',
        httpStatus: null,
        attempts: outcome.attempts ?? 1,
        failedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Reintenta las descargas registradas como fallidas.
 *
 * El enlace del PDF binario funciona por si solo, pero el visor HTML solo
 * responde dentro de la conversacion de Seam que abre la ficha del proceso;
 * por eso se reabre la ficha (una vez por proceso) antes de reintentar.
 */
async function retryFailedDownloads(
  http: HttpClient,
  failures: FailureLog,
  downloader: DocumentDownloader,
  logger: Logger,
): Promise<void> {
  const pending = await failures.read();
  if (pending.length === 0) {
    logger.info('No hay descargas fallidas registradas.');
    return;
  }

  logger.info(`Reintentando ${pending.length} descarga(s) fallida(s)`);
  const stillFailing: FailedDownload[] = [];
  let recovered = 0;

  const fichasAbiertas = new Set<string>();

  for (const entry of pending) {
    if (entry.formato === 'html' && !fichasAbiertas.has(entry.ca)) {
      fichasAbiertas.add(entry.ca);
      try {
        await http.get(`${DETAIL_URL}?ca=${entry.ca}`);
      } catch (error) {
        logger.warn(`No se pudo reabrir la ficha ${entry.ca}: ${message(error)}`);
      }
    }

    const outcome = await downloader.download(
      entry.numeroProcesso,
      {
        titulo: entry.documento,
        dataHora: entry.dataHora,
        nome: entry.nome ?? entry.documento,
        tipo: null,
        formato: entry.formato,
        tamanho: null,
        idBin: null,
        idProcessoDocumento: entry.idProcessoDocumento,
        numeroDocumento: null,
        nomeArquivo: null,
        downloadUrl: entry.formato === 'pdf' ? entry.downloadUrl : null,
        viewerUrl: entry.formato === 'html' ? entry.downloadUrl : null,
        comprovanteUrl: null,
      },
      `${DETAIL_URL}?ca=${entry.ca}`,
    );

    if (outcome.status === 'failed') {
      logger.warn(`Sigue fallando "${entry.documento}": ${outcome.reason ?? 'motivo desconocido'}`);
      stillFailing.push({
        ...entry,
        reason: outcome.reason ?? entry.reason,
        attempts: entry.attempts + (outcome.attempts ?? 1),
        failedAt: new Date().toISOString(),
      });
    } else {
      recovered += 1;
    }
  }

  await failures.rewrite(stillFailing);
  logger.info(`Recuperadas: ${recovered} | aun fallidas: ${stillFailing.length}`);
}

/**
 * Traduce las opciones en la secuencia de busquedas a ejecutar.
 *
 * Con `--sweep-days` se emite una busqueda por dia del rango: como el sitio
 * nunca devuelve mas de 30 procesos por consulta, fragmentar por fecha es la
 * forma de recorrer un periodo completo sin perder resultados.
 */
function* buildSearches(options: CliOptions): Generator<SearchCriteria> {
  const base: SearchCriteria = {
    numeroProcesso: options.numeroProcesso,
    nomeParte: options.nomeParte,
    nomeAdvogado: options.nomeAdvogado,
    classeJudicial: options.classeJudicial,
    documentoParte: options.documentoParte,
  };

  if (options.sweepDays && options.dataInicio && options.dataFim) {
    for (const dia of eachDay(options.dataInicio, options.dataFim)) {
      yield { ...base, dataInicio: dia, dataFim: dia };
    }
    return;
  }

  yield { ...base, dataInicio: options.dataInicio, dataFim: options.dataFim };
}

function describe(criteria: SearchCriteria): string {
  const parts = Object.entries(criteria)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join(' ') : '(sin criterios)';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error('Error fatal:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
