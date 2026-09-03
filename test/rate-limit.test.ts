/**
 * Verificacion del manejo de 429 sin golpear el sitio real.
 *
 * Levanta un servidor local que responde 429 las primeras veces y 200 despues,
 * y comprueba que el cliente reintenta con backoff, respeta `Retry-After` y
 * termina fallando con `RateLimitError` cuando el 429 es persistente.
 *
 * Ejecutar con: npm run test:429
 */

import * as http from 'node:http';
import assert from 'node:assert/strict';

import { HttpClient } from '../src/http/HttpClient';
import { RateLimitError } from '../src/http/errors';
import { Logger } from '../src/util/logger';

interface Scenario {
  /** Cuantas respuestas 429 emite antes de responder 200. */
  failures: number;
  /** Valor de la cabecera `Retry-After`, en segundos. */
  retryAfter?: number;
}

async function withServer<T>(
  scenario: Scenario,
  run: (baseUrl: string, hits: () => number) => Promise<T>,
): Promise<T> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    if (hits <= scenario.failures) {
      if (scenario.retryAfter !== undefined) res.setHeader('Retry-After', String(scenario.retryAfter));
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(Buffer.from('%PDF-1.4 ok'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no se pudo abrir el puerto');

  try {
    return await run(`http://127.0.0.1:${address.port}/doc.pdf`, () => hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function clientWith(maxRetries: number): HttpClient {
  return new HttpClient({
    minDelayMs: 0,
    maxRetries,
    retryBaseMs: 20,
    retryMaxMs: 200,
    timeoutMs: 5_000,
    userAgent: 'pje-scraper-test',
    logger: new Logger('error'),
  });
}

async function testRecoversAfterTransient429(): Promise<void> {
  await withServer({ failures: 2 }, async (url, hits) => {
    const response = await clientWith(5).get(url);
    assert.equal(response.status, 200);
    assert.ok(response.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal(hits(), 3, 'debe haber reintentado exactamente dos veces');
  });
  console.log('ok  reintenta y se recupera tras 429 transitorios');
}

async function testHonoursRetryAfter(): Promise<void> {
  await withServer({ failures: 1, retryAfter: 1 }, async (url) => {
    const started = Date.now();
    const response = await clientWith(3).get(url);
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed >= 900, `debe esperar el Retry-After (espero ${elapsed} ms)`);
  });
  console.log('ok  respeta la cabecera Retry-After');
}

async function testGivesUpOnPersistent429(): Promise<void> {
  await withServer({ failures: Number.MAX_SAFE_INTEGER }, async (url, hits) => {
    await assert.rejects(() => clientWith(2).get(url), RateLimitError);
    assert.equal(hits(), 3, 'un intento inicial mas dos reintentos');
  });
  console.log('ok  agota los reintentos y lanza RateLimitError');
}

async function testBackoffGrows(): Promise<void> {
  await withServer({ failures: 3 }, async (url) => {
    const started = Date.now();
    await clientWith(5).get(url);
    const elapsed = Date.now() - started;
    // Backoff base 20 ms: 20 + 40 + 80 = 140 ms menos el jitter (-25%).
    assert.ok(elapsed >= 100, `la espera debe crecer exponencialmente (fueron ${elapsed} ms)`);
  });
  console.log('ok  el backoff crece de forma exponencial');
}

async function main(): Promise<void> {
  await testRecoversAfterTransient429();
  await testHonoursRetryAfter();
  await testGivesUpOnPersistent429();
  await testBackoffGrows();
  console.log('\n4/4 verificaciones de rate limiting superadas');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
