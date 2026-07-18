import { MemoryStore } from '../src/store.js';
import { seed, totalValue } from '../src/service.js';

export function runTests(): boolean {
  const store = new MemoryStore();
  seed(store, [{ id: 'a', value: 2 }, { id: 'b', value: 3 }]);
  return totalValue(store, ['a', 'b']) === 5;
}
