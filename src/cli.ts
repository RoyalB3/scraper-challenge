/** Parseo de argumentos de linea de comandos, sin dependencias externas. */

import { DEFAULTS } from './config';
import type { LogLevel } from './util/logger';

export interface CliOptions {
  numeroProcesso?: string;
  nomeParte?: string;
  nomeAdvogado?: string;
  classeJudicial?: string;
  documentoParte?: string;
  dataInicio?: string;
  dataFim?: string;
  /** Recorre el rango `dataInicio..dataFim` dia por dia (una busqueda por dia). */
  sweepDays: boolean;
  /** Tope de procesos a procesar en esta corrida. */
  maxProcessos: number | null;
  /** Tope de PDFs a descargar por proceso. */
  maxPdfs: number | null;
  /** Extrae los metadatos pero no descarga documentos. */
  skipPdfs: boolean;
  /** Descarga tambien el comprobante de protocolo en PDF de cada documento. */
  comprovantes: boolean;
  /** Vuelve a procesar procesos ya guardados en corridas anteriores. */
  force: boolean;
  /** Reintenta unicamente las descargas registradas como fallidas. */
  retryFailed: boolean;
  outputDir: string;
  minDelayMs: number;
  maxRetries: number;
  logLevel: LogLevel;
}

const HELP = `
Scraper de la Consulta Publica del PJe - TRF5

Uso:
  npm run scrape -- [opciones]

Criterios de busqueda (al menos uno; el sitio ignora las busquedas vacias):
  --numero-processo <n>   Numero unico CNJ (ej. 0001223-51.1994.4.05.8300)
  --nome-parte <texto>    Nombre de una parte (el sitio exige 2 palabras o mas)
  --nome-advogado <texto> Nombre del abogado
  --classe <texto>        Clase judicial exacta (ej. "APELACAO CIVEL")
  --documento-parte <n>   CPF o CNPJ de la parte
  --data-inicio <fecha>   Inicio del rango de distribucion, dd/MM/yyyy
  --data-fim <fecha>      Fin del rango de distribucion, dd/MM/yyyy
  --sweep-days            Recorre el rango dia por dia (recomendado: el sitio
                          devuelve como maximo 30 procesos por consulta)

Alcance y salida:
  --max-processos <n>     Tope de procesos en esta corrida
  --max-pdfs <n>          Tope de documentos a descargar por proceso
  --skip-pdfs             Solo metadatos, sin descargar documentos
  --comprovantes          Descarga tambien el comprobante de protocolo en PDF
  --force                 Reprocesa procesos ya guardados
  --retry-failed          Reintenta solo las descargas fallidas registradas
  --out <ruta>            Directorio de salida (por defecto: ${DEFAULTS.outputDir})

Red y trazas:
  --delay <ms>            Espera minima entre peticiones (por defecto: ${DEFAULTS.minDelayMs})
  --max-retries <n>       Reintentos ante 429/5xx (por defecto: ${DEFAULTS.maxRetries})
  --log-level <nivel>     debug | info | warn | error
  -h, --help              Muestra esta ayuda

Ejemplos:
  npm run scrape -- --nome-parte "MARIA SILVA" --max-pdfs 5
  npm run scrape -- --data-inicio 01/08/2026 --data-fim 31/08/2026 --sweep-days
  npm run scrape -- --retry-failed
`;

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function parseArgs(argv: string[]): CliOptions | null {
  const options: CliOptions = {
    sweepDays: false,
    maxProcessos: null,
    maxPdfs: null,
    skipPdfs: false,
    comprovantes: false,
    force: false,
    retryFailed: false,
    outputDir: DEFAULTS.outputDir,
    minDelayMs: DEFAULTS.minDelayMs,
    maxRetries: DEFAULTS.maxRetries,
    logLevel: 'info',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`La opcion ${arg} requiere un valor`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP);
        return null;
      case '--numero-processo':
        options.numeroProcesso = next();
        break;
      case '--nome-parte':
        options.nomeParte = next();
        break;
      case '--nome-advogado':
        options.nomeAdvogado = next();
        break;
      case '--classe':
        options.classeJudicial = next();
        break;
      case '--documento-parte':
        options.documentoParte = next();
        break;
      case '--data-inicio':
        options.dataInicio = next();
        break;
      case '--data-fim':
        options.dataFim = next();
        break;
      case '--sweep-days':
        options.sweepDays = true;
        break;
      case '--max-processos':
        options.maxProcessos = positiveInt(next(), arg);
        break;
      case '--max-pdfs':
        options.maxPdfs = positiveInt(next(), arg);
        break;
      case '--skip-pdfs':
        options.skipPdfs = true;
        break;
      case '--comprovantes':
        options.comprovantes = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--retry-failed':
        options.retryFailed = true;
        break;
      case '--out':
        options.outputDir = next();
        break;
      case '--delay':
        options.minDelayMs = positiveInt(next(), arg);
        break;
      case '--max-retries':
        options.maxRetries = positiveInt(next(), arg);
        break;
      case '--log-level': {
        const value = next() as LogLevel;
        if (!LOG_LEVELS.includes(value)) {
          throw new Error(`Nivel de log invalido: ${value}. Use ${LOG_LEVELS.join(' | ')}`);
        }
        options.logLevel = value;
        break;
      }
      default:
        throw new Error(`Opcion desconocida: ${arg}. Use --help para ver el uso.`);
    }
  }

  if (options.sweepDays && (!options.dataInicio || !options.dataFim)) {
    throw new Error('--sweep-days requiere --data-inicio y --data-fim');
  }

  const hasCriteria =
    options.numeroProcesso !== undefined ||
    options.nomeParte !== undefined ||
    options.nomeAdvogado !== undefined ||
    options.classeJudicial !== undefined ||
    options.documentoParte !== undefined ||
    options.dataInicio !== undefined;

  if (!options.retryFailed && !hasCriteria) {
    throw new Error(
      'Indique al menos un criterio de busqueda (--nome-parte, --data-inicio, ...). Use --help para ver el uso.',
    );
  }

  return options;
}

function positiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`${flag} espera un entero positivo, recibio "${value}"`);
  return n;
}
