import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Registro de procesos ya extraidos, para poder reanudar una corrida sin
 * repetir trabajo (el sitio es lento y conviene no volver a pedir lo mismo).
 */
export class StateStore {
  private readonly filePath: string;
  private processed = new Set<string>();

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'state.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { processed?: unknown }).processed)) {
        this.processed = new Set((parsed as { processed: string[] }).processed);
      }
    } catch {
      // Primera corrida: no hay estado previo.
      this.processed = new Set();
    }
  }

  has(ca: string): boolean {
    return this.processed.has(ca);
  }

  async add(ca: string): Promise<void> {
    this.processed.add(ca);
    await this.flush();
  }

  get size(): number {
    return this.processed.size;
  }

  private async flush(): Promise<void> {
    const payload = { processed: [...this.processed], updatedAt: new Date().toISOString() };
    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
