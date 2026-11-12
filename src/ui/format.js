/** 92 -> '92', 78.24 -> '78.2'; '--' when unknown. */
export function formatBpm(bpm) {
  if (!(bpm > 0)) return '--';
  const r = Math.round(bpm * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
