import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { ProcessDetail } from '../types';
import { slug } from '../util/text';

/**
 * Persistencia de los datos extraidos.
 *
 * Se escriben dos formas del mismo dato:
 *  - `processos.ndjson`: una linea por proceso, apto para procesar en streaming;
 *  - `processos/<numero>.json`: la ficha individual, comoda para inspeccionar.
 *
 * El NDJSON se escribe en modo append para que una corrida interrumpida no
 * pierda lo ya extraido.
 */
export class ResultStore {
  private readonly ndjsonPath: string;
  private readonly perProcessDir: string;

  constructor(baseDir: string) {
    this.ndjsonPath = path.join(baseDir, 'processos.ndjson');
    this.perProcessDir = path.join(baseDir, 'processos');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.perProcessDir, { recursive: true });
  }

  async save(detail: ProcessDetail): Promise<void> {
    await fs.appendFile(this.ndjsonPath, `${JSON.stringify(detail)}\n`, 'utf8');
    const name = slug(detail.numeroProcesso ?? detail.ca, 80);
    await fs.writeFile(
      path.join(this.perProcessDir, `${name}.json`),
      JSON.stringify(detail, null, 2),
      'utf8',
    );
  }

  get ndjsonFile(): string {
    return this.ndjsonPath;
  }
}
