import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import iconv from 'iconv-lite';

import { exponentialBackoff, sleep } from '../util/async';
import { Logger } from '../util/logger';
import { HttpStatusError, NetworkError, RateLimitError } from './errors';

/** Respuesta ya decodificada segun el charset declarado por el servidor. */
export interface HttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  /** Cuerpo crudo; los PDFs se guardan desde aqui. */
  body: Buffer;
  /** Cuerpo decodificado a texto (vacio para binarios). */
  text: string;
  contentType: string;
}

export interface HttpClientOptions {
  /** Espera minima entre peticiones, en ms (limitador de tasa propio). */
  minDelayMs: number;
  /** Cantidad maxima de reintentos ante 429 / 5xx / errores de red. */
  maxRetries: number;
  /** Espera base del backoff exponencial, en ms. */
  retryBaseMs: number;
  /** Tope de espera entre reintentos, en ms. */
  retryMaxMs: number;
  /** Timeout por peticion, en ms. */
  timeoutMs: number;
  userAgent: string;
  logger: Logger;
}

/** Estados que ameritan reintento: rate limiting y fallos transitorios del servidor. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Techo para `Retry-After`. Se respeta la espera que pide el servidor (es mas
 * fiable que el backoff propio), pero acotada para que un valor desmedido no
 * deje la corrida colgada.
 */
const RETRY_AFTER_CEILING_MS = 300_000;

/**
 * Cliente HTTP con sesion (cookies), limitador de tasa, decodificacion de
 * charset y reintentos con backoff exponencial.
 *
 * Toda la politica de 429 vive aqui: cualquier peticion del scraper la hereda,
 * ya sea una busqueda, un detalle o la descarga de un PDF.
 */
export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly jar = new CookieJar();
  private readonly log: Logger;
  private nextAllowedAt = 0;
  /** Cola serial: garantiza que el limitador de tasa no se sortee en paralelo. */
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly options: HttpClientOptions) {
    this.log = options.logger.child('http');
    this.axios = wrapper(
      axios.create({
        jar: this.jar,
        timeout: options.timeoutMs,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        decompress: true,
        // Los estados se evaluan en `send`, no como excepciones de axios.
        validateStatus: () => true,
        headers: {
          'User-Agent': options.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7',
        },
      }),
    );
  }

  /** GET de una pagina HTML o de un binario. */
  get(url: string, config: AxiosRequestConfig = {}): Promise<HttpResponse> {
    return this.send({ ...config, method: 'GET', url });
  }

  /**
   * POST de un formulario JSF. El cuerpo se codifica en ISO-8859-1 porque es el
   * charset con el que el PJe renderiza (y por lo tanto lee) sus formularios.
   */
  postForm(
    url: string,
    fields: Array<[string, string]>,
    config: AxiosRequestConfig = {},
  ): Promise<HttpResponse> {
    return this.send({
      ...config,
      method: 'POST',
      url,
      data: encodeFormLatin1(fields),
      headers: {
        ...(config.headers ?? {}),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
  }

  /**
   * Ejecuta la peticion respetando el limitador de tasa y reintentando ante
   * 429 / 5xx / errores de red con backoff exponencial.
   *
   * @throws {RateLimitError} si tras agotar los reintentos el sitio sigue en 429.
   * @throws {HttpStatusError} ante otro estado no recuperable.
   * @throws {NetworkError} ante fallos de red persistentes.
   */
  async send(config: AxiosRequestConfig): Promise<HttpResponse> {
    const url = config.url ?? '';
    const total = this.options.maxRetries + 1;

    for (let attempt = 0; attempt < total; attempt += 1) {
      await this.throttle();

      let response: AxiosResponse<ArrayBuffer> | null = null;
      let networkError: unknown = null;
      try {
        response = await this.axios.request<ArrayBuffer>(config);
      } catch (error) {
        networkError = error;
      }

      const isLast = attempt === total - 1;

      if (networkError) {
        if (isLast) throw new NetworkError(url, total, networkError);
        const wait = this.backoff(attempt);
        this.log.warn(
          `Error de red (${describeError(networkError)}) en ${url}; reintento ${attempt + 1}/${this.options.maxRetries} en ${wait} ms`,
        );
        await sleep(wait);
        continue;
      }

      const res = response as AxiosResponse<ArrayBuffer>;

      if (res.status === 429) {
        if (isLast) throw new RateLimitError(url, total);
        const wait = this.retryAfterMs(res) ?? this.backoff(attempt);
        this.log.warn(
          `429 Too Many Requests en ${url}; espera ${wait} ms (reintento ${attempt + 1}/${this.options.maxRetries})`,
        );
        // Un 429 no solo afecta a esta peticion: frena tambien a las siguientes.
        this.pauseAll(wait);
        await sleep(wait);
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status)) {
        if (isLast) throw new HttpStatusError(url, res.status, total);
        const wait = this.retryAfterMs(res) ?? this.backoff(attempt);
        this.log.warn(
          `HTTP ${res.status} en ${url}; reintento ${attempt + 1}/${this.options.maxRetries} en ${wait} ms`,
        );
        await sleep(wait);
        continue;
      }

      if (res.status >= 400) {
        throw new HttpStatusError(url, res.status, attempt + 1);
      }

      return toHttpResponse(res, url);
    }

    // Inalcanzable: cada rama del bucle retorna o lanza.
    throw new NetworkError(url, total, new Error('bucle de reintentos agotado'));
  }

  /** Espera lo necesario para respetar `minDelayMs` entre peticiones. */
  private async throttle(): Promise<void> {
    const slot = this.gate.then(async () => {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAllowedAt = Date.now() + this.options.minDelayMs;
    });
    this.gate = slot.catch(() => undefined);
    return slot;
  }

  /** Retrasa el proximo turno de todas las peticiones (usado tras un 429). */
  private pauseAll(ms: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + ms);
  }

  private backoff(attempt: number): number {
    return exponentialBackoff(attempt, this.options.retryBaseMs, this.options.retryMaxMs);
  }

  /** Respeta la cabecera `Retry-After` cuando el servidor la envia. */
  private retryAfterMs(res: AxiosResponse): number | null {
    const raw = res.headers['retry-after'];
    if (typeof raw !== 'string') return null;
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, RETRY_AFTER_CEILING_MS);
    const date = Date.parse(raw);
    if (Number.isNaN(date)) return null;
    return Math.max(0, Math.min(date - Date.now(), RETRY_AFTER_CEILING_MS));
  }
}

