/* Keyframe maths. Pure: no DOM, no three.js, no app state (the frame rate is passed in).
 * A key is { t, ...fields }. A field is a number or an array of numbers, e.g. p:[x,y,z] or f:35.
 * Keys are kept sorted by t. Two keys closer than half a frame count as the same key.
 */
const arr = v => Array.isArray(v) ? v : [v];
const clone = o => JSON.parse(JSON.stringify(o));
const halfFrame = fps => 0.5 / fps;

/* slope of field f at key i (Catmull-Rom). Ends are flat, unless natural: then they follow the first/last segment */
export function tangent(keys, i, f, natural) {
  const n = keys.length, a = arr(keys[i][f]);
  if (i === 0 || i === n - 1) {
    if (!natural || n < 2) return a.map(() => 0);
    const j0 = i === 0 ? 0 : n - 2, j1 = j0 + 1, p = arr(keys[j0][f]), q = arr(keys[j1][f]), dt = keys[j1].t - keys[j0].t;
    return a.map((_, j) => dt > 0 ? (q[j] - p[j]) / dt : 0);
  }
  const p = arr(keys[i - 1][f]), q = arr(keys[i + 1][f]), dt = keys[i + 1].t - keys[i - 1].t;
  return a.map((_, j) => dt > 0 ? (q[j] - p[j]) / dt : 0);
}

/* value of field f at time t, always as an array. mode: 'linear', 'smooth', 'natural', anything else = ease in/out at every key */
export function sampleField(keys, t, f, mode) {
  const n = keys.length, g = i => arr(keys[i][f]);
  if (n === 1 || t <= keys[0].t) return g(0).slice();
  if (t >= keys[n - 1].t) return g(n - 1).slice();
  let i = 0; while (i < n - 2 && t >= keys[i + 1].t) i++;
  const t0 = keys[i].t, t1 = keys[i + 1].t, hh = t1 - t0, s = hh > 0 ? (t - t0) / hh : 1;
  const a = g(i), b = g(i + 1);
  if (mode === 'linear') return a.map((v, j) => v + (b[j] - v) * s);
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const sm = mode === 'smooth' || mode === 'natural', nat = mode === 'natural';
  const m0 = sm ? tangent(keys, i, f, nat) : a.map(() => 0);
  const m1 = sm ? tangent(keys, i + 1, f, nat) : a.map(() => 0);
  return a.map((v, j) => h00 * v + h10 * hh * m0[j] + h01 * b[j] + h11 * hh * m1[j]);
}

/* index of the key at time t (within half a frame), or -1 */
export function keyIndexAt(keys, t, fps) { const eps = halfFrame(fps); return keys.findIndex(k => Math.abs(k.t - t) < eps); }

/* add a key at t (snapped to a frame), or update the fields of the key already there */
export function setKey(keys, t, vals, fps) {
  t = Math.round(t * fps) / fps;
  const i = keyIndexAt(keys, t, fps);
  if (i >= 0) Object.assign(keys[i], clone(vals));
  else { keys.push({ t, ...clone(vals) }); keys.sort((a, b) => a.t - b.t); }
}

/* the nearest key that is not at time t, or null */
export function neighborKey(keys, t, fps) {
  let best = null;
  for (const k of keys) { if (Math.abs(k.t - t) < halfFrame(fps)) continue; if (!best || Math.abs(k.t - t) < Math.abs(best.t - t)) best = k; }
  return best;
}
