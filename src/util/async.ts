/** Utilidades de temporizacion usadas por el limitador de tasa y el backoff. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Aplica jitter aleatorio (+/- `ratio`) a una espera para que varios reintentos
 * no vuelvan a golpear el servidor exactamente al mismo tiempo.
 */
export function jitter(ms: number, ratio = 0.25): number {
  const delta = ms * ratio;
  return Math.round(ms - delta + Math.random() * delta * 2);
}

/**
 * Backoff exponencial acotado: `base * 2^attempt`, con jitter y tope `max`.
 * `attempt` vale 0 para el primer reintento.
 */
export function exponentialBackoff(attempt: number, base: number, max: number): number {
  const raw = base * Math.pow(2, attempt);
  return jitter(Math.min(raw, max));
}
