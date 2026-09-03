/** Logger minimo con niveles y marca de tiempo, sin dependencias externas. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly scope = '',
  ) {}

  /** Deriva un logger con el mismo nivel y un prefijo propio. */
  child(scope: string): Logger {
    return new Logger(this.level, this.scope ? `${this.scope}:${scope}` : scope);
  }

  debug(message: string, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  info(message: string, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  warn(message: string, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  error(message: string, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  private write(level: LogLevel, message: string, rest: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const time = new Date().toISOString().slice(11, 19);
    const tag = level.toUpperCase().padEnd(5);
    const prefix = this.scope ? `[${this.scope}] ` : '';
    const line = `${time} ${tag} ${prefix}${message}`;
    if (level === 'error' || level === 'warn') console.error(line, ...rest);
    else console.log(line, ...rest);
  }
}
