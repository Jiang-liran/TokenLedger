/** 通用 SSE 解析器，处理跨 chunk 的半行、CRLF、多行 data 与注释。 */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    // 事件以空行分隔；兼容 \n\n 与 \r\n\r\n。
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const parsed = parseEventBlock(raw);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  flush(): SseEvent[] {
    if (this.buffer.trim() === '') {
      this.buffer = '';
      return [];
    }
    const raw = this.buffer;
    this.buffer = '';
    const parsed = parseEventBlock(raw);
    return parsed ? [parsed] : [];
  }
}

function parseEventBlock(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n'), id };
}
