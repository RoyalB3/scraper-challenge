/** Errores propios del scraper, para distinguir fallos recuperables de los que no lo son. */

export class ScraperError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** La peticion agoto todos los reintentos y el ultimo estado seguia siendo 429. */
export class RateLimitError extends ScraperError {
  constructor(
    readonly url: string,
    readonly attempts: number,
  ) {
    super(`429 Too Many Requests tras ${attempts} intento(s): ${url}`);
  }
}

/** La peticion agoto los reintentos por un estado HTTP no recuperable o de servidor. */
export class HttpStatusError extends ScraperError {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly attempts: number,
  ) {
    super(`HTTP ${status} tras ${attempts} intento(s): ${url}`);
  }
}

/** Fallo de red/timeout persistente. */
export class NetworkError extends ScraperError {
  constructor(
    readonly url: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`Fallo de red tras ${attempts} intento(s): ${url}`, cause);
  }
}
