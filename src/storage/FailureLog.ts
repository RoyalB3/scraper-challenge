import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { FailedDownload } from '../types';

/**
 * Bitacora de descargas fallidas.
 *
 * Cada fallo (429 persistente, 5xx, respuesta que no es un PDF, corte de red)
 * queda registrado con su URL y su motivo, de modo que `--retry-failed` pueda
 * reintentarlos mas tarde sin volver a recorrer todo el sitio.
 */
export class FailureLog {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'failed-downloads.ndjson');
  }

  async record(entry: FailedDownload): Promise<void> {
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Lee los fallos registrados, quedandose con el ultimo intento de cada documento. */
  async read(): Promise<FailedDownload[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }

    const byDocument = new Map<string, FailedDownload>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as FailedDownload;
        byDocument.set(entry.downloadUrl, entry);
      } catch {
        // Linea corrupta (por ejemplo, escritura interrumpida): se ignora.
      }
    }
    return [...byDocument.values()];
  }

  /** Reescribe la bitacora dejando solo los fallos que siguen pendientes. */
  async rewrite(entries: FailedDownload[]): Promise<void> {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await fs.writeFile(this.filePath, body ? `${body}\n` : '', 'utf8');
  }

  get file(): string {
    return this.filePath;
  }
}
