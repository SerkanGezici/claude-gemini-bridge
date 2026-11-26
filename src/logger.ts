import { createWriteStream, type WriteStream } from 'fs';
 
const DEBUG = process.env['DEBUG'] === 'true';
 
type LogLevel = 'info' | 'warn' | 'error' | 'debug';
 
const COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  debug: '\x1b[90m',  // gray
};
const RESET = '\x1b[0m';
 
let logStream: WriteStream | null = null;
let mirrorConsole = false;

/**
 * Bridge loglarını dosyaya yönlendir.
 * mirrorToConsole=true → dosya + konsol birlikte (bridge-only mod: operatör
 * terminali izler, kanıt dosyada kalır — LOG-1). false → salt dosya
 * (full mod: Claude Code TUI ile console çakışmasını önler).
 */
export function setLogFile(filePath: string, mirrorToConsole = false): void {
  logStream = createWriteStream(filePath, { flags: 'a' });
  mirrorConsole = mirrorToConsole;
}

function write(level: LogLevel, msg: string, data?: unknown): void {
  if (level === 'debug' && !DEBUG) return;

  const timestamp = new Date().toISOString().slice(11, 23);
  const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';

  if (logStream) {
    logStream.write(`[${timestamp}] [${level.toUpperCase()}] ${msg}${dataStr}\n`);
  }
  if (!logStream || mirrorConsole) {
    const prefix = `${COLORS[level]}[${timestamp}] [${level.toUpperCase()}]${RESET}`;
    const line = `${prefix} ${msg}${dataStr}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}
 
export const logger = {
  info(msg: string, data?: unknown): void { write('info', msg, data); },
  warn(msg: string, data?: unknown): void { write('warn', msg, data); },
  error(msg: string, data?: unknown): void { write('error', msg, data); },
  debug(msg: string, data?: unknown): void { write('debug', msg, data); },
};
 