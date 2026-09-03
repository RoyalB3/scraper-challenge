/** Manejo del formato de fecha `dd/MM/yyyy` que usa el formulario del PJe. */

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ONE_DAY_MS = 86_400_000;

export function parseBrDate(value: string): Date {
  const m = value.match(DATE_RE);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    throw new Error(`Fecha invalida "${value}": se espera el formato dd/MM/yyyy`);
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Fecha inexistente: "${value}"`);
  }
  return date;
}

export function formatBrDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

/**
 * Genera cada dia del rango `[inicio, fim]` en formato `dd/MM/yyyy`.
 * Es la base del barrido diario que sortea el tope de 30 resultados por consulta.
 */
export function* eachDay(inicio: string, fim: string): Generator<string> {
  const start = parseBrDate(inicio);
  const end = parseBrDate(fim);
  if (start.getTime() > end.getTime()) {
    throw new Error(`El rango de fechas esta invertido: ${inicio} > ${fim}`);
  }
  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + ONE_DAY_MS)) {
    yield formatBrDate(d);
  }
}
