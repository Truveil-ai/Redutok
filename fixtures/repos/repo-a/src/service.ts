import { MemoryStore, type Row } from './store.js';

export function totalValue(store: MemoryStore, ids: string[]): number {
  let total = 0;
  for (const id of ids) {
    const row = store.get(id);
    if (row !== undefined) total += row.value;
  }
  return total;
}

export function seed(store: MemoryStore, rows: Row[]): void {
  for (const row of rows) store.put(row);
}
