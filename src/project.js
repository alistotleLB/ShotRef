/* ShotRef project files: load, check and fill in missing fields.
 * Pure: no DOM, no three.js. main.js passes in its defaults.
 *
 *   normalizeProject(raw, { settings, camera, uid, enums }) -> { state, assets }
 *   enums: { settingKey: [allowed values] }, e.g. { style: ['shaded', ...] }; other values fall back to the default.
 *
 * raw is the parsed .shotref.json ({app, version, state, assets}) or an autosave ({state, assets}).
 * Throws Error('NOT_SHOTREF') when raw is not a ShotRef project at all.
 * Only ever adds or repairs fields, so files stay readable by older ShotRef builds.
 */
export const FORMAT_VERSION = 2;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? v.slice() : d.slice());
const copy = v => JSON.parse(JSON.stringify(v));
const FEELS = ['constant', 'gentle', 'strong'];
let n = 0;
const fallbackUid = () => 'o' + Date.now().toString(36) + (n++).toString(36);

/* keys: objects with a finite numeric t, sorted by time; missing fields come from fill(key) */
function cleanKeys(keys, fill) {
  if (!Array.isArray(keys)) return [];
  return keys.filter(k => isObj(k) && typeof k.t === 'number' && Number.isFinite(k.t)).map(fill).sort((a, b) => a.t - b.t);
}

/* depth of field: on/auto booleans, fstop a positive number */
function cleanDof(v, d) {
  const x = isObj(v) ? v : {};
  const bool = (a, b) => (typeof a === 'boolean' ? a : b);
  return { ...copy(d), ...x, on: bool(x.on, bool(d.on, false)), auto: bool(x.auto, bool(d.auto, true)), fstop: num(x.fstop, 0) > 0 ? x.fstop : (num(d.fstop, 0) > 0 ? d.fstop : 2.8) };
}

export function normalizeProject(raw, defaults = {}) {
  if (!isObj(raw) || (raw.app !== undefined && raw.app !== 'ShotRef') || !isObj(raw.state) || !isObj(raw.state.camera)) throw new Error('NOT_SHOTREF');
  const uid = defaults.uid || fallbackUid;
  const src = copy(raw.state);
  const st = { ...src };

  /* settings */
  const ds = defaults.settings || {};
  st.settings = { ...copy(ds), ...(isObj(src.settings) ? src.settings : {}) };
  /* a known setting with the wrong type, or a value not in its list, takes the default (a bad style crashed the camera view) */
  const enums = isObj(defaults.enums) ? defaults.enums : {};
  for (const k of Object.keys(ds)) {
    const v = st.settings[k];
    if (typeof v !== typeof ds[k] || (typeof v === 'number' && !Number.isFinite(v)) || (Array.isArray(enums[k]) && !enums[k].includes(v))) st.settings[k] = copy(ds[k]);
  }
  for (const k of ['duration', 'fps', 'size']) if (k in ds && !(num(st.settings[k], 0) > 0)) st.settings[k] = ds[k];

  /* objects */
  const objects = Array.isArray(src.objects) ? src.objects : [];
  const seen = new Set(); /* a repeated id gets a fresh one; the first keeps it (and any lookAtId that points at it) */
  st.objects = objects.filter(o => isObj(o) && typeof o.type === 'string' && o.type).map(o => {
    const b = isObj(o.base) ? o.base : {};
    const base = { p: vec3(b.p, [0, 0, 0]), r: vec3(b.r, [0, 0, 0]), s: vec3(b.s, [1, 1, 1]) };
    let id = o.id != null && o.id !== '' ? String(o.id) : uid();
    while (seen.has(id)) id = uid();
    seen.add(id);
    return {
      ...o,
      id,
      name: typeof o.name === 'string' ? o.name : o.type,
      opts: isObj(o.opts) ? o.opts : {},
      base,
      keys: cleanKeys(o.keys, k => ({ ...k, p: vec3(k.p, base.p), r: vec3(k.r, base.r), s: vec3(k.s, base.s) })),
      visible: o.visible !== false,
    };
  });
  const ids = new Set(st.objects.map(o => o.id));

  /* camera */
  const dc = defaults.camera || {};
  const dcb = dc.base || { p: [3.4, 1.6, 6.2], tg: [0, 1.15, 0], f: 35, roll: 0, fd: 7.2 };
  const c = src.camera, cb = isObj(c.base) ? c.base : {};
  const base = { ...cb, p: vec3(cb.p, dcb.p), tg: vec3(cb.tg, dcb.tg), f: num(cb.f, dcb.f), roll: num(cb.roll, dcb.roll) };
  base.fd = num(cb.fd, Math.hypot(base.p[0] - base.tg[0], base.p[1] - base.tg[1], base.p[2] - base.tg[2]));
  st.camera = {
    ...c,
    base,
    keys: cleanKeys(c.keys, k => {
      const out = { ...k, p: vec3(k.p, base.p), tg: vec3(k.tg, base.tg), f: num(k.f, base.f), roll: num(k.roll, base.roll) };
      if (k.fd !== undefined && typeof k.fd !== 'number') delete out.fd;
      return out;
    }),
    feel: FEELS.includes(c.feel) ? c.feel : (dc.feel || 'gentle'),
    dof: cleanDof(c.dof, isObj(dc.dof) ? dc.dof : {}),
    shake: num(c.shake, 0),
    lookAtId: c.lookAtId != null && ids.has(c.lookAtId) ? c.lookAtId : null,
    follow: c.follow === true,
  };

  /* location photo */
  if ('plate' in src) st.plate = isObj(src.plate) && typeof src.plate.asset === 'string' ? src.plate : null;

  st.v = FORMAT_VERSION;
  const assets = isObj(raw.assets) ? raw.assets : {};
  return { state: st, assets };
}

/* Short plain-English name for the change between two state snapshots (JSON strings),
   for the undo/redo toast: "move Person 1", "delete Box 1", "add Car 1", "camera change".
   Returns '' when it can't tell. */
export function describeChange(beforeJSON, afterJSON) {
  let a, b;
  try { a = JSON.parse(beforeJSON); b = JSON.parse(afterJSON); } catch (e) { return ''; }
  if (!a || !b) return '';
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const list = s => (Array.isArray(s.objects) ? s.objects : []).filter(o => o && typeof o === 'object');
  const A = list(a), B = list(b);
  const inA = new Map(A.map(o => [o.id, o])), inB = new Map(B.map(o => [o.id, o]));
  const added = B.filter(o => !inA.has(o.id)), removed = A.filter(o => !inB.has(o.id));
  const nm = (l, verb) => verb + ' ' + (l[0].name || 'item') + (l.length > 1 ? ' and ' + (l.length - 1) + ' more' : '');
  if (added.length && removed.length) return 'scene change';
  if (added.length) return nm(added, 'add');
  if (removed.length) return nm(removed, 'delete');
  for (const o of B) { const p = inA.get(o.id); if (!same(p.base, o.base) || !same(p.keys, o.keys)) return 'move ' + (o.name || 'item'); }
  for (const o of B) { const p = inA.get(o.id); if (!same(p, o)) return 'change ' + (o.name || 'item'); }
  if (!same(a.camera, b.camera)) return 'camera change';
  if (!same(a.settings, b.settings)) return 'settings change';
  if (!same(a.plate, b.plate)) return 'location photo change';
  return '';
}
