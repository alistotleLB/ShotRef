import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { normalizeProject, FORMAT_VERSION, describeChange } from './project.js';
import * as K from './keys.js';
import { platform } from './platform.js';

/* ---- shared values: every module-level `let`, what it holds, and what changes it ----
 * state, assets                  the project and its photos/models: restore, buildState, replaceProject, boot
 * T, playing, view, selected,  playhead: setTime; playing: setPlaying; view: setView; selected: select; pipOn: #bPip;
 *   pipOn, editRev, ...Dirty     editRev counts edits: changed, quietChange; uiDirty/propsDirty ask frame() to rebuild lists/panel
 * hist, hi                       undo snapshots and position: pushHistory, undo, redo, replaceProject
 * toastTimer                   toast hide timer: toast (downloads capability and the open file/unsaved mark live in platform.js)
 * sizeWarned                     autosave size warning shown once: warnSize
 * autosaveReady, autosaveWaiting boot has loaded stored assets / a save is waiting for that: boot, writeAutosave
 * inlineTooBig, saveTimer        autosave fallback state and the debounce timer: writeAutosave, autosave, flushAutosave
 * topInit, skyTex                top view framed once: setView; sky texture: applyEnv
 * camState, pilotActive          shot camera at the playhead: applyAll; user is steering it: fly, camControls, records
 * pathRev                        editRev the walk paths were last drawn at: updatePaths, select
 * gizmoMode, snapOn, gizmoUsed   arrows mode: setGizmoMode; snap: #bSnapGrid; gizmo was used this click: gizmo, canvas
 * vw, vh                         canvas size last drawn at: draw
 * depthCache                     depth range for the depth style, per editRev: depthRange
 * plateTex...exportingRender     location photo texture cache: ensurePlate; export frame in progress: renderExportFrame
 * drawCount...rebuilds           render stats for tests: draw, requestRender, frame
 * lastNow                        time of the previous animation frame: frame
 * needsRender...wasExporting     render on demand: requestRender, pokeRender, frame
 * moveAmt                        one-click move strength: propsCamera
 * simple                         Simple/Advanced mode: setSimple
 * placing, pathMode, pathFit, rec  click-to-place, path drawing, path fit option, live recording: their start/commit/cancel functions
 * shotPerson                     person picked for shot sizes: propsCamera
 * focusPick, lastWorkView        picking focus in the view: start/finishFocusPick; last non-camera view: setView
 * exRenderer                     offscreen export renderer: getExportRenderer (dropped on context loss)
 * copyBlob                       last copied frame: copyFrame
 * exCancel, exporting            export cancel request and export running: exportVideo, #exCancel
 * modalReturn, cfCb              focus to return to after dialogs: openModal, closeModal; confirm callback: confirmBox
 */

/* ============================== utilities ============================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(c)); }
  return e;
}
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r4 = v => Math.round(v * 1e4) / 1e4;
const lerp = (a, b, t) => a + (b - a) * t;
const clone = o => JSON.parse(JSON.stringify(o));
const arr = v => Array.isArray(v) ? v : [v];
const fmtTime = t => { const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0'); };
let toastTimer;
/* while a dialog is open the toast moves to the top of the window, so the dialog doesn't hide it (U7) */
function placeToast() { const t = $('#toast'); if (t) t.classList.toggle('top', $$('.modal').some(m => !m.classList.contains('hidden'))); }
function toast(msg, ms = 2400) { const t = $('#toast'); t.textContent = msg; placeToast(); t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
function b64ToBuf(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
function bufToB64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
/* text fields only: a focused dropdown, slider, checkbox or colour still lets shortcuts like Space work (U5) */
const isTyping = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'checkbox' && a.type !== 'range' && a.type !== 'color'; };
const isField = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');

/* exports and downloads go through the platform layer (native dialog in the desktop app, downloads capability on claude.ai, plain link elsewhere) */
const SAVE_KINDS = { png: ['PNG image', ['png']], mp4: ['MP4 video', ['mp4']], webm: ['WebM video', ['webm']], shotref: ['ShotRef project', ['shotref']] };
async function saveFile(filename, blob) {
  const k = SAVE_KINDS[(filename.split('.').pop() || '').toLowerCase()];
  const r = await platform.saveBlob(filename, blob, { filters: k ? [{ name: k[0], extensions: k[1] }] : [] });
  if (r.ok) toast('Saved ' + (r.name || filename));
  else if (r.canceled) toast('Save cancelled');
  else toast("Couldn't save the file. Try again.", 4000);
  return r;
}

/* ============================== constants ============================== */
const ASPECTS = [['16:9', 16 / 9, '16:9 widescreen'], ['9:16', 9 / 16, '9:16 vertical'], ['1:1', 1, '1:1 square'], ['4:5', 0.8, '4:5 portrait'], ['4:3', 4 / 3, '4:3'], ['2.39:1', 2.39, '2.39:1 cinemascope'], ['21:9', 21 / 9, '21:9 ultrawide']];
const arOf = k => (ASPECTS.find(a => a[0] === k) || ASPECTS[0])[1];
const SIZES = [[1280, '1280 px long side (720p)'], [1920, '1920 px long side (1080p)'], [2560, '2560 px long side (1440p)'], [3840, '3840 px long side (4K)']];
const STYLES = [
  ['shaded', 'Shaded', 'Colours, light and shadows', 'linear-gradient(135deg,#9fc3ea,#c98e6b 60%,#3d6fd8)'],
  ['clay', 'Clay', 'All grey: shape and light only', 'linear-gradient(135deg,#eee,#9a9a9a)'],
  ['depth', 'Depth', 'White = near, black = far', 'linear-gradient(90deg,#fff,#000)'],
  ['normal', 'Normals', 'Surface direction map', 'linear-gradient(135deg,#8080ff,#ff80c0 50%,#80ff80)'],
];
const ENV = {
  studio: { label: 'Studio', sky: '#3f434a', groundColor: '#5d6064', sunColor: '#ffffff', sunInt: 2.0, sunEl: 58, sunAz: 35, ambInt: 1.15, fog: false },
  day: { label: 'Day', sky: '#9cc2ea', groundColor: '#8c9286', sunColor: '#fff3dc', sunInt: 2.6, sunEl: 52, sunAz: 40, ambInt: 0.9, fog: false },
  overcast: { label: 'Overcast', sky: '#c3c8ce', groundColor: '#80867d', sunColor: '#ffffff', sunInt: 0.55, sunEl: 70, sunAz: 20, ambInt: 1.7, fog: true },
  sunset: { label: 'Sunset', sky: '#e99f72', groundColor: '#6f6253', sunColor: '#ffb36b', sunInt: 2.5, sunEl: 8, sunAz: 250, ambInt: 0.6, fog: true },
  night: { label: 'Night', sky: '#101a2e', groundColor: '#2c3139', sunColor: '#a8b9ff', sunInt: 0.75, sunEl: 40, sunAz: 300, ambInt: 0.38, fog: true },
};
const DEFAULT_SETTINGS = {
  duration: 5, fps: 24, aspect: '16:9', size: 1920, interp: 'smooth', loop: true,
  env: 'day', ...ENV.day, groundOn: true, gridOn: true, fogDensity: 0.018,
  style: 'shaded', exportGrid: false, guides: 'thirds', depthAuto: true, depthNear: 0.5, depthFar: 25,
};

/* shape icons (24x24 line art) */
const IC = {
  person: '<circle cx="12" cy="4.5" r="2.3"/><path d="M12 7.5v7M8 10l4-1.5 4 1.5M12 14.5l-3 6.5M12 14.5l3 6.5"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  sphere: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>',
  cone: '<path d="M12 3L5 18c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5z"/>',
  torus: '<ellipse cx="12" cy="12" rx="9" ry="5"/><ellipse cx="12" cy="11.5" rx="4" ry="1.6"/>',
  capsule: '<rect x="7" y="3" width="10" height="18" rx="5"/>',
  plane: '<path d="M2 15l7-6h13l-7 6z"/>',
  wall: '<path d="M3 6h18v12H3zM3 12h18M9 6v6M15 12v6"/>',
  stairs: '<path d="M3 20h4v-4h4v-4h4V8h4V4h2"/>',
  table: '<path d="M3 9h18M5 9v10M19 9v10M3 9l2-2h14l2 2"/>',
  chair: '<path d="M7 3v10h10M7 13v8M17 13v8M7 9h10"/>',
  sofa: '<path d="M3 11v7h18v-7M3 11a2 2 0 014 0v3h10v-3a2 2 0 014 0M6 11V7h12v4M5 18v2M19 18v2"/>',
  bed: '<path d="M3 6v14M3 14h18v6M21 14v-3a2 2 0 00-2-2h-9v5M5 11.5h3"/>',
  car: '<path d="M3 15v-3l2-5h11l3 5h2v3z"/><circle cx="7.5" cy="16" r="2"/><circle cx="16.5" cy="16" r="2"/>',
  tree: '<path d="M12 21v-5M12 3l6 9h-3l4 4H5l4-4H6z"/>',
  house: '<path d="M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-5h4v5"/>',
  building: '<path d="M6 21V3h12v18M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M4 21h16"/>',
  lamp: '<path d="M8 21h6M11 21V5h5M16 5v3M14 8h4"/>',
  rock: '<path d="M3 18l3-7 5-4 6 2 4 9z"/>',
  ball: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4.5 9c4 2 11 2 15 0M4.5 15c4-2 11-2 15 0"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l6-5 4 3 3-2 4 3"/>',
  model: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>',
  mark: '<ellipse cx="12" cy="15" rx="9" ry="4.5"/><path d="M9 16.5l3-7 3 7M10.2 14h3.6"/>',
  path: '<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18c6 0 2-9 7-11 1.5-.6 3-.9 3-.9" stroke-dasharray="2 2.5"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>',
};
const svgI = k => `<svg viewBox="0 0 24 24">${IC[k] || IC.box}</svg>`;

/* entry for a type; an unknown type (from a newer or edited file) gets a plain fallback */
const catalogOf = type => CATALOG[type] || { label: String(type || 'Object'), cat: 'Shapes', color: '#d6d0c4' };
const CATALOG = {
  person: { label: 'Person', cat: 'People', color: '#3d6fd8', opts: { pose: 'stand', height: 1.75, skin: '#c98e6b', pants: '#2d3340', hair: '#2a1d14', speed: 1, faceTravel: true } },
  box: { label: 'Box', cat: 'Shapes', color: '#d6d0c4' },
  sphere: { label: 'Sphere', cat: 'Shapes', color: '#d9cbb7' },
  cylinder: { label: 'Cylinder', cat: 'Shapes', color: '#c9d3d6' },
  cone: { label: 'Cone', cat: 'Shapes', color: '#e0b88f' },
  torus: { label: 'Ring', cat: 'Shapes', color: '#c7b6d9' },
  capsule: { label: 'Capsule', cat: 'Shapes', color: '#b9d3c0' },
  plane: { label: 'Floor tile', cat: 'Shapes', color: '#a5a09a' },
  wall: { label: 'Wall', cat: 'Shapes', color: '#e5e0d6' },
  stairs: { label: 'Stairs', cat: 'Shapes', color: '#bdb6aa' },
  table: { label: 'Table', cat: 'Props', color: '#8a5f3c' },
  chair: { label: 'Chair', cat: 'Props', color: '#6f4b31' },
  sofa: { label: 'Sofa', cat: 'Props', color: '#5c6f88' },
  bed: { label: 'Bed', cat: 'Props', color: '#7a6a5a' },
  car: { label: 'Car', cat: 'Props', color: '#b3262b' },
  tree: { label: 'Tree', cat: 'Props', color: '#4c8a3f' },
  house: { label: 'House', cat: 'Props', color: '#e8dcc6' },
  building: { label: 'Building', cat: 'Props', color: '#a9b0b8' },
  lamp: { label: 'Street lamp', cat: 'Props', color: '#2f3237' },
  rock: { label: 'Rock', cat: 'Props', color: '#8a8780' },
  ball: { label: 'Ball', cat: 'Props', color: '#f2f2f2' },
  mark: { label: 'Floor mark', cat: 'Blocking', color: '#ffd23f', opts: { letter: 'A' } },
  image: { label: 'Image card', cat: 'Import', color: '#ffffff', opts: { unlit: true, aspect: 1.5 } },
  model: { label: '3D model', cat: 'Import', color: '#ffffff', opts: {} },
};

/* ============================== state ============================== */
function defaultState() {
  const s = {
    v: FORMAT_VERSION, settings: clone(DEFAULT_SETTINGS),
    camera: { base: { p: [3.4, 1.6, 6.2], tg: [0, 1.15, 0], f: 35, roll: 0, fd: 7.2 }, keys: [], shake: 0, lookAtId: null, follow: false, feel: 'gentle', dof: { on: false, fstop: 2.8, auto: true } },
    objects: [],
  };
  return s;
}
let state = defaultState();
let assets = {}; // id -> {kind, name, b64, mime, aspect}
let T = 0, playing = false, view = 'editor', selected = null, pipOn = true, editRev = 1, uiDirty = true, propsDirty = true;
const frames = () => Math.max(2, Math.round(state.settings.duration * state.settings.fps));
const lastT = () => (frames() - 1) / state.settings.fps;
const snapT = t => Math.round(t * state.settings.fps) / state.settings.fps;
const getObj = id => state.objects.find(o => o.id === id);
/* every playhead move goes through here. panel=false for moves made many times a second
   (playback, scrubbing, dragging a key): the panel then refreshes when they end */
function setTime(t, panel = true) { T = t; if (panel) propsDirty = true; }

function nextName(label) {
  let n = 1; const names = new Set(state.objects.map(o => o.name));
  while (names.has(label + ' ' + n)) n++;
  return label + ' ' + n;
}
function makeObject(type, pos, extra = {}) {
  const c = CATALOG[type];
  return { id: uid(), type, name: nextName(c.label), color: c.color, opts: clone(c.opts || {}), base: { p: pos || [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, keys: [], visible: true, ...extra };
}

/* ---- keyframes & interpolation ---- */

/* the maths lives in keys.js; these wrappers pass the project's frame rate */
const { sampleField } = K;
const keyIndexAt = (keys, t) => K.keyIndexAt(keys, t, state.settings.fps);
const setKey = (keys, t, vals) => K.setKey(keys, t, vals, state.settings.fps);
const neighborKey = (keys, t) => K.neighborKey(keys, t, state.settings.fps);
const unwrap = (v, ref) => { while (v - ref > 180) v -= 360; while (v - ref < -180) v += 360; return v; };

function evalObj(o, t) {
  if (!o.keys.length) return o.base;
  const m = state.settings.interp;
  return { p: sampleField(o.keys, t, 'p', m), r: sampleField(o.keys, t, 'r', m), s: sampleField(o.keys, t, 's', m) };
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const FEEL = {
  constant: u => u,
  gentle: u => lerp(u, u * u * (3 - 2 * u), 0.7),
  strong: u => u * u * u * (u * (u * 6 - 15) + 10),
};
function camTime(t) {
  const k = state.camera.keys; if (k.length < 2) return t;
  const a = k[0].t, b = k[k.length - 1].t;
  if (t <= a || t >= b || b - a < 1e-6) return t;
  return a + (FEEL[state.camera.feel] || FEEL.gentle)((t - a) / (b - a)) * (b - a);
}
function evalCamRaw(t) {
  const c = state.camera;
  if (!c.keys.length) { const b = c.base; return { ...b, fd: typeof b.fd === 'number' ? b.fd : dist3(b.p, b.tg) }; }
  const m = 'natural'; t = camTime(t);
  const r = { p: sampleField(c.keys, t, 'p', m), tg: sampleField(c.keys, t, 'tg', m), f: sampleField(c.keys, t, 'f', m)[0], roll: sampleField(c.keys, t, 'roll', m)[0] };
  r.fd = c.keys.every(k => typeof k.fd === 'number') ? Math.max(0.05, sampleField(c.keys, t, 'fd', m)[0]) : dist3(r.p, r.tg);
  return r;
}
function ensureDof() { const c = state.camera; if (!c.dof) c.dof = { on: false, fstop: 2.8, auto: true }; return c.dof; }
function focusDist(cs) { const d = ensureDof(); return d.auto ? Math.max(0.05, dist3(cs.p, cs.tg)) : cs.fd; }
const subject = () => state.camera.lookAtId ? getObj(state.camera.lookAtId) : null;
function aimPoint(o, t) {
  const tr = evalObj(o, t), v = views.get(o.id);
  const ay = (v && v.aimY != null ? v.aimY : 1) * tr.s[1];
  return [tr.p[0], tr.p[1] + ay, tr.p[2]];
}
function followOffset(t) {
  const o = subject(); if (!o || !state.camera.follow) return [0, 0, 0];
  const t0 = o.keys.length ? o.keys[0].t : 0;
  const a = evalObj(o, t0).p, b = evalObj(o, t).p;
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}
function evalCam(t) {
  const r = evalCamRaw(t), o = subject();
  let p = r.p.slice(), tg = r.tg.slice();
  if (o) { tg = aimPoint(o, t); if (state.camera.follow) { const off = followOffset(t); p = p.map((v, i) => v + off[i]); } }
  return { p, tg, f: r.f, roll: r.roll, fd: r.fd };
}

/* ---- history ---- */
let hist = [], hi = -1;
let histFile = []; /* the open file ({name, path}) for each history step, so undo across an Open can't make Save overwrite that file */
function snapshot() { return JSON.stringify(state); }
function pushHistory() {
  const s = snapshot();
  if (hist[hi] === s) return;
  hist = hist.slice(0, hi + 1); hist.push(s);
  histFile = histFile.slice(0, hi + 1); histFile.push(platform.getFile());
  if (hist.length > 100) { hist.shift(); histFile.shift(); }
  hi = hist.length - 1;
  platform.setDirty(true);
  autosave();
}
function changed(commit, props = false) { editRev++; uiDirty = true; if (props) propsDirty = true; if (commit) pushHistory(); }
function restore(s) {
  state = JSON.parse(s);
  if (selected && selected !== 'camera' && selected !== 'target' && !getObj(selected)) selected = null;
  syncScene(); applyEnv(); editRev++; uiDirty = true; propsDirty = true; updateGizmo(); syncTopUI();
}
/* undo/redo autosave too, so an undone delete puts its photo or model back in the autosave */
const changeLabel = (word, before, after) => { const d = describeChange(before, after); return d ? word + ': ' + d : word; };
function undo() { if (exporting) return; if (hi > 0) { hi--; restore(hist[hi]); platform.restoreFile(histFile[hi]); platform.setDirty(true); autosave(); toast(changeLabel('Undo', hist[hi], hist[hi + 1])); } }
function redo() { if (exporting) return; if (hi < hist.length - 1) { hi++; restore(hist[hi]); platform.restoreFile(histFile[hi]); platform.setDirty(true); autosave(); toast(changeLabel('Redo', hist[hi - 1], hist[hi])); } }
/* ---- autosave ----
   localStorage 'shotref.autosave' = { state, assets: {}, assetIds: [...], v: 2 } (small).
   Photos and models go to IndexedDB (db 'shotref', store 'assets', key = asset id).
   If IndexedDB is unavailable (sandboxed iframe, private mode…), the used assets go inline as before;
   if even that does not fit, the scene is saved without them and the user is told once. */
const AUTOSAVE_KEY = 'shotref.autosave';
const SIZE_WARNING = 'Photos and models are too big to autosave in this browser. Use Save to keep them.';
const NO_AUTOSAVE = "Autosave isn't available here. Use Save to keep your work.";
/* true when this page can't use localStorage at all (claude.ai sandbox): autosave is skipped, boot says so once */
let autosaveOff = false;
function probeStorage() {
  try { localStorage.setItem('shotref.probe', '1'); localStorage.removeItem('shotref.probe'); autosaveOff = false; }
  catch (e) { autosaveOff = true; }
  return !autosaveOff;
}
/* the asset ids the scene actually uses (memory also keeps older ones for undo) */
function usedAssetIds(st) {
  const ids = new Set();
  if (st.plate && st.plate.asset) ids.add(st.plate.asset);
  for (const o of st.objects || []) { const id = o.asset || (o.opts && o.opts.asset); if (id) ids.add(id); }
  return ids;
}
/* noPrune: set when boot dropped a broken autosave, so its photos and models stay in IndexedDB this session.
   keep: ids never deleted this session (files a kept broken autosave lists, files that failed to load).
   lastErr: the error of the last failed transaction */
const idb = { db: null, ok: null /* null = not known yet */, noPrune: false, keep: new Set(), lastErr: null, opening: null, queue: Promise.resolve() };
const isQuota = e => !!e && (e.name === 'QuotaExceededError' || e.code === 22);
/* resolves to the db, or null when IndexedDB can't be used this session (never rejects) */
function idbOpen() {
  if (idb.opening) return idb.opening;
  idb.opening = new Promise(res => {
    let done = false;
    const finish = db => {
      if (done) { if (db) try { db.close(); } catch (e) { } return; }
      done = true; clearTimeout(timer); idb.db = db; idb.ok = !!db;
      if (db) db.onversionchange = () => { try { db.close(); } catch (e) { } idb.db = null; idb.ok = false; };
      res(db);
    };
    const timer = setTimeout(() => finish(null), 1500);
    try {
      const rq = indexedDB.open('shotref', 1);
      rq.onupgradeneeded = () => { try { if (!rq.result.objectStoreNames.contains('assets')) rq.result.createObjectStore('assets'); } catch (e) { } };
      rq.onsuccess = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('assets')) { try { db.close(); } catch (e) { } finish(null); return; }
        finish(db);
      };
      rq.onerror = e => { if (e && e.preventDefault) e.preventDefault(); finish(null); };
    } catch (e) { finish(null); }
  });
  return idb.opening;
}
/* wraps one IndexedDB transaction; resolves with fn's result, or null on any failure */
function idbTx(mode, fn) {
  return idbOpen().then(db => new Promise(res => {
    if (!db) return res(null);
    try {
      const tx = db.transaction('assets', mode), st = tx.objectStore('assets'), out = fn(st);
      tx.oncomplete = () => res(out);
      tx.onerror = e => { const err = e && e.target && e.target.error; idb.lastErr = err || tx.error; console.error('ShotRef: IndexedDB request failed', err); if (e && e.preventDefault) e.preventDefault(); res(null); };
      tx.onabort = () => { if (tx.error) idb.lastErr = tx.error; console.error('ShotRef: could not autosave photos and models', tx.error); res(null); };
    } catch (e) { idb.lastErr = e; console.error('ShotRef: IndexedDB transaction failed', e); res(null); }
  }));
}
/* reads the stored records for `ids`. Resolves {id: asset} */
function idbLoad(ids) {
  if (!ids.length) return idbOpen().then(() => ({}));
  return idbTx('readonly', st => {
    const got = {};
    for (const id of ids) { const r = st.get(id); r.onsuccess = () => { if (r.result && r.result.b64) got[id] = r.result; }; }
    return got;
  }).then(got => got || {});
}
/* Puts used assets that are not stored yet and deletes unused records. It reads the keys inside the
   same transaction (another tab may have changed the store), so only missing files are written.
   Queued so writes never overlap. */
function idbSync(ids) {
  idb.queue = idb.queue.then(() => idbTx('readwrite', st => {
    const k = st.getAllKeys();
    k.onsuccess = () => {
      try {
        const have = new Set(k.result.map(String));
        for (const id of ids) if (!have.has(id) && assets[id]) st.put(assets[id], id);
        if (!idb.noPrune) for (const id of have) if (!ids.includes(id) && !idb.keep.has(id)) st.delete(id);
      } catch (e) { idb.lastErr = e; console.error('ShotRef: could not autosave photos and models', e); try { k.transaction.abort(); } catch (e2) { } }
    };
    idb.lastErr = null;
    return true;
  }).then(ok => { if (!ok && ids.length && isQuota(idb.lastErr)) warnSize(); })); /* other failures: console only (C6) */
}
let sizeWarned = false;
function warnSize() { if (autosaveOff) return; if (!sizeWarned) { sizeWarned = true; toast(SIZE_WARNING, 6000); } }
let autosaveReady = false; /* false until boot has fetched the stored assets: saving earlier would drop them */
/* writes the localStorage part now; in IndexedDB mode also queues the asset write */
let autosaveWaiting = false;
function writeAutosave() {
  if (autosaveOff) return;
  if (!autosaveReady) { autosaveWaiting = true; return; }
  const ids = [...usedAssetIds(state)].filter(id => assets[id]);
  const put = a => localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ state, assets: a, assetIds: ids, v: FORMAT_VERSION }));
  if (idb.ok !== false) {
    try { put({}); } catch (e) { console.error('ShotRef: could not autosave', e); }
    if (idb.ok) idbSync(ids);
    else idbOpen().then(() => { if (idb.ok) idbSync(ids); else writeAutosave(); }); /* still opening: decide when known */
    return;
  }
  /* don't retry a big inline write that already failed for these same files */
  const key = ids.join();
  if (ids.length && key !== inlineTooBig) {
    const inline = {}; for (const id of ids) inline[id] = assets[id];
    try { put(inline); return; } catch (e) { inlineTooBig = key; }
  }
  try { put({}); } catch (e2) { console.error('ShotRef: could not autosave', e2); }
  if (ids.length) warnSize();
}
let inlineTooBig = null;
let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeAutosave(); }, 400);
}
/* write a pending autosave straight away (page closing) */
function flushAutosave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeAutosave(); } }

/* ============================== three.js setup ============================== */
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
/* after a graphics reset three.js rebuilds its GPU state; nothing else asks for a frame, so ask here (K1) */
canvas.addEventListener('webglcontextrestored', () => requestRender());
function configureRenderer(r) {
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
  r.outputColorSpace = THREE.SRGBColorSpace;
}
configureRenderer(renderer);
renderer.shadowMap.autoUpdate = false; /* needsUpdate is set once per drawn frame (render on demand) */
const scene = new THREE.Scene();

const edCam = new THREE.PerspectiveCamera(50, 1, 0.05, 3000);
edCam.position.set(7, 5, 10);
const edControls = new OrbitControls(edCam, canvas);
edControls.target.set(0, 1, 0); edControls.enableDamping = true; edControls.dampingFactor = 0.12;

const shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);
const renderCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);
const camControls = new OrbitControls(shotCam, canvas);
camControls.enabled = false; camControls.enableDamping = false; camControls.rotateSpeed = 0.6; camControls.zoomSpeed = 0.6;
const topCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 600);
topCam.up.set(0, 0, -1); topCam.position.set(0, 120, 0); topCam.lookAt(0, 0, 0);
const topControls = new OrbitControls(topCam, canvas);
topControls.enableRotate = false; topControls.screenSpacePanning = true; topControls.enabled = false;
topControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
topControls.minZoom = 0.12; topControls.maxZoom = 15;
let topInit = false;

// environment
const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 160;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 2;
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x8c9286, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.userData.ground = true;
scene.add(ground);
const grid = new THREE.GridHelper(60, 60, 0x4b4f56, 0x3a3d43);
grid.position.y = 0.002; grid.material.transparent = true; grid.material.opacity = 0.55;
scene.add(grid);

