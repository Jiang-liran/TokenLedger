import fs from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/(Bearer)\s+[A-Za-z0-9._~+/-]{8,}/gi, '$1 ***'],
  [/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/-]{8,}/gi, '$1***'],
];

export function redact(input: unknown): string {
  let text =
    typeof input === 'string'
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}`
        : safeStringify(input);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Logger {
  private readonly filePath: string;

  constructor(logDir: string) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(logDir, 'main.log');
  }

  private write(level: string, message: string, detail?: unknown): void {
    const line = `[${new Date().toISOString()}] [${level}] ${redact(message)}${
      detail === undefined ? '' : ` ${redact(detail)}`
    }\n`;
    try {
      fs.appendFileSync(this.filePath, line, { mode: 0o600 });
    } catch {
      // 日志写入失败不应影响应用运行。
    }
    if (level === 'ERROR') console.error(line.trimEnd());
    else if (level === 'WARN') console.warn(line.trimEnd());
  }

  info(message: string, detail?: unknown): void {
    this.write('INFO', message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.write('WARN', message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.write('ERROR', message, detail);
  }
}
