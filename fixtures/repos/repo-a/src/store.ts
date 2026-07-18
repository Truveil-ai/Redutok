export interface Row {
  id: string;
  value: number;
}

export class MemoryStore {
  private rows = new Map<string, Row>();

  put(row: Row): void {
    this.rows.set(row.id, row);
  }

  get(id: string): Row | undefined {
    return this.rows.get(id);
  }
}
