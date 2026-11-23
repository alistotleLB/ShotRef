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
  const out = { ...copy(d), ...x, on: bool(x.on, bool(d.on, false)), auto: bool(x.auto, bool(d.auto, true)), fstop: num(x.fstop, 0) > 0 ? x.fstop : (num(d.fstop, 0) > 0 ? d.fstop : 2.8) };
  if ('strength' in out) out.strength = num(out.strength, 0) > 0 ? out.strength : 3; /* blur strength, default 3 (artifact files) */
  return out;
}

const BODIES = ['man', 'woman', 'child'];
const str = (v, d) => (typeof v === 'string' && v ? v : d);
const clampN = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);

/* the shot camera (also used for each shot's saved camera): fills and repairs everything, drops references to objects that are gone */
function cleanCamera(c, defaults, ids) {
  const dc = defaults.camera || {};
  const dcb = dc.base || { p: [3.4, 1.6, 6.2], tg: [0, 1.15, 0], f: 35, roll: 0, fd: 7.2 };
  const cb = isObj(c.base) ? c.base : {};
  const base = { ...cb, p: vec3(cb.p, dcb.p), tg: vec3(cb.tg, dcb.tg), f: num(cb.f, dcb.f), roll: num(cb.roll, dcb.roll) };
  base.fd = num(cb.fd, Math.hypot(base.p[0] - base.tg[0], base.p[1] - base.tg[1], base.p[2] - base.tg[2]));
  const out = {
    ...c,
    base,
    keys: cleanKeys(c.keys, k => {
      const o = { ...k, p: vec3(k.p, base.p), tg: vec3(k.tg, base.tg), f: num(k.f, base.f), roll: num(k.roll, base.roll) };
      if (k.fd !== undefined && typeof k.fd !== 'number') delete o.fd;
      return o;
    }),
    feel: FEELS.includes(c.feel) ? c.feel : (dc.feel || 'gentle'),
    dof: cleanDof(c.dof, isObj(dc.dof) ? dc.dof : {}),
    shake: num(c.shake, 0),
    lookAtId: c.lookAtId != null && ids.has(c.lookAtId) ? c.lookAtId : null,
    follow: c.follow === true,
  };
  if ('mount' in c) out.mount = c.mount != null && ids.has(c.mount) ? c.mount : null; /* camera rides on this object */
  return out;
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

  /* new-feature fields on objects: only repaired when present, so files from older builds are not changed */
  const groups = isObj(src.groups) ? Object.fromEntries(Object.entries(src.groups).filter(([, g]) => isObj(g)).map(([k, g]) => [k, { ...g, name: str(g.name, 'Group') }])) : {};
  for (const o of st.objects) {
    if ('grp' in o) o.grp = typeof o.grp === 'string' && groups[o.grp] ? o.grp : null;
    if ('locked' in o) o.locked = o.locked === true;
    if ('parent' in o) o.parent = o.parent != null && o.parent !== o.id && ids.has(o.parent) ? String(o.parent) : null;
    if ('acts' in o) {
      const acts = (Array.isArray(o.acts) ? o.acts : []).filter(a => isObj(a) && typeof a.pose === 'string' && a.pose && typeof a.t === 'number' && Number.isFinite(a.t)).map(a => {
        const out = { ...a };
        if ('at' in a) { if (isObj(a.at) && Array.isArray(a.at.p) && a.at.p.length === 3 && a.at.p.every(x => typeof x === 'number' && Number.isFinite(x))) out.at = { ...a.at, p: a.at.p.slice(), yaw: num(a.at.yaw, 0) }; else delete out.at; }
        return out;
      }).sort((a, b) => a.t - b.t);
      if (acts.length) o.acts = acts; else delete o.acts; /* deleted when empty */
    }
    const op = o.opts;
    if ('body' in op && !BODIES.includes(op.body)) delete op.body;
    if ('seated' in op) op.seated = op.seated != null && op.seated !== o.id && ids.has(op.seated) ? String(op.seated) : null;
    if ('lookAt' in op && !(op.lookAt === 'camera' || (op.lookAt != null && op.lookAt !== o.id && ids.has(op.lookAt)))) delete op.lookAt;
    for (const k of ['free', 'convertible']) if (k in op && typeof op[k] !== 'boolean') delete op[k];
  }
  /* a ride-with parent chain must not loop: cut the link that closes a loop */
  const byId = new Map(st.objects.map(o => [o.id, o]));
  for (const o of st.objects) {
    const walk = new Set([o.id]);
    for (let p = o.parent ? byId.get(o.parent) : null; p; p = p.parent ? byId.get(p.parent) : null) {
      if (walk.has(p.id)) { o.parent = null; break; }
      walk.add(p.id);
    }
  }
  if ('groups' in src) st.groups = groups;

  /* camera */
  st.camera = cleanCamera(src.camera, defaults, ids);

  /* project name */
  if ('meta' in src) st.meta = isObj(src.meta) ? { ...src.meta, id: str(src.meta.id, uid()), name: typeof src.meta.name === 'string' ? src.meta.name : '' } : { id: uid(), name: '' };

  /* shots: each carries its own camera */
  if ('shots' in src) {
    const sid = new Set();
    st.shots = (Array.isArray(src.shots) ? src.shots : []).filter(x => isObj(x) && isObj(x.camera)).map(x => {
      let id = str(x.id, uid()); while (sid.has(id)) id = uid(); sid.add(id);
      return { ...x, id, name: str(x.name, 'Shot'), camera: cleanCamera(x.camera, defaults, ids), duration: num(x.duration, 0) > 0 ? x.duration : num(st.settings.duration, 5) };
    });
  }
  if ('shotId' in src || st.shots) st.shotId = st.shots && st.shots.length ? (st.shots.some(x => x.id === src.shotId) ? src.shotId : st.shots[0].id) : null;

  /* takes: snap is a JSON string of the scene (null for the active take) */
  if ('takes' in src) {
    const tid = new Set();
    st.takes = (Array.isArray(src.takes) ? src.takes : []).filter(isObj).map(x => {
      let id = str(x.id, uid()); while (tid.has(id)) id = uid(); tid.add(id);
      let snap = null;
      if (typeof x.snap === 'string') { try { if (isObj(JSON.parse(x.snap))) snap = x.snap; } catch (e) { } }
      return { ...x, id, name: str(x.name, 'Take'), snap };
    });
  }
  if ('takeId' in src || st.takes) st.takeId = st.takes && st.takes.length ? (st.takes.some(x => x.id === src.takeId) ? src.takeId : st.takes[0].id) : null;

  /* sun and shadows */
  const ss = st.settings;
  if ('shadows' in ss && typeof ss.shadows !== 'boolean') delete ss.shadows;
  if ('shadowSoft' in ss) ss.shadowSoft = clampN(ss.shadowSoft, 0, 1, 0.3);
  if ('tod' in ss) ss.tod = clampN(ss.tod, 5, 20, 14);

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