function skyTexture(hex) {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const base = new THREE.Color(hex);
  const top = base.clone().multiplyScalar(0.72), hor = base.clone().lerp(new THREE.Color('#ffffff'), 0.32);
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#' + top.getHexString()); gr.addColorStop(0.62, '#' + base.getHexString()); gr.addColorStop(1, '#' + hor.getHexString());
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return { tex: t, horizon: hor };
}
let skyTex = null;
function applyEnv() {
  const s = state.settings;
  if (skyTex) skyTex.tex.dispose();
  skyTex = skyTexture(s.sky);
  scene.background = skyTex.tex;
  scene.fog = s.fog ? new THREE.FogExp2(skyTex.horizon, s.fogDensity) : null;
  hemi.color.set(s.sky).lerp(new THREE.Color('#ffffff'), 0.35); hemi.groundColor.set(s.groundColor); hemi.intensity = s.ambInt;
  sun.color.set(s.sunColor); sun.intensity = s.sunInt;
  ground.material.color.set(s.groundColor); ground.visible = s.groundOn;
  grid.visible = s.gridOn;
}

/* ---- materials for render styles ---- */
const clayMat = new THREE.MeshStandardMaterial({ color: 0xd9d9d9, roughness: 0.9 });
const clayBg = new THREE.Color('#9c9fa3');
const depthMat = new THREE.ShaderMaterial({
  uniforms: { uNear: { value: 0.5 }, uFar: { value: 25 } }, side: THREE.DoubleSide,
  vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix*mv; }',
  fragmentShader: 'uniform float uNear; uniform float uFar; varying float vD; void main(){ float d = clamp((vD-uNear)/(uFar-uNear),0.0,1.0); gl_FragColor = vec4(vec3(1.0-d),1.0); }',
});
const normalMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: 'varying vec3 vN; void main(){ vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n; gl_FragColor = vec4(n*0.5+0.5,1.0); }',
});
const black = new THREE.Color(0, 0, 0), normalBg = new THREE.Color().setRGB(0.5, 0.5, 1.0, THREE.SRGBColorSpace);

