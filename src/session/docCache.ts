import { joinDoc } from "../api/socket.js";

export interface CachedDoc {
  docId: string;
  text: string;
  version: number;
  ranges?: unknown;
}

const docs = new Map<string, CachedDoc>();

export async function ensureDocLoaded(docId: string): Promise<CachedDoc> {
  const cached = docs.get(docId);
  if (cached) return cached;
  const r = await joinDoc(docId);
  const entry: CachedDoc = { docId, text: r.docLines.join("\n"), version: r.version, ranges: r.ranges };
  docs.set(docId, entry);
  return entry;
}

export function updateDoc(docId: string, newText: string, newVersion: number, ranges?: unknown): void {
  docs.set(docId, { docId, text: newText, version: newVersion, ranges });
}

export function invalidateDoc(docId: string): void {
  docs.delete(docId);
}

export function clearDocCache(): void {
  docs.clear();
}
