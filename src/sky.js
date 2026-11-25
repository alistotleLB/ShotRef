/* ShotRef sky: cloud settings. Pure and import-free, so project.js can use cleanClouds. */
export const COVER = [['clear', 0, 'Clear'], ['few', 0.2, 'Few'], ['scattered', 0.42, 'Scattered'], ['mostly', 0.68, 'Mostly cloudy'], ['overcast', 1, 'Overcast']];
export const LOOKS = [['fluffy', 'Fluffy'], ['wispy', 'Wispy'], ['flat', 'Flat layer']];
export const DRIFTS = [['still', 'Still'], ['slow', 'Slow'], ['breezy', 'Breezy'], ['fast', 'Fast']];
export const CLOUDS_NEW = { cover: 0.2, look: 'fluffy', drift: 'slow', dir: 90, soft: 0.5, seed: 1 };
export const CLOUDS_NONE = { ...CLOUDS_NEW, cover: 0 };

/* the COVER key closest to a stored value */
export function nearestCover(cover) {
  const c = typeof cover === 'number' && Number.isFinite(cover) ? cover : 0;
  let best = COVER[0];
  for (const e of COVER) if (Math.abs(e[1] - c) < Math.abs(best[1] - c)) best = e;
  return best[0];
}

/* a repaired copy; anything missing or bad falls back field by field to CLOUDS_NONE */
export function cleanClouds(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}, D = CLOUDS_NONE;
  const num = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);
  const dir = typeof r.dir === 'number' && Number.isFinite(r.dir) ? ((r.dir % 360) + 360) % 360 : D.dir;
  return {
    cover: num(r.cover, 0, 1, D.cover),
    look: LOOKS.some(l => l[0] === r.look) ? r.look : D.look,
    drift: DRIFTS.some(d => d[0] === r.drift) ? r.drift : D.drift,
    dir,
    soft: num(r.soft, 0, 1, D.soft),
    seed: Math.round(num(r.seed, 1, 9999, D.seed)),
  };
}
