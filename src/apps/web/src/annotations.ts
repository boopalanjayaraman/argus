/** Box of one tracked object at time t (seconds): linear interpolation
 * between SAM samples up to 0.6 s apart; nothing outside its track. */
export function boxAt(frames: number[][], fps: number, t: number): number[] | null {
  const f = t * fps;
  let lo = -1;
  for (let i = 0; i < frames.length; i++) { if (frames[i][0] <= f) lo = i; else break; }
  if (lo < 0) return null;
  const a = frames[lo], b = frames[lo + 1];
  if (!b) return f - a[0] <= 1 ? a.slice(1, 5) : null;
  if (b[0] - a[0] > fps * 0.6) return f - a[0] <= 1 ? a.slice(1, 5) : null;
  const k = (f - a[0]) / (b[0] - a[0]);
  return [1, 2, 3, 4].map(i => a[i] + (b[i] - a[i]) * k);
}
