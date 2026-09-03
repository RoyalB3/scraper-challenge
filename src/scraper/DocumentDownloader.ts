import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { HttpStatusError, NetworkError, RateLimitError } from '../http/errors';
import type { HttpClient } from '../http/HttpClient';
import type { DownloadOutcome, ProcessDocument } from '../types';
import { Logger } from '../util/logger';
import { isoDatePrefix, slug } from '../util/text';

/** Firma de un PDF valido. Sirve para detectar respuestas HTML de error. */
const PDF_MAGIC = Buffer.from('%PDF-');

export interface DocumentDownloaderOptions {
  /** Raiz donde se crea un subdirectorio por proceso. */
  baseDir: string;
  /** Si el archivo ya existe con tamano > 0, no se vuelve a descargar. */
  skipExisting: boolean;
  /** Descarga tambien el comprobante de protocolo en PDF de cada documento. */
  comprovantes: boolean;
}

/**
 * Descarga los documentos de un proceso.
 *
 * Los documentos binarios se guardan como `.pdf`: su enlace responde un 302
 * hacia `download.seam` y el cliente HTTP sigue la redireccion manteniendo la
 * sesion. Los documentos que el PJe solo publica renderizados se guardan como
 * `.html`, para no perderlos silenciosamente.
 *
 * Toda la politica de 429 (reintentos con backoff exponencial) la aporta el
 * cliente HTTP; aqui solo se traduce el fallo final a un resultado que el
 * orquestador pueda registrar y seguir adelante.
 */
export class DocumentDownloader {
  private readonly log: Logger;

  constructor(
    private readonly http: HttpClient,
    private readonly options: DocumentDownloaderOptions,
    logger: Logger,
  ) {
    this.log = logger.child('download');
  }

  /**
   * Descarga un documento. Nunca lanza: devuelve el resultado para que el
   * orquestador registre los fallos y continue con el siguiente documento.
   */
  async download(
    numeroProcesso: string | null,
    document: ProcessDocument,
    referer: string,
  ): Promise<DownloadOutcome> {
    const target = document.downloadUrl
      ? ({ url: document.downloadUrl, formato: 'pdf' } as const)
      : document.viewerUrl
        ? ({ url: document.viewerUrl, formato: 'html' } as const)
        : null;

    if (!target) {
      return { status: 'skipped', reason: 'el documento no expone enlace de descarga' };
    }

    const outcome = await this.fetchTo(
      target.url,
      this.pathFor(numeroProcesso, document, target.formato),
      target.formato,
      referer,
    );

    if (this.options.comprovantes && document.comprovanteUrl) {
      // El comprobante es una pieza aparte: su fallo no invalida el documento.
      const comprovantePath = this.pathFor(numeroProcesso, document, 'pdf', '_comprovante');
      const result = await this.fetchTo(document.comprovanteUrl, comprovantePath, 'pdf', referer);
      if (result.status === 'failed') {
        this.log.warn(`No se pudo descargar el comprobante de "${document.titulo}": ${result.reason}`);
      }
    }

    return outcome;
  }

  private async fetchTo(
    url: string,
    filePath: string,
    formato: 'pdf' | 'html',
    referer: string,
  ): Promise<DownloadOutcome> {
    if (this.options.skipExisting && (await fileHasContent(filePath))) {
      this.log.debug(`Ya existe, se omite: ${filePath}`);
      return { status: 'skipped', formato, filePath, reason: 'ya descargado' };
    }

    try {
      const response = await this.http.get(url, { headers: { Referer: referer } });

      if (formato === 'pdf' && !looksLikePdf(response.body)) {
        return {
          status: 'failed',
          formato,
          reason: `la respuesta no es un PDF (content-type: ${response.contentType || 'desconocido'}, ${response.body.length} bytes)`,
        };
      }
      if (formato === 'html' && response.text.trim() === '') {
        return { status: 'failed', formato, reason: 'el visor devolvio una respuesta vacia' };
      }

      const body = formato === 'pdf' ? response.body : Buffer.from(response.text, 'utf8');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, body);
      this.log.info(
        `${formato.toUpperCase()} guardado: ${path.relative(process.cwd(), filePath)} (${body.length} bytes)`,
      );
      return { status: 'downloaded', formato, filePath, bytes: body.length };
    } catch (error) {
      return { status: 'failed', formato, ...describeFailure(error) };
    }
  }

  private pathFor(
    numeroProcesso: string | null,
    document: ProcessDocument,
    formato: 'pdf' | 'html',
    suffix = '',
  ): string {
    const dir = path.join(this.options.baseDir, slug(numeroProcesso ?? 'sem-numero', 80));
    return path.join(dir, buildFileName(numeroProcesso, document, formato, suffix));
  }
}

/** Traduce el error a un motivo legible, preservando el numero de intentos. */
function describeFailure(error: unknown): { reason: string; attempts?: number } {
  if (error instanceof RateLimitError) {
    return { reason: `429 persistente: ${error.message}`, attempts: error.attempts };
  }
  if (error instanceof HttpStatusError) {
    return { reason: `HTTP ${error.status}`, attempts: error.attempts };
  }
  if (error instanceof NetworkError) {
    return { reason: `error de red: ${error.message}`, attempts: error.attempts };
  }
  return { reason: error instanceof Error ? error.message : String(error) };
}

function looksLikePdf(body: Buffer): boolean {
  return body.length > 0 && body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Nombre descriptivo y estable:
 * `<numero-processo>_<fecha>_<nombre-documento>_<id>.<ext>`.
 *
 * La fecha va en formato ISO para que el orden alfabetico coincida con el
 * cronologico, y el id del documento garantiza unicidad dentro del proceso.
 */
export function buildFileName(
  numeroProcesso: string | null,
  document: ProcessDocument,
  formato: 'pdf' | 'html' = 'pdf',
  suffix = '',
): string {
  const processo = slug(numeroProcesso ?? 'sem-numero', 40);
  const fecha = isoDatePrefix(document.dataHora);
  const nombre = slug(document.nome ?? document.nomeArquivo ?? 'documento', 60);
  const id =
    document.idProcessoDocumento ??
    document.idBin ??
    createHash('sha1').update(document.titulo).digest('hex').slice(0, 8);
  return `${processo}_${fecha}_${nombre}_${id}${suffix}.${formato}`;
}