/* ---- depth of field (physical: focal length, f-stop, focus distance, 36 mm sensor) ---- */
const dofMat = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.05 }, uFar: { value: 2000 }, uFocus: { value: 5 }, uK: { value: 0 }, uMax: { value: 30 }, uBgRaw: { value: 0 } },
  depthTest: false, depthWrite: false,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    #include <packing>
    uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uRes;
    uniform float uNear; uniform float uFar; uniform float uFocus; uniform float uK; uniform float uMax; uniform float uBgRaw;
    varying vec2 vUv;
    float vdist(vec2 uv){ float z = texture2D(tDepth, uv).x; return -perspectiveDepthToViewZ(z, uNear, uFar); }
    float coc(float d){ return min(uMax, uK * abs(d - uFocus) / max(d, 0.001)); }
    void main(){
      vec4 c0 = texture2D(tColor, vUv);
      bool bg = texture2D(tDepth, vUv).x >= 0.99999 && uBgRaw > 0.5;
      float d0 = vdist(vUv), r0 = bg ? 0.0 : coc(d0);
      vec3 acc = c0.rgb; float ws = 1.0;
      if (r0 > 0.6) {
        float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        for (int i = 0; i < 80; i++) {
          float fi = float(i) + 0.5;
          float r = sqrt(fi / 80.0) * r0;
          float a = fi * 2.39996323 + rot;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
          vec3 c = texture2D(tColor, uv).rgb;
          float d = vdist(uv), rs = coc(d);
          float w = d < d0 ? clamp(rs - r + 1.0, 0.0, 1.0) : 1.0;
          acc += c * w; ws += w;
        }
      }
      gl_FragColor = vec4(acc / ws, 1.0);
      vec3 pre = gl_FragColor.rgb;
      #include <tonemapping_fragment>
      if (bg) gl_FragColor.rgb = pre;
      #include <colorspace_fragment>
    }`,
});
const dofQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dofMat); dofQuad.frustumCulled = false;
const dofScene = new THREE.Scene(); dofScene.add(dofQuad);
const dofCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const dofTargets = new WeakMap();
function dofTarget(rd, w, hh) {
  let rt = dofTargets.get(rd);
  if (!rt) {
    rt = new THREE.WebGLRenderTarget(w, hh, { type: THREE.HalfFloatType, samples: 4 });
    rt.depthTexture = new THREE.DepthTexture(w, hh); rt.depthTexture.type = THREE.UnsignedIntType;
    dofTargets.set(rd, rt);
  }
  if (rt.width !== w || rt.height !== hh) rt.setSize(w, hh);
  return rt;
}
function dofActive() { const d = ensureDof(); return d.on && (state.settings.style === 'shaded' || state.settings.style === 'clay'); }
// renders the shot into the renderer's current viewport (pxW x pxH device pixels)
function shotPass(rd, pxW, pxH) {
  const style = state.settings.style;
  if (!dofActive()) { withShotStyle(style, () => rd.render(scene, renderCam)); return; }
  pxW = Math.max(2, Math.round(pxW)); pxH = Math.max(2, Math.round(pxH));
  const rt = dofTarget(rd, pxW, pxH);
  withShotStyle(style, () => { rd.setRenderTarget(rt); rd.clear(); rd.render(scene, renderCam); rd.setRenderTarget(null); });
  const d = ensureDof(), f = camState.f, N = Math.max(0.7, d.fstop), S = focusDist(camState), Smm = Math.max(S * 1000, f * 1.05);
  const longPx = Math.max(pxW, pxH);
  const u = dofMat.uniforms;
  u.tColor.value = rt.texture; u.tDepth.value = rt.depthTexture; u.uRes.value.set(pxW, pxH);
  u.uNear.value = renderCam.near; u.uFar.value = renderCam.far; u.uFocus.value = S;
  u.uK.value = (f * f) / (N * (Smm - f)) / 36 * longPx; u.uMax.value = 0.025 * longPx; u.uBgRaw.value = plateActive(style) ? 1 : 0;
  rd.render(dofScene, dofCam);
}

/* ============================== object builders ============================== */
function M(color, o = {}) { return new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.72, metalness: o.m ?? 0, flatShading: !!o.flat, emissive: o.e || 0x000000, emissiveIntensity: o.ei ?? 1 }); }
function mk(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; }
const BOX = (w, hh, d) => new THREE.BoxGeometry(w, hh, d);

const BUILD = {
  mark: o => {
    const g = new THREE.Group(), c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(20,20,20,0.55)'; x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.fill();
    x.strokeStyle = o.color; x.lineWidth = 9; x.beginPath(); x.arc(64, 64, 54, 0, Math.PI * 2); x.stroke();
    x.fillStyle = o.color; x.font = 'bold 70px Segoe UI, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(o.opts.letter || 'A', 64, 68);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const m = mk(new THREE.CircleGeometry(0.34, 40), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), 0, 0.014, 0);
    m.rotation.x = -Math.PI / 2; m.renderOrder = 2; g.add(m);
    return { root: g, aimY: 0, isMark: true };
  },
  box: o => { const g = new THREE.Group(); g.add(mk(BOX(1, 1, 1), M(o.color), 0, 0.5, 0)); return { root: g }; },
  sphere: o => { const g = new THREE.Group(); g.add(mk(new THREE.SphereGeometry(0.5, 40, 24), M(o.color), 0, 0.5, 0)); return { root: g }; },
  cylinder: o => { const g = new THREE.Group(); g.add(mk(new THREE.CylinderGeometry(0.5, 0.5, 1, 40), M(o.color), 0, 0.5, 0)); return { root: g }; },
  cone: o => { const g = new THREE.Group(); g.add(mk(new THREE.ConeGeometry(0.5, 1, 40), M(o.color), 0, 0.5, 0)); return { root: g }; },
  torus: o => { const g = new THREE.Group(); const m = mk(new THREE.TorusGeometry(0.4, 0.14, 20, 56), M(o.color), 0, 0.14, 0); m.rotation.x = -Math.PI / 2; g.add(m); return { root: g }; },
  capsule: o => { const g = new THREE.Group(); g.add(mk(new THREE.CapsuleGeometry(0.3, 1, 8, 24), M(o.color), 0, 0.8, 0)); return { root: g }; },
  plane: o => { const g = new THREE.Group(); const m = mk(new THREE.PlaneGeometry(4, 4), M(o.color, { r: 0.95 }), 0, 0.01, 0); m.rotation.x = -Math.PI / 2; g.add(m); return { root: g }; },
  wall: o => { const g = new THREE.Group(); g.add(mk(BOX(4, 3, 0.2), M(o.color, { r: 0.9 }), 0, 1.5, 0)); return { root: g }; },
  stairs: o => {
    const g = new THREE.Group(), m = M(o.color);
    for (let i = 0; i < 8; i++) g.add(mk(BOX(1.2, 0.18 * (i + 1), 0.28), m, 0, 0.09 * (i + 1), -i * 0.28));
    return { root: g };
  },
  table: o => {
    const g = new THREE.Group(), m = M(o.color, { r: 0.55 });
    g.add(mk(BOX(1.4, 0.05, 0.8), m, 0, 0.745, 0));
    for (const x of [-0.64, 0.64]) for (const z of [-0.34, 0.34]) g.add(mk(BOX(0.06, 0.72, 0.06), m, x, 0.36, z));
    return { root: g };
  },
  chair: o => {
    const g = new THREE.Group(), m = M(o.color, { r: 0.6 });
    g.add(mk(BOX(0.46, 0.05, 0.46), m, 0, 0.43, 0));
    for (const x of [-0.2, 0.2]) for (const z of [-0.2, 0.2]) g.add(mk(BOX(0.04, 0.43, 0.04), m, x, 0.215, z));
    g.add(mk(BOX(0.46, 0.5, 0.04), m, 0, 0.7, -0.21));
    return { root: g };
  },
  sofa: o => {
    const g = new THREE.Group(), m = M(o.color, { r: 0.95 });
    g.add(mk(BOX(2.0, 0.42, 0.9), m, 0, 0.21, 0));
    g.add(mk(BOX(1.6, 0.1, 0.72), M(new THREE.Color(o.color).offsetHSL(0, 0, 0.06), { r: 0.95 }), 0, 0.47, 0.06));
    g.add(mk(BOX(2.0, 0.55, 0.2), m, 0, 0.7, -0.35));
    for (const x of [-0.9, 0.9]) g.add(mk(BOX(0.2, 0.62, 0.9), m, x, 0.31, 0));
    return { root: g };
  },
  bed: o => {
    const g = new THREE.Group(), m = M(o.color, { r: 0.7 });
    g.add(mk(BOX(1.6, 0.3, 2.1), m, 0, 0.2, 0));
    g.add(mk(BOX(1.5, 0.22, 2.0), M('#eeeae4', { r: 0.95 }), 0, 0.46, 0.02));
    g.add(mk(BOX(1.6, 0.9, 0.08), m, 0, 0.55, -1.05));
    for (const x of [-0.4, 0.4]) g.add(mk(BOX(0.6, 0.1, 0.35), M('#ffffff', { r: 0.95 }), x, 0.62, -0.75));
    return { root: g };
  },
  car: o => {
    const g = new THREE.Group();
    g.add(mk(BOX(1.8, 0.62, 4.3), M(o.color, { r: 0.35, m: 0.3 }), 0, 0.62, 0));
    g.add(mk(BOX(1.62, 0.56, 2.2), M('#27313d', { r: 0.15, m: 0.4 }), 0, 1.2, -0.25));
    const wm = M('#151515', { r: 0.8 }), wg = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 28);
    for (const x of [-0.84, 0.84]) for (const z of [-1.35, 1.35]) { const w = mk(wg, wm, x, 0.36, z); w.rotation.z = Math.PI / 2; g.add(w); }
    for (const x of [-0.62, 0.62]) { g.add(mk(BOX(0.38, 0.14, 0.05), M('#ffffff', { e: 0xfff4d0, ei: 0.8 }), x, 0.74, 2.16)); g.add(mk(BOX(0.38, 0.12, 0.05), M('#550000', { e: 0xff2020, ei: 0.6 }), x, 0.78, -2.16)); }
    return { root: g };
  },
  tree: o => {
    const g = new THREE.Group();
    g.add(mk(new THREE.CylinderGeometry(0.12, 0.2, 2.2, 10), M('#6b4a32', { r: 0.95 }), 0, 1.1, 0));
    const fm = M(o.color, { r: 0.9, flat: true });
    g.add(mk(new THREE.IcosahedronGeometry(1.25, 1), fm, 0, 2.7, 0));
    g.add(mk(new THREE.IcosahedronGeometry(0.85, 1), fm, 0.35, 3.5, 0.15));
    return { root: g };
  },
  house: o => {
    const g = new THREE.Group();
    g.add(mk(BOX(6, 3, 5), M(o.color, { r: 0.9 }), 0, 1.5, 0));
    const sh = new THREE.Shape(); sh.moveTo(-2.9, 0); sh.lineTo(2.9, 0); sh.lineTo(0, 1.9); sh.lineTo(-2.9, 0);
    const rg = new THREE.ExtrudeGeometry(sh, { depth: 6.5, bevelEnabled: false }); rg.translate(0, 0, -3.25); rg.rotateY(Math.PI / 2);
    g.add(mk(rg, M('#7c3b2e', { r: 0.8 }), 0, 3, 0));
    g.add(mk(BOX(1.0, 2.0, 0.08), M('#4a3326'), 0, 1.0, 2.52));
    const wmat = M('#9fc3df', { r: 0.1, m: 0.2 });
    for (const x of [-1.9, 1.9]) g.add(mk(BOX(1.1, 1.0, 0.08), wmat, x, 1.7, 2.52));
    return { root: g };
  },
  building: o => {
    const g = new THREE.Group();
    g.add(mk(BOX(10, 18, 10), M(o.color, { r: 0.8 }), 0, 9, 0));
    const gm = M('#2b3440', { r: 0.15, m: 0.5 });
    for (let i = 0; i < 5; i++) g.add(mk(BOX(10.1, 1.4, 10.1), gm, 0, 2.6 + i * 3.2, 0));
    return { root: g };
  },
  lamp: o => {
    const g = new THREE.Group(), m = M(o.color, { r: 0.5, m: 0.6 });
    g.add(mk(new THREE.CylinderGeometry(0.06, 0.09, 4.5, 14), m, 0, 2.25, 0));
    g.add(mk(BOX(0.07, 0.07, 0.8), m, 0, 4.45, 0.36));
    g.add(mk(BOX(0.32, 0.12, 0.5), M('#fff2c4', { e: 0xffd27a, ei: 1.2 }), 0, 4.38, 0.78));
    return { root: g };
  },
  rock: o => { const g = new THREE.Group(); const m = mk(new THREE.DodecahedronGeometry(0.6, 0), M(o.color, { r: 1, flat: true }), 0, 0.3, 0); m.scale.set(1.3, 0.7, 1); m.rotation.y = 0.6; g.add(m); return { root: g }; },
  ball: o => { const g = new THREE.Group(); g.add(mk(new THREE.SphereGeometry(0.11, 28, 18), M(o.color, { r: 0.5 }), 0, 0.11, 0)); return { root: g }; },
  image: o => {
    const g = new THREE.Group();
    const a = assets[o.asset]; const asp = o.opts.aspect || 1.5, H = 2;
    const mat = o.opts.unlit ? new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true }) : new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.9, transparent: true });
    if (a) {
      const img = new Image();
      const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace;
      img.onload = () => { tex.needsUpdate = true; requestRender(); };
      img.src = assetURL(o.asset);
      mat.map = tex;
    }
    const m = mk(new THREE.PlaneGeometry(H * asp, H), mat, 0, H / 2, 0);
    m.castShadow = true;
    g.add(m);
    return { root: g, aimY: 1 };
  },
  model: o => {
    const g = new THREE.Group();
    const ph = mk(BOX(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff9a3c, wireframe: true }), 0, 0.5, 0);
    g.add(ph);
    const res = { root: g, async: true };
    loadModel(o.asset).then(src => {
      if (!src) return;
      const inner = src.clone(true);
      const wrap = new THREE.Group(); wrap.add(inner);
      const bb = new THREE.Box3().setFromObject(inner); const size = bb.getSize(new THREE.Vector3());
      const mx = Math.max(size.x, size.y, size.z) || 1;
      const k = (mx > 60 || mx < 0.02) ? 2 / mx : 1;
      inner.scale.multiplyScalar(k);
      const bb2 = new THREE.Box3().setFromObject(inner); const ctr = bb2.getCenter(new THREE.Vector3());
      inner.position.sub(new THREE.Vector3(ctr.x, bb2.min.y, ctr.z));
      inner.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; m.userData.shared = true; } });
      g.remove(ph); ph.geometry.dispose(); g.add(wrap);
      const v = views.get(o.id); if (v) v.aimY = (bb2.max.y - bb2.min.y) * 0.6;
      editRev++; requestRender();
    }).catch(err => { console.error(err); toast(err && err.friendly || 'Could not read that model file', 4500); });
    return res;
  },
};

/* ---- GLB loading: embedded textures are decoded straight from bytes (no blob: URLs, which sandboxes can block) ---- */
const GL_FILTER = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
const GL_WRAP = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
/* Textures stored as outside files (a web address or a file next to the model) are skipped, so a model
   never makes ShotRef go online (A7); onSkip is called when that happens. A model whose geometry lives
   in outside files can't be loaded at all. */
const OUTSIDE_FILES = 'This model uses separate files. Please export it as a single .glb.';
const TEX_SKIPPED = "This model's textures are separate files, so they were skipped.";
const embeddedTexturePlugin = (parser, onSkip) => {
  const json = parser.json, outside = u => typeof u === 'string' && !/^data:/i.test(u);
  const skip = new Set();
  (json.images || []).forEach((im, i) => { if (im && im.bufferView === undefined && outside(im.uri)) { skip.add(i); delete im.uri; } });
  for (const t of json.textures || []) {
    if (!t) continue;
    for (const [k, e] of Object.entries(t.extensions || {})) if (e && skip.has(e.source)) delete t.extensions[k];
    if (t.source === undefined || skip.has(t.source)) {
      const alt = Object.values(t.extensions || {}).find(e => e && e.source !== undefined);
      if (alt) t.source = alt.source; else if (skip.has(t.source)) t.shotrefSkip = true;
    }
  }
  if (skip.size && onSkip) onSkip();
  const badBuffers = (json.buffers || []).some(b => b && outside(b.uri));
  return {
  name: 'shotref_embedded_textures',
  beforeRoot() { if (!badBuffers) return null; const e = new Error('GLB buffer is an outside file'); e.friendly = OUTSIDE_FILES; return Promise.reject(e); },
  loadTexture(textureIndex) {
    const tdef = json.textures[textureIndex];
    if (tdef && tdef.shotrefSkip) return Promise.resolve(null);
    if (!tdef || tdef.source === undefined || typeof createImageBitmap !== 'function') return null;
    const idef = json.images[tdef.source];
    if (!idef || idef.bufferView === undefined) return null;
    return parser.getDependency('bufferView', idef.bufferView)
      .then(buf => createImageBitmap(new Blob([buf], { type: idef.mimeType || 'image/png' })))
      .then(bmp => {
        const t = new THREE.Texture(bmp); t.flipY = false; t.needsUpdate = true;
        const smp = (json.samplers || [])[tdef.sampler] || {};
        t.magFilter = GL_FILTER[smp.magFilter] || THREE.LinearFilter;
        t.minFilter = GL_FILTER[smp.minFilter] || THREE.LinearMipmapLinearFilter;
        t.wrapS = GL_WRAP[smp.wrapS] || THREE.RepeatWrapping; t.wrapT = GL_WRAP[smp.wrapT] || THREE.RepeatWrapping;
        parser.associations.set(t, { textures: textureIndex });
        return t;
      });
  },
  };
};
/* data: URL per asset id, built once (P7); rebuilt if the asset's data changes */
const urlCache = new Map();
function assetURL(id) {
  const a = assets[id]; if (!a) return null;
  let c = urlCache.get(id);
  if (!c || c.b64 !== a.b64 || c.mime !== a.mime) { c = { b64: a.b64, mime: a.mime, url: 'data:' + a.mime + ';base64,' + a.b64 }; urlCache.set(id, c); }
  return c.url;
}
/* ---- GLB loading ---- */
const modelCache = new Map();
/* frees a parsed model's GPU memory (P4): geometry, materials and their textures */
function disposeModel(root) {
  root.traverse(m => {
    if (m.geometry) m.geometry.dispose();
    for (const mt of arr(m.material)) { if (!mt) continue; for (const v of Object.values(mt)) if (v && v.isTexture) v.dispose(); mt.dispose(); }
  });
}
function dropModel(id) {
  const pr = modelCache.get(id); if (!pr) return;
  modelCache.delete(id);
  pr.then(src => { if (src) disposeModel(src); }, () => { });
}
/* drop parsed models that no object in the scene uses (undo parses them again from the stored file) */
function pruneModelCache() {
  for (const id of [...urlCache.keys()]) if (!assets[id]) urlCache.delete(id); /* data: URLs of files no longer kept (M6) */
  if (!modelCache.size) return;
  const used = new Set();
  for (const o of state.objects) if (o.type === 'model') { const id = o.asset || (o.opts && o.opts.asset); if (id) used.add(id); }
  for (const id of [...modelCache.keys()]) if (!used.has(id)) dropModel(id);
}
function loadModel(id) {
  const a = assets[id]; if (!a) return Promise.resolve(null);
  if (!modelCache.has(id)) {
    modelCache.set(id, new Promise((res, rej) => {
      const buf = b64ToBuf(a.b64);
      const saved = window.createImageBitmap;
      try { window.createImageBitmap = undefined; } catch (e) { }
      let skipped = false;
      try { const ld = new GLTFLoader(); ld.register(p => embeddedTexturePlugin(p, () => { skipped = true; })); ld.parse(buf, '', gl => { if (skipped) toast(TEX_SKIPPED, 5000); res(gl.scene); }, rej); }
      catch (e) { rej(e); }
      finally { try { window.createImageBitmap = saved; } catch (e) { } }
    }));
  }
  return modelCache.get(id);
}

/* ============================== people ============================== */
function buildPerson(o) {
  const H = clamp(o.opts.height || 1.75, 0.5, 2.6);
  const skin = M(o.opts.skin || '#c98e6b', { r: 0.6 }), shirt = M(o.color, { r: 0.85 }), pants = M(o.opts.pants || '#2d3340', { r: 0.9 }), shoe = M('#1d1d1f', { r: 0.6 }), hair = M(o.opts.hair || '#2a1d14', { r: 0.9 });
  const cap = (r, len, mat) => new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len), 6, 16), mat);
  const J = (parent, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };
  const root = new THREE.Group();
  const pelvis = J(root, 0, 0.52 * H, 0);
  const pm = cap(0.068 * H, 0.08 * H, pants); pm.rotation.z = Math.PI / 2; pm.position.y = 0.0; pm.scale.set(1, 1, 0.85); pelvis.add(pm);
  const spine = J(pelvis, 0, 0.03 * H, 0);
  const tor = cap(0.08 * H, 0.15 * H, shirt); tor.position.y = 0.145 * H; tor.scale.set(1.32, 1, 0.72); spine.add(tor);
  const neck = J(spine, 0, 0.29 * H, 0);
  const nm = new THREE.Mesh(new THREE.CylinderGeometry(0.024 * H, 0.028 * H, 0.06 * H, 12), skin); nm.position.y = 0.02 * H; neck.add(nm);
  const head = J(neck, 0, 0.085 * H, 0);
  const hm = new THREE.Mesh(new THREE.SphereGeometry(0.062 * H, 24, 18), skin); hm.scale.set(0.92, 1.12, 1); head.add(hm);
  const hr = new THREE.Mesh(new THREE.SphereGeometry(0.066 * H, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), hair); hr.rotation.x = -0.45; hr.position.set(0, 0.008 * H, -0.006 * H); hr.scale.set(0.95, 1.1, 1.02); head.add(hr);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.012 * H, 0.03 * H, 8), skin); nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.004 * H, 0.062 * H); head.add(nose);
  const Lu = 0.165 * H, Lf = 0.15 * H, Lt = 0.245 * H, Ls = 0.245 * H;
  const arm = side => {
    const sh = J(spine, side * 0.118 * H, 0.255 * H, 0);
    const u = cap(0.031 * H, Lu - 0.04 * H, shirt); u.position.y = -Lu / 2; sh.add(u);
    const el = J(sh, 0, -Lu, 0);
    const f = cap(0.026 * H, Lf - 0.03 * H, skin); f.position.y = -Lf / 2; el.add(f);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.033 * H, 14, 10), skin); hd.scale.set(0.8, 1.2, 1); hd.position.y = -Lf - 0.03 * H; el.add(hd);
    return [sh, el];
  };
  const leg = side => {
    const hp = J(pelvis, side * 0.062 * H, -0.01 * H, 0);
    const t = cap(0.046 * H, Lt - 0.05 * H, pants); t.position.y = -Lt / 2; hp.add(t);
    const kn = J(hp, 0, -Lt, 0);
    const s = cap(0.037 * H, Ls - 0.04 * H, pants); s.position.y = -Ls / 2; kn.add(s);
    const an = J(kn, 0, -Ls, 0);
    const ft = new THREE.Mesh(BOX(0.058 * H, 0.04 * H, 0.15 * H), shoe); ft.position.set(0, -0.0, 0.035 * H); an.add(ft);
    const heel = J(an, 0, -0.02 * H, -0.035 * H), toe = J(an, 0, -0.02 * H, 0.105 * H);
    return [hp, kn, an, heel, toe];
  };
  const [lSh, lEl] = arm(1), [rSh, rEl] = arm(-1);
  const [lHip, lKnee, lAnk, lh, lt] = leg(1), [rHip, rKnee, rAnk, rh, rt] = leg(-1);
  const P = { root, pelvis, spine, neck, head, lSh, lEl, rSh, rEl, lHip, lKnee, lAnk, rHip, rKnee, rAnk, soles: [lh, lt, rh, rt], H };
  return { root, person: P, aimY: 0.82 * H };
}

const STAND = { spine: [2, 0, 0], neck: [0, 0, 0], lSh: [3, 7, 0], rSh: [3, 7, 0], lEl: [10, 0], rEl: [10, 0], lHip: [0, 1], rHip: [0, 1], lKnee: 2, rKnee: 2, flat: 1 };
const sw = (v, p = 1.5) => Math.pow(Math.max(0, v), p);
const POSES = {
  stand: { label: 'Stand', f: () => ({}) },
  walk: { label: 'Walk', anim: true, loco: true, cadence: 0.9, stride: 1.45, minSpeed: 0.4, f: ph => {
    const s = Math.sin(ph), c = Math.cos(ph), s2 = -s, c2 = -c;
    return { spine: [4, 5 * s, 0], neck: [-3, -4 * s, 0], lHip: [24 * s, 2], rHip: [24 * s2, 2], lKnee: 5 + 48 * sw(c), rKnee: 5 + 48 * sw(c2), lSh: [-20 * s, 7], rSh: [-20 * s2, 7], lEl: [18 + 12 * Math.max(0, -s)], rEl: [18 + 12 * Math.max(0, -s2)] };
  } },
  run: { label: 'Run', anim: true, loco: true, cadence: 1.4, stride: 2.6, minSpeed: 1.2, f: ph => {
    const s = Math.sin(ph), c = Math.cos(ph);
    return { spine: [13, 8 * s, 0], neck: [-10, -6 * s, 0], lHip: [42 * s + 8, 3], rHip: [-42 * s + 8, 3], lKnee: 22 + 85 * sw(c, 1.2), rKnee: 22 + 85 * sw(-c, 1.2), lSh: [-42 * s, 10], rSh: [42 * s, 10], lEl: [88], rEl: [88], flat: 0.55 };
  } },
  sit: { label: 'Sit', f: () => ({ spine: [-4, 0, 0], lHip: [88, 4], rHip: [88, 4], lKnee: 88, rKnee: 88, lSh: [22, 10], rSh: [22, 10], lEl: [48], rEl: [48] }) },
  crouch: { label: 'Crouch', f: () => ({ spine: [30, 0, 0], neck: [-22, 0, 0], lHip: [78, 10], rHip: [78, 10], lKnee: 125, rKnee: 125, lSh: [45, 12], rSh: [45, 12], lEl: [60], rEl: [60] }) },
  wave: { label: 'Wave', anim: true, cadence: 1.6, f: ph => ({ rSh: [8, 105, 0], rEl: [10, 42 + 24 * Math.sin(ph)], neck: [-2, -8, 0] }) },
  point: { label: 'Point', f: () => ({ rSh: [84, 6, 0], rEl: [4], neck: [0, -10, 0], spine: [2, -8, 0] }) },
  talk: { label: 'Talk', anim: true, cadence: 0.7, f: ph => {
    const s = Math.sin(ph), s2 = Math.sin(ph * 1.37 + 1);
    return { lSh: [16 + 7 * s, 12], rSh: [16 + 7 * s2, 12], lEl: [72 + 16 * s2], rEl: [72 + 16 * s], spine: [3, 4 * Math.sin(ph * 0.5), 0], neck: [3 * Math.sin(ph * 0.8), 6 * Math.sin(ph * 0.45), 0] };
  } },
  cheer: { label: 'Cheer', anim: true, cadence: 1.3, f: ph => ({ lSh: [0, 160 + 10 * Math.sin(ph)], rSh: [0, 160 + 10 * Math.sin(ph + 0.5)], lEl: [14], rEl: [14], neck: [-12, 0, 0], spine: [-4, 0, 0] }) },
  phone: { label: 'On phone', f: () => ({ rSh: [24, 18, 0], rEl: [140, 0], neck: [6, 12, 0], lSh: [3, 7], lEl: [12] }) },
  arms: { label: 'Arms out', f: () => ({ lSh: [0, 88], rSh: [0, 88], lEl: [0], rEl: [0] }) },
  look: { label: 'Look around', anim: true, cadence: 0.25, f: ph => ({ neck: [-4, 55 * Math.sin(ph), 0], spine: [2, 14 * Math.sin(ph), 0] }) },
};
function fullPose(p) { const o = clone(STAND); for (const k in p) o[k] = p[k]; return o; }
function mixPose(a, b, w) {
  const o = {};
  for (const k in a) {
    if (Array.isArray(a[k])) { const bb = arr(b[k]); o[k] = a[k].map((v, i) => lerp(v, bb[i] ?? 0, w)); if (bb.length > a[k].length) o[k] = bb.map((v, i) => lerp(a[k][i] ?? 0, v, w)); }
    else o[k] = lerp(a[k], b[k], w);
  }
  return o;
}
const _v = new THREE.Vector3(), _m = new THREE.Matrix4();
function personMotion(o, t) {
  const res = { yaw: null, speed: 0, dist: null, moving: false };
  if (o.keys.length < 2) return res;
  const k0 = o.keys[0].t, k1 = o.keys[o.keys.length - 1].t;
  if (k1 - k0 < 1e-3) return res;
  let path = 0; for (let i = 1; i < o.keys.length; i++) path += Math.hypot(o.keys[i].p[0] - o.keys[i - 1].p[0], o.keys[i].p[2] - o.keys[i - 1].p[2]);
  if (path < 0.05) return res;
  res.moving = true;
  const pos = tt => evalObj(o, tt).p;
  const ta = clamp(t - 0.05, k0, k1), tb = clamp(t + 0.05, k0, k1);
  const a = pos(ta), b = pos(tb);
  let dx = b[0] - a[0], dz = b[2] - a[2];
  res.speed = tb > ta ? Math.hypot(dx, dz) / (tb - ta) : 0;
  if (o.opts.faceTravel) {
    if (Math.hypot(dx, dz) < 1e-4) {
      const tt = clamp(t, k0, k1);
      const a2 = pos(clamp(tt - 0.3, k0, k1)), b2 = pos(clamp(tt + 0.3, k0, k1));
      dx = b2[0] - a2[0]; dz = b2[2] - a2[2];
    }
    if (Math.hypot(dx, dz) > 1e-5) res.yaw = Math.atan2(dx, dz);
  }
  const tc = clamp(t, k0, k1), dt = 1 / 40;
  let d = 0, prev = pos(k0);
  for (let tt = k0 + dt; tt < tc; tt += dt) { const q = pos(tt); d += Math.hypot(q[0] - prev[0], q[2] - prev[2]); prev = q; }
  const q = pos(tc); d += Math.hypot(q[0] - prev[0], q[2] - prev[2]);
  res.dist = d;
  return res;
}
function posePerson(P, o, t, info) {
  const def = POSES[o.opts.pose] || POSES.stand;
  let ph, w = 1;
  if (def.loco && info.moving) {
    ph = info.dist / (def.stride * P.H / 1.75) * Math.PI * 2;
    w = clamp(info.speed / def.minSpeed, 0, 1);
  } else ph = t * (def.cadence || 1) * (o.opts.speed || 1) * Math.PI * 2;
  let a = fullPose(def.f(ph));
  if (w < 1) a = mixPose(fullPose({}), a, w);
  const R = (j, x, y, z) => j.rotation.set(x * D2R, y * D2R, z * D2R);
  R(P.spine, a.spine[0], a.spine[1] || 0, a.spine[2] || 0);
  R(P.neck, a.neck[0], a.neck[1] || 0, a.neck[2] || 0);
  R(P.lSh, -a.lSh[0], a.lSh[2] || 0, a.lSh[1] || 0);
  R(P.rSh, -a.rSh[0], -(a.rSh[2] || 0), -(a.rSh[1] || 0));
  R(P.lEl, -a.lEl[0], 0, a.lEl[1] || 0);
  R(P.rEl, -a.rEl[0], 0, -(a.rEl[1] || 0));
  R(P.lHip, -a.lHip[0], 0, a.lHip[1] || 0);
  R(P.rHip, -a.rHip[0], 0, -(a.rHip[1] || 0));
  R(P.lKnee, a.lKnee, 0, 0); R(P.rKnee, a.rKnee, 0, 0);
  const fl = a.flat ?? 1;
  R(P.lAnk, (a.lHip[0] - a.lKnee) * fl, 0, 0); R(P.rAnk, (a.rHip[0] - a.rKnee) * fl, 0, 0);
  // keep feet on the ground
  P.pelvis.position.y = 0.52 * P.H;
  P.root.updateWorldMatrix(true, true);
  _m.copy(P.root.matrixWorld).invert();
  let minY = Infinity;
  for (const s of P.soles) { _v.setFromMatrixPosition(s.matrixWorld).applyMatrix4(_m); minY = Math.min(minY, _v.y); }
  if (isFinite(minY)) P.pelvis.position.y -= minY;
}

/* ============================== scene sync ============================== */
const views = new Map();
function disposeTree(root) {
  root.traverse(m => {
    if (!m.isMesh || m.userData.shared) return;
    m.geometry && m.geometry.dispose();
    for (const mt of arr(m.material)) { if (mt) { mt.map && mt.map.dispose(); mt.dispose(); } }
  });
}
function buildVisual(o) {
  const res = o.type === 'person' ? buildPerson(o) : (BUILD[o.type] || BUILD.box)(o);
  res.root.traverse(m => { if (m.isMesh) { m.castShadow = !res.isMark; m.receiveShadow = !res.isMark; } });
  if (res.aimY == null) { res.root.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(res.root); res.aimY = isFinite(bb.max.y) ? (bb.min.y + bb.max.y) / 2 : 0.5; }
  return res;
}
function syncScene() {
  const ids = new Set(state.objects.map(o => o.id));
  for (const [id, v] of views) if (!ids.has(id)) { scene.remove(v.group); disposeTree(v.group); views.delete(id); }
  for (const o of state.objects) {
    let v = views.get(o.id);
    const sig = JSON.stringify([o.type, o.color, o.opts.height, o.opts.skin, o.opts.pants, o.opts.hair, o.opts.unlit, o.opts.aspect, o.asset, !!(o.asset && assets[o.asset]), o.opts.letter]);
    if (!v) { const g = new THREE.Group(); g.userData.objId = o.id; g.rotation.order = 'YXZ'; scene.add(g); v = { group: g, sig: null }; views.set(o.id, v); }
    if (v.sig !== sig) {
      for (const c of [...v.group.children]) { v.group.remove(c); disposeTree(c); }
      const b = buildVisual(o);
      v.group.add(b.root); v.person = b.person || null; v.aimY = b.aimY; v.isMark = !!b.isMark; v.sig = sig;
    }
    v.group.visible = o.visible !== false;
  }
  pruneModelCache();
}

/* ============================== animation apply ============================== */
let camState = evalCam(0);
let pilotActive = false;
function applyAll(t) {
  for (const o of state.objects) {
    const v = views.get(o.id); if (!v) continue;
    const tr = evalObj(o, t), g = v.group;
    g.position.fromArray(tr.p);
    g.rotation.set(tr.r[0] * D2R, tr.r[1] * D2R, tr.r[2] * D2R, 'YXZ');
    g.scale.fromArray(tr.s);
    if (v.person || o.opts.faceTravel) {
      const info = personMotion(o, t);
      if (info.yaw != null) g.rotation.y = info.yaw;
      if (v.person) posePerson(v.person, o, t, info);
    }
  }
  const c = evalCam(t);
  if (!pilotActive) {
    shotCam.position.fromArray(c.p); shotCam.up.set(0, 1, 0); shotCam.lookAt(c.tg[0], c.tg[1], c.tg[2]);
    camControls.target.fromArray(c.tg);
    camState = c;
  } else {
    camState = { p: shotCam.position.toArray(), tg: camControls.target.toArray(), f: rec ? rec.f : c.f, roll: c.roll, fd: c.fd };
  }
  shotCam.aspect = arOf(state.settings.aspect); shotCam.filmGauge = 36; shotCam.setFocalLength(camState.f);
}
function noise(t, s) { return Math.sin(t * 1.7 + s) * 0.5 + Math.sin(t * 3.13 + s * 2.1) * 0.3 + Math.sin(t * 7.37 + s * 3.7) * 0.2; }
function prepRenderCam(t) {
  renderCam.copy(shotCam);
  const k = state.camera.shake || 0;
  if (k > 0) {
    renderCam.translateX(noise(t, 1) * 0.02 * k); renderCam.translateY(noise(t, 2) * 0.015 * k);
    renderCam.rotateY(noise(t, 3) * 0.014 * k); renderCam.rotateX(noise(t, 4) * 0.011 * k);
  }
  renderCam.rotateZ((camState.roll || 0) * D2R + (k > 0 ? noise(t, 5) * 0.006 * k : 0));
  renderCam.aspect = arOf(state.settings.aspect); renderCam.filmGauge = 36; renderCam.setFocalLength(camState.f);
  renderCam.updateMatrixWorld(true);
}

/* ============================== helpers (editor-only visuals) ============================== */
const helpers = new THREE.Group(); scene.add(helpers);
const camRig = new THREE.Group(); helpers.add(camRig);
const camBody = new THREE.Group(); camBody.userData.pick = 'camera'; camRig.add(camBody);
const camMat = new THREE.MeshBasicMaterial({ color: 0xff9a3c });
camBody.add(mk(BOX(0.22, 0.17, 0.3), camMat, 0, 0, 0.17));
const lens = mk(new THREE.CylinderGeometry(0.06, 0.075, 0.1, 16), new THREE.MeshBasicMaterial({ color: 0x222222 }), 0, 0, -0.02); lens.rotation.x = Math.PI / 2; camBody.add(lens);
for (const z of [0.1, 0.25]) { const r = mk(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 16), camMat, 0, 0.14, z); r.rotation.z = Math.PI / 2; camBody.add(r); }
const frustGeo = new THREE.BufferGeometry(); frustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3 * 2), 3));
const frust = new THREE.LineSegments(frustGeo, new THREE.LineBasicMaterial({ color: 0xffb870 })); camRig.add(frust);
const targetMarker = mk(new THREE.SphereGeometry(0.07, 16, 10), new THREE.MeshBasicMaterial({ color: 0xff9a3c, depthTest: false, transparent: true, opacity: 0.85 }));
targetMarker.userData.pick = 'target'; targetMarker.renderOrder = 10; helpers.add(targetMarker);
const aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xff9a3c, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.6 }));
helpers.add(aimLine);
function makePath(color) {
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  const pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false }));
  helpers.add(line, pts); return { line, pts };
}
const camPath = makePath(0xffcf5a), objPath = makePath(0x7fc4ff);
const selBox = new THREE.BoxHelper(undefined, 0xff9a3c); selBox.visible = false; helpers.add(selBox);
const camProxy = new THREE.Object3D(), tgtProxy = new THREE.Object3D(); scene.add(camProxy, tgtProxy);
const ringGrp = new THREE.Group(); ringGrp.visible = false; helpers.add(ringGrp);
const ringVis = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 8, 80), new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.95, depthTest: false }));
ringVis.rotation.x = -Math.PI / 2; ringVis.renderOrder = 5;
const ringPick = new THREE.Mesh(new THREE.TorusGeometry(1, 0.13, 6, 48), new THREE.MeshBasicMaterial({ visible: false }));
ringPick.rotation.x = -Math.PI / 2; ringPick.userData.pick = 'ring';
const ringKnob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffd2a3, depthTest: false }));
ringKnob.renderOrder = 6; ringKnob.userData.pick = 'ring';
ringGrp.add(ringVis, ringPick, ringKnob);
const arrowGeo = (() => { const sh = new THREE.Shape(); sh.moveTo(0, 0.62); sh.lineTo(-0.17, 0.36); sh.lineTo(0.17, 0.36); sh.lineTo(0, 0.62); const g = new THREE.ShapeGeometry(sh); g.rotateX(Math.PI / 2); return g; })();
const arrowMat = new THREE.MeshBasicMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
const arrows = new Map();
const pathPrev = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x7fc4ff, dashSize: 0.25, gapSize: 0.12, depthTest: false }));
const pathPrevPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false, depthTest: false }));
pathPrev.renderOrder = pathPrevPts.renderOrder = 7; helpers.add(pathPrev, pathPrevPts);
const _bb = new THREE.Box3();

let pathRev = -1;
function setPath(path, points, keyPoints) {
  path.line.geometry.dispose(); path.pts.geometry.dispose();
  path.line.geometry = new THREE.BufferGeometry().setFromPoints(points);
  path.pts.geometry = new THREE.BufferGeometry().setFromPoints(keyPoints);
  path.line.visible = path.pts.visible = points.length > 1;
}
function updatePaths() {
  if (pathRev === editRev) return; pathRev = editRev;
  const N = 140, L = lastT();
  const c = state.camera;
  if (c.keys.length > 1 || (c.follow && subject())) {
    const pts = []; for (let i = 0; i <= N; i++) pts.push(new THREE.Vector3().fromArray(evalCam(i / N * L).p));
    setPath(camPath, pts, c.keys.map(k => new THREE.Vector3().fromArray(evalCam(k.t).p)));
  } else setPath(camPath, [], []);
  const o = selected && getObj(selected);
  if (o && o.keys.length > 1) {
    const pts = []; for (let i = 0; i <= N; i++) { const p = evalObj(o, i / N * L).p; pts.push(new THREE.Vector3(p[0], p[1] + 0.03, p[2])); }
    setPath(objPath, pts, o.keys.map(k => new THREE.Vector3(k.p[0], k.p[1] + 0.03, k.p[2])));
  } else setPath(objPath, [], []);
}
function updateHelpers() {
  prepRenderCam(T);
  camRig.position.copy(renderCam.position); camRig.quaternion.copy(renderCam.quaternion);
  const d = 1.1, hh = Math.tan(renderCam.fov * D2R / 2) * d, hw = hh * renderCam.aspect;
  const P = [[0, 0, 0], [-hw, -hh, -d], [0, 0, 0], [hw, -hh, -d], [0, 0, 0], [hw, hh, -d], [0, 0, 0], [-hw, hh, -d],
    [-hw, -hh, -d], [hw, -hh, -d], [hw, -hh, -d], [hw, hh, -d], [hw, hh, -d], [-hw, hh, -d], [-hw, hh, -d], [-hw, -hh, -d],
    [-hw * 0.35, hh * 1.08, -d], [hw * 0.35, hh * 1.08, -d], [hw * 0.35, hh * 1.08, -d], [0, hh * 1.4, -d], [0, hh * 1.4, -d], [-hw * 0.35, hh * 1.08, -d]];
  if (ensureDof().on) {
    const fd = Math.min(80, focusDist(camState)), fh = Math.tan(renderCam.fov * D2R / 2) * fd, fw = fh * renderCam.aspect;
    P.push([-fw, -fh, -fd], [fw, -fh, -fd], [fw, -fh, -fd], [fw, fh, -fd], [fw, fh, -fd], [-fw, fh, -fd], [-fw, fh, -fd], [-fw, -fh, -fd], [-fw, 0, -fd], [fw, 0, -fd], [0, -fh, -fd], [0, fh, -fd]);
  }
  const a = frustGeo.attributes.position;
  if (a.count < P.length) frustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P.length * 3), 3));
  const pa = frustGeo.attributes.position; P.forEach((p, i) => pa.setXYZ(i, p[0], p[1], p[2])); pa.needsUpdate = true; frustGeo.setDrawRange(0, P.length);
  targetMarker.position.fromArray(camState.tg);
  targetMarker.visible = !subject();
  const lp = aimLine.geometry.attributes.position, cp = camState.p, ct = camState.tg, F = Math.fround;
  if (lp.getX(0) !== F(cp[0]) || lp.getY(0) !== F(cp[1]) || lp.getZ(0) !== F(cp[2]) || lp.getX(1) !== F(ct[0]) || lp.getY(1) !== F(ct[1]) || lp.getZ(1) !== F(ct[2])) {
    lp.setXYZ(0, ...cp); lp.setXYZ(1, ...ct); lp.needsUpdate = true; aimLine.computeLineDistances(); /* only when the aim line moved (P6) */
  }
  if (!gizmo.dragging) { camProxy.position.fromArray(camState.p); tgtProxy.position.fromArray(camState.tg); }
  const v = selected && views.get(selected);
  if (v && v.group.visible) { selBox.setFromObject(v.group); selBox.visible = true; } else selBox.visible = false;
  // turn ring around the selected object
  if (v && v.group.visible && view !== 'camera' && !v.isMark) {
    _bb.setFromObject(v.group);
    const r = Math.max(0.45, Math.max(_bb.max.x - _bb.min.x, _bb.max.z - _bb.min.z) / 2 + 0.25);
    ringGrp.visible = true; ringGrp.position.set(v.group.position.x, _bb.min.y + 0.03, v.group.position.z); ringGrp.scale.setScalar(r);
    const yaw = v.group.rotation.y; ringKnob.position.set(Math.sin(yaw), 0, Math.cos(yaw)); ringKnob.scale.setScalar(1 / r);
  } else ringGrp.visible = false;
  // facing arrows under people
  const seen = new Set();
  for (const o of state.objects) {
    const vv = views.get(o.id); if (!vv || !vv.person) continue;
    seen.add(o.id);
    let a = arrows.get(o.id); if (!a) { a = new THREE.Mesh(arrowGeo, arrowMat); a.renderOrder = 3; helpers.add(a); arrows.set(o.id, a); }
    a.visible = vv.group.visible; a.position.set(vv.group.position.x, vv.group.position.y + 0.02, vv.group.position.z); a.rotation.y = vv.group.rotation.y;
    const sc = (o.opts.height || 1.75) / 1.75 * vv.group.scale.x; a.scale.setScalar(sc);
  }
  for (const [id, a] of arrows) if (!seen.has(id)) { helpers.remove(a); arrows.delete(id); }
  // path drawing preview
  if (pathMode) {
    const pts = pathMode.pts.map(q => new THREE.Vector3(q[0], pathMode.y + 0.03, q[1]));
    const all = pathMode.cursor ? [...pts, new THREE.Vector3(pathMode.cursor[0], pathMode.y + 0.03, pathMode.cursor[1])] : pts;
    pathPrev.geometry.dispose(); pathPrev.geometry = new THREE.BufferGeometry().setFromPoints(all.length > 1 ? all : [all[0], all[0]]); pathPrev.computeLineDistances();
    pathPrevPts.geometry.dispose(); pathPrevPts.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    pathPrev.visible = pathPrevPts.visible = true;
  } else pathPrev.visible = pathPrevPts.visible = false;
  updatePaths();
  // shadows follow the action
  const az = state.settings.sunAz * D2R, el = state.settings.sunEl * D2R;
  const c = new THREE.Vector3(camState.tg[0], 0, camState.tg[2]);
  sun.target.position.copy(c);
  sun.position.set(c.x + Math.cos(el) * Math.sin(az) * 60, Math.sin(el) * 60, c.z + Math.cos(el) * Math.cos(az) * 60);
}

/* ---- gizmo ---- */
const gizmo = new TransformControls(edCam, canvas);
gizmo.setSize(0.9);
const gizmoHelper = gizmo.getHelper(); scene.add(gizmoHelper);
let gizmoMode = 'translate', snapOn = false, gizmoUsed = false;
gizmo.addEventListener('dragging-changed', e => {
  edControls.enabled = !e.value;
  if (e.value) { gizmoUsed = true; if (playing) setPlaying(false); }
  else { changed(true, false); }
});
gizmo.addEventListener('mouseDown', () => { gizmoUsed = true; });
gizmo.addEventListener('objectChange', () => {
  if (selected === 'camera') writeCam({ p: camProxy.position.toArray() }, false);
  else if (selected === 'target') writeCam({ tg: tgtProxy.position.toArray() }, false);
  else {
    const o = getObj(selected), v = views.get(selected); if (!o || !v) return;
    const g = v.group, cur = clone(evalObj(o, T));
    if (gizmo.mode === 'translate') cur.p = g.position.toArray();
    else if (gizmo.mode === 'rotate') cur.r = [g.rotation.x * R2D, g.rotation.y * R2D, g.rotation.z * R2D];
    else cur.s = g.scale.toArray().map(s => Math.max(0.01, s));
    writeObj(o, cur, false);
  }
});
function setGizmoMode(m) { gizmoMode = m; updateGizmo(); $$('#vpTools [data-g]').forEach(b => b.classList.toggle('on', b.dataset.g === m)); }
function updateGizmo() {
  gizmo.detach();
  gizmo.camera = view === 'top' ? topCam : edCam;
  if (view === 'camera' || !selected) return;
  if (selected === 'camera') { gizmo.attach(camProxy); gizmo.setMode('translate'); }
  else if (selected === 'target') { if (!subject()) { gizmo.attach(tgtProxy); gizmo.setMode('translate'); } }
  else if (!simple) { const v = views.get(selected); if (v && v.group.visible) { gizmo.attach(v.group); gizmo.setMode(gizmoMode); } }
  gizmo.setTranslationSnap(snapOn ? 0.25 : null); gizmo.setRotationSnap(snapOn ? 15 * D2R : null); gizmo.setScaleSnap(snapOn ? 0.1 : null);
}

/* ---- writers ---- */
/* a drag's in-between writes redraw the view but don't rebuild the outliner and timeline, unless a key was added (P2) */
function quietChange(commit, keysChanged) { if (commit || keysChanged) changed(commit); else editRev++; }
function writeObj(o, tr, commit) {
  const nk = o.keys.length;
  tr = { p: tr.p.map(r4), r: tr.r.map(r4), s: tr.s.map(r4) };
  if (o.keys.length) {
    const ref = neighborKey(o.keys, T);
    if (ref) tr.r = tr.r.map((v, j) => r4(unwrap(v, ref.r[j])));
    setKey(o.keys, T, tr);
  } else o.base = tr;
  quietChange(commit, o.keys.length !== nk);
}
function writeCam(fields, commit) {
  const c = state.camera, cur = clone(evalCamRaw(T));
  if (fields.p) { const off = followOffset(T); cur.p = fields.p.map((v, i) => r4(v - off[i])); }
  if (fields.tg && !subject()) cur.tg = fields.tg.map(r4);
  if (fields.f != null) cur.f = r4(fields.f);
  if (fields.roll != null) cur.roll = r4(fields.roll);
  if (fields.fd != null) { cur.fd = r4(Math.max(0.05, fields.fd)); for (const k of c.keys) if (typeof k.fd !== 'number') k.fd = r4(dist3(k.p, k.tg)); }
  const nk = c.keys.length;
  if (c.keys.length) setKey(c.keys, T, cur); else c.base = cur;
  quietChange(commit, c.keys.length !== nk);
}

/* ============================== drawing ============================== */
let vw = 0, vh = 0;
const vpEl = $('#vp');
function camRect(w, hh) {
  const ar = arOf(state.settings.aspect), m = 28;
  let rw = w - 2 * m, rh = rw / ar;
  if (rh > hh - 2 * m - 20) { rh = hh - 2 * m - 20; rw = rh * ar; }
  return { x: Math.round((w - rw) / 2), y: Math.round((hh - rh) / 2 + 8), w: Math.round(rw), h: Math.round(rh) };
}
function pipRect(w, hh) {
  const ar = arOf(state.settings.aspect);
  let pw = Math.min(330, w * 0.32), ph = pw / ar;
  if (ph > hh * 0.42) { ph = hh * 0.42; pw = ph * ar; }
  return { x: Math.round(w - pw - 12), y: Math.round(hh - ph - 12), w: Math.round(pw), h: Math.round(ph) };
}
let depthCache = { v: -1, near: 0.5, far: 25 };
function depthRange() {
  const s = state.settings;
  if (!s.depthAuto) return { near: s.depthNear, far: Math.max(s.depthNear + 0.1, s.depthFar) };
  if (depthCache.v === editRev) return depthCache;
  let mn = Infinity, mx = 0; const bb = new THREE.Box3(), cp = new THREE.Vector3(), pt = new THREE.Vector3();
  const saveT = T;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8 * lastT(); applyAll(t); const c = evalCam(t); cp.fromArray(c.p);
    const fwd = new THREE.Vector3().fromArray(c.tg).sub(cp).normalize();
    for (const v of views.values()) {
      if (!v.group.visible || v.isMark) continue;
      bb.setFromObject(v.group); if (bb.isEmpty()) continue;
      for (let k = 0; k < 8; k++) {
        pt.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z);
        const z = pt.sub(cp).dot(fwd); if (z > 0.05) { mn = Math.min(mn, z); mx = Math.max(mx, z); }
      }
    }
  }
  applyAll(saveT);
  if (!isFinite(mn)) { mn = 0.5; mx = 20; }
  depthCache = { v: editRev, near: r4(Math.max(0.05, mn * 0.85)), far: r4(Math.max(mn + 1, mx * 1.08)) };
  return depthCache;
}
/* ---- location photo (background plate) ---- */
let plateTex = null, plateKey = null, plateURL = null, plateBusy = null, exportingRender = false;
const shadowMat = new THREE.ShadowMaterial({ opacity: 0.38 });
function plateAsset() { const pl = state.plate; return pl && assets[pl.asset] ? assets[pl.asset] : null; }
// Decodes an image without object URLs (they can be blocked inside sandboxed viewers) and scales it down.
async function decodeToCanvas(blob, maxSide = 2560) {
  let src = null;
  try { src = await createImageBitmap(blob); } catch (e) { src = null; }
  if (!src) {
    const url = 'data:' + (blob.type || 'image/jpeg') + ';base64,' + bufToB64(await blob.arrayBuffer());
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('decode')); im.src = url; });
  }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error('decode');
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  return c;
}
function ensurePlate() {
  const a = plateAsset(), key = a ? state.plate.asset : null;
  if (key === plateKey || key === plateBusy) return;
  if (plateTex) { plateTex.dispose(); plateTex = null; }
  plateURL = null; plateKey = null;
  $$('.plateImg').forEach(i => { i.removeAttribute('src'); });
  if (!a) { plateKey = null; return; }
  plateBusy = key;
  const url = assetURL(key);
  decodeToCanvas(new Blob([b64ToBuf(a.b64)], { type: a.mime })).then(c => {
    if (plateBusy !== key) return;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    plateTex = tex; plateURL = url; plateKey = key; plateBusy = null;
    $$('.plateImg').forEach(i => { i.src = url; });
    requestRender();
  }).catch(() => { plateBusy = null; plateKey = key; requestRender(); toast('Could not read the location photo'); });
}
function plateActive(style) {
  const pl = state.plate;
  return !!(pl && plateTex && plateTex.image && plateTex.image.width && (style === 'shaded' || style === 'clay') && (!exportingRender || pl.export !== false));
}
function fitPlate() {
  const img = plateTex.image, ia = img.width / img.height, fa = arOf(state.settings.aspect);
  if (ia > fa) { plateTex.repeat.set(fa / ia, 1); plateTex.offset.set((1 - fa / ia) / 2, 0); }
  else { plateTex.repeat.set(1, ia / fa); plateTex.offset.set(0, (1 - ia / fa) / 2); }
  plateTex.updateMatrix();
}
function withShotStyle(style, fn) {
  const bg = scene.background, fog = scene.fog, gv = gizmoHelper.visible;
  helpers.visible = false; gizmoHelper.visible = false;
  const marks = [...views.values()].filter(v => v.isMark && v.group.visible); marks.forEach(v => { v.group.visible = false; }); grid.visible = state.settings.exportGrid;
  if (style === 'clay') { scene.overrideMaterial = clayMat; scene.background = clayBg; scene.fog = null; }
  else if (style === 'depth') { const r = depthRange(); depthMat.uniforms.uNear.value = r.near; depthMat.uniforms.uFar.value = r.far; scene.overrideMaterial = depthMat; scene.background = black; scene.fog = null; }
  else if (style === 'normal') { scene.overrideMaterial = normalMat; scene.background = normalBg; scene.fog = null; }
  const usePlate = plateActive(style), gMat = ground.material, gVis = ground.visible;
  if (usePlate) {
    fitPlate(); scene.background = plateTex; scene.fog = null;
    const gm = state.plate.ground || 'shadow';
    if (gm === 'shadow') { ground.material = shadowMat; ground.visible = true; } else if (gm === 'hide') ground.visible = false;
  }
  try { fn(); } finally {
    ground.material = gMat; ground.visible = gVis;
    scene.overrideMaterial = null; scene.background = bg; scene.fog = fog;
    marks.forEach(v => { v.group.visible = true; });
    helpers.visible = true; gizmoHelper.visible = gv; grid.visible = state.settings.gridOn;
  }
}
function renderShotInto(rd, r, H) {
  rd.setViewport(r.x, H - r.y - r.h, r.w, r.h); rd.setScissor(r.x, H - r.y - r.h, r.w, r.h); rd.setScissorTest(true);
  const pr = rd.getPixelRatio();
  shotPass(rd, r.w * pr, r.h * pr);
  rd.setScissorTest(false);
}
function place(el, r) { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; }
/* test/perf hooks (see __shotref.renderStats) */
let drawCount = 0, lastDraw = 0, lastAsync = 0, rebuilds = 0;
function draw() {
  drawCount++; lastDraw = performance.now();
  const w = vpEl.clientWidth, hh = vpEl.clientHeight;
  if (w !== vw || hh !== vh) { vw = w; vh = hh; renderer.setSize(w, hh, false); }
  if (!w || !hh) return;
  renderer.setScissorTest(false);
  const pip = $('#pipFrame'), cf = $('#camFrame');
  if (view === 'editor') {
    edCam.aspect = w / hh; edCam.updateProjectionMatrix();
    renderer.setViewport(0, 0, w, hh);
    camRig.visible = true;
    renderer.render(scene, edCam);
    if (pipOn) { const r = pipRect(w, hh); renderShotInto(renderer, r, hh); place(pip, r); pip.style.display = 'block'; } else pip.style.display = 'none';
    cf.style.display = 'none';
  } else if (view === 'top') {
    const half = 5.5; topCam.left = -half * w / hh; topCam.right = half * w / hh; topCam.top = half; topCam.bottom = -half; topCam.updateProjectionMatrix();
    renderer.setViewport(0, 0, w, hh);
    const gv = grid.visible; grid.visible = true;
    renderer.render(scene, topCam);
    grid.visible = gv;
    if (pipOn) { const r = pipRect(w, hh); renderShotInto(renderer, r, hh); place(pip, r); pip.style.display = 'block'; } else pip.style.display = 'none';
    cf.style.display = 'none';
  } else {
    renderer.setViewport(0, 0, w, hh); renderer.setClearColor(0x0e0f11, 1); renderer.clear();
    const r = camRect(w, hh); renderShotInto(renderer, r, hh); place(cf, r); cf.style.display = 'block'; pip.style.display = 'none';
  }
}
function drawGuides() {
  const g = state.settings.guides, s = $('#guides');
  const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,.35)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  let out = '';
  if (g === 'thirds') out = L(33.33, 0, 33.33, 100) + L(66.66, 0, 66.66, 100) + L(0, 33.33, 100, 33.33) + L(0, 66.66, 100, 66.66);
  else if (g === 'center') out = L(47, 50, 53, 50) + L(50, 46, 50, 54);
  else if (g === 'safe') out = `<rect x="5" y="5" width="90" height="90" fill="none" stroke="rgba(255,255,255,.35)" vector-effect="non-scaling-stroke" stroke-dasharray="4 4"/><rect x="10" y="10" width="80" height="80" fill="none" stroke="rgba(255,255,255,.25)" vector-effect="non-scaling-stroke"/>`;
  s.innerHTML = out;
}

/* ============================== main loop ============================== */
let lastNow = performance.now();
const flyKeys = new Set();
function fly(dt) {
  if (view !== 'camera' || !flyKeys.size) return;
  const sp = (flyKeys.has('shift') ? 6 : 2) * dt;
  const fwd = new THREE.Vector3(); shotCam.getWorldDirection(fwd);
  const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize(), right = new THREE.Vector3().crossVectors(flat, new THREE.Vector3(0, 1, 0)).normalize();
  const mv = new THREE.Vector3();
  if (flyKeys.has('w')) mv.add(fwd); if (flyKeys.has('s')) mv.sub(fwd);
  if (flyKeys.has('d')) mv.add(right); if (flyKeys.has('a')) mv.sub(right);
  if (flyKeys.has('e')) mv.y += 1; if (flyKeys.has('q')) mv.y -= 1;
  if (mv.lengthSq() === 0) return;
  mv.normalize().multiplyScalar(sp);
  pilotActive = true;
  shotCam.position.add(mv); camControls.target.add(mv);
  if (!rec) writeCam({ p: shotCam.position.toArray(), tg: camControls.target.toArray() }, false);
}
/* ---- render on demand (P1): draw only when something that is drawn may have changed ---- */
let needsRender = true, keepAlive = 0, lastSig = '', wasExporting = false;
/* async work (model, photo, image, restored files) finished: draw the next frame */
function requestRender() { needsRender = true; lastAsync = performance.now(); }
/* pointer, wheel and key events keep drawing for a few frames (gizmo hover, controls) */
function pokeRender() { keepAlive = 20; }
function frameSig() {
  const e = edCam.position, q = edCam.quaternion, tp = topCam.position, pm = pathMode;
  return [editRev, T, view, selected, playing, rec ? rec.phase : '', pipOn, simple, vpEl.clientWidth, vpEl.clientHeight, window.devicePixelRatio,
    gizmo.dragging, gizmo.axis, e.x, e.y, e.z, q.x, q.y, q.z, q.w, edCam.zoom, tp.x, tp.y, tp.z, topCam.zoom,
    plateKey, plateBusy, placing, focusPick, hi, hist.length, pm ? pm.pts.length + ':' + pm.cursor : ''].join('|');
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
  if (exporting) { wasExporting = true; return; } // the export owns the scene and the renderers until it finishes
  if (wasExporting) { wasExporting = false; needsRender = true; }
  if (rec && rec.phase === 'count') { const left = Math.ceil((rec.until - now) / 1000); $('#countdown').textContent = left > 0 ? left : ''; if (now >= rec.until) { rec.phase = 'rec'; setTime(0, false); setPlaying(true); $('#countdown').textContent = ''; recSample(); showModeBar('● Recording. Steer the camera until the shot ends.', [['Cancel', cancelRecord]]); } }
  if (playing) {
    setTime(T + dt, false);
    if (rec && rec.phase === 'rec' && T >= lastT()) { setTime(lastT(), false); recSample(); finishRecord(); }
    else if (T > lastT()) { if (state.settings.loop) setTime(0, false); else { setTime(lastT(), false); setPlaying(false); } }
  }
  fly(dt);
  let moving = false;
  if (view === 'editor') moving = edControls.update(); /* true while damping still moves the view */
  if (view === 'top') moving = topControls.update();
  const sig = frameSig();
  const go = needsRender || moving || keepAlive > 0 || playing || !!rec || flyKeys.size > 0 || uiDirty || propsDirty || sig !== lastSig;
  if (keepAlive > 0) keepAlive--;
  if (go) {
    needsRender = false; lastSig = sig;
    applyAll(T);
    if (rec && rec.phase === 'rec') recSample();
    updateHelpers();
    renderer.shadowMap.needsUpdate = true;
    draw();
  }
  if (uiDirty) { uiDirty = false; rebuilds++; renderOutliner(); renderTimeline(); }
  if (propsDirty) { propsDirty = false; renderProps(); }
  if (go) tickUI();
}

/* ============================== camera moves ============================== */
const MOVES = [
  ['static', '■', 'Static'], ['dollyIn', '↑', 'Dolly in'], ['dollyOut', '↓', 'Dolly out'], ['orbitL', '↺', 'Orbit left'], ['orbitR', '↻', 'Orbit right'],
  ['truckL', '←', 'Truck left'], ['truckR', '→', 'Truck right'], ['craneUp', '⤒', 'Crane up'], ['craneDown', '⤓', 'Crane down'],
  ['panL', '⟲', 'Pan left'], ['panR', '⟳', 'Pan right'], ['tiltUp', '⌃', 'Tilt up'], ['tiltDown', '⌄', 'Tilt down'],
  ['zoomIn', '⊕', 'Zoom in'], ['dollyZoom', '◎', 'Dolly zoom'], ['arcPush', '↗', 'Arc + push'], ['droneRise', '✈', 'Drone rise'], ['reveal', '◐', 'Reveal (pull back)'],
];
let moveAmt = 1;
function applyMove(kind) {
  const a = moveAmt, c = state.camera, start = clone(evalCamRaw(T));
  const off = followOffset(T);
  const P = new THREE.Vector3().fromArray(start.p), G = new THREE.Vector3().fromArray(subject() ? aimPoint(subject(), T).map((v, i) => v - off[i]) : start.tg);
  const up = new THREE.Vector3(0, 1, 0);
  const D = Math.max(0.3, P.distanceTo(G));
  const fwd = G.clone().sub(P).normalize(), right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  let P2 = P.clone(), G2 = G.clone(), f2 = start.f;
  const rotAround = (pt, ctr, axis, ang) => pt.clone().sub(ctr).applyAxisAngle(axis, ang).add(ctr);
  switch (kind) {
    case 'dollyIn': P2.addScaledVector(fwd, Math.min(D - 0.3, D * 0.45 * a)); break;
    case 'dollyOut': P2.addScaledVector(fwd, -D * 0.6 * a); break;
    case 'truckL': P2.addScaledVector(right, -D * 0.5 * a); G2.addScaledVector(right, -D * 0.5 * a); break;
    case 'truckR': P2.addScaledVector(right, D * 0.5 * a); G2.addScaledVector(right, D * 0.5 * a); break;
    case 'orbitL': P2 = rotAround(P, G, up, -55 * D2R * a); break;
    case 'orbitR': P2 = rotAround(P, G, up, 55 * D2R * a); break;
    case 'craneUp': P2.y += 2.2 * a; break;
    case 'craneDown': P2.y = Math.max(0.15, P2.y - 1.3 * a); break;
    case 'panL': G2 = rotAround(G, P, up, 35 * D2R * a); break;
    case 'panR': G2 = rotAround(G, P, up, -35 * D2R * a); break;
    case 'tiltUp': G2 = rotAround(G, P, right, 22 * D2R * a); break;
    case 'tiltDown': G2 = rotAround(G, P, right, -22 * D2R * a); break;
    case 'zoomIn': f2 = clamp(start.f * Math.pow(2, a), 10, 300); break;
    case 'dollyZoom': { P2.addScaledVector(fwd, Math.min(D - 0.4, D * 0.5 * a)); f2 = clamp(start.f * P2.distanceTo(G) / D, 8, 300); break; }
    case 'arcPush': P2 = rotAround(P, G, up, 30 * D2R * a); P2.add(G.clone().sub(P2).multiplyScalar(0.3 * Math.min(a, 2))); break;
    case 'droneRise': P2.y += 6 * a; P2.addScaledVector(fwd, -3 * a); break;
    case 'reveal': P2.addScaledVector(fwd, -D * 1.2 * a); P2.y += 1.2 * a; break;
  }
  c.keys = [];
  if (kind === 'static') { c.base = start; changed(true, true); toast('Camera is now static'); return; }
  const tgStore = subject() ? start.tg : null;
  const k0 = { p: P.toArray().map(r4), tg: (tgStore || G.toArray()).map(r4), f: r4(start.f), roll: start.roll || 0, fd: r4(start.fd) };
  const k1 = { p: P2.toArray().map(r4), tg: (tgStore || G2.toArray()).map(r4), f: r4(f2), roll: start.roll || 0, fd: r4(start.fd) };
  const arcs = { orbitL: ['p', G, up, -55], orbitR: ['p', G, up, 55], panL: ['tg', P, up, 35], panR: ['tg', P, up, -35], tiltUp: ['tg', P, right, 22], tiltDown: ['tg', P, right, -22] };
  if (arcs[kind] || kind === 'arcPush') {
    const N = 5, ease = x => x; c.keys = [];
    for (let i = 0; i < N; i++) {
      const u = ease(i / (N - 1)), k = clone(k0);
      if (kind === 'arcPush') { const q = rotAround(P, G, up, 30 * D2R * a * u); q.add(G.clone().sub(q).multiplyScalar(0.3 * Math.min(a, 2) * u)); k.p = q.toArray().map(r4); }
      else { const [fld, ctr, ax, deg] = arcs[kind]; const src = fld === 'p' ? P : G; k[fld] = rotAround(src, ctr, ax, deg * D2R * a * u).toArray().map(r4); if (fld === 'tg' && tgStore) k.tg = tgStore.map(r4); }
      c.keys.push({ t: snapT(i / (N - 1) * lastT()), ...k });
    }
  } else c.keys = [{ t: 0, ...k0 }, { t: snapT(lastT()), ...k1 }];
  c.base = clone(k0);
  setTime(0);
  changed(true, true);
  toast((MOVES.find(m => m[0] === kind) || [, , kind])[2] + ' added. Press Space to play.');
}

/* ============================== UI: add panel & outliner ============================== */
function groundPointInView() {
  const cam = view === 'camera' ? shotCam : edCam;
  const target = view === 'camera' ? camControls.target : edControls.target;
  const p = new THREE.Vector3(target.x, 0, target.z);
  if (p.distanceTo(new THREE.Vector3(cam.position.x, 0, cam.position.z)) > 40) return [0, 0, 0];
  return [Math.round(p.x * 4) / 4, 0, Math.round(p.z * 4) / 4];
}
const SHIRTS = ['#3d6fd8', '#c0392b', '#2e8b57', '#d4a017', '#7d3c98', '#e67e22', '#16a085', '#555b66'];
function addObject(type, extra, place = false) {
  if (placing) commitPlacing();
  if (pathMode) cancelPath();
  const o = makeObject(type, groundPointInView(), extra);
  if (type === 'person') o.color = SHIRTS[persons().length % SHIRTS.length];
  if (type === 'mark') { o.opts.letter = nextMarkLetter(); o.name = 'Mark ' + o.opts.letter; }
  state.objects.push(o); syncScene(); select(o.id);
  if (place) { changed(false, true); startPlacing(o.id); } else { changed(true, true); toast(o.name + ' added'); }
  return o;
}
function buildAddPanel() {
  const area = $('#addArea'); area.innerHTML = '';
  const cats = { People: [], Shapes: [], Props: [], Import: [], Blocking: [] };
  for (const [k, c] of Object.entries(CATALOG)) cats[c.cat].push(k);
  area.append(h('div', { class: 'addgrid' },
    h('button', { class: 'tile big', title: 'Add a person, then click where they stand', onclick: () => addObject('person', null, true) }, h('span', { html: svgI('person') }), 'Add person'),
    h('button', { class: 'tile big', title: 'Floor mark (like tape on set). Not visible in the shot.', onclick: () => addObject('mark', null, true) }, h('span', { html: svgI('mark') }), 'Add floor mark')));
  for (const cat of ['Shapes', 'Props']) {
    area.append(h('div', { class: 'addcat' }, cat));
    area.append(h('div', { class: 'addgrid' }, cats[cat].map(k => h('button', { class: 'tile', title: 'Add ' + CATALOG[k].label.toLowerCase() + ', then click where it goes', onclick: () => addObject(k, null, true) }, h('span', { html: svgI(k) }), CATALOG[k].label))));
  }
  area.append(h('div', { class: 'addcat' }, 'Import'));
  area.append(h('div', { class: 'addgrid' },
    h('button', { class: 'tile', title: 'Import a photo or drawing as a flat card (backdrop, poster, reference)', onclick: () => $('#fImage').click() }, h('span', { html: svgI('image') }), 'Image'),
    h('button', { class: 'tile', title: 'Import a 3D model (.glb)', onclick: () => $('#fModel').click() }, h('span', { html: svgI('model') }), 'Model .glb'),
  ));
}
function iconFor(o) { return svgI(o.type); }
function renderOutliner() {
  const el = $('#outliner'), fid = focusedRowId(el); el.innerHTML = '';
  const row = (id, icon, name, nk, hidden, onEye) => h('div', { class: 'ol' + (selected === id ? ' sel' : '') + (hidden ? ' hid' : ''), tabindex: 0, 'data-id': id, onclick: () => select(id), onkeydown: rowKeys(id), ondblclick: () => { if (id !== 'camera') renameObj(id); } },
    h('span', { html: icon }), h('span', { class: 'nm' }, name), nk ? h('span', { class: 'kd', title: nk + ' keyframes' }, '◆' + nk) : null,
    onEye ? h('button', { class: 'eye', title: hidden ? 'Show' : 'Hide', onclick: e => { e.stopPropagation(); onEye(); } }, hidden ? '◌' : '●') : null);
  el.append(row('camera', svgI('camera'), 'Shot camera', state.camera.keys.length));
  for (const o of state.objects) el.append(row(o.id, iconFor(o), o.name, o.keys.length, o.visible === false, () => { o.visible = o.visible === false; syncScene(); updateGizmo(); changed(true); }));
  if (!state.objects.length) el.append(h('div', { class: 'note', style: 'padding:6px 8px' }, 'Nothing here yet. Add a person or an object above.'));
  refocusRow(el, fid);
}
/* list rows (outliner, timeline labels) are keyboard-reachable: Enter or Space selects (U4) */
function rowKeys(id) { return e => { if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); e.stopPropagation(); select(id); }; }
function focusedRowId(el) { const a = document.activeElement; return a && a !== el && el.contains(a) && a.dataset ? a.dataset.id || null : null; }
function refocusRow(el, id) { if (!id) return; const r = [...el.querySelectorAll('[data-id]')].find(x => x.dataset.id === id); if (r) r.focus(); }
function renameObj(id) {
  const o = getObj(id); if (!o) return;
  const rows = $$('#outliner .ol'); const idx = state.objects.indexOf(o) + 1; const r = rows[idx]; if (!r) return;
  const nm = r.querySelector('.nm');
  const inp = h('input', { type: 'text', value: o.name, style: 'width:100%;padding:1px 4px' });
  nm.replaceWith(inp); inp.focus(); inp.select();
  const done = () => { const v = inp.value.trim(); if (v) { o.name = v; changed(true, true); } else uiDirty = true; };
  inp.addEventListener('blur', done); inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = o.name; inp.blur(); } });
}
function select(id) {
  selected = id; updateGizmo(); uiDirty = true; propsDirty = true; pathRev = -1;
}

/* ============================== UI: property fields ============================== */
const live = []; // fields refreshed every frame
function numField(label, get, set, o = {}) {
  const { step = 0.02, min = -1e6, max = 1e6, dec = 2, cls = '' } = o;
  const inp = h('input', { type: 'text', inputmode: 'decimal' });
  const show = () => { if (document.activeElement !== inp) { const v = get(); inp.value = (+v).toFixed(dec); } };
  const lab = h('span', { class: 'nf-l ' + cls, title: 'Drag to change, Shift for fine' }, label);
  let sx = 0, sv = 0, moved = false, down = false;
  lab.addEventListener('pointerdown', e => { if (exporting) return; /* the export owns the settings (M3) */ down = true; lab.setPointerCapture(e.pointerId); sx = e.clientX; sv = +get(); moved = false; e.preventDefault(); });
  lab.addEventListener('pointermove', e => { if (!down) return; const dx = e.clientX - sx; if (Math.abs(dx) > 2) moved = true; if (moved) { const v = clamp(sv + dx * step * (e.shiftKey ? 0.1 : 1), min, max); set(+v.toFixed(dec + 1), false); show(); } });
  const up = e => { if (!down) return; down = false; try { lab.releasePointerCapture(e.pointerId); } catch (_) { } if (moved) set(+get(), true); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) lab.addEventListener(ev, up);
  inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v)) set(clamp(v, min, max), true); show(); });
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Tab') e.stopPropagation(); /* Tab must reach the dialog focus trap */
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const v = clamp(+get() + (e.key === 'ArrowUp' ? 1 : -1) * step * 10 * (e.shiftKey ? 0.1 : 1), min, max); set(+v.toFixed(dec + 1), true); inp.value = v.toFixed(dec); }
  });
  show();
  const el = h('div', { class: 'nf' }, lab, inp); live.push(show);
  return el;
}
function vecRow(label, get, set, o = {}) {
  return h('div', { class: 'row' }, h('label', null, label), h('div', { class: 'vec' }, ['X', 'Y', 'Z'].map((ax, i) => numField(ax, () => get()[i], (v, c) => { const a = get().slice(); a[i] = v; set(a, c); }, { ...o, cls: ax.toLowerCase() }))));
}
function slider(label, get, set, { min = 0, max = 1, step = 0.01, fmt = v => v.toFixed(2) } = {}) {
  const val = h('span', { class: 'sval' });
  const r = h('input', { type: 'range', min, max, step, class: 'grow' });
  const show = () => { if (document.activeElement !== r) r.value = get(); val.textContent = fmt(+get()); };
  r.addEventListener('input', () => { set(+r.value, false); val.textContent = fmt(+r.value); });
  r.addEventListener('change', () => set(+r.value, true));
  show(); live.push(show);
  return h('div', { class: 'row' }, h('label', null, label), r, val);
}
function colorRow(label, get, set) {
  const c = h('input', { type: 'color', value: get() });
  c.addEventListener('input', () => set(c.value, false));
  c.addEventListener('change', () => set(c.value, true));
  return h('div', { class: 'row' }, h('label', null, label), c, h('span', { class: 'note', style: 'margin:0' }, ''));
}
function selectRow(label, options, get, set) {
  const s = h('select', { class: 'grow' }, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = get(); s.addEventListener('change', () => set(s.value));
  return h('div', { class: 'row' }, h('label', null, label), s);
}
function check(label, get, set, title) {
  const c = h('input', { type: 'checkbox' }); c.checked = !!get();
  c.addEventListener('change', () => set(c.checked));
  return h('label', { class: 'row', style: 'gap:8px;cursor:pointer;width:auto;flex:1', title }, c, label);
}
const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h3', null, title), ...kids);

function keySection(kind) {
  const keys = kind === 'camera' ? state.camera.keys : getObj(kind).keys;
  const here = keyIndexAt(keys, T) >= 0;
  const line = h('div', { class: 'keyline' }, h('span', { class: 'kdia' }, here ? '◆' : '◇'),
    keys.length ? `${keys.length} keyframe${keys.length > 1 ? 's' : ''}` + (here ? ' · one at the playhead' : '') : 'Not animated');
  return sec('Animation', line,
    h('div', { class: 'btns' },
      h('button', { onclick: addKeySel, title: 'K' }, '◆ Add key here'),
      h('button', { onclick: removeKeySel, disabled: !here }, 'Remove key'),
      h('button', { onclick: () => { if (kind === 'camera') { state.camera.base = clone(evalCamRaw(T)); state.camera.keys = []; } else { const o = getObj(kind); o.base = clone(evalObj(o, T)); o.keys = []; } changed(true, true); toast('Animation cleared'); }, disabled: !keys.length }, 'Clear')),
    h('p', { class: 'note' }, keys.length ? 'Move the playhead, then change anything. A key is added for you at that time.' : 'Press ◆ Add key to start animating. Then move the playhead and change position. A second key is added for you.'));
}

function renderProps() {
  live.length = 0;
  const p = $('#props'); p.innerHTML = '';
  /* in Camera view with nothing selected, show the camera tools; the selection stays empty (U3) */
  if (selected === 'camera' || selected === 'target' || (view === 'camera' && !selected)) return propsCamera(p);
  const o = selected && getObj(selected);
  if (o) return propsObject(p, o);
  propsScene(p);
}
function propsScene(p) {
  const s = state.settings;
  const set = (k, v, c = true) => { s[k] = v; applyEnv(); changed(c); };
  p.append(sec('Scene', h('p', { class: 'note', style: 'margin:0 0 8px' }, 'Nothing selected. Click an object, or click Shot camera in the list or the timeline.'),
    h('div', { class: 'chips' }, Object.entries(ENV).map(([k, e]) => h('button', { class: s.env === k ? 'on' : '', onclick: () => { Object.assign(s, e, { env: k }); applyEnv(); changed(true, true); } }, e.label)))));
  p.append(sec('Start from a set', h('p', { class: 'note', style: 'margin:0 0 6px' }, 'Ready-made layouts for common blocking situations.'),
    h('button', { class: 'primary', style: 'width:100%', onclick: () => openStarters() }, 'Browse starter sets…')));
  if (simple) {
    p.append(sec('Ground', check('Show ground', () => s.groundOn, v => set('groundOn', v)), check('Grid in editor', () => s.gridOn, v => { set('gridOn', v); syncTopUI(); }),
      h('p', { class: 'note' }, 'Sky colours, sun and fog are in Advanced mode (top bar).')));
  }
  if (!simple) p.append(sec('Sky & ground',
    colorRow('Sky', () => s.sky, (v, c) => { s.env = 'custom'; set('sky', v, c); }),
    check('Show ground', () => s.groundOn, v => set('groundOn', v)),
    colorRow('Ground', () => s.groundColor, (v, c) => set('groundColor', v, c)),
    check('Grid in editor', () => s.gridOn, v => { set('gridOn', v); syncTopUI(); }),
    check('Fog / haze', () => s.fog, v => set('fog', v)),
    slider('Fog amount', () => s.fogDensity, (v, c) => set('fogDensity', v, c), { min: 0.002, max: 0.08, step: 0.001, fmt: v => v.toFixed(3) })));
  if (!simple) p.append(sec('Sun & light',
    slider('Direction', () => s.sunAz, (v, c) => set('sunAz', v, c), { min: 0, max: 360, step: 1, fmt: v => v.toFixed(0) + '°' }),
    slider('Height', () => s.sunEl, (v, c) => set('sunEl', v, c), { min: 2, max: 90, step: 1, fmt: v => v.toFixed(0) + '°' }),
    slider('Sun strength', () => s.sunInt, (v, c) => set('sunInt', v, c), { min: 0, max: 5, step: 0.05 }),
    colorRow('Sun colour', () => s.sunColor, (v, c) => set('sunColor', v, c)),
    slider('Fill light', () => s.ambInt, (v, c) => set('ambInt', v, c), { min: 0, max: 3, step: 0.05 })));
  p.append(sec('Getting started', h('ol', { class: 'steps', style: 'font-size:12px;margin:0' },
    h('li', null, 'Add people and props from the left, then click where they go.'),
    h('li', null, 'Drag them on the floor, turn them with the orange ring, draw walk paths.'),
    h('li', null, 'Frame the shot: Set start, reframe, Set end. Or use a shot size or move.'),
    h('li', null, 'Export the video or frames.')),
    h('button', { style: 'margin-top:8px', onclick: () => openModal('mHelp') }, 'Show quick start & shortcuts')));
}
function propsCamera(p) {
  const c = state.camera, s = state.settings;
  p.append(sec('Shot camera',
    h('div', { class: 'btns' },
      h('button', { class: view === 'camera' ? 'on' : '', onclick: () => setView(view === 'camera' ? 'editor' : 'camera') }, view === 'camera' ? 'Back to editor' : 'Look through camera'),
      view === 'editor' ? h('button', { onclick: camToEditorView, title: 'Place the camera where the editor view is' }, 'Camera to editor view') : null),
  ));
  const ends = camEnds();
  p.append(sec('Start & end frames',
    h('div', { class: 'btns big2' },
      h('button', { class: ends.s ? 'on' : '', onclick: () => setShotEnd('start'), title: 'Save the current framing as the first frame' }, (ends.s ? '✓ ' : '') + 'Set start'),
      h('button', { class: ends.e ? 'on' : '', onclick: () => setShotEnd('end'), title: 'Save the current framing as the last frame' }, (ends.e ? '✓ ' : '') + 'Set end')),
    h('div', { class: 'btns' },
      h('button', { onclick: () => setTime(0), disabled: !ends.s }, '⏮ Go to start'),
      h('button', { onclick: () => setTime(lastT()), disabled: !ends.e }, 'Go to end ⏭')),
    h('p', { class: 'note' }, 'Frame the opening shot and press Set start. Then frame the closing shot and press Set end. The move in between is made for you.')));
  const ps = persons();
  if (ps.length) {
    if (!shotPerson || !getObj(shotPerson)) shotPerson = defaultShotPerson();
    p.append(sec('Frame a person',
      ps.length > 1 ? selectRow('Person', ps.map(x => [x.id, x.name]), () => shotPerson, v => { shotPerson = v; }) : null,
      shotGrid(() => shotPerson),
      h('p', { class: 'note' }, 'Uses the current lens. Try: Wide → Set start, Close-up → Set end.')));
  }
  p.append(plateSection());
  p.append(sec('Record a move live',
    h('div', { class: 'btns' }, h('button', { class: 'recbtn', onclick: startRecord }, '● Record camera')),
    h('p', { class: 'note' }, 'After a 3 s countdown the shot plays and you operate the camera: drag to orbit, right-drag to pan, scroll to dolly, W A S D Q E to fly. Your move is smoothed into keyframes.')));
  const fr = slider('Focal length', () => camState.f, (v, cm) => writeCam({ f: v }, cm), { min: 10, max: 200, step: 1, fmt: v => v.toFixed(0) + ' mm' });
  p.append(sec('Lens', fr,
    h('div', { class: 'chips' }, [14, 18, 24, 35, 50, 85, 135].map(f => h('button', { onclick: () => writeCam({ f }, true), title: f < 24 ? 'Ultra wide' : f < 35 ? 'Wide' : f < 60 ? 'Normal' : 'Telephoto' }, f + 'mm'))),
    simple ? null : slider('Dutch roll', () => camState.roll || 0, (v, cm) => writeCam({ roll: v }, cm), { min: -45, max: 45, step: 0.5, fmt: v => v.toFixed(1) + '°' }),
    slider('Handheld', () => c.shake || 0, (v, cm) => { c.shake = v; changed(cm); }, { min: 0, max: 2, step: 0.05, fmt: v => v ? v.toFixed(2) : 'off' })));
  const subjOpts = [['', 'None (use the target point)'], ...state.objects.map(o => [o.id, o.name])];
  p.append(sec('Subject',
    selectRow('Look at', subjOpts, () => c.lookAtId || '', v => { if (v && !c.lookAtId) { c.base.tg = evalCam(T).tg; } c.lookAtId = v || null; if (!v) c.follow = false; updateGizmo(); changed(true, true); }),
    c.lookAtId ? check('Follow the subject (camera travels with it)', () => c.follow, v => { const cur = evalCam(T).p; c.follow = v; writeCam({ p: cur }, true); propsDirty = true; }) : null,
    h('p', { class: 'note' }, c.lookAtId ? 'The camera keeps aiming at the subject while it moves.' : 'Pick a person or object to keep it centred automatically.')));
  const mg = h('div', { class: 'movegrid' }, MOVES.map(([k, ic, l]) => h('button', { onclick: () => applyMove(k), title: 'Animate the camera: ' + l.toLowerCase() + ', from the current framing' }, h('b', null, ic), l)));
  p.append(sec('One-click camera moves',
    slider('Strength', () => moveAmt, v => { moveAmt = v; }, { min: 0.25, max: 2.5, step: 0.05, fmt: v => v.toFixed(2) + '×' }),
    mg, h('p', { class: 'note' }, 'Starts from the current framing and runs for the whole shot.')));
  p.append(sec('Motion feel', feelSeg(), h('p', { class: 'note' }, 'How the camera starts and stops across the whole move.')));
  const dof = ensureDof();
  const fstops = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
  p.append(sec('Depth of field',
    check('Blur what is out of focus', () => dof.on, v => { dof.on = v; changed(true, true); }),
    dof.on ? h('div', null,
      slider('Aperture', () => dof.fstop, (v, cm) => { dof.fstop = v; changed(cm); }, { min: 1, max: 22, step: 0.1, fmt: v => 'f/' + v.toFixed(1) }),
      h('div', { class: 'chips' }, fstops.map(n => h('button', { class: Math.abs(dof.fstop - n) < 0.05 ? 'on' : '', onclick: () => { dof.fstop = n; changed(true, true); } }, 'f/' + n))),
      selectRow('Focus', [['auto', 'Auto: on the subject / aim point'], ['manual', 'Manual distance (for focus pulls)']], () => dof.auto ? 'auto' : 'manual', v => {
        const cur = focusDist(camState); dof.auto = v === 'auto';
        if (!dof.auto) writeCam({ fd: cur }, true); else changed(true, true);
      }),
      dof.auto ? (() => { const sp = h('span', { class: 'note', style: 'margin:0' }); live.push(() => { sp.textContent = focusDist(camState).toFixed(2) + ' m (auto)'; }); return h('div', { class: 'row' }, h('label', null, 'Distance'), sp); })() : slider('Distance', () => camState.fd, (v, cm) => writeCam({ fd: v }, cm), { min: 0.2, max: 60, step: 0.05, fmt: v => v.toFixed(2) + ' m' }),
      h('div', { class: 'btns', style: 'margin-top:6px' }, h('button', { onclick: startFocusPick, title: 'Then click on anything in the camera view' }, 'Pick focus point')),
      h('p', { class: 'note' }, dof.auto
        ? 'Focus stays on the aim point or subject, even while it moves.'
        : 'Set keys on the distance to rack focus between subjects.'),
      h('p', { class: 'note' }, 'Lower f-numbers and longer lenses give more blur. Not used in the Depth and Normals styles.')) : h('p', { class: 'note' }, 'Simulates a real lens: focal length, f-stop and focus distance.')));
  p.append(keySection('camera'));
  if (!simple) p.append(sec('Placement',
    vecRow('Position', () => camState.p, (v, cm) => writeCam({ p: v }, cm), { step: 0.02 }),
    c.lookAtId ? null : vecRow('Aims at', () => camState.tg, (v, cm) => writeCam({ tg: v }, cm), { step: 0.02 })));
  p.append(sec('Frame',
    selectRow('Aspect', ASPECTS.map(a => [a[0], a[2]]), () => s.aspect, v => { s.aspect = v; changed(true, true); syncTopUI(); }),
    selectRow('Size', SIZES, () => String(s.size), v => { s.size = +v; changed(true); }),
    selectRow('Guides', [['thirds', 'Rule of thirds'], ['center', 'Centre cross'], ['safe', 'Safe areas'], ['none', 'None']], () => s.guides, v => { s.guides = v; drawGuides(); changed(true); }),
    selectRow('View style', STYLES.map(x => [x[0], x[1]]), () => s.style, v => { s.style = v; changed(true); syncTopUI(); })));
}
function shotGrid(pid) { return h('div', { class: 'posegrid' }, SHOTS.map(([k, l]) => h('button', { onclick: () => frameShot(k, pid()) }, l))); }
function feelSeg() {
  const c = state.camera;
  return h('div', { class: 'seg feel' }, [['constant', 'Constant'], ['gentle', 'Gentle ease'], ['strong', 'Strong ease']].map(([k, l]) =>
    h('button', { class: (c.feel || 'gentle') === k ? 'on' : '', onclick: () => { c.feel = k; changed(true, true); syncTopUI(); } }, l)));
}
function propsObject(p, o) {
  const tr = () => evalObj(o, T);
  const setPart = (part) => (v, cm) => { const cur = clone(tr()); cur[part] = v; writeObj(o, cur, cm); };
  const name = h('input', { type: 'text', value: o.name, class: 'grow' });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; changed(true, true); });
  name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
  p.append(sec(catalogOf(o.type).label, h('div', { class: 'row' }, h('label', null, 'Name'), name)));
  const rebuild = (cm = true) => { syncScene(); updateGizmo(); changed(cm); };
  const isMark = o.type === 'mark';
  if (isMark) {
    const letter = h('input', { type: 'text', value: o.opts.letter, maxlength: 2, style: 'width:52px;text-align:center' });
    letter.addEventListener('keydown', e => e.stopPropagation());
    letter.addEventListener('change', () => { const L = letter.value.trim().toUpperCase() || 'A'; o.opts.letter = L; o.name = 'Mark ' + L; rebuild(); propsDirty = true; });
    p.append(sec('Floor mark', h('div', { class: 'row' }, h('label', null, 'Letter'), letter),
      colorRow('Colour', () => o.color, (v, cm) => { o.color = v; rebuild(cm); }),
      h('p', { class: 'note' }, 'Marks show in the editor and top view only, never in the shot. Select a person to send them to a mark.'),
      h('div', { class: 'btns' }, h('button', { onclick: duplicateSel }, 'Duplicate'), h('button', { onclick: deleteSel, style: 'color:#ff9c9c' }, 'Delete'))));
    return;
  }
  if (o.type === 'person') {
    const pg = h('div', { class: 'posegrid' }, Object.entries(POSES).map(([k, d]) => h('button', { class: o.opts.pose === k ? 'on' : '', onclick: () => { o.opts.pose = k; changed(true, true); } }, d.label, d.anim ? h('i', null, d.loco ? 'moves' : 'animated') : null)));
    const def = POSES[o.opts.pose] || POSES.stand;
    p.append(sec('Pose', pg,
      def.anim && !(def.loco && o.keys.length > 1) ? slider('Action speed', () => o.opts.speed || 1, (v, cm) => { o.opts.speed = v; changed(cm); }, { min: 0.2, max: 3, step: 0.05, fmt: v => v.toFixed(2) + '×' }) : null,
      def.loco ? h('p', { class: 'note' }, o.keys.length > 1 ? 'Steps match the distance walked, so the feet do not slide.' : 'Walking on the spot. Draw a path below to make them travel.') : null));
  }
  // ---- movement
  const who = o.type === 'person' ? 'walk ' : '';
  const moveKids = [
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => startPath(o.id), title: 'Click points on the floor; ' + (o.type === 'person' ? 'they walk' : 'it moves') + ' through them' }, h('span', { html: svgI('path'), class: 'bi' }), 'Draw ' + who + 'path')),
    slider('Speed', () => pathSpeedOf(o), (v, cm) => { o.opts.pathSpeed = v; changed(cm); }, { min: 0.3, max: o.type === 'car' ? 30 : 8, step: 0.1, fmt: v => v.toFixed(1) + ' m/s' }),
    check('Fit the path to the end of the shot', () => pathFit, v => { pathFit = v; }, 'Ignore the speed: arrive exactly on the last frame'),
    h('p', { class: 'note' }, 'Starts at the playhead (' + snapT(T).toFixed(2) + ' s). Walking ≈ 1.4 m/s, jogging ≈ 3 m/s.'),
  ];
  const marks = state.objects.filter(m => m.type === 'mark');
  if (marks.length) {
    const sel = h('select', { class: 'grow' }, marks.map(m => h('option', { value: m.id }, m.name)));
    const tIn = h('input', { type: 'number', min: 0, step: 0.1, style: 'width:62px' });
    const suggest = () => { const m = getObj(sel.value); const a = evalObj(o, T).p, b = evalObj(m, T).p; tIn.value = Math.min(lastT(), snapT(T + Math.max(0.5, Math.hypot(a[0] - b[0], a[2] - b[2]) / pathSpeedOf(o)))).toFixed(2); };
    sel.onchange = suggest; suggest(); tIn.addEventListener('keydown', e => e.stopPropagation());
    moveKids.push(h('div', { class: 'row' }, h('label', null, 'Go to mark'), sel), h('div', { class: 'row' }, h('label', null, 'Arrive at'), tIn, h('span', { class: 'note', style: 'margin:0' }, 's'), h('button', { class: 'grow', onclick: () => walkToMark(o, sel.value, parseFloat(tIn.value)) }, (o.type === 'person' ? 'Walk' : 'Move') + ' there')));
  } else moveKids.push(h('p', { class: 'note' }, 'Tip: add floor marks (left panel) to send people to them with an arrival time.'));
  const others = state.objects.filter(x => x !== o);
  const fsel = h('select', { class: 'grow' }, h('option', { value: '' }, 'Face toward…'), others.map(x => h('option', { value: x.id }, x.name)));
  fsel.onchange = () => { const t = getObj(fsel.value); if (t) faceToward(o, evalObj(t, T).p, t.name); };
  moveKids.push(h('div', { class: 'row' }, h('button', { onclick: () => faceToward(o, camState.p, 'the camera') }, 'Face camera'), fsel));
  if (o.keys.length > 1 || o.type === 'person') moveKids.push(check('Face the way ' + (o.type === 'person' ? 'they' : 'it') + ' travel' + (o.type === 'person' ? '' : 's'), () => o.opts.faceTravel, v => { o.opts.faceTravel = v; changed(true); }));
  p.append(sec('Move & face', ...moveKids));
  if (o.type === 'person') p.append(sec('Frame with the camera', shotGrid(() => o.id), h('p', { class: 'note' }, 'Moves the shot camera to frame ' + o.name + '.')));
  // ---- look
  if (o.type === 'person') {
    p.append(sec('Look',
      slider('Height', () => o.opts.height || 1.75, (v, cm) => { o.opts.height = v; rebuild(cm); }, { min: 0.8, max: 2.2, step: 0.01, fmt: v => v.toFixed(2) + ' m' }),
      colorRow('Top', () => o.color, (v, cm) => { o.color = v; rebuild(cm); }),
      colorRow('Trousers', () => o.opts.pants, (v, cm) => { o.opts.pants = v; rebuild(cm); }),
      simple ? null : colorRow('Skin', () => o.opts.skin, (v, cm) => { o.opts.skin = v; rebuild(cm); }),
      simple ? null : colorRow('Hair', () => o.opts.hair, (v, cm) => { o.opts.hair = v; rebuild(cm); })));
  } else if (o.type === 'image') {
    p.append(sec('Image card', check('Unlit (no shading, like a backdrop)', () => o.opts.unlit, v => { o.opts.unlit = v; rebuild(); })));
  } else if (o.type !== 'model') {
    p.append(sec('Look', colorRow('Colour', () => o.color, (v, cm) => { o.color = v; rebuild(cm); })));
  }
  // ---- placement
  const tools = h('div', { class: 'btns', style: 'margin-top:8px' },
    h('button', { onclick: dropToFloor }, 'Drop to floor'),
    h('button', { onclick: duplicateSel }, 'Duplicate'),
    h('button', { onclick: deleteSel, style: 'color:#ff9c9c' }, 'Delete'));
  const travelNote = o.opts.faceTravel && o.keys.length > 1 ? h('p', { class: 'note' }, 'Turning follows the path. Untick "Face the way they travel" to turn them yourself.') : null;
  if (simple) {
    p.append(sec('Placement',
      slider('Turn', () => { let y = tr().r[1] % 360; if (y > 180) y -= 360; if (y < -180) y += 360; return y; }, (v, cm) => { const cur = clone(tr()); cur.r[1] = v; writeObj(o, cur, cm); }, { min: -180, max: 180, step: 1, fmt: v => v.toFixed(0) + '°' }),
      slider('Size', () => tr().s[0], (v, cm) => { const cur = clone(tr()); const k = v / (cur.s[0] || 1); cur.s = cur.s.map(x => Math.max(0.01, x * k)); writeObj(o, cur, cm); }, { min: 0.1, max: 5, step: 0.01, fmt: v => v.toFixed(2) + '×' }),
      slider('Lift', () => tr().p[1], (v, cm) => { const cur = clone(tr()); cur.p[1] = v; writeObj(o, cur, cm); }, { min: 0, max: 5, step: 0.01, fmt: v => v.toFixed(2) + ' m' }),
      travelNote, h('p', { class: 'note' }, 'Drag it across the floor to move it. Drag the orange ring to turn it.'), tools));
  } else {
    const uni = numField('×', () => tr().s[0], (v, cm) => { const cur = clone(tr()); const k = v / (cur.s[0] || 1); cur.s = cur.s.map(x => Math.max(0.01, x * k)); writeObj(o, cur, cm); }, { step: 0.01, min: 0.01, dec: 2 });
    p.append(sec('Transform',
      vecRow('Position', () => tr().p, setPart('p'), { step: 0.02 }),
      vecRow('Rotation', () => tr().r, setPart('r'), { step: 0.5, dec: 1 }),
      h('div', { class: 'row' }, h('label', null, 'Size'), h('div', { style: 'width:90px' }, uni), h('span', { class: 'note', style: 'margin:0' }, 'uniform')),
      vecRow('Scale', () => tr().s, (v, cm) => setPart('s')(v.map(x => Math.max(0.01, x)), cm), { step: 0.01, min: 0.01 }),
      travelNote, tools));
  }
  p.append(keySection(o.id));
  p.append(sec('Camera', h('div', { class: 'btns' },
    h('button', { onclick: () => { state.camera.lookAtId = o.id; state.camera.base.tg = evalCam(T).tg; changed(true); toast('Camera now keeps ' + o.name + ' in frame'); } }, 'Keep camera on this'))));
}
/* ============================== timeline ============================== */
function laneW() { const l = $('#rulerLane'); return l ? l.clientWidth : 1; }
function renderTimeline() {
  const L = lastT(), lane = $('#rulerLane'); lane.innerHTML = '';
  const W = laneW(), pxs = W / Math.max(L, 0.01);
  const step = pxs > 90 ? 0.5 : pxs > 40 ? 1 : pxs > 18 ? 2 : 5;
  const minor = pxs > 200 ? 1 / state.settings.fps * Math.ceil(state.settings.fps / 12) : step / 4;
  for (let t = 0; t <= L + 1e-6; t += minor) {
    const maj = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const tk = h('div', { class: 'tick' + (maj ? ' maj' : ''), style: `left:${t / L * 100}%` });
    if (maj) tk.append(h('span', null, (Math.round(t * 100) / 100) + 's'));
    lane.append(tk);
  }
  const rows = $('#tlRows'), fid = focusedRowId(rows); rows.innerHTML = '';
  const mk = (id, name, keys, isCam) => {
    const laneEl = h('div', { class: 'lane' });
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]; if (k.t > L + 1e-6) continue;
      const d = h('div', { class: 'dia' + (isCam ? ' cam' : ''), style: `left:${k.t / L * 100}%`, title: `${fmtTime(k.t)} · drag to retime · right-click to delete` });
      keyDrag(d, id, k, laneEl);
      laneEl.append(d);
    }
    scrubOn(laneEl);
    return h('div', { class: 'tlr' + (selected === id || (isCam && selected === 'target') ? ' sel' : '') }, h('div', { class: 'lab', tabindex: 0, 'data-id': id, title: name, onclick: () => select(id), onkeydown: rowKeys(id) }, h('span', { html: isCam ? svgI('camera') : iconFor(getObj(id)), style: 'display:flex;width:14px;flex:none' }), h('span', { class: 'nm' }, name)), laneEl);
  };
  rows.append(mk('camera', 'Shot camera', state.camera.keys, true));
  for (const o of state.objects) if (o.keys.length || selected === o.id) rows.append(mk(o.id, o.name, o.keys, false));
  $$('#tlRows .lab svg').forEach(s => { s.style.width = '14px'; s.style.stroke = 'currentColor'; s.style.fill = 'none'; s.style.strokeWidth = '1.6'; });
  refocusRow(rows, fid);
}
function timeFromX(clientX, laneEl) { const r = laneEl.getBoundingClientRect(); return clamp((clientX - r.left) / r.width, 0, 1) * lastT(); }
function scrubOn(laneEl) {
  laneEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (playing) setPlaying(false);
    laneEl.setPointerCapture(e.pointerId); setTime(snapT(timeFromX(e.clientX, laneEl)));
    const mv = ev => { setTime(snapT(timeFromX(ev.clientX, laneEl)), false); };
    const up = () => { laneEl.removeEventListener('pointermove', mv); for (const ev of ['pointerup', 'pointercancel']) laneEl.removeEventListener(ev, up); propsDirty = true; };
    laneEl.addEventListener('pointermove', mv); for (const ev of ['pointerup', 'pointercancel']) laneEl.addEventListener(ev, up);
  });
}
function keyDrag(d, id, k, laneEl) {
  d.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    const keys = id === 'camera' ? state.camera.keys : getObj(id).keys;
    removeKey(id, keys.indexOf(k));
  });
  d.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation(); if (playing) setPlaying(false);
    d.setPointerCapture(e.pointerId);
    const sx = e.clientX; let moved = false;
    const keys = id === 'camera' ? state.camera.keys : getObj(id).keys;
    const mv = ev => {
      if (Math.abs(ev.clientX - sx) > 3) moved = true;
      if (!moved) return;
      const nt = snapT(timeFromX(ev.clientX, laneEl));
      k.t = nt; d.style.left = (nt / lastT() * 100) + '%'; setTime(nt, false); editRev++;
      keys.sort((a, b) => a.t - b.t);
    };
    const up = () => {
      d.removeEventListener('pointermove', mv); for (const ev of ['pointerup', 'pointercancel']) d.removeEventListener(ev, up);
      if (moved) {
        const dup = keys.filter(x => x !== k && Math.abs(x.t - k.t) < 0.5 / state.settings.fps);
        for (const x of dup) keys.splice(keys.indexOf(x), 1);
        changed(true, true);
      } else { setTime(k.t); if (selected !== id) select(id); }
    };
    d.addEventListener('pointermove', mv); for (const ev of ['pointerup', 'pointercancel']) d.addEventListener(ev, up);
  });
}
function selKeysTarget() {
  if (view === 'camera') return 'camera';
  if (selected === 'target') return 'camera';
  return selected || (view === 'camera' ? 'camera' : null);
}
function addKeySel() {
  const id = selKeysTarget();
  if (!id) { toast('Select something first (or switch to Camera view to key the camera)'); return; }
  if (id === 'camera') { const cur = clone(evalCamRaw(T)); setKey(state.camera.keys, T, cur); }
  else { const o = getObj(id); setKey(o.keys, T, clone(evalObj(o, T))); }
  changed(true, true); toast('◆ Key added at ' + fmtTime(snapT(T)));
}
function removeKey(id, idx) {
  const isCam = id === 'camera';
  const holder = isCam ? state.camera : getObj(id);
  if (!holder || idx < 0) return;
  const before = clone(isCam ? evalCamRaw(T) : evalObj(holder, T));
  holder.keys.splice(idx, 1);
  if (!holder.keys.length) holder.base = before;
  changed(true, true); toast('Key removed');
}
function removeKeySel() {
  const id = selKeysTarget(); if (!id) return;
  const keys = id === 'camera' ? state.camera.keys : getObj(id).keys;
  const i = keyIndexAt(keys, T);
  if (i < 0) { toast('No key at the playhead'); return; }
  removeKey(id, i);
}
function jumpKey(dir) {
  const id = selKeysTarget();
  let times = [];
  if (id) times = (id === 'camera' ? state.camera.keys : getObj(id).keys).map(k => k.t);
  else { times = state.camera.keys.map(k => k.t); for (const o of state.objects) times.push(...o.keys.map(k => k.t)); }
  times = [...new Set(times)].sort((a, b) => a - b);
  const eps = 0.5 / state.settings.fps;
  const t = dir > 0 ? times.find(x => x > T + eps) : [...times].reverse().find(x => x < T - eps);
  if (t != null) setTime(t); else toast(dir > 0 ? 'No later key' : 'No earlier key');
}
function setPlaying(v) { playing = v; $('#bPlay').textContent = v ? '❚❚' : '▶'; $('#bPlay').classList.toggle('on', v); if (!v) propsDirty = true; }

const labelEls = new Map();
function updateLabels() {
  const box = $('#labels');
  if (view === 'camera') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const cam = view === 'top' ? topCam : edCam, w = vpEl.clientWidth, hh = vpEl.clientHeight, seen = new Set();
  for (const o of state.objects) {
    if (o.type !== 'person') continue;
    const v = views.get(o.id); if (!v || !v.group.visible) continue;
    seen.add(o.id);
    let el = labelEls.get(o.id); if (!el) { el = h('div', { class: 'lbl3d' }); box.append(el); labelEls.set(o.id, el); }
    if (el.textContent !== o.name) el.textContent = o.name;
    const H = (o.opts.height || 1.75) * v.group.scale.y;
    const pt = new THREE.Vector3(v.group.position.x, v.group.position.y + H + 0.16, v.group.position.z).project(cam);
    el.style.display = pt.z < 1 && pt.z > -1 ? 'block' : 'none';
    el.style.transform = `translate(${((pt.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-pt.y * 0.5 + 0.5) * hh).toFixed(1)}px) translate(-50%,-100%)`;
    el.classList.toggle('sel', selected === o.id);
  }
  for (const [id, el] of labelEls) if (!seen.has(id)) { el.remove(); labelEls.delete(id); }
}
/* write to the DOM only when the value changed (P5) */
function putHTML(el, s) { if (el._html !== s) { el._html = s; el.innerHTML = s; } }
function putText(el, s) { if (el.textContent !== s) el.textContent = s; }
function putStyle(el, k, v) { if (el.style[k] !== v) el.style[k] = v; }
function tickUI() {
  updateLabels();
  ensurePlate();
  const ov = state.plate && plateURL ? (state.plate.overlay || 0) : 0;
  $$('.plateImg').forEach(i => { putStyle(i, 'opacity', String(ov)); putStyle(i, 'display', ov > 0 ? 'block' : 'none'); });
  if (view === 'camera') { const en = camEnds(); $('#cbStart').classList.toggle('on', en.s); $('#cbEnd').classList.toggle('on', en.e); putText($('#cbStart'), (en.s ? '✓ ' : '') + 'Set start'); putText($('#cbEnd'), (en.e ? '✓ ' : '') + 'Set end'); $('#cbRec').classList.toggle('on', !!rec); }
  const L = lastT(), W = laneW();
  putStyle($('#tlHead'), 'left', (168 + T / L * W) + 'px');
  putText($('#tcode'), fmtTime(T));
  putText($('#tframe'), 'frame ' + (Math.round(T * state.settings.fps) + 1) + ' / ' + frames());
  for (const f of live) f();
  const hint = $('#hint');
  if (view === 'camera') {
    const sz = exportSize();
    putHTML($('#hud'), `<span><b>CAMERA</b></span><span>${camState.f.toFixed(0)} mm</span><span>${state.settings.aspect}</span><span>${sz.w}×${sz.h}</span><span>${(STYLES.find(s => s[0] === state.settings.style) || STYLES[0])[1]}</span>${dofActive() ? `<span>f/${ensureDof().fstop.toFixed(1)} · focus ${focusDist(camState).toFixed(2)} m</span>` : ''}${focusPick ? '<span class="rec">Click to set focus</span>' : ''}${playing ? '<span class="rec">● PLAY</span>' : ''}`);
    putStyle($('#hud'), 'display', 'flex');
    putHTML(hint, rec ? (rec.phase === 'rec' ? '<b style="color:#ff6b6b">● Recording</b> · steer the camera · <kbd>Esc</kbd> cancel' : 'Get ready… position the camera now')
      : 'Drag: orbit · Right-drag: pan · Scroll: dolly · <kbd>Alt</kbd>+scroll: lens · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <kbd>Q</kbd><kbd>E</kbd> fly · <kbd>K</kbd> key camera');
  } else {
    putStyle($('#hud'), 'display', 'none');
    const nav = view === 'top' ? 'Drag empty space: pan · Scroll: zoom' : 'Drag empty space: orbit · Right-drag: pan · Scroll: zoom';
    putHTML(hint, placing || pathMode ? '<kbd>Esc</kbd> cancel' + (pathMode ? ' · <kbd>Enter</kbd> done · right-click removes the last point' : '')
      : selected && selected !== 'camera' && selected !== 'target'
        ? 'Drag it on the floor to move · drag the orange ring to turn · <kbd>K</kbd> key · <kbd>Del</kbd> delete'
        : selected ? 'Drag the camera or its aim point on the floor · or use the panel'
          : nav + ' · Click something to select it, or click Shot camera in the timeline · <kbd>T</kbd> top view · <kbd>C</kbd> camera view');
  }
  $('#bUndo').disabled = hi <= 0; $('#bRedo').disabled = hi >= hist.length - 1;
}


/* ============================== interaction modes ============================== */
let simple = true; try { simple = localStorage.getItem('shotref.simple') !== '0'; } catch (e) { }
let placing = null, pathMode = null, pathFit = false, rec = null;
const MODE_TIP_MS = 6500; /* path and recording tips stay up long enough to read (U7) */
const snapV = v => snapOn ? Math.round(v * 4) / 4 : r4(v);
const _rc = new THREE.Raycaster();
function rayFromEvent(e) {
  const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
  let r = { x: 0, y: 0, w: rect.width, h: rect.height }, cam = view === 'top' ? topCam : edCam;
  if (view === 'camera') { r = camRect(rect.width, rect.height); cam = renderCam; prepRenderCam(T); }
  if (px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) return null;
  if (view === 'top') topCam.updateMatrixWorld();
  _rc.setFromCamera(new THREE.Vector2((px - r.x) / r.w * 2 - 1, -((py - r.y) / r.h) * 2 + 1), cam);
  return _rc;
}
function planeHit(rc, y = 0) { const pt = new THREE.Vector3(); return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), pt) ? pt : null; }
function pickAt(rc) {
  const targets = [...views.values()].filter(v => v.group.visible && !(view === 'camera' && v.isMark)).map(v => v.group);
  if (view !== 'camera') { targets.push(camBody); if (targetMarker.visible) targets.push(targetMarker); if (ringGrp.visible) targets.push(ringPick, ringKnob); }
  const hits = rc.intersectObjects(targets, true);
  for (const hit of hits) {
    let ob = hit.object;
    while (ob) { if (ob.userData.pick) return { id: ob.userData.pick, point: hit.point }; if (ob.userData.objId) return { id: ob.userData.objId, point: hit.point }; ob = ob.parent; }
  }
  return null;
}
function showModeBar(text, buttons) {
  const b = $('#modeBar'); b.innerHTML = '';
  b.append(h('span', null, text), ...buttons.map(([l, fn, cls]) => h('button', { class: cls || '', onclick: fn }, l)));
  b.style.display = 'flex';
}
function hideModeBar() { $('#modeBar').style.display = 'none'; }

/* ---- click to place ---- */
function startPlacing(id) {
  placing = id; canvas.style.cursor = 'copy';
  showModeBar('Click on the floor to place ' + getObj(id).name, [['Cancel', cancelPlacing]]);
}
function commitPlacing() {
  const o = getObj(placing); placing = null; hideModeBar(); canvas.style.cursor = '';
  changed(true, true); if (o) toast(o.name + ' placed');
}
function cancelPlacing() {
  const id = placing; placing = null; hideModeBar(); canvas.style.cursor = '';
  if (id) { state.objects = state.objects.filter(o => o.id !== id); if (selected === id) selected = null; syncScene(); updateGizmo(); changed(false, true); autosave(); }
}
function movePlacing(e) {
  const rc = rayFromEvent(e); if (!rc) return; const g = planeHit(rc, 0); const o = getObj(placing); if (!g || !o) return;
  o.base.p = [snapV(g.x), o.base.p[1], snapV(g.z)]; editRev++;
}

/* ---- draw a path ---- */
function pathSpeedOf(o) {
  if (o.opts.pathSpeed) return o.opts.pathSpeed;
  if (o.type === 'person') return o.opts.pose === 'run' ? 3.5 : 1.4;
  if (o.type === 'car') return 8;
  return 1.5;
}
function startPath(id) {
  const o = getObj(id); if (!o) return;
  if (placing) commitPlacing();
  if (view === 'camera') setView('top');
  const p = evalObj(o, T).p;
  pathMode = { id, pts: [[p[0], p[2]]], y: p[1], cursor: null };
  canvas.style.cursor = 'crosshair'; pathBar();
}
function pathBar() {
  const n = pathMode.pts.length - 1;
  showModeBar(n ? `${n} point${n > 1 ? 's' : ''} · keep clicking, then Done (or double-click / Enter)` : 'Click on the floor where they should go. Add as many points as you like.',
    [['Undo point', removePathPoint], ['Done', finishPath, 'primary'], ['Cancel', cancelPath]]);
}
function addPathPoint(g) {
  const last = pathMode.pts[pathMode.pts.length - 1];
  if (Math.hypot(g.x - last[0], g.z - last[1]) < 0.08) return;
  pathMode.pts.push([snapV(g.x), snapV(g.z)]); pathBar();
}
function removePathPoint() { if (pathMode && pathMode.pts.length > 1) { pathMode.pts.pop(); pathBar(); } }
function cancelPath() { pathMode = null; hideModeBar(); canvas.style.cursor = ''; }
function finishPath() {
  const pm = pathMode; if (!pm) return; cancelPath();
  const o = getObj(pm.id); if (!o) return;
  if (pm.pts.length < 2) { toast('Click at least one point on the floor'); return; }
  const cum = [0]; for (let i = 1; i < pm.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pm.pts[i][0] - pm.pts[i - 1][0], pm.pts[i][1] - pm.pts[i - 1][1]));
  const total = cum[cum.length - 1], t0 = snapT(T);
  let speed = pathSpeedOf(o);
  if (pathFit) { const avail = lastT() - t0; if (avail < 0.3) { toast('Move the playhead earlier so there is time to walk'); return; } speed = total / avail; }
  const cur = clone(evalObj(o, t0)), eps = 0.5 / state.settings.fps;
  o.keys = o.keys.filter(k => k.t < t0 - eps);
  pm.pts.forEach((pt, i) => setKey(o.keys, t0 + cum[i] / speed, { p: [r4(pt[0]), pm.y, r4(pt[1])], r: cur.r, s: cur.s }));
  if (o.type === 'person') { if (!(POSES[o.opts.pose] || {}).loco) o.opts.pose = speed > 2.6 ? 'run' : 'walk'; }
  o.opts.faceTravel = true;
  const dur = total / speed;
  changed(true, true);
  toast(`Path set: ${total.toFixed(1)} m in ${dur.toFixed(1)} s` + (t0 + dur > lastT() + 0.01 ? '. It runs past the end of the shot. Raise the speed or tick "Fit the path to the end of the shot".' : ''), MODE_TIP_MS);
}

/* ---- marks & facing ---- */
function nextMarkLetter() {
  const used = new Set(state.objects.filter(o => o.type === 'mark').map(o => o.opts.letter));
  for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(L)) return L;
  return '#';
}
function walkToMark(o, markId, arrive) {
  const m = getObj(markId); if (!m) return;
  const t0 = snapT(T), tA = snapT(arrive), eps = 0.5 / state.settings.fps;
  if (!(tA > t0 + eps)) { toast('The arrival time must be after the playhead (' + t0.toFixed(2) + ' s)'); return; }
  const cur = clone(evalObj(o, t0)), mp = evalObj(m, t0).p;
  o.keys = o.keys.filter(k => k.t < t0 - eps || k.t > tA + eps);
  setKey(o.keys, t0, cur);
  setKey(o.keys, tA, { ...cur, p: [r4(mp[0]), cur.p[1], r4(mp[2])] });
  const sp = Math.hypot(mp[0] - cur.p[0], mp[2] - cur.p[2]) / (tA - t0);
  if (o.type === 'person' && !(POSES[o.opts.pose] || {}).loco) o.opts.pose = sp > 2.6 ? 'run' : 'walk';
  o.opts.faceTravel = true;
  changed(true, true); toast(`${o.name} reaches ${m.name} at ${tA.toFixed(1)} s`);
}
function faceToward(o, pt, label) {
  const cur = clone(evalObj(o, T));
  cur.r[1] = Math.atan2(pt[0] - cur.p[0], pt[2] - cur.p[2]) * R2D;
  if (o.opts.faceTravel && o.keys.length > 1) { o.opts.faceTravel = false; }
  writeObj(o, cur, true); propsDirty = true; toast(o.name + ' now faces ' + label);
}

/* ---- shot sizes ---- */
const SHOTS = [['wide', 'Wide'], ['full', 'Full body'], ['medium', 'Medium'], ['mcu', 'Medium close'], ['cu', 'Close-up'], ['ecu', 'Extreme close'], ['low', 'Low angle'], ['high', 'High angle'], ['top', 'Top-down'], ['ots', 'Over shoulder'], ['two', 'Two-shot']];
const persons = () => state.objects.filter(o => o.type === 'person');
function personGeom(o) {
  const v = views.get(o.id), tr = evalObj(o, T), P = new THREE.Vector3().fromArray(tr.p);
  const H = (o.opts.height || 1.75) * tr.s[1];
  let headY = P.y + 0.93 * H;
  if (v && v.person) { v.group.updateMatrixWorld(true); const hp = new THREE.Vector3(); v.person.head.getWorldPosition(hp); headY = hp.y; }
  return { P, H, headY, top: headY + 0.07 * H, yaw: v ? v.group.rotation.y : tr.r[1] * D2R };
}
function nearestOther(o) {
  let best = null, bd = Infinity; const a = evalObj(o, T).p;
  for (const q of persons()) { if (q === o) continue; const b = evalObj(q, T).p; const d = Math.hypot(a[0] - b[0], a[2] - b[2]); if (d < bd) { bd = d; best = q; } }
  return best;
}
function defaultShotPerson() {
  if (selected && getObj(selected) && getObj(selected).type === 'person') return selected;
  const s = subject(); if (s && s.type === 'person') return s.id;
  const p = persons()[0]; return p ? p.id : null;
}
let shotPerson = null;
function frameShot(kind, pid) {
  const o = pid && getObj(pid); if (!o) { toast('Add a person first'); return; }
  const g = personGeom(o), He = g.top - g.P.y;
  const f = camState.f, ar = arOf(state.settings.aspect), sv = ar >= 1 ? 36 / ar : 36;
  const vfov = 2 * Math.atan(sv / (2 * f)), hfov = 2 * Math.atan(Math.tan(vfov / 2) * ar);
  const dist = vh => (vh / 2) / Math.tan(vfov / 2);
  // pick a viewing angle (three-quarter front) whose line of sight is not blocked by other people
  const others = persons().filter(q => q !== o).map(q => evalObj(q, T).p);
  const segDist = (px, pz, ax, az, bx, bz) => { const vx = bx - ax, vz = bz - az, l = vx * vx + vz * vz || 1, u = clamp(((px - ax) * vx + (pz - az) * vz) / l, 0, 1); return Math.hypot(px - (ax + u * vx), pz - (az + u * vz)); };
  const shotD = S0 => S0 ? dist(S0[0] * He) : 3;
  const S0 = { wide: [2.4], full: [1.22], medium: [0.56], mcu: [0.37], cu: [0.23], ecu: [0.1], low: [0.85], high: [0.85] }[kind];
  let ang = g.yaw + 18 * D2R;
  if (others.length && S0) {
    const d0 = shotD(S0);
    for (const deg of [18, -18, 35, -35, 55, -55, 75, -75, 100, -100]) {
      const a = g.yaw + deg * D2R, cx = g.P.x + Math.sin(a) * d0, cz = g.P.z + Math.cos(a) * d0;
      if (others.every(q => segDist(q[0], q[2], cx, cz, g.P.x, g.P.z) > 0.42)) { ang = a; break; }
    }
  }
  const dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
  const at = yf => new THREE.Vector3(g.P.x, g.P.y + yf * He, g.P.z);
  const S = { wide: [2.4, 0.55, 0.62], full: [1.22, 0.5, 0.58], medium: [0.56, 0.74, 0.8], mcu: [0.37, 0.82, 0.86], cu: [0.23, 0.885, 0.9], ecu: [0.1, 0.92, 0.92], low: [0.85, 0.66, 0.25], high: [0.85, 0.6, 1.55] };
  let p, tg;
  if (S[kind]) { const [vh, aim, cy] = S[kind]; tg = at(aim); p = g.P.clone().addScaledVector(dir, dist(vh * He)); p.y = g.P.y + cy * He; }
  else if (kind === 'top') { tg = at(0.3); p = tg.clone(); p.y += dist(1.5 * He); p.addScaledVector(new THREE.Vector3(Math.sin(g.yaw), 0, Math.cos(g.yaw)), 0.03); }
  else {
    const other = nearestOther(o); if (!other) { toast('Add a second person for this shot'); return; }
    const g2 = personGeom(other);
    if (kind === 'ots') {
      const fwd = new THREE.Vector3(g.P.x - g2.P.x, 0, g.P.z - g2.P.z).normalize(), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      p = g2.P.clone().addScaledVector(fwd, -0.75).addScaledVector(right, 0.36); p.y = g2.headY + 0.05;
      tg = new THREE.Vector3(g.P.x, g.headY - 0.06, g.P.z);
    } else {
      const mid = g.P.clone().add(g2.P).multiplyScalar(0.5), ab = new THREE.Vector3(g2.P.x - g.P.x, 0, g2.P.z - g.P.z);
      const span = ab.length() + 1.0, perp = new THREE.Vector3(-ab.z, 0, ab.x).normalize();
      if (perp.dot(new THREE.Vector3().fromArray(camState.p).sub(mid)) < 0) perp.negate();
      const He2 = (He + g2.top - g2.P.y) / 2;
      p = mid.clone().addScaledVector(perp, Math.max((span / 2) / Math.tan(hfov / 2), dist(1.15 * He2))); p.y = mid.y + 0.8 * He2;
      tg = new THREE.Vector3(mid.x, mid.y + 0.62 * He2, mid.z);
    }
  }
  writeCam({ p: p.toArray(), tg: tg.toArray() }, true);
  propsDirty = true;
  toast((SHOTS.find(x => x[0] === kind) || [, kind])[1] + ' on ' + o.name + (state.camera.keys.length ? ' (keyed at ' + snapT(T).toFixed(2) + ' s)' : ''));
}

/* ---- start / end frames ---- */
function camEnds() { const k = state.camera.keys; return { s: keyIndexAt(k, 0) >= 0, e: keyIndexAt(k, snapT(lastT())) >= 0 }; }
function setShotEnd(which) {
  const c = state.camera, pose = clone(evalCamRaw(T)), t = which === 'start' ? 0 : snapT(lastT());
  setKey(c.keys, t, pose);
  const st = camEnds();
  if (!(st.s && st.e)) {
    setTime(which === 'start' ? lastT() : 0);
    toast(which === 'start' ? 'Start saved. Now frame the END of the shot, then press Set end.' : 'End saved. Now frame the START of the shot, then press Set start.', MODE_TIP_MS);
  } else { setTime(0); setPlaying(true); toast('Start and end set. Playing the move.'); }
  changed(true, true);
}

/* ---- live camera recording ---- */
function startRecord() {
  if (rec) return;
  if (placing) commitPlacing(); if (pathMode) cancelPath();
  if (view !== 'camera') setView('camera');
  setPlaying(false); setTime(0, false);
  rec = { phase: 'count', until: performance.now() + 3000, samples: [], f: camState.f };
  pilotActive = true;
  showModeBar('Recording starts in 3 s. Steer with the mouse or W A S D Q E while the shot plays.', [['Cancel', cancelRecord]]);
}
function recSample() {
  if (!rec) return;
  rec.samples.push({ t: T, p: shotCam.position.toArray(), tg: camControls.target.toArray(), f: rec.f });
}
function cancelRecord() { rec = null; pilotActive = false; setPlaying(false); hideModeBar(); $('#countdown').textContent = ''; toast('Recording cancelled'); }
function finishRecord() {
  const r = rec; rec = null; pilotActive = false; setPlaying(false); hideModeBar(); $('#countdown').textContent = '';
  const S = r.samples; if (S.length < 4) { toast('Recording too short'); return; }
  const W = 4, sm = S.map((x, i) => {
    const o = { t: x.t, p: [0, 0, 0], tg: [0, 0, 0], f: 0 }; let n = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(S.length - 1, i + W); j++) { for (let k = 0; k < 3; k++) { o.p[k] += S[j].p[k]; o.tg[k] += S[j].tg[k]; } o.f += S[j].f; n++; }
    o.p = o.p.map(v => r4(v / n)); o.tg = o.tg.map(v => r4(v / n)); o.f = r4(o.f / n); return o;
  });
  const roll = camState.roll || 0, fd = camState.fd, step = 1 / 6, keys = [];
  let next = 0;
  for (const x of sm) if (x.t >= next - 1e-6) { keys.push({ t: snapT(x.t), p: x.p, tg: x.tg, f: x.f, roll, fd }); next = x.t + step; }
  const last = sm[sm.length - 1]; if (keys[keys.length - 1].t < snapT(last.t)) keys.push({ t: snapT(last.t), p: last.p, tg: last.tg, f: last.f, roll, fd });
  const c = state.camera; c.keys = []; for (const k of keys) setKey(c.keys, k.t, k);
  c.lookAtId = null; c.follow = false; c.feel = 'constant'; c.base = clone(keys[0]);
  setTime(0); changed(true, true); syncTopUI();
  toast('Camera move recorded (' + c.keys.length + ' keys). Press Space to watch it.', MODE_TIP_MS);
}

/* Re-times one track with map(t) and snaps it to frames so no two keys share a frame (A6).
   A clash moves forward a frame, or back if that would pass the last frame. Only when the track has
   more keys than frames do keys on the same frame merge (the later key's values win). */
function resnapKeys(keys, map) {
  if (!keys.length) return;
  const fps = state.settings.fps;
  keys.sort((a, b) => a.t - b.t);
  const want = keys.map(k => Math.round(map(k.t) * fps));
  const start = Math.min(0, want[0]), end = Math.max(frames() - 1, want[want.length - 1]);
  if (keys.length > end - start + 1) {
    const byFrame = new Map();
    keys.forEach((k, i) => { k.t = want[i] / fps; byFrame.set(want[i], k); });
    keys.splice(0, keys.length, ...byFrame.values());
    return;
  }
  const f = want.slice();
  for (let i = 1; i < f.length; i++) f[i] = Math.max(f[i], f[i - 1] + 1);
  f[f.length - 1] = Math.min(f[f.length - 1], end);
  for (let i = f.length - 2; i >= 0; i--) f[i] = Math.min(f[i], f[i + 1] - 1);
  keys.forEach((k, i) => { k.t = f[i] / fps; });
}
const resnapAll = map => { resnapKeys(state.camera.keys, map); state.objects.forEach(o => resnapKeys(o.keys, map)); };

/* ---- shot length presets (stretch animation to fit) ---- */
function setDuration(v) {
  if (exporting) return;
  v = clamp(v, 1, 120);
  const old = lastT(); state.settings.duration = v; const nw = lastT(), k = old > 0 ? nw / old : 1;
  if (Math.abs(k - 1) > 1e-6) {
    resnapAll(t => t * k);
    setTime(clamp(snapT(T * k), 0, nw));
  }
  changed(true, true); syncTopUI();
}
function setSimple(v) {
  simple = v; try { localStorage.setItem('shotref.simple', v ? '1' : '0'); } catch (e) { }
  document.body.classList.toggle('simple', v); updateGizmo(); propsDirty = true; syncTopUI();
}

/* ============================== commands ============================== */
let focusPick = false;
function startFocusPick() {
  ensureDof().on = true;
  if (view !== 'camera') setView('camera');
  focusPick = true; canvas.style.cursor = 'crosshair';
  toast('Click on what should be sharp');
}
function finishFocusPick(rc) {
  focusPick = false; canvas.style.cursor = '';
  const targets = [...views.values()].filter(v => v.group.visible).map(v => v.group);
  if (state.settings.groundOn) targets.push(ground);
  const hit = rc.intersectObjects(targets, true)[0];
  if (!hit) { toast('Nothing there to focus on'); return; }
  const fwd = new THREE.Vector3(); renderCam.getWorldDirection(fwd);
  const d = hit.point.clone().sub(renderCam.position).dot(fwd);
  ensureDof().auto = false;
  writeCam({ fd: d }, true); propsDirty = true;
  toast('Focus set to ' + d.toFixed(2) + ' m');
}
let lastWorkView = 'editor';
function setView(v) {
  if (v === 'top' && !topInit) {
    topInit = true; topControls.target.set(edControls.target.x, 0, edControls.target.z);
    topCam.position.set(topControls.target.x, 120, topControls.target.z); topCam.zoom = 1; topCam.updateProjectionMatrix();
  }
  if (v !== 'camera') lastWorkView = v;
  view = v;
  edControls.enabled = v === 'editor'; camControls.enabled = v === 'camera'; topControls.enabled = v === 'top';
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#vpTools').style.display = v !== 'camera' ? 'flex' : 'none';
  $('#camBar').style.display = v === 'camera' ? 'flex' : 'none';
  $('#bCamHere').style.display = v === 'editor' ? '' : 'none';
  $('#bPip').style.display = v !== 'camera' ? '' : 'none';
  if (focusPick && v !== 'camera') { focusPick = false; canvas.style.cursor = ''; }
  updateGizmo(); propsDirty = true;
}
function camToEditorView() {
  const p = edCam.position.toArray(), tg = edControls.target.toArray();
  writeCam({ p, tg }, true);
  toast('Camera placed at your editor view'); propsDirty = true;
}
function deleteSel() {
  if (!selected || selected === 'camera' || selected === 'target') return;
  const o = getObj(selected); if (!o) return;
  /* read the aim while the subject still exists, so the framing stays put (A11) */
  if (state.camera.lookAtId === o.id) { state.camera.base.tg = evalCam(T).tg; state.camera.lookAtId = null; state.camera.follow = false; }
  state.objects = state.objects.filter(x => x !== o);
  selected = null; syncScene(); updateGizmo(); changed(true, true); toast(o.name + ' deleted');
}
function duplicateSel() {
  const o = selected && getObj(selected); if (!o) return;
  const c = clone(o); c.id = uid(); c.name = nextName(catalogOf(o.type).label);
  const off = [0.8, 0, 0.4];
  c.base.p = c.base.p.map((v, i) => r4(v + off[i])); c.keys.forEach(k => { k.p = k.p.map((v, i) => r4(v + off[i])); });
  state.objects.push(c); syncScene(); select(c.id); changed(true, true); toast('Duplicated');
}
function dropToFloor() {
  const o = selected && getObj(selected), v = o && views.get(o.id); if (!v) return;
  v.group.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(v.group);
  if (bb.isEmpty()) return;
  const cur = clone(evalObj(o, T)); cur.p[1] = r4(cur.p[1] - bb.min.y); writeObj(o, cur, true);
}
function focusSel() {
  let c = null, rad = 2;
  if (selected === 'camera' || selected === 'target') { c = new THREE.Vector3().fromArray(selected === 'camera' ? camState.p : camState.tg); }
  else if (selected && views.get(selected)) { const bb = new THREE.Box3().setFromObject(views.get(selected).group); const sph = bb.getBoundingSphere(new THREE.Sphere()); c = sph.center; rad = Math.max(0.6, sph.radius); }
  if (!c) return;
  const dir = edCam.position.clone().sub(edControls.target).normalize();
  edControls.target.copy(c); edCam.position.copy(c).addScaledVector(dir, rad * 3.2);
}
const STARTERS = [
  ['empty', 'Empty stage', 'Just the floor and the camera.'],
  ['dialogue', 'Two-person dialogue', 'Two people facing each other, medium two-shot.'],
  ['walktalk', 'Walk and talk', 'Two people walking down a street, camera leading them.'],
  ['room', 'Living room', 'Sofa, coffee table and chair. One person sits, one stands.'],
  ['cafe', 'Café table', 'Two people seated across a small table.'],
  ['street', 'Street', 'Buildings, street lamps, a parked car and a passing car.'],
  ['marks', 'Blocking practice', 'One person and floor marks A, B and C.'],
];
function openStarters(firstLaunch = false) {
  const g = $('#startGrid'); g.innerHTML = '';
  /* first launch doubles as the welcome screen (branding/BRAND.md) */
  $('#startHead').style.display = firstLaunch ? '' : 'none';
  $('#mStartT').textContent = firstLaunch ? 'Start a shot' : 'Starter sets';
  $('#mStartP').textContent = firstLaunch ? 'Pick a starter set, or start from an empty stage. Everything in it can be moved, changed or deleted.' : 'Pick a ready-made layout. Everything in it can be moved, changed or deleted.';
  for (const [k, t, d] of STARTERS) g.append(h('button', { class: 'card', onclick: () => {
    closeModal(g);
    /* on first launch the scene is our sample, not the user's work: no replace question */
    if (!firstLaunch && platform.kind === 'desktop' && platform.isDirty()) guardUnsaved(() => loadStarter(k));
    else if (!firstLaunch && (state.objects.length || state.plate)) confirmBox('Replace the current scene?', 'Start from "' + t + '". You can undo this with Ctrl+Z.', () => loadStarter(k), 'Replace scene');
    else loadStarter(k);
  } }, h('b', null, t), h('small', null, d)));
  openModal('mStart');
}
/* Builds a new state with the scene helpers (they work on the global `state`), then puts the old one back. */
function buildState(fill) {
  const prev = state;
  state = defaultState();
  try { fill(); return state; } finally { state = prev; }
}
/* The one way to swap the whole scene. Keeps undo (pushes a step) and keeps old files in memory so undo can rebuild them.
   On any error the previous scene is put back and the error is rethrown. */
function replaceProject(newState, newAssets = {}, label) {
  const prev = { state, assets, selected, T, hist: hist.slice(), histFile: histFile.slice(), hi };
  try {
    for (const [id, a] of Object.entries(newAssets)) if (assets[id] && assets[id].b64 !== (a && a.b64)) dropModel(id);
    assets = { ...assets, ...newAssets };
    state = newState; selected = null; setTime(0);
    restore(snapshot()); pushHistory(); resetEditorCam();
    if (label) toast(label);
  } catch (e) {
    state = prev.state; assets = prev.assets; selected = prev.selected; setTime(prev.T); hist = prev.hist; histFile = prev.histFile; hi = prev.hi;
    try { restore(snapshot()); } catch (e2) { console.error('ShotRef: could not put the previous scene back', e2); }
    throw e;
  }
}
function loadStarter(kind) {
  let sel = null;
  const built = buildState(() => fillStarter(kind, id => { sel = id; }));
  replaceProject(built, {}, (STARTERS.find(x => x[0] === kind) || [, kind])[1] + ' ready');
  platform.newProject(); histFile[hi] = platform.getFile();
  if (sel) { selected = sel; propsDirty = true; updateGizmo(); }
}
function fillStarter(kind, selectId) {
  const L = snapT(lastT());
  const add = (type, pos, mod = {}) => {
    const o = makeObject(type, pos);
    if (type === 'person') o.color = SHIRTS[persons().length % SHIRTS.length];
    if (type === 'mark') { o.opts.letter = nextMarkLetter(); o.name = 'Mark ' + o.opts.letter; }
    if (mod.r) o.base.r = mod.r; if (mod.s) o.base.s = mod.s; if (mod.color) o.color = mod.color;
    if (mod.opts) Object.assign(o.opts, mod.opts);
    state.objects.push(o); return o;
  };
  const cam = (pp, tg, f = 35) => { state.camera.base = { p: pp, tg, f, roll: 0, fd: r4(dist3(pp, tg)) }; };
  const yawTo = (a, b) => r4(Math.atan2(b[0] - a[0], b[2] - a[2]) * R2D);
  const walk = (o, a, b) => { o.opts.pose = 'walk'; o.keys = [{ t: 0, p: a, r: [0, 0, 0], s: [1, 1, 1] }, { t: L, p: b, r: [0, 0, 0], s: [1, 1, 1] }]; };
  const BLD = ['#a9b0b8', '#c9b79c', '#9aa5a0', '#b8a3a0', '#cfc6b8'];
  const street = () => {
    state.settings.groundColor = '#6f736d'; state.settings.sunAz = 12; state.settings.sunEl = 58;
    let i = 0; for (const x of [-9.5, 9.5]) for (const z of [-30, -18, -6, 6, 18]) add('building', [x, 0, z], { s: [1, 0.55 + ((i * 37) % 9) / 10, 1.05], color: BLD[i++ % BLD.length] });
    for (const z of [-14, -4, 6, 16]) { add('lamp', [-4.2, 0, z], { r: [0, 90, 0] }); add('lamp', [4.2, 0, z + 5], { r: [0, -90, 0] }); }
  };
  switch (kind) {
    case 'empty': cam([3.4, 1.6, 6.2], [0, 1.1, 0]); break;
    case 'dialogue': {
      add('person', [-0.62, 0, 0], { r: [0, 90, 0] }); add('person', [0.62, 0, 0], { r: [0, -90, 0], opts: { height: 1.68, hair: '#5a3a22' } });
      add('tree', [-3.5, 0, -5]); add('wall', [1.5, 0, -4.5], { s: [2, 1, 1], color: '#d9d2c3' });
      cam([0.35, 1.5, 3.3], [0, 1.35, 0], 35); break;
    }
    case 'walktalk': {
      street();
      const A = add('person', [-0.4, 0, -5]), B = add('person', [0.4, 0, -5], { opts: { height: 1.68, hair: '#5a3a22' } });
      walk(A, [-0.4, 0, -5], [-0.4, 0, 2]); walk(B, [0.4, 0, -5], [0.4, 0, 2]);
      cam([0.4, 1.55, -1.7], [0, 1.3, -5], 32); state.camera.lookAtId = A.id; state.camera.follow = true;
      state.settings.env = 'overcast'; Object.assign(state.settings, ENV.overcast);
      break;
    }
    case 'room': {
      Object.assign(state.settings, ENV.studio, { env: 'studio' });
      add('plane', [0, 0, -0.4], { s: [2, 1, 1.7], color: '#9b7a5a' });
      add('wall', [0, 0, -3.8], { s: [2, 1, 1] }); add('wall', [-4, 0, -0.4], { r: [0, 90, 0], s: [1.7, 1, 1] });
      add('sofa', [0, 0, -3.1]); add('table', [0, 0, -1.9], { s: [0.7, 0.55, 0.75], color: '#6b4a32' });
      add('chair', [2.1, 0, -1.6], { r: [0, -55, 0] });
      add('person', [0, 0, -3.05], { opts: { pose: 'sit' } });
      const st = add('person', [2.0, 0, 0.4], { opts: { height: 1.68, hair: '#5a3a22' } }); st.base.r = [0, yawTo([2.0, 0, 0.4], [0, 0, -3.05]), 0];
      cam([2.7, 1.45, 3.0], [0, 0.95, -2.0], 28); break;
    }
    case 'cafe': {
      add('table', [0, 0, 0], { s: [0.6, 1, 1] });
      add('chair', [0, 0, -0.62]); add('chair', [0, 0, 0.62], { r: [0, 180, 0] });
      add('person', [0, 0, -0.6], { opts: { pose: 'talk' } }); add('person', [0, 0, 0.6], { r: [0, 180, 0], opts: { pose: 'sit', height: 1.68, hair: '#5a3a22' } });
      add('building', [0, 0, -12], { color: '#c9b79c', s: [1.6, 0.4, 0.6] }); add('tree', [-3, 0, -5]); add('tree', [3.5, 0, -6]);
      cam([2.1, 1.35, 0.9], [0, 1.0, -0.15], 35); break;
    }
    case 'street': {
      street();
      add('car', [2.6, 0, -3], { color: '#2f5d8a' }); add('tree', [3.6, 0, -12]); add('tree', [-3.8, 0, -16]);
      const car = add('car', [-1.6, 0, -25]); car.opts.faceTravel = true; car.keys = [{ t: 0, p: [-1.6, 0, -25], r: [0, 0, 0], s: [1, 1, 1] }, { t: L, p: [-1.6, 0, 25], r: [0, 0, 0], s: [1, 1, 1] }];
      const w = add('person', [3.4, 0, -4]); walk(w, [3.4, 0, -4], [3.4, 0, 3]);
      cam([-3.4, 1.6, 7.5], [1.5, 1.4, -3], 28); break;
    }
    case 'marks': {
      const pr = add('person', [0, 0, 0]);
      add('mark', [-2.2, 0, -1.5]); add('mark', [2.2, 0, -2]); add('mark', [0.5, 0, 2.2]);
      cam([3.6, 1.7, 6.4], [0, 1.0, -0.2], 30); selectId(pr.id); break;
    }
  }
}
function newProject(skipConfirm) {
  const go = () => replaceProject(buildState(seedScene), {}, 'New project');
  if (skipConfirm) go(); else confirmBox('Start a new project?', 'The current scene will be cleared. You can undo this with Ctrl+Z.', go, 'New project');
}
function seedScene() {
  const p = makeObject('person', [0, 0, 0]); p.base.r = [0, 20, 0];
  const t = makeObject('tree', [-3.5, 0, -4]);
  const b = makeObject('box', [2.2, 0, -1.5]); b.base.s = [0.8, 0.8, 0.8];
  state.objects.push(p, t, b);
}
function resetEditorCam() { edCam.position.set(7, 5, 10); edControls.target.set(0, 1, 0); }
/* Save (or Save as). On the web both download a new file; the desktop app writes back to the open file unless saveAs. */
let saving = false;
async function saveProject(saveAs = false) {
  if (saving) return { ok: false, busy: true };
  saving = true;
  try { return await doSaveProject(saveAs); } finally { saving = false; }
}
async function doSaveProject(saveAs) {
  /* only the files this scene uses (memory also keeps older ones for undo) */
  const used = {};
  for (const id of usedAssetIds(state)) if (assets[id]) used[id] = assets[id];
  const data = JSON.stringify({ app: 'ShotRef', version: FORMAT_VERSION, state, assets: used });
  const r = await platform.saveProject(data, { saveAs: saveAs === true, name: `shotref-${stamp()}.shotref` });
  if (r.ok) toast('Saved ' + (r.name || 'project'));
  else if (r.canceled) toast('Save cancelled');
  else toast("Couldn't save the project. Your changes are still here, so try again.", 5000);
  return r;
}
/* allowed values for list-type settings: a file with anything else gets the default (I1) */
const SETTING_ENUMS = {
  style: STYLES.map(x => x[0]), aspect: ASPECTS.map(x => x[0]), env: [...Object.keys(ENV), 'custom'],
  interp: ['smooth', 'linear', 'natural', 'ease'], guides: ['thirds', 'center', 'safe', 'none'],
};
const projectDefaults = () => ({ settings: DEFAULT_SETTINGS, camera: defaultState().camera, uid, enums: SETTING_ENUMS });
const BAD_FILE = "This isn't a ShotRef project, or the file is damaged.";
/* Open a .shotref / .json project (Open button, Ctrl+O, drag-drop and the desktop app's file events all come here). Asks first if the scene has anything in it.
   `file` is { name, path } when the desktop app knows where it came from. */
function loadProjectText(txt, file) {
  if (exporting) { toast('Wait for the export to finish.'); return; }
  let d;
  try { d = normalizeProject(JSON.parse(txt), projectDefaults()); }
  catch (e) { console.error('ShotRef: could not read the project file', e); toast(BAD_FILE, 4000); return; }
  const go = () => {
    try { replaceProject(d.state, d.assets, 'Project opened'); platform.setCurrent(file && file.name, file && file.path); histFile[hi] = platform.getFile(); }
    catch (e) { console.error('ShotRef: could not open the project', e); toast(BAD_FILE, 4000); }
  };
  if (platform.kind === 'desktop' && platform.isDirty()) guardUnsaved(go);
  else if (state.objects.length || state.plate) confirmBox('Open this file?', 'It will replace the current scene. You can undo this with Ctrl+Z.', go, 'Open file');
  else go();
}
function readFile(file, as) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; if (as === 'text') r.readAsText(file); else r.readAsArrayBuffer(file); }); }
async function importModel(file) {
  const buf = await readFile(file, 'buf');
  if (/\.gltf$/i.test(file.name)) { const txt = new TextDecoder().decode(buf); if (/"uri"\s*:\s*"(?!data:)/.test(txt)) { toast('This .gltf uses separate files. Please export it as a single .glb.', 4000); return; } }
  const id = uid(); assets[id] = { kind: 'model', name: file.name, b64: bufToB64(buf), mime: 'model/gltf-binary' };
  const o = addObject('model', { asset: id }, true);
  o.name = nextName(file.name.replace(/\.(glb|gltf)$/i, '')); changed(false, true); autosave(); if (placing === o.id) startPlacing(o.id);
}
async function importPlate(file) {
  if (file.type && !/^image\//.test(file.type)) { toast('Please pick an image file (JPG, PNG or WebP)'); return; }
  toast('Loading photo…', 8000);
  let c;
  try { c = await decodeToCanvas(file, 2560); }
  catch (e) { toast('Could not read that image. Try a JPG or PNG.', 4500); return; }
  const dataURL = c.toDataURL('image/jpeg', 0.9), b64 = dataURL.slice(dataURL.indexOf(',') + 1);
  const ia = c.width / c.height;
  const id = uid(); assets[id] = { kind: 'plate', name: file.name, b64, mime: 'image/jpeg', aspect: r4(ia) };
  const prev = state.plate || {};
  state.plate = { asset: id, overlay: prev.overlay ?? 0, export: prev.export ?? true, ground: prev.ground || 'shadow' };
  const close = ASPECTS.reduce((b, a) => Math.abs(Math.log(a[1] / ia)) < Math.abs(Math.log(b[1] / ia)) ? a : b);
  if (Math.abs(Math.log(close[1] / ia)) < 0.04 && close[0] !== state.settings.aspect) state.settings.aspect = close[0];
  select('camera'); setView('camera'); changed(true, true); syncTopUI();
  toast('Location photo loaded. Match the lens and camera height, then line up the floor.', 4500);
}
function plateSection() {
  const pl = state.plate, a = plateAsset();
  if (!pl || !a) return sec('Location photo',
    h('p', { class: 'note', style: 'margin:0 0 8px' }, 'Put a still of the real or AI-generated location behind the scene. Then block people and the camera on top of it.'),
    h('button', { class: 'primary', style: 'width:100%', onclick: () => $('#fPlate').click() }, 'Load location photo…'));
  const fa = arOf(state.settings.aspect), ia = a.aspect || 1.5;
  const close = ASPECTS.reduce((b, x) => Math.abs(Math.log(x[1] / ia)) < Math.abs(Math.log(b[1] / ia)) ? x : b);
  const thumb = h('img', { src: assetURL(pl.asset), style: 'width:100%;border-radius:6px;display:block;border:1px solid var(--line2)' });
  return sec('Location photo', thumb,
    slider('See-through', () => pl.overlay || 0, (v, cm) => { pl.overlay = v; changed(cm); }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    h('p', { class: 'note', style: 'margin:-2px 0 6px' }, 'Raise it to see the photo on top of your 3D scene while you line things up.'),
    selectRow('Ground', [['shadow', 'Shadows only (blend with photo)'], ['hide', 'Hidden'], ['solid', 'Solid 3D ground']], () => pl.ground || 'shadow', v => { pl.ground = v; changed(true); }),
    check('Include the photo in exports', () => pl.export !== false, v => { pl.export = v; changed(true); }),
    Math.abs(Math.log(fa / ia)) > 0.04 ? h('div', { class: 'row' }, h('span', { class: 'note', style: 'margin:0;flex:1' }, `The photo is ${close[0]}-ish; the frame is ${state.settings.aspect}, so the photo is cropped to fill it.`), h('button', { onclick: () => { state.settings.aspect = close[0]; changed(true, true); syncTopUI(); } }, 'Use ' + close[0])) : null,
    h('div', { class: 'btns' }, h('button', { onclick: () => $('#fPlate').click() }, 'Replace…'), h('button', { style: 'color:#ff9c9c', onclick: () => { state.plate = null; changed(true, true); toast('Location photo removed'); } }, 'Remove')),
    h('p', { class: 'note' }, 'How to match it: set the lens to roughly what the photo was shot with, and the camera at eye height (about 1.6 m) unless it was high or low. Then raise See-through and adjust until the 3D grid floor sits on the photo floor. Depth and Normals exports leave the photo out.'));
}
const NOT_IMAGE = "That file isn't an image. Use a JPG, PNG or WebP.";
async function importImage(file) {
  if (file.type && !/^image\//.test(file.type)) { toast(NOT_IMAGE, 4500); return; }
  const buf = await readFile(file, 'buf');
  const b64 = bufToB64(buf), mime = file.type || 'image/png';
  const img = new Image();
  await new Promise(r => { img.onload = r; img.onerror = r; img.src = 'data:' + mime + ';base64,' + b64; });
  if (!img.naturalWidth || !img.naturalHeight) { toast(NOT_IMAGE, 4500); return; }
  const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.5;
  const id = uid(); assets[id] = { kind: 'image', name: file.name, b64, mime };
  const o = addObject('image', { asset: id }, true);
  o.opts.aspect = r4(aspect); o.name = nextName(file.name.replace(/\.[^.]+$/, '')); syncScene(); changed(false, true); autosave(); if (placing === o.id) startPlacing(o.id);
}

/* ============================== export ============================== */
function exportSize() {
  const ar = arOf(state.settings.aspect), L = state.settings.size;
  let w, hh; if (ar >= 1) { w = L; hh = L / ar; } else { hh = L; w = L * ar; }
  const ev = x => Math.max(2, Math.round(x / 2) * 2);
  return { w: ev(w), h: ev(hh) };
}
let exRenderer = null;
function getExportRenderer(w, hh) {
  if (exRenderer) { let lost = false; try { lost = exRenderer.getContext().isContextLost(); } catch (e) { lost = true; } if (lost) { try { exRenderer.dispose(); } catch (e) { } exRenderer = null; } }
  if (!exRenderer) {
    const c = document.createElement('canvas');
    const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, preserveDrawingBuffer: true });
    c.addEventListener('webglcontextlost', ev => { ev.preventDefault(); if (exRenderer === r) { exRenderer = null; setTimeout(() => { try { r.dispose(); } catch (e) { } }, 0); } });
    configureRenderer(r); r.setPixelRatio(1); exRenderer = r;
  }
  exRenderer.setSize(w, hh, false);
  return exRenderer;
}
function renderExportFrame(r, t, w, hh) {
  applyAll(t); prepRenderCam(t);
  r.setViewport(0, 0, w, hh); r.setScissorTest(false);
  exportingRender = true;
  try { shotPass(r, w, hh); } finally { exportingRender = false; }
}
function canvasBlob(c, type = 'image/png') { return new Promise(res => c.toBlob(res, type)); }
const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
async function exportPNG(t, label) {
  if (exporting) { toast('Wait for the export to finish.'); return false; }
  const { w, h: hh } = exportSize();
  let blob = null;
  try {
    const r = getExportRenderer(w, hh);
    renderExportFrame(r, t, w, hh);
    blob = await canvasBlob(r.domElement);
  } catch (e) { console.error(e); }
  applyAll(T);
  if (!blob) { toast('Could not make that frame. Try a smaller export size.', 4000); return false; }
  const fr = Math.round(t * state.settings.fps) + 1;
  await saveFile(`shotref-${label || 'frame' + String(fr).padStart(4, '0')}-${state.settings.style}-${stamp()}.png`, blob);
  return true;
}
/* ---- copy the current camera frame to the clipboard ---- */
function renderFrameBlob(t) {
  const { w, h: hh } = exportSize(), r = getExportRenderer(w, hh);
  renderExportFrame(r, t, w, hh);
  const p = canvasBlob(r.domElement);
  applyAll(T);
  return p;
}
function copyFrame() {
  if (exporting) { toast('Wait for the export to finish.'); return; }
  setPlaying(false);
  let blobP;
  try { blobP = renderFrameBlob(T); } catch (e) { toast('Could not render the frame'); return; }
  // ClipboardItem is created synchronously inside the click so the browser keeps the user gesture
  let writeP;
  try {
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') throw new Error('unsupported');
    writeP = navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]);
  } catch (e) { writeP = Promise.reject(e); }
  writeP.then(() => {
    const { w, h: hh } = exportSize();
    toast(`Frame copied (${w}×${hh}, ${(STYLES.find(x => x[0] === state.settings.style) || STYLES[0])[1]}). Paste it anywhere with Ctrl+V.`, 3500);
  }).catch(async () => {
    const blob = await blobP; if (!blob) { toast('Could not copy the frame'); return; }
    const url = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    $('#copyImg').src = url; copyBlob = blob; openModal('mCopy');
  });
}
let copyBlob = null;
let exCancel = false, exporting = false;
async function pickCodec(w, hh, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  const br = Math.round(clamp(w * hh * fps * 0.22, 4e6, 60e6));
  for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.4d0028', 'avc1.42e033', 'avc1.42001f']) {
    const cfg = { codec, width: w, height: hh, bitrate: br, framerate: fps, avc: { format: 'avc' } };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch (e) { }
    try { const s = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: 'prefer-software' }); if (s.supported) return { ...cfg, hardwareAcceleration: 'prefer-software' }; } catch (e) { }
  }
  return null;
}
/* While a video renders nothing in the export dialog may change; only Cancel stays live. */
function setExportLock(on) {
  $$('#mExport input, #mExport select, #mExport button').forEach(el => { if (el.id !== 'exCancel') el.disabled = on; });
  // make everything outside the export dialog unreachable by Tab, Enter or Space
  for (const el of document.body.children) if (el.id !== 'mExport' && el.id !== 'toast' && el.tagName !== 'SCRIPT') el.inert = on;
  if (on) { const c = $('#exCancel'); if (c && !c.hidden) c.focus(); else if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
}
function exProgress(frac, txt) { $('#exBar').style.width = (frac * 100).toFixed(1) + '%'; $('#exTxt').textContent = txt; }
async function exportVideo() {
  if (exporting) return;
  exporting = true; exCancel = false;
  const saveT = T;
  let enc = null, vf = null; /* closed in finally if the loop fails (C8) */
  try {
    setPlaying(false); setExportLock(true);
    const { w, h: hh } = exportSize(), fps = state.settings.fps, N = frames();
    $('#exProg').hidden = false; $('#exCancel').hidden = false; exProgress(0, 'Starting…'); $('#exCancel').focus();
    const r = getExportRenderer(w, hh);
    const cfg = await pickCodec(w, hh, fps);
    if (cfg) {
      const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: hh, frameRate: fps }, fastStart: 'in-memory' });
      let encErr = null;
      enc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: e => { encErr = e; } });
      try { enc.configure(cfg); } catch (e) { e.mp4 = true; throw e; }
      for (let i = 0; i < N; i++) {
        if (exCancel) break; if (encErr) { encErr.mp4 = true; throw encErr; }
        if (r.getContext().isContextLost()) throw new Error('Graphics context lost');
        renderExportFrame(r, i / fps, w, hh);
        vf = new VideoFrame(r.domElement, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close(); vf = null;
        while (enc.encodeQueueSize > 6) await new Promise(res => setTimeout(res, 2));
        if (i % 2 === 0) { exProgress((i + 1) / N, `Rendering frame ${i + 1} of ${N}…`); await new Promise(res => setTimeout(res, 0)); }
      }
      if (exCancel) { try { enc.close(); } catch (e) { } toast('Export cancelled'); return; }
      exProgress(1, 'Finishing the MP4…');
      try { await enc.flush(); enc.close(); muxer.finalize(); } catch (e) { e.mp4 = true; throw e; }
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      if (blob.size < 1024) { const e = new Error('MP4 came out empty (' + blob.size + ' bytes)'); e.mp4 = true; throw e; }
      exProgress(1, 'Done: ' + (blob.size < 0.1 * 1048576 ? Math.max(1, Math.round(blob.size / 1024)) + ' KB' : (blob.size / 1048576).toFixed(1) + ' MB'));
      await saveFile(`shotref-${state.settings.style}-${w}x${hh}-${fps}fps-${stamp()}.mp4`, blob);
    } else {
      // fallback: WebM in real time
      const c = r.domElement;
      if (!c.captureStream || typeof MediaRecorder === 'undefined') { const e = new Error('This browser cannot record video. Please use Chrome or Edge.'); e.plain = true; throw e; }
      const stream = c.captureStream(0), track = stream.getVideoTracks()[0];
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 }); const parts = [];
      rec.ondataavailable = e => e.data.size && parts.push(e.data);
      const stopped = new Promise(res => rec.onstop = res);
      rec.start();
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        if (exCancel) break;
        if (r.getContext().isContextLost()) throw new Error('Graphics context lost');
        renderExportFrame(r, i / fps, w, hh); track.requestFrame && track.requestFrame();
        exProgress((i + 1) / N, `Recording frame ${i + 1} of ${N} (real time)…`);
        const due = t0 + (i + 1) * 1000 / fps; await new Promise(res => setTimeout(res, Math.max(0, due - performance.now())));
      }
      rec.stop(); await stopped;
      if (exCancel) { toast('Export cancelled'); return; }
      const blob = new Blob(parts, { type: 'video/webm' });
      if (blob.size < 1024) throw new Error('WebM came out empty (' + blob.size + ' bytes)');
      await saveFile(`shotref-${state.settings.style}-${w}x${hh}-${stamp()}.webm`, blob);
    }
  } catch (e) {
    console.error(e);
    const msg = e && e.plain ? e.message : e && e.mp4 ? "Your PC couldn't make an MP4 at this size. Try 1280 px, or use Start + end frames." : 'The export stopped because of an error. Try again, or try a smaller size.';
    toast(msg, 6000); exProgress(0, msg);
  } finally {
    if (vf) { try { vf.close(); } catch (e) { } }
    if (enc && enc.state !== 'closed') { try { enc.close(); } catch (e) { } }
    if (exCancel) exProgress(0, '');
    exporting = false; exCancel = false; $('#exCancel').hidden = true; setTime(saveT, false); applyAll(T); setExportLock(false);
    if (!$('#mExport').classList.contains('hidden')) $('#exVideo').focus(); /* Cancel just hid itself; keep focus in the dialog (M8) */
  }
}
function renderExportDialog() {
  const s = state.settings, { w, h: hh } = exportSize();
  $('#exSum').innerHTML = `<b>${w}×${hh}</b> · ${s.aspect} · <b>${s.fps} fps</b> · ${s.duration.toFixed(1)} s · ${frames()} frames`;
  $('#exAspect').value = s.aspect; $('#exSize').value = String(s.size);
  const st = $('#exStyles'); st.innerHTML = '';
  for (const [k, l, d, bg] of STYLES) st.append(h('button', { class: s.style === k ? 'on' : '', onclick: () => { s.style = k; changed(true); renderExportDialog(); syncTopUI(); } }, h('div', { class: 'sw', style: 'background:' + bg }), h('b', null, l), h('small', null, d)));
  const dr = $('#exDepthRow'); dr.innerHTML = '';
  if (s.style === 'depth') {
    const r = depthRange();
    dr.append(check('Auto depth range', () => s.depthAuto, v => { s.depthAuto = v; if (!v) { s.depthNear = r.near; s.depthFar = r.far; } changed(true); renderExportDialog(); }));
    if (!s.depthAuto) dr.append(h('div', { style: 'display:flex;gap:6px;flex:1' }, numField('Near', () => s.depthNear, (v, c) => { s.depthNear = v; changed(c); }, { step: 0.05, min: 0 }), numField('Far', () => s.depthFar, (v, c) => { s.depthFar = v; changed(c); }, { step: 0.1, min: 0.2 })));
    else dr.append(h('span', { class: 'note', style: 'margin:0' }, `${r.near.toFixed(1)} m to ${r.far.toFixed(1)} m`));
    dr.style.display = 'flex';
  } else dr.style.display = 'none';
  $('#exGrid').checked = s.exportGrid;
  if (exporting) setExportLock(true);
}

/* ============================== modals ============================== */
const openModals = () => $$('.modal').filter(m => !m.classList.contains('hidden'));
/* buttons, fields and rows a keyboard user can reach inside a dialog */
const focusables = m => [...m.querySelectorAll('button, select, input, textarea, [tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
let modalReturn = null;
function openModal(id) {
  const m = $('#' + id), ae = document.activeElement;
  if (!openModals().length && ae && ae !== document.body) modalReturn = ae;
  m.classList.remove('hidden');
  if (id === 'mExport') { $('#exProg').hidden = !exporting; renderExportDialog(); }
  placeToast();
  if (exporting && id === 'mExport') return; /* the export lock owns focus */
  /* the main button, else the first real control: the × only when there is nothing else (K6) */
  const f = m.querySelector('button.primary:not(:disabled)') || focusables(m).find(el => !el.hasAttribute('data-close')) || focusables(m)[0];
  if (f) f.focus();
}
function closeModal(el) {
  const m = el.closest('.modal'); if (exporting && m.id === 'mExport') return;
  m.classList.add('hidden'); placeToast();
  if (!openModals().length && modalReturn) { const r = modalReturn; modalReturn = null; if (r.isConnected && !r.closest('.modal')) r.focus(); }
}
/* Tab and Shift+Tab cycle inside the topmost open dialog (U4) */
function trapTab(e) {
  const all = openModals(), m = all[all.length - 1]; if (!m) return false;
  const f = focusables(m); e.preventDefault();
  if (!f.length) return true;
  const i = f.indexOf(document.activeElement);
  const n = i < 0 ? (e.shiftKey ? f.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + f.length) % f.length;
  f[n].focus();
  return true;
}
let cfCb = null;
let cfAltCb = null;
/* desktop: before replacing the project, offer to save unsaved changes (Save / Don't save / Cancel) */
function guardUnsaved(go) {
  const nm = platform.currentName();
  confirmBox('Save changes first?', (nm ? '"' + nm + '" has' : 'This project has') + ' changes that are not saved. Opening something else replaces it.',
    async () => { const r = await saveProject(false); if (r.ok) go(); }, 'Save', { label: "Don't save", cb: go });
}
/* alt = { label, cb } adds a middle button (used for "Don't save") */
function confirmBox(title, text, cb, okLabel = 'OK', alt = null) {
  $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfOk').textContent = okLabel; cfCb = cb;
  cfAltCb = alt && alt.cb; $('#cfAlt').textContent = alt ? alt.label : ''; $('#cfAlt').style.display = alt ? '' : 'none';
  openModal('mConfirm');
}
/* the one way to pick a project to open: native dialog on desktop, the file picker on the web */
async function openDialog() {
  if (exporting) { toast('Wait for the export to finish.'); return; }
  const f = await platform.openProject($('#fOpen'));
  if (f && typeof f.text === 'string') loadProjectText(f.text, f);
}
/* The desktop window asked to close. Nothing unsaved: allow it. Otherwise ask, and only allow it once it is safe. */
function closeRequested() {
  if (exporting) { toast('Wait for the export to finish before closing.', 4000); return; }
  if (!platform.isDirty()) { platform.closeOk(); return; }
  const nm = platform.currentName();
  confirmBox('Save changes before closing?', (nm ? '"' + nm + '" has' : 'This project has') + ' changes that are not saved.',
    async () => { const r = await saveProject(false); if (r.ok) platform.closeOk(); }, 'Save',
    { label: "Don't save", cb: () => platform.closeOk() });
}
/* menu clicks from the desktop app's native menu */
function onDesktopMenu(cmd) {
  if (cmd === 'close-request') { closeRequested(); return; }
  if (exporting) { toast('Wait for the export to finish.'); return; }
  if (cmd === 'new') openStarters();
  else if (cmd === 'open') openDialog();
  else if (cmd === 'save') saveProject(false);
  else if (cmd === 'save-as') saveProject(true);
}

/* ============================== wiring ============================== */
function syncTopUI() {
  $('#inDur').value = state.settings.duration; $('#inFps').value = String(state.settings.fps);
  $$('#lenSet [data-len]').forEach(b => b.classList.toggle('on', +b.dataset.len === state.settings.duration));
  $$('#feelBar button').forEach(b => b.classList.toggle('on', b.dataset.feel === (state.camera.feel || 'gentle')));
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', (b.dataset.m === 'simple') === simple));
  $('#bLoop').classList.toggle('on', !!state.settings.loop);
  $('#bGrid').classList.toggle('on', !!state.settings.gridOn);
  $('#bPip').classList.toggle('on', pipOn);
  $('#bSnapGrid').classList.toggle('on', snapOn);
  drawGuides();
}
function wire() {
  buildAddPanel();
  $('#bNew').onclick = () => openStarters();
  $$('#modeSeg button').forEach(b => b.onclick = () => setSimple(b.dataset.m === 'simple'));
  $$('#lenSet [data-len]').forEach(b => b.onclick = () => setDuration(+b.dataset.len));
  $$('#feelBar button').forEach(b => b.onclick = () => { state.camera.feel = b.dataset.feel; changed(true, true); syncTopUI(); });
  $('#cbStart').onclick = () => setShotEnd('start'); $('#cbEnd').onclick = () => setShotEnd('end'); $('#cbRec').onclick = startRecord;
  $('#bOpen').onclick = openDialog;
  $('#bSave').onclick = () => saveProject(false);
  $('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
  $$('#viewSeg button').forEach(b => b.onclick = () => setView(b.dataset.v));
  $('#bHelp').onclick = () => openModal('mHelp');
  $('#stHelp').onclick = () => { closeModal($('#stHelp')); openModal('mHelp'); };
  $('#bSnap').onclick = () => exportPNG(T);
  $('#bCopy').onclick = copyFrame; $('#cbCopy').onclick = copyFrame; $('#exCopy').onclick = copyFrame;
  $('#copySave').onclick = () => { if (copyBlob) { const fr = Math.round(T * state.settings.fps) + 1; saveFile(`shotref-frame${String(fr).padStart(4, '0')}-${state.settings.style}-${stamp()}.png`, copyBlob); } closeModal($('#copySave')); };
  $('#bExport').onclick = () => openModal('mExport');
  $$('#vpTools [data-g]').forEach(b => b.onclick = () => setGizmoMode(b.dataset.g));
  $('#bSnapGrid').onclick = () => { snapOn = !snapOn; updateGizmo(); syncTopUI(); };
  $('#bFocus').onclick = focusSel;
  $('#bCamHere').onclick = camToEditorView;
  $('#bPip').onclick = () => { pipOn = !pipOn; syncTopUI(); };
  $('#bGrid').onclick = () => { state.settings.gridOn = !state.settings.gridOn; applyEnv(); changed(true, true); syncTopUI(); };
  $('#pipFrame').onclick = () => setView('camera');
  $('#bPlay').onclick = () => { if (!playing && T >= lastT() - 1e-6) setTime(0); setPlaying(!playing); };
  $('#bStart').onclick = () => setTime(0);
  $('#bEnd').onclick = () => setTime(lastT());
  $('#bPrevKey').onclick = () => jumpKey(-1); $('#bNextKey').onclick = () => jumpKey(1);
  $('#bKey').onclick = addKeySel; $('#bUnkey').onclick = removeKeySel;
  $('#bLoop').onclick = () => { state.settings.loop = !state.settings.loop; syncTopUI(); changed(true); };
  $('#inDur').onchange = e => {
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) { syncTopUI(); toast('Type the shot length in seconds, for example 5.'); return; }
    if (v < 1) toast('1 s is the minimum shot length, so it was set to 1 s.', 3500);
    else if (v > 120) toast('120 s is the maximum shot length, so it was set to 120 s.', 3500);
    setDuration(v);
  };
  $('#inFps').onchange = e => { if (exporting) return; state.settings.fps = +e.target.value; setTime(snapT(T)); resnapAll(t => t); changed(true, true); };
  for (const inp of ['#inDur']) $(inp).addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
  // files
  $('#fOpen').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadProjectText(await readFile(f, 'text')); };
  $('#fModel').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importModel(f); };
  $('#fImage').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importImage(f); };
  $('#fPlate').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPlate(f); };
  $('#cbPlate').onclick = () => { if (plateAsset()) { select('camera'); toast('Location photo settings are in the Camera panel'); } else $('#fPlate').click(); };
  // drag & drop
  const drop = $('#drop');
  vpEl.addEventListener('dragover', e => { e.preventDefault(); drop.style.display = 'flex'; });
  vpEl.addEventListener('dragleave', e => { if (e.target === drop) drop.style.display = 'none'; });
  /* a file dropped anywhere else must not make the browser open it and leave ShotRef (C7) */
  const hasFiles = e => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e) && !e.defaultPrevented) { e.preventDefault(); toast('Drop files on the 3D view to add them.'); } });
  vpEl.addEventListener('drop', async e => {
    e.preventDefault(); drop.style.display = 'none';
    for (const f of e.dataTransfer.files) {
      if (/\.(glb|gltf)$/i.test(f.name)) await importModel(f);
      else if (/^image\//.test(f.type)) { if (view === 'camera') await importPlate(f); else await importImage(f); }
      else if (/\.(json|shotref)$/i.test(f.name)) loadProjectText(await readFile(f, 'text'), { name: f.name });
    }
  });
  // modals
  $$('[data-close]').forEach(b => b.onclick = () => closeModal(b));
  $$('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m && !exporting) { e.preventDefault(); closeModal(m); } })); /* preventDefault: the click must not move focus to the page (K3) */
  $('#cfOk').onclick = () => { closeModal($('#cfOk')); cfCb && cfCb(); };
  $('#cfAlt').onclick = () => { closeModal($('#cfAlt')); cfAltCb && cfAltCb(); };
  platform.onMenu(onDesktopMenu);
  platform.onOpenFile(f => { if (f && typeof f.text === 'string') loadProjectText(f.text, f); });
  $('#exAspect').append(...ASPECTS.map(a => h('option', { value: a[0] }, a[2])));
  $('#exSize').append(...SIZES.map(s => h('option', { value: s[0] }, s[1])));
  $('#exAspect').onchange = e => { state.settings.aspect = e.target.value; changed(true, true); renderExportDialog(); };
  $('#exSize').onchange = e => { state.settings.size = +e.target.value; changed(true, true); renderExportDialog(); };
  $('#exGrid').onchange = e => { state.settings.exportGrid = e.target.checked; changed(true); };
  $('#exVideo').onclick = exportVideo;
  $('#exFrame').onclick = () => exportPNG(T);
  $('#exEnds').onclick = async () => { if (!(await exportPNG(0, 'start'))) return; await new Promise(r => setTimeout(r, 400)); await exportPNG(lastT(), 'end'); };
  $('#exCancel').onclick = () => { exCancel = true; };

  // viewport pointer handling: click to place, drag on the floor, turn ring, paths, picking
  let pdown = null, drag = null, hoverT = 0;
  canvas.addEventListener('pointerdown', e => {
    canvas.focus(); gizmoUsed = false;
    pdown = { x: e.clientX, y: e.clientY, b: e.button };
    if (placing) { e.stopImmediatePropagation(); if (e.button === 0) { movePlacing(e); commitPlacing(); } else cancelPlacing(); pdown = null; return; }
    if (pathMode) {
      e.stopImmediatePropagation();
      const rc = rayFromEvent(e);
      if (e.button === 0 && rc) { const g = planeHit(rc, pathMode.y); if (g) addPathPoint(g); } else if (e.button === 2) removePathPoint();
      pdown = null; return;
    }
    if (focusPick && view === 'camera') { e.stopImmediatePropagation(); const rc = rayFromEvent(e); if (e.button === 0 && rc) finishFocusPick(rc); pdown = null; return; }
    if (rec || e.button !== 0 || view === 'camera' || gizmo.axis) return;
    const rc = rayFromEvent(e); if (!rc) return;
    const hit = pickAt(rc); if (!hit) return;
    e.stopImmediatePropagation();
    if (playing) setPlaying(false);
    if (hit.id === 'ring') {
      const o = getObj(selected), v = views.get(selected); if (!o || !v) return;
      const y = ringGrp.position.y, g = planeHit(rc, y) || hit.point;
      drag = { kind: 'rot', id: selected, py: y, cx: ringGrp.position.x, cz: ringGrp.position.z, a0: Math.atan2(g.x - ringGrp.position.x, g.z - ringGrp.position.z), yaw0: v.group.rotation.y * R2D };
      if (o.opts.faceTravel && o.keys.length > 1) { o.opts.faceTravel = false; toast('Turning by hand, so "face the way they travel" is now off'); }
    } else {
      if (selected !== hit.id) select(hit.id);
      const pos = hit.id === 'camera' ? camState.p : hit.id === 'target' ? camState.tg : evalObj(getObj(hit.id), T).p;
      const py = hit.point.y, g = planeHit(rc, py) || hit.point;
      drag = { kind: 'move', id: hit.id, py, ox: g.x - pos[0], oz: g.z - pos[2] };
    }
    drag.sx = e.clientX; drag.sy = e.clientY; drag.moved = false;
    gizmo.enabled = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
  }, { capture: true });
  canvas.addEventListener('pointermove', e => {
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
      drag.moved = true; canvas.style.cursor = 'grabbing';
      const rc = rayFromEvent(e); if (!rc) return;
      const g = planeHit(rc, drag.py); if (!g) return;
      if (drag.kind === 'rot') {
        let yaw = drag.yaw0 + (Math.atan2(g.x - drag.cx, g.z - drag.cz) - drag.a0) * R2D;
        if (snapOn) yaw = Math.round(yaw / 15) * 15;
        const o = getObj(drag.id), cur = clone(evalObj(o, T)); cur.r[1] = yaw; writeObj(o, cur, false);
      } else {
        const nx = snapV(g.x - drag.ox), nz = snapV(g.z - drag.oz);
        if (drag.id === 'camera') writeCam({ p: [nx, camState.p[1], nz] }, false);
        else if (drag.id === 'target') writeCam({ tg: [nx, camState.tg[1], nz] }, false);
        else { const o = getObj(drag.id), cur = clone(evalObj(o, T)); cur.p = [nx, cur.p[1], nz]; writeObj(o, cur, false); }
      }
      return;
    }
    if (placing) { movePlacing(e); return; }
    if (pathMode) { const rc = rayFromEvent(e), g = rc && planeHit(rc, pathMode.y); pathMode.cursor = g ? [g.x, g.z] : null; return; }
    if (!e.buttons && view !== 'camera' && !focusPick && performance.now() - hoverT > 50) {
      hoverT = performance.now();
      const rc = rayFromEvent(e), hit = rc && !gizmo.axis && pickAt(rc);
      canvas.style.cursor = hit ? (hit.id === 'ring' ? 'ew-resize' : 'grab') : '';
    }
  });
  /* a drag ends on mouse-up, or when the browser cuts it off (pointercancel, lost capture): either way it is saved (K2) */
  const endDrag = e => {
    const d = drag; drag = null; gizmo.enabled = true; canvas.style.cursor = '';
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { }
    if (d.moved) changed(true, true);
    pdown = null;
  };
  const cutOff = e => {
    if (drag) endDrag(e);
    pdown = null;
    /* the move/rotate/scale arrows only listen for pointerup */
    if (gizmo.dragging) { canvas.removeEventListener('pointermove', gizmo._onPointerMove); gizmo.pointerUp(null); }
  };
  canvas.addEventListener('pointercancel', cutOff);
  canvas.addEventListener('lostpointercapture', e => { if (drag) endDrag(e); });
  canvas.addEventListener('pointerup', e => {
    if (drag) { endDrag(e); return; }
    if (!pdown || pdown.b !== 0) { pdown = null; return; }
    const moved = Math.hypot(e.clientX - pdown.x, e.clientY - pdown.y) > 4; pdown = null;
    if (moved || gizmoUsed || gizmo.dragging || rec) return;
    const rc = rayFromEvent(e); if (!rc) return;
    const hit = pickAt(rc);
    if (!hit) select(null); else if (hit.id !== 'ring') select(hit.id);
  });
  canvas.addEventListener('dblclick', () => { if (pathMode) finishPath(); else if (view !== 'camera' && selected) focusSel(); });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    if (view === 'camera' && (e.altKey || e.ctrlKey)) {
      e.preventDefault(); e.stopImmediatePropagation();
      const f = clamp(camState.f * Math.pow(1.0015, -e.deltaY), 8, 300);
      if (rec) { rec.f = f; return; }
      writeCam({ f }, false); clearTimeout(wheelTimer); wheelTimer = setTimeout(() => changed(true), 350);
    }
  }, { capture: true, passive: false });
  let wheelTimer;
  camControls.addEventListener('start', () => { pilotActive = true; if (playing && !rec) setPlaying(false); });
  camControls.addEventListener('change', () => { if (pilotActive && !rec) writeCam({ p: shotCam.position.toArray(), tg: camControls.target.toArray() }, false); });
  camControls.addEventListener('end', () => { if (rec) return; pilotActive = false; changed(true); });

  // keyboard
  window.addEventListener('keydown', e => {
    if (exporting) { if (e.key === 'p' || e.key === 'P' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c')) toast('Wait for the export to finish.'); return; }
    if (e.key === 'Tab' && trapTab(e)) return;
    if (isTyping()) return;
    const ae = document.activeElement;
    if (ae && (ae.type === 'range' || ae.tagName === 'SELECT') && /^(Arrow|Home|End|Page)/.test(e.key)) return;
    /* Delete/Backspace never delete the selection while a field, slider or dropdown has focus (U5) */
    if (isField(ae) && (e.key === 'Delete' || e.key === 'Backspace')) return;
    const om = openModals();
    if (om.length) {
      if (e.key === 'Escape') om.forEach(m => closeModal(m));
      /* Enter = OK in the confirm box, unless a button there has focus (then that button runs) */
      else if (e.key === 'Enter' && om[om.length - 1].id === 'mConfirm' && !(ae && ae.tagName === 'BUTTON' && ae.closest('#mConfirm'))) { e.preventDefault(); $('#cfOk').click(); }
      return;
    }
    /* a focused dropdown outside dialogs: the shortcut runs, but the browser's type-ahead must not change its choice */
    if (ae && ae.tagName === 'SELECT' && e.key.length === 1 && !e.ctrlKey && !e.metaKey) e.preventDefault();
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); saveProject(e.shiftKey); }
      else if (k === 'o') { e.preventDefault(); openDialog(); }
      else if (k === 'd') { e.preventDefault(); duplicateSel(); }
      else if (k === 'c' && !e.shiftKey && !(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyFrame(); }
      return;
    }
    if (view === 'camera' && 'wasdqe'.includes(k) && k.length === 1) { flyKeys.add(k); if (e.shiftKey) flyKeys.add('shift'); e.preventDefault(); return; }
    if (k === 'escape' && (rec || placing || pathMode)) { if (rec) cancelRecord(); else if (placing) cancelPlacing(); else cancelPath(); return; }
    if (pathMode && (k === 'enter')) { finishPath(); return; }
    if (pathMode && (k === 'backspace' || k === 'delete')) { e.preventDefault(); removePathPoint(); return; }
    if (rec && k !== ' ') return;
    if (k === ' ') { e.preventDefault(); if (rec) return; $('#bPlay').click(); }
    else if (k === 'c') setView(view === 'camera' ? lastWorkView : 'camera');
    else if (k === 't') setView(view === 'top' ? 'editor' : 'top');
    else if (k === 'w') setGizmoMode('translate');
    else if (k === 'e') setGizmoMode('rotate');
    else if (k === 'r') setGizmoMode('scale');
    else if (k === 'k') addKeySel();
    else if (k === 'f') focusSel();
    else if (k === 'p') exportPNG(T);
    else if (k === 'delete' || k === 'backspace') deleteSel();
    else if (k === 'escape') { if (focusPick) { focusPick = false; canvas.style.cursor = ''; } else select(null); }
    else if (k === 'home') setTime(0);
    else if (k === 'end') setTime(lastT());
    else if (k === 'arrowright' || k === '.') { e.preventDefault(); setTime(clamp(snapT(T + (e.shiftKey ? 10 : 1) / state.settings.fps), 0, lastT())); }
    else if (k === 'arrowleft' || k === ',') { e.preventDefault(); setTime(clamp(snapT(T - (e.shiftKey ? 10 : 1) / state.settings.fps), 0, lastT())); }
    else if (k === '?') openModal('mHelp');
  });
  window.addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (k === 'shift') flyKeys.delete('shift');
    if (flyKeys.delete(k) && ![...flyKeys].some(x => x !== 'shift')) { flyKeys.clear(); if (!rec) { pilotActive = false; changed(true); } }
  });
  window.addEventListener('blur', () => { if (flyKeys.size) { flyKeys.clear(); if (!rec) { pilotActive = false; changed(true); } } });
  new ResizeObserver(() => { uiDirty = true; }).observe($('#tlBody'));
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup']) window.addEventListener(ev, pokeRender, { capture: true, passive: true });
}

/* asset ids a (maybe cut-off) autosave text lists */
function brokenAssetIds(raw) {
  if (!raw) return [];
  try { const d = JSON.parse(raw); if (Array.isArray(d.assetIds)) return d.assetIds.filter(x => typeof x === 'string'); } catch (e) { }
  const m = /"assetIds"\s*:\s*\[([^\]]*)\]/.exec(raw.slice(0, 200000));
  if (!m) return [];
  try { const a = JSON.parse('[' + m[1] + ']'); return a.filter(x => typeof x === 'string'); } catch (e) { return []; }
}
/* ============================== boot ============================== */
function boot() {
  let restored = false, broken = false, raw = null;
  probeStorage();
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (e) { }
  if (raw) {
    try { const d = normalizeProject(JSON.parse(raw), projectDefaults()); state = d.state; assets = { ...d.assets }; restored = true; }
    catch (e) { broken = true; console.error('ShotRef: could not read the autosave', e); }
  }
  if (!restored) seedScene();
  wire();
  try { syncScene(); applyEnv(); }
  catch (e) {
    if (!restored) throw e;
    console.error('ShotRef: could not rebuild the autosaved scene', e);
    restored = false; broken = true;
    state = defaultState(); assets = {}; for (const id of [...modelCache.keys()]) dropModel(id); seedScene();
    syncScene(); applyEnv();
  }
  /* move (not copy) the broken autosave aside: a big one would not fit twice */
  if (broken) {
    try { localStorage.removeItem('shotref.autosave'); localStorage.setItem('shotref.autosave.broken', raw); }
    catch (e) { console.error('ShotRef: could not keep a copy of the broken autosave', e); }
  }
  pushHistory(); platform.setDirty(false); setSimple(simple); setView('editor'); setGizmoMode('translate');
  requestAnimationFrame(frame);
  let seen = false; try { seen = localStorage.getItem('shotref.seenHelp'); localStorage.setItem('shotref.seenHelp', '1'); } catch (e) { }
  if (autosaveOff) toast(NO_AUTOSAVE, 6000); /* starter sets still open below on a first visit */
  if (broken) toast("Your last session couldn't be restored, so ShotRef started a fresh scene.", 5000);
  else if (!restored && !seen) setTimeout(() => { if (!openModals().length) openStarters(true); }, 400);
  /* photos and models come from IndexedDB (async); legacy autosaves carry them inline */
  if (broken) idb.noPrune = true; /* the broken autosave's files may live only in IndexedDB */
  /* while a broken autosave is kept aside, never prune the files it lists (C4) */
  try { for (const id of brokenAssetIds(localStorage.getItem('shotref.autosave.broken'))) idb.keep.add(id); } catch (e) { }
  const want = restored ? [...usedAssetIds(state)].filter(id => !assets[id]) : [];
  if (restored && !want.length) toast('Restored your last session');
  idbLoad(want).then(got => {
    const n = Object.keys(got).length;
    if (n) {
      assets = { ...assets, ...got };
      try { syncScene(); } catch (e) { console.error('ShotRef: could not rebuild the restored photos and models', e); }
      editRev++; uiDirty = true; propsDirty = true; requestRender();
    }
    /* a file that failed to load (maybe a passing error) must not be pruned this session (C5) */
    for (const id of want) if (!got[id]) idb.keep.add(id);
    const missing = want.length - n;
    if (missing > 0) toast(missing === 1 ? "1 photo or model couldn't be restored. Open your saved project file to get them back." : missing + " photos or models couldn't be restored. Open your saved project file to get them back.", 6000);
    else if (want.length) toast('Restored your last session');
  }).catch(e => console.error('ShotRef: could not restore photos and models', e)).finally(() => {
    autosaveReady = true;
    if (autosaveWaiting) { autosaveWaiting = false; writeAutosave(); }
  });
  /* another tab writing the same autosave (A5): warn once */
  let tabWarned = false;
  window.addEventListener('storage', e => {
    if (e.key === AUTOSAVE_KEY && !tabWarned) { tabWarned = true; toast('ShotRef is open in another tab. Changes here may overwrite it.', 6000); }
  });
  window.addEventListener('pagehide', flushAutosave);
  window.__shotref = { project: (x, y, z) => { const r = canvas.getBoundingClientRect(); let cam = view === 'top' ? topCam : edCam, rr = { x: 0, y: 0, w: r.width, h: r.height }; if (view === 'camera') { cam = renderCam; rr = camRect(r.width, r.height); } const v = new THREE.Vector3(x, y, z).project(cam); return [r.left + rr.x + (v.x * 0.5 + 0.5) * rr.w, r.top + rr.y + (-v.y * 0.5 + 0.5) * rr.h]; }, get view() { return view; }, get selected() { return selected; }, get state() { return state; }, get assets() { return assets; }, setT: t => setTime(t, false), applyMove, addObject, select, setView, evalCam, exportVideo, exportPNG, pickCodec, _exportCanvas: () => exRenderer ? exRenderer.domElement : null, changed, writeObj, evalObj, setKey, get T() { return T; },
    get rebuilds() { return rebuilds; }, urlCacheIds: () => [...urlCache.keys()],
    get history() { return { at: hi, length: hist.length }; },
    renderStats: () => ({ frame: renderer.info.render.frame, calls: renderer.info.render.calls, draws: drawCount, lastDraw, lastAsync, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }) };
}
boot();