/** Percent-encoding de un formulario usando ISO-8859-1, como hace el navegador en el PJe. */
export function encodeFormLatin1(fields: Array<[string, string]>): Buffer {
  const encoded = fields
    .map(([key, value]) => `${percentEncodeLatin1(key)}=${percentEncodeLatin1(value)}`)
    .join('&');
  return Buffer.from(encoded, 'latin1');
}

function percentEncodeLatin1(value: string): string {
  const bytes = iconv.encode(value, 'iso-8859-1');
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9*\-._]/.test(char)) out += char;
    else if (char === ' ') out += '+';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function toHttpResponse(res: AxiosResponse<ArrayBuffer>, requestedUrl: string): HttpResponse {
  const body = Buffer.from(res.data);
  const contentType = String(res.headers['content-type'] ?? '');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }
  return {
    status: res.status,
    url: res.request?.res?.responseUrl ?? requestedUrl,
    headers,
    body,
    text: isTextual(contentType) ? decodeBody(body, contentType) : '',
    contentType,
  };
}

function isTextual(contentType: string): boolean {
  return /text\/|xml|json|javascript/i.test(contentType) || contentType === '';
}

/**
 * Decodifica segun el charset declarado. Importa: el PJe entrega las paginas
 * completas en ISO-8859-1 y las respuestas AJAX (`text/xml`) en UTF-8.
 */
function decodeBody(body: Buffer, contentType: string): string {
  const match = contentType.match(/charset=([\w-]+)/i);
  const charset = match?.[1]?.toLowerCase() ?? 'iso-8859-1';
  const normalized = charset === 'utf8' ? 'utf-8' : charset;
  if (!iconv.encodingExists(normalized)) return body.toString('latin1');
  return iconv.decode(body, normalized);
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code ?? 'desconocido');
  }
  return error instanceof Error ? error.message : String(error);
}
