export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function newIdWithPrefix(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}
