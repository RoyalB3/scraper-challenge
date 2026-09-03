/** Normalizacion de texto y construccion de nombres de archivo seguros. */

const NBSP = /\u00a0/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Colapsa espacios, tabulaciones, saltos de linea y `&nbsp;` en un solo espacio. */
export function squash(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
}

/** Devuelve `null` en lugar de cadena vacia, util para campos opcionales. */
export function nullIfEmpty(value: string | null | undefined): string | null {
  const v = squash(value);
  return v === '' ? null : v;
}

/** Extrae el numero unico CNJ de un texto, si esta presente. */
export function extractNumeroProcesso(value: string): string | null {
  const m = value.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return m ? m[0] : null;
}

/**
 * Convierte un texto en un fragmento apto para nombre de archivo: sin acentos,
 * sin separadores de ruta y con longitud acotada.
 */
export function slug(value: string, maxLength = 60): string {
  const ascii = value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (ascii || 'sem-nome').slice(0, maxLength).replace(/-+$/g, '');
}

/**
 * Convierte `dd/MM/yyyy HH:mm:ss` (formato del PJe) a `yyyy-MM-dd`, que ordena
 * alfabeticamente igual que cronologicamente en el nombre del archivo.
 */
export function isoDatePrefix(value: string | null): string {
  if (!value) return 'sem-data';
  const m = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m && m[1] && m[2] && m[3] ? `${m[3]}-${m[2]}-${m[1]}` : 'sem-data';
}

/** Lee el total que el sitio muestra como "N resultados encontrados". */
export function parseResultCount(html: string): number | null {
  const m = html.match(/([\d.]+)\s*resultados?\s+encontrados?/i);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1].replace(/\./g, ''), 10);
  return Number.isNaN(n) ? null : n;
}
