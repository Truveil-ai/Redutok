export function formatCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([token, n]) => `${token}: ${n}`)
    .join('\n');
}
