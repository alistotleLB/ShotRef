import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { normalizeProject, FORMAT_VERSION, describeChange } from './project.js';
import * as K from './keys.js';
import { platform } from './platform.js';
import { CLOUDS_NEW, COVER, DRIFTS, LOOKS, cleanClouds, cloudLight, makeSkyDome, nearestCover, skyPhrase, skyWording } from './sky.js';
import { runTour, tourActive, tourTick } from './tour.js';
import { TOUR_COPY } from './tour-copy.js';

/* ---- shared values: every module-level `let`, what it holds, and what changes it ----
 * state, assets                  the project and its photos/models: restore, buildState, replaceProject, boot
 * T, playing, view, selected,  playhead: setTime; playing: setPlaying; view: setView; selected ('camera', 'target', 'sun' or an object id), selIds: select, sanitizeSel; pipOn: #bPip;
 *   pipOn, editRev, ...Dirty     editRev counts edits: changed, quietChange; uiDirty/propsDirty ask frame() to rebuild lists/panel
 * hist, hi                       undo snapshots and position: pushHistory, undo, redo, replaceProject, enterPractice/leavePractice
 * tourHandle, tourAsk              the running tour's handle (null when none), and the first-run question is open: runStops, startTour, tourFromDialog, closeModal
 * focusPicks                     how many times the lens was focused (the hands-on tour waits for a new one): the focus pick, the menu
 * practicing                     null, or the user's own scene set aside in memory while the hands-on tour's practice stage shows: enterPractice, leavePractice
 * snapPool, snapById, snapLive   the take copies the undo steps refer to, and how many are in use: snapRef, pruneSnapPool
 * cmp, cmpBusy                   the Compare takes dialog's frames and playhead, and whether it is rendering: openCompare, renderCompare
 * toastTimer                   toast hide timer: toast (downloads capability and the open file/unsaved mark live in platform.js)
 * sizeWarned                     autosave size warning shown once: warnSize
 * autosaveReady, autosaveWaiting boot has loaded stored assets / a save is waiting for that: boot, writeAutosave
 * inlineTooBig, saveTimer        autosave fallback state and the debounce timer: writeAutosave, autosave, flushAutosave
 * topInit, skyTex                top view framed once: setView; sky texture (fog colour, top view and style backgrounds): applyEnv
 *                                (the sky dome, skyDome, is a const: its look follows applyEnv and placeSun, its clock applyAll)
 * camState, pilotActive          shot camera at the playhead: applyAll; user is steering it: fly, camControls, records
 * pathRev                        editRev the walk paths were last drawn at: updatePaths, select
 * gizmoMode, snapOn, gizmoUsed   arrows mode: setGizmoMode; snap: #bSnapGrid; gizmo was used this click: gizmo, canvas
 * dragActive, selBarKey         a floor/ring/box drag is running: wire pointer handlers; selection toolbar content key: updateSelBar
 * vw, vh                         canvas size last drawn at: draw
 * depthCache                     depth range for the depth style, per editRev: depthRange
 * plateTex...exportingRender     location photo texture cache: ensurePlate; export frame in progress: renderExportFrame
 * drawCount...rebuilds           render stats for tests: draw, requestRender, frame
 * lastNow                        time of the previous animation frame: frame
 * needsRender...wasExporting     render on demand: requestRender, pokeRender, frame
 * moveAmt                        one-click move strength: propsCamera
 * simple                         Simple/Advanced mode: setSimple (gear menu)
 * tracksMode                      timeline tracks opened or closed by hand (null = open only while something is keyed): #bTracks
 * placing, pathMode, pathFit, rec  click-to-place, path drawing, path fit option, live recording: their start/commit/cancel functions
 * shotPerson                     person picked for shot sizes: propsCamera
 * menuBtn, menuClosedAt           button whose menu is open, when a menu last closed: showMenu, hideMenu, menuButton
 * ttKey                          history entries the undo/redo titles were last worked out for: undoTitles
 * prefs                          per-browser preferences (localStorage shotref.prefs): setPref
 * layout, pane                  single or split view (Settings, #bSplit: setLayout), and the half the pointer is in: setPane (paneOf)
 * libraryMem, libraryBad           My sets kept for this visit when storage is blocked, and unreadable stored text: writeLibrary
 * placeRest, placeSetName          the rest of a set being placed and its name: placeSet, commitPlacing, cancelPlacing
 * recentSession, recentTimer       id of a project without meta.id (renewed by replaceProject), recent-list save timer: markRecentDirty / recentTick
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
/* per-browser preferences: localStorage 'shotref.prefs' (may be missing, broken or refuse writes: always try/catch) */
const PREFS_KEY = 'shotref.prefs';
let prefs = {};
try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); if (p && typeof p === 'object' && !Array.isArray(p)) prefs = p; } catch (e) { }
const getPref = (k, d) => (Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : d);
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { } }
function setPref(k, v) { prefs[k] = v; savePrefs(); }
/* the Settings window's preferences: what each one is when nothing is stored, and the values a list-type one may take.
   pref(k) always answers with a usable value (a stored value of the wrong kind or outside its list counts as not stored). */
const PREF_DEFAULTS = {
  newDuration: 5, newFps: 24, newAspect: '16:9', newSize: 1920, walkSpeed: 1.4, autoSit: true, ground: true,
  videoQuality: 'high', filePrefix: 'shotref', dateStamp: true, quality: 'high', layout: 'single', liveShadows: true, pipDefault: true,
  showLabels: true, showArrows: true, showHints: true, showSun: true, selBar: true, camPoints: true,
  orbitSpeed: 1, zoomSpeed: 1, flySpeed: 2, snapStep: 0.25, rotSnap: 15, autosave: true, recentOn: true, keepRecent: 12,
};
const PREF_LISTS = {
  newDuration: [5, 8, 10, 15], newFps: [24, 25, 30, 50, 60], newSize: [1280, 1920, 2560, 3840], videoQuality: ['standard', 'high', 'max'],
  quality: ['low', 'balanced', 'high'], layout: ['single', 'split'], snapStep: [0.1, 0.25, 0.5, 1], rotSnap: [5, 15, 45, 90], keepRecent: [5, 12, 25, 50],
};
const PREF_RANGES = { walkSpeed: [0.6, 2.5], orbitSpeed: [0.3, 2.5], zoomSpeed: [0.3, 2.5], flySpeed: [0.5, 10] };
function pref(k) {
  const d = PREF_DEFAULTS[k], v = getPref(k, d);
  if (typeof v !== typeof d) return d;
  if (typeof v === 'number') { if (!isFinite(v)) return d; if (PREF_LISTS[k] && !PREF_LISTS[k].includes(v)) return d; if (PREF_RANGES[k]) return clamp(v, PREF_RANGES[k][0], PREF_RANGES[k][1]); return v; }
  if (typeof v === 'string') { if (k === 'newAspect') return ASPECTS.some(a => a[0] === v) ? v : d; if (k === 'filePrefix') return v.trim() ? v : d; if (PREF_LISTS[k] && !PREF_LISTS[k].includes(v)) return d; }
  return v;
}
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
const SAVE_KINDS = { png: ['PNG image', ['png']], mp4: ['MP4 video', ['mp4']], webm: ['WebM video', ['webm']], shotref: ['ShotRef project', ['shotref']], zip: ['Zip file', ['zip']] };
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
  studio: { label: 'Studio', sky: '#3f434a', groundColor: '#5d6064', sunColor: '#ffffff', sunInt: 2.0, sunEl: 58, sunAz: 35, ambInt: 1.15, fog: false, clouds: { cover: 0, look: 'fluffy' } },
  day: { label: 'Day', sky: '#9cc2ea', groundColor: '#8c9286', sunColor: '#fff3dc', sunInt: 2.6, sunEl: 52, sunAz: 40, ambInt: 0.9, fog: false, clouds: { cover: 0.2, look: 'fluffy' } },
  overcast: { label: 'Overcast', sky: '#c3c8ce', groundColor: '#80867d', sunColor: '#ffffff', sunInt: 2.75, sunEl: 70, sunAz: 20, ambInt: 1.1, fog: true, clouds: { cover: 1, look: 'flat' } },
  sunset: { label: 'Sunset', sky: '#e99f72', groundColor: '#6f6253', sunColor: '#ffb36b', sunInt: 2.5, sunEl: 8, sunAz: 250, ambInt: 0.6, fog: true, clouds: { cover: 0.42, look: 'fluffy' } },
  night: { label: 'Night', sky: '#101a2e', groundColor: '#2c3139', sunColor: '#a8b9ff', sunInt: 0.75, sunEl: 40, sunAz: 300, ambInt: 0.38, fog: true, clouds: { cover: 0.2, look: 'fluffy' } },
};
/* a preset's own fields without its cloud look: that is merged into settings.clouds (setEnv) so drift, direction and seed stay */
const envFields = ({ clouds, ...rest }) => rest;
/* put a preset into the settings (no redraw): its light and colours, plus cover and look for the clouds */
function setEnv(s, k) { const e = ENV[k]; Object.assign(s, envFields(e), { env: k }); s.clouds = cleanClouds({ ...s.clouds, ...e.clouds }); }
function pickEnv(k) { setEnv(state.settings, k); applyEnv(); changed(true, true); }
const DEFAULT_SETTINGS = {
  duration: 5, fps: 24, aspect: '16:9', size: 1920, interp: 'smooth', loop: true,
  env: 'day', ...envFields(ENV.day), groundOn: true, gridOn: true, fogDensity: 0.018,
  style: 'shaded', exportGrid: false, guides: 'thirds', depthAuto: true, depthNear: 0.5, depthFar: 25, shadowSoft: 0.3,
  clouds: { ...CLOUDS_NEW },
};

/* shape icons (24x24 line art) */
const IC = {
  person: '<circle cx="12" cy="4.5" r="2.3"/><path d="M12 7.5v7M8 10l4-1.5 4 1.5M12 14.5l-3 6.5M12 14.5l3 6.5"/>',
  woman: '<circle cx="12" cy="4.5" r="2.3"/><path d="M12 7.5l-4 8h8zM9.5 15.5L9 21M14.5 15.5l.5 5.5M8.5 10L7 13M15.5 10l1.5 3"/>',
  child: '<circle cx="12" cy="9" r="2.6"/><path d="M12 11.6v4.4M9 13.2l3-1 3 1M12 16l-2.4 4.5M12 16l2.4 4.5"/>',
  eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  sit: '<circle cx="8" cy="4.5" r="2.2"/><path d="M8 7.2V14h8M16 14v6M8 14v6M6 10.5l2-1.2"/>',
  stand: '<circle cx="12" cy="4.5" r="2.3"/><path d="M12 7.5v8M8.5 10.5L12 9l3.5 1.5M12 15.5V21M12 15.5V21M9 21h6M12 3v-1.5M10.5 3l-1-1.2M13.5 3l1-1.2"/>',
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
  cactus: '<path d="M12 21V4a2 2 0 014 0v17M12 13H8a2 2 0 01-2-2V8M16 15h2a2 2 0 002-2v-2M8 21h12"/>',
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
  group: '<rect x="3" y="6" width="8" height="8" rx="1.5"/><rect x="13" y="10" width="8" height="8" rx="1.5"/><path d="M11 10h2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  frame: '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3"/><circle cx="12" cy="10" r="2.5"/><path d="M8 17c.5-2.3 2-3.5 4-3.5s3.5 1.2 4 3.5"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
const svgI = k => `<svg viewBox="0 0 24 24">${IC[k] || IC.box}</svg>`;

/* entry for a type; an unknown type (from a newer or edited file) gets a plain fallback */
const catalogOf = type => CATALOG[type] || { label: String(type || 'Object'), cat: 'Shapes', color: '#d6d0c4' };
/* body types: starting height and colours (the Add tiles and the Look buttons), and the mannequin proportions */
const BODIES = {
  man: { label: 'Man', height: 1.78, color: '#3d6fd8', pants: '#2d3340', hair: '#2a1d14', skin: '#c98e6b' },
  woman: { label: 'Woman', height: 1.66, color: '#c4566c', pants: '#3e5f8f', hair: '#3a2418', skin: '#d2a07c' },
  child: { label: 'Child', height: 1.2, color: '#e0a030', pants: '#3b6ea5', hair: '#5a3a22', skin: '#d8a882' },
};
const BODY_SHAPE = {
  man: { sh: 0.118, tsx: 1.32, hip: 0.062, pel: 1, head: 1, hairLong: false },
  woman: { sh: 0.106, tsx: 1.18, hip: 0.066, pel: 1.12, head: 1.02, hairLong: true },
  child: { sh: 0.112, tsx: 1.28, hip: 0.06, pel: 1, head: 1.32, hairLong: false },
};
const bodyOf = o => BODIES[o.opts && o.opts.body] ? o.opts.body : 'man';
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
  cactus: { label: 'Cactus', cat: 'Props', color: '#6f8a52' },
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
    camera: { base: { p: [3.4, 1.6, 6.2], tg: [0, 1.15, 0], f: 35, roll: 0, fd: 7.2 }, keys: [], shake: 0, lookAtId: null, follow: false, feel: 'gentle', dof: { on: false, fstop: 2.8, auto: true, strength: 3 } },
    objects: [],
  };
  /* a new scene starts with the length, frame rate, shape and size chosen in Settings (an opened file never does: it has its own) */
  Object.assign(s.settings, { duration: pref('newDuration'), fps: pref('newFps'), aspect: pref('newAspect'), size: pref('newSize') });
  return s;
}
let state = defaultState();
let assets = {}; // id -> {kind, name, b64, mime, aspect}
let T = 0, playing = false, view = 'editor', selected = null, pipOn = pref('pipDefault'), editRev = 1, uiDirty = true, propsDirty = true;
let selIds = []; /* the selected objects' ids, `selected` (the one clicked last) among them: select, sanitizeSel */
let dragActive = false; /* a drag on the floor, the ring or a box is under way: the pointer handlers in wire */
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

/* ---- riding on a parent (o.parent): the base and keys are stored relative to the parent ----
   evalLocal  the stored pose at time t (relative to the parent, if there is one)
   evalObj    the same pose in the world: what dragging, the arrows and the panels read, and writeObj writes back
   shownObj   the pose as it is drawn: plus turning to face the travel direction and a seat chosen by a pose change
   A parent's own turn and move carry its children; its scale does not. */
const parentOf = o => (o && o.parent ? getObj(o.parent) : null);
const eulerQ = r => new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ'));
const quatEuler = q => { const e = new THREE.Euler().setFromQuaternion(q, 'YXZ'); return [e.x * R2D, e.y * R2D, e.z * R2D]; };
function evalLocal(o, t) {
  if (!o.keys.length) return o.base;
  const m = state.settings.interp;
  return { p: sampleField(o.keys, t, 'p', m), r: sampleField(o.keys, t, 'r', m), s: sampleField(o.keys, t, 's', m) };
}
/* the pose an object has inside its own parent as drawn: with the walking-direction turn and the seat of a pose change */
function localShown(o, t) {
  let tr = evalLocal(o, t);
  const lay = o.type === 'person' && actList(o) ? actLayer(o, t) : null;
  if (lay) tr = actPlace(o, tr, lay);
  if (!(lay && (lay.cur.at || (lay.prev && lay.prev.at)))) { const y = travelYaw(o, t); if (y != null) tr = { p: tr.p, r: [tr.r[0], y * R2D, tr.r[2]], s: tr.s }; }
  return tr;
}
/* where the parent's frame is in the world at time t: { p: Vector3, q: Quaternion }, or null when o has no parent */
function parentFrame(o, t, depth = 0) {
  const par = parentOf(o); if (!par || depth > 20) return null;
  const l = localShown(par, t), p = new THREE.Vector3().fromArray(l.p), q = eulerQ(l.r), up = parentFrame(par, t, depth + 1);
  if (up) { p.applyQuaternion(up.q).add(up.p); q.premultiply(up.q); }
  return { p, q };
}
function toWorldPose(o, tr, t, f = parentFrame(o, t)) {
  if (!f) return tr;
  return { p: new THREE.Vector3().fromArray(tr.p).applyQuaternion(f.q).add(f.p).toArray(), r: quatEuler(eulerQ(tr.r).premultiply(f.q)), s: tr.s.slice() };
}
function toLocalPose(o, tr, t, f = parentFrame(o, t)) {
  if (!f) return tr;
  const inv = f.q.clone().invert();
  return { p: new THREE.Vector3().fromArray(tr.p).sub(f.p).applyQuaternion(inv).toArray(), r: quatEuler(eulerQ(tr.r).premultiply(inv)), s: tr.s.slice() };
}
const evalObj = (o, t) => toWorldPose(o, evalLocal(o, t), t);
const shownObj = (o, t) => toWorldPose(o, localShown(o, t), t);
/* is `id` the object o itself or something that rides on it (directly or further down)? */
function ridesWith(o, id) { for (let q = getObj(id), n = 0; q && n < 30; q = parentOf(q), n++) if (q.id === o.id) return true; return false; }
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
function ensureDof() { const c = state.camera; if (!c.dof) c.dof = { on: false, fstop: 2.8, auto: true, strength: 3 }; return c.dof; }
/* how strong the blur is (1 = a real lens and the look before this setting, 3 = cinematic, 4.5 = dreamy); project.js gives older files 1 */
const dofStrength = () => { const v = ensureDof().strength; return typeof v === 'number' && v > 0 ? clamp(v, 0.5, 4.5) : 3; };
function focusDist(cs) { const d = ensureDof(); return d.auto ? Math.max(0.05, dist3(cs.p, cs.tg)) : cs.fd; }
const subject = () => state.camera.lookAtId ? getObj(state.camera.lookAtId) : null;
function aimPoint(o, t) {
  const tr = shownObj(o, t), v = views.get(o.id);
  const ay = (v && v.aimY != null ? v.aimY : 1) * tr.s[1];
  return [tr.p[0], tr.p[1] + ay, tr.p[2]];
}
function followOffset(t) {
  const o = subject(); if (!o || !state.camera.follow) return [0, 0, 0];
  const t0 = o.keys.length ? o.keys[0].t : 0;
  const a = shownObj(o, t0).p, b = shownObj(o, t).p;
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}
/* ---- camera mount (camera.mount = an object's id): the camera's base and keys are stored relative to that object,
   so the camera rides along; its own moves still apply on top. A mount wins over "follow the subject". ---- */
const mountObj = () => state.camera.mount ? getObj(state.camera.mount) : null;
function mountFrame(t) { const m = mountObj(); if (!m) return null; const s = shownObj(m, t); return { p: new THREE.Vector3().fromArray(s.p), q: eulerQ(s.r) }; }
function camToWorld(pt, t) {
  const f = mountFrame(t);
  if (f) return new THREE.Vector3().fromArray(pt).applyQuaternion(f.q).add(f.p).toArray();
  if (state.camera.follow && subject()) { const off = followOffset(t); return pt.map((v, i) => v + off[i]); }
  return pt.slice();
}
function camToLocal(pt, t) {
  const f = mountFrame(t);
  if (f) return new THREE.Vector3().fromArray(pt).sub(f.p).applyQuaternion(f.q.clone().invert()).toArray();
  if (state.camera.follow && subject()) { const off = followOffset(t); return pt.map((v, i) => v - off[i]); }
  return pt.slice();
}
function evalCam(t) {
  const r = evalCamRaw(t), o = subject(), m = mountObj();
  const p = camToWorld(r.p, t), tg = o ? aimPoint(o, t) : m ? camToWorld(r.tg, t) : r.tg.slice();
  return { p, tg, f: r.f, roll: r.roll, fd: r.fd };
}
/* mount the camera on an object (or free it with null) without moving it at the playhead */
function setMount(id) {
  const c = state.camera, subj = !!subject();
  if (id && !getObj(id)) return;
  const keys = c.keys.map(k => ({ k, p: camToWorld(k.p, k.t), tg: subj ? null : camToWorld(k.tg, k.t) }));
  const bp = camToWorld(c.base.p, T), bt = subj ? null : camToWorld(c.base.tg, T);
  c.mount = id || null; if (id) c.follow = false;
  c.base.p = camToLocal(bp, T).map(r4); if (bt) c.base.tg = camToLocal(bt, T).map(r4);
  for (const r of keys) { r.k.p = camToLocal(r.p, r.k.t).map(r4); if (r.tg) r.k.tg = camToLocal(r.tg, r.k.t).map(r4); }
}

/* ---- history ---- */
let hist = [], hi = -1;
let practicing = null; /* the set-aside real scene while the practice stage shows. While it is set nothing is written (autosave, Recent, unsaved mark, title): see enterPractice */
let histDoc = []; /* the document id of each history step (platform.js maps it to the file), so undo across an Open can't make Save overwrite that file */
/* Takes keep a full copy of the scene in take.snap (a JSON string) for every take that is not the one on screen. An undo step must not
   hold those copies again and again, so a step stores a short reference ("@3") and the text itself lives once in snapPool. A step
   only ever refers to a copy by its number, so undo and redo bring back exactly the take copies that step had. */
const snapPool = new Map(), snapById = []; /* copy text -> number, and number -> text (null once nothing refers to it) */
let snapLive = 0, snapPruneAt = 12, snapPruned = 0, snapHold = false; /* snapHold: no pruning while an Open might still be rolled back */
function snapRef(text) {
  let i = snapPool.get(text);
  if (i === undefined) { i = snapById.length; snapById.push(text); snapPool.set(text, i); snapLive++; }
  return '@' + i;
}
/* forget the copies no step refers to any more (steps older than 100 or cut off by a new edit) */
function pruneSnapPool() {
  if (snapHold) return;
  const used = new Set();
  for (const s of hist) { const re = /"snap":"@(\d+)"/g; let m; while ((m = re.exec(s))) used.add(+m[1]); }
  snapById.forEach((text, i) => { if (text !== null && !used.has(i)) { snapPool.delete(text); snapById[i] = null; snapLive--; snapPruned++; } });
  snapPruneAt = Math.max(12, snapLive * 2);
}
/* the undo step for the current project: the live scene in full, other takes by reference */
function snapshot() {
  if (!state.takes) return JSON.stringify(state);
  return JSON.stringify({ ...state, takes: state.takes.map(t => ({ ...t, snap: t.id !== state.takeId && typeof t.snap === 'string' ? snapRef(t.snap) : null })) });
}
/* read a step back: references become the take copies again. A reference that can't be found drops that take (never a wrong one). */
function parseStep(s) {
  const st = JSON.parse(s);
  if (st.takes) st.takes = st.takes.filter(t => { if (typeof t.snap === 'string' && t.snap[0] === '@') t.snap = snapById[+t.snap.slice(1)] || null; return t.id === st.takeId || t.snap; });
  return st;
}
function pushHistory() {
  const s = snapshot();
  if (hist[hi] === s) return;
  hist = hist.slice(0, hi + 1); hist.push(s);
  histDoc = histDoc.slice(0, hi + 1); histDoc.push(platform.getDoc());
  if (hist.length > 100) { hist.shift(); histDoc.shift(); }
  hi = hist.length - 1;
  if (snapLive > snapPruneAt) pruneSnapPool();
  platform.setDirty(true);
  autosave();
}
function changed(commit, props = false) { editRev++; uiDirty = true; if (props) propsDirty = true; if (commit) { groundDirty = true; pushHistory(); markRecentDirty(); } } /* a real edit: things settle once it is over */
function restore(s) {
  state = parseStep(s);
  showState();
}
/* show the scene in `state` (the scene helpers read it) */
function showState() {
  sanitizeSel();
  syncScene(); applyEnv(); editRev++; uiDirty = true; propsDirty = true; updateGizmo(); syncTopUI();
}
/* undo/redo autosave too, so an undone delete puts its photo or model back in the autosave */
const changeLabel = (word, before, after) => { const d = describeChange(before, after); return d ? word + ': ' + d : word; };
function undo() { if (exporting) return; if (hi > 0) { hi--; restore(hist[hi]); platform.restoreDoc(histDoc[hi]); platform.setDirty(true); autosave(); markRecentDirty(); toast(changeLabel('Undo', hist[hi], hist[hi + 1])); } }
function redo() { if (exporting) return; if (hi < hist.length - 1) { hi++; restore(hist[hi]); platform.restoreDoc(histDoc[hi]); platform.setDirty(true); autosave(); markRecentDirty(); toast(changeLabel('Redo', hist[hi - 1], hist[hi])); } }
/* ---- autosave ----
   localStorage 'shotref.autosave' = { state, assets: {}, assetIds: [...], v: 2 } (small).
   Photos and models go to IndexedDB (db 'shotref', store 'assets', key = asset id).
   If IndexedDB is unavailable (sandboxed iframe, private mode…), the used assets go inline as before;
   if even that does not fit, the scene is saved without them and the user is told once. */
/* A page that publishes ShotRef with its own scene can set window.__SHOTREF_EMBED__ = { key, project, message } before the app starts:
   its visitors begin with that project and message, and their own work is kept under its own key. Anything unreadable is ignored. */
const EMBED = (() => {
  try {
    const e = window.__SHOTREF_EMBED__; if (!e || typeof e !== 'object') return null;
    return { key: (typeof e.key === 'string' ? e.key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '') || 'embed', project: e.project, message: typeof e.message === 'string' ? e.message.slice(0, 300) : '' };
  } catch (err) { return null; }
})();
const AUTOSAVE_KEY = 'shotref.autosave' + (EMBED && EMBED.key ? '.' + EMBED.key : '');
const IDB_NAME = EMBED && EMBED.key ? 'shotref-' + EMBED.key : 'shotref';
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
const takeAssetCache = new Map(); /* take copy text -> the asset ids it uses (parsed once per copy) */
function takeAssetIds(text) {
  let r = takeAssetCache.get(text);
  if (!r) {
    r = [];
    try { const st = JSON.parse(text); r = [...usedAssetIds({ plate: st.plate, objects: st.objects })]; } catch (e) { }
    if (takeAssetCache.size > 40) takeAssetCache.clear();
    takeAssetCache.set(text, r);
  }
  return r;
}
function usedAssetIds(st) {
  const ids = new Set();
  if (st.plate && st.plate.asset) ids.add(st.plate.asset);
  for (const o of st.objects || []) { const id = o.asset || (o.opts && o.opts.asset); if (id) ids.add(id); }
  for (const t of st.takes || []) if (t.id !== st.takeId && typeof t.snap === 'string') for (const id of takeAssetIds(t.snap)) ids.add(id); /* a photo only an inactive take uses is still part of the project */
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
    let timer = setTimeout(() => finish(null), 1500);
    const longer = () => { clearTimeout(timer); timer = setTimeout(() => finish(null), 20000); }; /* an upgrade or a blocked open gets longer */
    try {
      const rq = indexedDB.open(IDB_NAME, 2);
      /* version 2 adds the recent projects next to the photos and models; a version 1 database keeps everything it has */
      rq.onupgradeneeded = () => { try { const d = rq.result; if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets'); const ps = d.objectStoreNames.contains('projects') ? rq.transaction.objectStore('projects') : d.createObjectStore('projects', { keyPath: 'id' }); if (!ps.indexNames.contains('updated')) ps.createIndex('updated', 'updated'); } catch (e) { } };
      rq.onupgradeneeded = (orig => ev => { longer(); orig(ev); })(rq.onupgradeneeded);
      rq.onblocked = () => { longer(); toast('Another ShotRef tab is still open. Close it so ShotRef can finish updating its storage. Your work is safe.', 8000); };
      rq.onsuccess = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('assets') || !db.objectStoreNames.contains('projects')) { try { db.close(); } catch (e) { } finish(null); return; }
        finish(db);
      };
      rq.onerror = e => { if (e && e.preventDefault) e.preventDefault(); finish(null); };
    } catch (e) { finish(null); }
  });
  return idb.opening;
}
/* wraps one IndexedDB transaction; resolves with fn's result, or null on any failure */
function idbTx(mode, fn, store = 'assets') {
  return idbOpen().then(db => new Promise(res => {
    if (!db) return res(null);
    try {
      const tx = db.transaction(store, mode), st = tx.objectStore(store), out = fn(st);
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
  const src = assets; /* the files as they are now: the queue runs later, maybe while the practice stage has swapped `assets` */
  idb.queue = idb.queue.then(() => idbTx('readwrite', st => {
    const k = st.getAllKeys();
    k.onsuccess = () => {
      try {
        const have = new Set(k.result.map(String));
        for (const id of ids) if (!have.has(id) && src[id]) st.put(src[id], id);
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
  if (practicing) return; /* the practice stage is never stored; the real scene's last autosave is what a reload reopens */
  if (autosaveOff || swapping) return;
  if (!autosaveReady) { autosaveWaiting = true; return; }
  const ids = [...usedAssetIds(state)].filter(id => assets[id]);
  const put = a => localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ state: stateForSave(), assets: a, assetIds: ids, v: FORMAT_VERSION, dirty: platform.isDirty() })); /* dirty: unsaved changes, so a restored session keeps its "unsaved" mark */
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
  if (practicing) return; /* never written during practice; leavePractice runs it again */
  clearTimeout(saveTimer);
  if (!pref('autosave')) { saveTimer = null; return; } /* Settings: autosave off */
  saveTimer = setTimeout(() => { saveTimer = null; writeAutosave(); }, 400);
}
/* write a pending autosave straight away (page closing) */
function flushAutosave() { if (practicing) return; if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeAutosave(); } }

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
/* the world-anchored sky: gradient, clouds and sun glow. Shown behind the editor view and shaded shot renders;
   the top view, clay, depth and normal styles and the location photo keep their flat backgrounds (draw, withShotStyle) */
/* only the parts it uses: handing over the whole THREE namespace would stop the bundler dropping the rest of three.js (+130 KB) */
const skyDome = makeSkyDome({ Color: THREE.Color, Vector2: THREE.Vector2, Vector3: THREE.Vector3, Mesh: THREE.Mesh, SphereGeometry: THREE.SphereGeometry, ShaderMaterial: THREE.ShaderMaterial, BackSide: THREE.BackSide });
scene.add(skyDome.mesh);
/* the dome or the flat gradient behind the scene */
function showDome(on) { skyDome.mesh.visible = on; scene.background = on ? null : skyTex && skyTex.tex; }
function applyEnv() {
  const s = state.settings, L = cloudLight(s); /* cloud cover softens the light on top of the saved values */
  if (skyTex) skyTex.tex.dispose();
  skyTex = skyTexture(s.sky); /* still the fog colour (its horizon), and the top view's background */
  placeSun();
  skyDome.update({ sky: s.sky, clouds: s.clouds, sunDir: _sunDir, sunColor: s.sunColor, night: s.env === 'night', glow: s.env !== 'studio' });
  showDome(view !== 'top');
  scene.fog = s.fog ? new THREE.FogExp2(skyTex.horizon, s.fogDensity) : null;
  hemi.color.set(s.sky).lerp(new THREE.Color('#ffffff'), 0.35); hemi.groundColor.set(s.groundColor); hemi.intensity = L.ambInt;
  sun.color.set(s.sunColor); sun.intensity = L.sunInt;
  sun.castShadow = s.shadows !== false; sun.shadow.radius = 1 + L.shadowSoft * 6; /* softness 0..1 */
  ground.material.color.set(s.groundColor); ground.visible = s.groundOn;
  grid.visible = s.gridOn;
}

/* the Settings choices that need pushing into three.js: preview resolution, live shadows, how fast the mouse moves the views */
function applyPrefs() {
  const dpr = window.devicePixelRatio || 1, q = pref('quality');
  renderer.setPixelRatio(q === 'low' ? 0.75 : q === 'balanced' ? Math.min(dpr, 1.25) : Math.min(dpr, 2));
  const sh = pref('liveShadows');
  if (renderer.shadowMap.enabled !== sh) { renderer.shadowMap.enabled = sh; scene.traverse(o => { if (o.material) for (const m of arr(o.material)) m.needsUpdate = true; }); } /* exports always render with shadows */
  const o = pref('orbitSpeed'), z = pref('zoomSpeed');
  edControls.rotateSpeed = o; edControls.zoomSpeed = z; topControls.zoomSpeed = z; camControls.rotateSpeed = 0.6 * o; camControls.zoomSpeed = 0.6 * z;
  updateGizmo(); requestRender();
}

/* ---- time of day and the sun ----
   settings.tod (5..20 h) drives the sun's height, colour and strength; direction, height, shadows and softness can also be set by hand */
const todSun = tod => {
  const e = clamp(Math.sin(Math.PI * (tod - 6) / 12), 0, 1), warm = clamp(e / 0.45, 0, 1);
  return { el: Math.max(2, Math.round(72 * e)), color: '#' + new THREE.Color('#ff8a3c').lerp(new THREE.Color('#fff4e2'), warm * warm * (3 - 2 * warm)).getHexString(), int: r4(0.9 + 1.8 * clamp(e * 1.6, 0, 1)) };
};
const todLabel = t => { const m = Math.round(t % 1 * 60); return String(Math.floor(t)).padStart(2, '0') + ':' + String(m === 60 ? 0 : m).padStart(2, '0'); };
const sunWording = () => { const e = state.settings.sunEl; return e < 8 ? 'Sun on the horizon, very long shadows' : e < 18 ? 'Golden hour, long shadows' : e < 40 ? 'Low sun, medium shadows' : e < 68 ? 'High sun, short shadows' : 'Overhead, tiny shadows'; };
const camAzimuth = () => Math.atan2(camState.p[0] - camState.tg[0], camState.p[2] - camState.tg[2]) * R2D;
/* "light the shot from": the sun placed relative to where the shot camera stands */
const LIGHT_FROM = { front: [25, 35, 'Front light'], left: [-90, 22, 'Side light from the left'], right: [90, 22, 'Side light from the right'], back: [180, 16, 'Backlight'], top: [0, 82, 'Top light'] };
function lightFrom(kind) {
  const d = LIGHT_FROM[kind], s = state.settings; if (!d) return;
  s.sunAz = Math.round(((camAzimuth() + d[0]) % 360 + 360) % 360); s.sunEl = d[1];
  applyEnv(); changed(true, true); toast(d[2] + ' (relative to the shot camera)');
}
function setShadows(on) { state.settings.shadows = on; applyEnv(); changed(true, true); toast(on ? 'Shadows on' : 'Shadows off'); }

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
        /* big blurs read the colour from a smaller (mipmapped) copy, so 80 samples still cover the disc smoothly */
        float lod = clamp(log2(max(1.0, r0 * 0.11)), 0.0, 3.5);
        float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        for (int i = 0; i < 80; i++) {
          float fi = float(i) + 0.5;
          float r = sqrt(fi / 80.0) * r0;
          float a = fi * 2.39996323 + rot;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
          vec3 c = texture2D(tColor, uv, lod).rgb;
          float d = vdist(uv), rs = coc(d);
          /* nearer samples only count if they are blurry themselves (keeps a sharp subject from smearing, without halos round blurred shapes) */
          float w = d < d0 ? clamp(max(rs - r + 1.0, rs / max(r, 1.0) * 1.6 - 0.2), 0.0, 1.0) : 1.0;
          if (d < d0 - 0.25 && rs < 1.5) w = 0.0;
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
    rt = new THREE.WebGLRenderTarget(w, hh, { type: THREE.HalfFloatType, samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
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
  const sg = dofStrength(); /* blur strength: scales how big the blur discs get (and how far they may grow) */
  u.uK.value = (f * f) / (N * (Smm - f)) / 36 * longPx * sg; u.uMax.value = Math.min(0.075, 0.025 * Math.max(1, sg * 0.8)) * longPx; u.uBgRaw.value = plateActive(style) ? 1 : 0;
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
    if (o.opts.convertible) { /* open top: a dark floor, a low windscreen, two seats and a rear deck */
      const seat = M('#e6dfcd', { r: 0.8 }), dark = M('#2a2c30', { r: 0.9 });
      g.add(mk(BOX(1.6, 0.06, 1.9), dark, 0, 0.94, -0.35));
      const ws = mk(BOX(1.56, 0.4, 0.05), M('#3a4654', { r: 0.1, m: 0.3 }), 0, 1.12, 0.62); ws.rotation.x = -0.5; g.add(ws);
      for (const x of [-0.4, 0.4]) { g.add(mk(BOX(0.52, 0.18, 0.5), seat, x, 1.02, -0.3)); g.add(mk(BOX(0.52, 0.48, 0.12), seat, x, 1.2, -0.58)); }
      g.add(mk(BOX(1.64, 0.16, 0.55), seat, 0, 1, -1.25));
      g.add(mk(new THREE.TorusGeometry(0.17, 0.025, 8, 24), dark, -0.4, 1.12, 0.3));
    } else g.add(mk(BOX(1.62, 0.56, 2.2), M('#27313d', { r: 0.15, m: 0.4 }), 0, 1.2, -0.25));
    /* wheels: a pivot (front ones steer) holding a spinning tyre, rim and hub; updateWheels turns them */
    const tyre = M('#151515', { r: 0.8 }), rim = M('#a7abb2', { r: 0.4, m: 0.6 }), tg = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 28), rg = new THREE.CylinderGeometry(0.2, 0.2, 0.275, 20), hub = BOX(0.28, 0.52, 0.07), list = [];
    for (const x of [-0.84, 0.84]) for (const z of [-1.35, 1.35]) {
      const piv = new THREE.Group(); piv.position.set(x, 0.36, z);
      const spin = new THREE.Group(); piv.add(spin);
      const w = mk(tg, tyre); w.rotation.z = Math.PI / 2;
      const r = mk(rg, rim); r.rotation.z = Math.PI / 2;
      spin.add(w, r, mk(hub, rim)); g.add(piv); list.push({ piv, spin, front: z > 0 });
    }
    for (const x of [-0.62, 0.62]) { g.add(mk(BOX(0.38, 0.14, 0.05), M('#ffffff', { e: 0xfff4d0, ei: 0.8 }), x, 0.74, 2.16)); g.add(mk(BOX(0.38, 0.12, 0.05), M('#550000', { e: 0xff2020, ei: 0.6 }), x, 0.78, -2.16)); }
    return { root: g, wheels: { list, r: 0.36 } };
  },
  cactus: o => {
    const g = new THREE.Group(), m = M(o.color, { r: 0.85 });
    const arm = (r, len, x, y, z, rz = 0) => { const c = mk(new THREE.CapsuleGeometry(r, len, 6, 14), m, x, y, z); c.rotation.z = rz; g.add(c); };
    arm(0.27, 6.55, 0, 3.55, 0); arm(0.19, 0.5, -0.5, 2, 0, Math.PI / 2); arm(0.19, 1.7, -0.82, 2.95, 0); arm(0.16, 0.36, 0.42, 1.55, 0, Math.PI / 2); arm(0.16, 0.75, 0.62, 2, 0);
    return { root: g, aimY: 3.5 };
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
      const v = views.get(o.id); if (v) { v.aimY = (bb2.max.y - bb2.min.y) * 0.6; v.pending = false; if (!groundMigrate.has(o.id)) groundDirty = true; } /* real bounds now: rest it (a new import) */
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
  const B = BODY_SHAPE[bodyOf(o)];
  const root = new THREE.Group();
  const pelvis = J(root, 0, 0.52 * H, 0);
  const pm = cap(0.068 * H, 0.08 * H, pants); pm.rotation.z = Math.PI / 2; pm.position.y = 0.0; pm.scale.set(1, B.pel, 0.85 * B.pel); pelvis.add(pm);
  const spine = J(pelvis, 0, 0.03 * H, 0);
  const tor = cap(0.08 * H, 0.15 * H, shirt); tor.position.y = 0.145 * H; tor.scale.set(B.tsx, 1, 0.72); spine.add(tor);
  const neck = J(spine, 0, 0.29 * H, 0);
  const nm = new THREE.Mesh(new THREE.CylinderGeometry(0.024 * H, 0.028 * H, 0.06 * H, 12), skin); nm.position.y = 0.02 * H; neck.add(nm);
  const head = J(neck, 0, 0.085 * H * (0.6 + 0.4 * B.head), 0); head.scale.setScalar(B.head);
  const hm = new THREE.Mesh(new THREE.SphereGeometry(0.062 * H, 24, 18), skin); hm.scale.set(0.92, 1.12, 1); head.add(hm);
  const hr = new THREE.Mesh(new THREE.SphereGeometry(0.066 * H, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), hair); hr.rotation.x = -0.45; hr.position.set(0, 0.008 * H, -0.006 * H); hr.scale.set(0.95, 1.1, 1.02); head.add(hr);
  if (B.hairLong) { const tail = cap(0.05 * H, 0.1 * H, hair); tail.position.set(0, -0.055 * H, -0.03 * H); tail.scale.set(1.75, 1, 0.75); head.add(tail); }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.012 * H, 0.03 * H, 8), skin); nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.004 * H, 0.062 * H); head.add(nose);
  const Lu = 0.165 * H, Lf = 0.15 * H, Lt = 0.245 * H, Ls = 0.245 * H;
  const arm = side => {
    const sh = J(spine, side * B.sh * H, 0.255 * H, 0);
    const u = cap(0.031 * H, Lu - 0.04 * H, shirt); u.position.y = -Lu / 2; sh.add(u);
    const el = J(sh, 0, -Lu, 0);
    const f = cap(0.026 * H, Lf - 0.03 * H, skin); f.position.y = -Lf / 2; el.add(f);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.033 * H, 14, 10), skin); hd.scale.set(0.8, 1.2, 1); hd.position.y = -Lf - 0.03 * H; el.add(hd);
    return [sh, el];
  };
  const leg = side => {
    const hp = J(pelvis, side * B.hip * H, -0.01 * H, 0);
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
/* the direction (radians, 0 = +Z) an item turns to while it travels along its keys, or null when it should not turn */
function travelYaw(o, t) {
  if (!o.opts.faceTravel || o.keys.length < 2) return null;
  const k0 = o.keys[0].t, k1 = o.keys[o.keys.length - 1].t;
  if (k1 - k0 < 1e-3) return null;
  let path = 0; for (let i = 1; i < o.keys.length; i++) path += Math.hypot(o.keys[i].p[0] - o.keys[i - 1].p[0], o.keys[i].p[2] - o.keys[i - 1].p[2]);
  if (path < 0.05) return null;
  const pos = tt => evalLocal(o, tt).p;
  const a = pos(clamp(t - 0.05, k0, k1)), b = pos(clamp(t + 0.05, k0, k1));
  let dx = b[0] - a[0], dz = b[2] - a[2];
  if (Math.hypot(dx, dz) < 1e-4) {
    const tt = clamp(t, k0, k1);
    const a2 = pos(clamp(tt - 0.3, k0, k1)), b2 = pos(clamp(tt + 0.3, k0, k1));
    dx = b2[0] - a2[0]; dz = b2[2] - a2[2];
  }
  return Math.hypot(dx, dz) > 1e-5 ? Math.atan2(dx, dz) : null;
}
/* how a keyed item is moving at time t (relative to its parent): speed and distance walked, for the stride and the wheels */
function personMotion(o, t) {
  const res = { yaw: null, speed: 0, dist: null, moving: false };
  if (o.keys.length < 2) return res;
  const k0 = o.keys[0].t, k1 = o.keys[o.keys.length - 1].t;
  if (k1 - k0 < 1e-3) return res;
  let path = 0; for (let i = 1; i < o.keys.length; i++) path += Math.hypot(o.keys[i].p[0] - o.keys[i - 1].p[0], o.keys[i].p[2] - o.keys[i - 1].p[2]);
  if (path < 0.05) return res;
  res.moving = true;
  const pos = tt => evalLocal(o, tt).p;
  const ta = clamp(t - 0.05, k0, k1), tb = clamp(t + 0.05, k0, k1);
  const a = pos(ta), b = pos(tb);
  res.speed = tb > ta ? Math.hypot(b[0] - a[0], b[2] - a[2]) / (tb - ta) : 0;
  res.yaw = travelYaw(o, t);
  const tc = clamp(t, k0, k1), dt = 1 / 40;
  let d = 0, prev = pos(k0);
  for (let tt = k0 + dt; tt < tc; tt += dt) { const q = pos(tt); d += Math.hypot(q[0] - prev[0], q[2] - prev[2]); prev = q; }
  const q = pos(tc); d += Math.hypot(q[0] - prev[0], q[2] - prev[2]);
  res.dist = d;
  return res;
}
/* ---- pose changes over time: o.acts = [{t, pose, at?}] sorted by time; o.opts.pose is the starting pose ---- */
const ACT_BLEND = 0.45; /* seconds a change of pose takes to blend */
const actList = o => (o.acts && o.acts.length ? o.acts : null);
/* which pose is current at time t, the one before it, and how far the blend between them has got (0..1) */
function actLayer(o, t) {
  const base = { pose: o.opts.pose || 'stand', t: -1e9 }, list = actList(o);
  if (!list) return { cur: base, prev: null, w: 1 };
  let i = -1;
  for (let k = 0; k < list.length; k++) if (list[k].t <= t + 1e-6) i = k;
  if (i < 0) return { cur: base, prev: null, w: 1 };
  const u = clamp((t - list[i].t) / ACT_BLEND, 0, 1);
  return { cur: list[i], prev: i > 0 ? list[i - 1] : base, w: u * u * (3 - 2 * u) };
}
const poseAt = (o, t) => actLayer(o, t).cur.pose;
const poseLabel = k => (POSES[k] || {}).label || k;
function setActs(o, list) { o.acts = list.sort((a, b) => a.t - b.t); if (!o.acts.length) delete o.acts; }
/* where a person stands at time t once seat changes are blended in (own path plus the act that moved them to a seat) */
function actPlace(o, tr, lay) {
  const to = lay.cur.at || null, from = lay.prev && lay.prev.at || null;
  if (!to && !from) return tr;
  const src = from || { p: tr.p, yaw: tr.r[1] }, dst = to || { p: tr.p, yaw: tr.r[1] };
  const turn = (a, b) => { while (b - a > 180) b -= 360; while (b - a < -180) b += 360; return b; };
  const out = { p: tr.p.slice(), r: tr.r.slice(), s: tr.s };
  out.p = src.p.map((v, i) => lerp(v, dst.p[i], lay.w)); out.r[1] = lerp(src.yaw, turn(src.yaw, dst.yaw), lay.w);
  return out;
}
/* the joint angles for one pose at one moment */
function poseValues(def, P, o, t, info) {
  let ph, w = 1;
  if (def.loco && info.moving) {
    ph = info.dist / (def.stride * P.H / 1.75) * Math.PI * 2;
    w = clamp(info.speed / def.minSpeed, 0, 1);
  } else ph = t * (def.cadence || 1) * (o.opts.speed || 1) * Math.PI * 2;
  let a = fullPose(def.f(ph));
  if (w < 1) a = mixPose(fullPose({}), a, w);
  return a;
}
/* ---- eyeline: where a person looks (o.opts.lookAt = 'camera' | another object's id) ---- */
const _lookV = new THREE.Vector3();
function lookPoint(o, t, camPos) {
  const id = o.opts.lookAt; if (!id) return null;
  if (id === 'camera') return _lookV.fromArray(camPos || camState.p);
  const s = getObj(id); if (!s || s === o) return null;
  const tr = shownObj(s, t); /* where it is drawn in the world, including what it rides on */
  if (s.type === 'person') return _lookV.set(tr.p[0], tr.p[1] + (s.opts.height || 1.75) * tr.s[1] * (poseAt(s, t) === 'sit' ? 0.66 : 0.93), tr.p[2]);
  const v = views.get(s.id);
  return _lookV.set(tr.p[0], tr.p[1] + (v && v.aimY != null ? v.aimY : 0.5) * tr.s[1], tr.p[2]);
}
function posePerson(P, o, t, info, camPos) {
  const lay = actLayer(o, t);
  let a = poseValues(POSES[lay.cur.pose] || POSES.stand, P, o, t, info);
  if (lay.prev && lay.w < 1) a = mixPose(poseValues(POSES[lay.prev.pose] || POSES.stand, P, o, t, info), a, lay.w);
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
  /* the head and upper body turn toward whatever they look at (after the feet are planted, so nothing slides) */
  const tgt = lookPoint(o, t, camPos);
  if (tgt) {
    P.root.updateWorldMatrix(true, true);
    _m.copy(P.root.matrixWorld).invert();
    const np = P.neck.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m);
    const d = tgt.applyMatrix4(_m).sub(np);
    const yaw = Math.atan2(d.x, d.z) * R2D, pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)) * R2D;
    const away = Math.abs(yaw) > 110 ? clamp((175 - Math.abs(yaw)) / 65, 0, 1) : 1; /* behind them: ease back to straight ahead */
    const gy = clamp(yaw, -85, 85) * away, gp = clamp(pitch, -38, 32) * away;
    P.neck.rotation.y = lerp(P.neck.rotation.y, gy * 0.62 * D2R, away);
    P.neck.rotation.x = lerp(P.neck.rotation.x, -gp * 0.8 * D2R, away);
    P.spine.rotation.y += gy * 0.3 * D2R; P.head.rotation.x = -gp * 0.2 * D2R;
  } else P.head.rotation.x = 0;
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
    const sig = JSON.stringify([o.type, o.color, o.opts.height, o.opts.skin, o.opts.pants, o.opts.hair, o.opts.unlit, o.opts.aspect, o.asset, !!(o.asset && assets[o.asset]), o.opts.letter, o.opts.body, o.opts.convertible]);
    if (!v) { const g = new THREE.Group(); g.userData.objId = o.id; g.rotation.order = 'YXZ'; scene.add(g); v = { group: g, sig: null }; views.set(o.id, v); }
    if (v.sig !== sig) {
      for (const c of [...v.group.children]) { v.group.remove(c); disposeTree(c); }
      const b = buildVisual(o);
      v.group.add(b.root); v.person = b.person || null; v.wheels = b.wheels || null; v.pending = !!b.async; v.aimY = b.aimY; v.isMark = !!b.isMark; v.sig = sig;
    }
    v.group.visible = o.visible !== false;
  }
  pruneModelCache();
}

/* ============================== animation apply ============================== */
let camState = evalCam(0);
let pilotActive = false;
function applyAll(t) {
  const c = evalCam(t), camPos = pilotActive ? shotCam.position.toArray() : c.p; /* where people who look at the camera look */
  for (const o of state.objects) {
    const v = views.get(o.id); if (!v) continue;
    const tr = shownObj(o, t), g = v.group; /* in the world: what it rides on, a walking turn and a seat from a pose change are all in it */
    g.position.fromArray(tr.p);
    g.rotation.set(tr.r[0] * D2R, tr.r[1] * D2R, tr.r[2] * D2R, 'YXZ');
    g.scale.fromArray(tr.s);
    if (v.person || v.wheels) {
      const info = personMotion(o, t);
      if (v.person) posePerson(v.person, o, t, info, camPos);
      if (v.wheels) updateWheels(v, o, t, info);
    }
  }
  if (!pilotActive) {
    shotCam.position.fromArray(c.p); shotCam.up.set(0, 1, 0); shotCam.lookAt(c.tg[0], c.tg[1], c.tg[2]);
    camControls.target.fromArray(c.tg);
    camState = c;
  } else {
    camState = { p: shotCam.position.toArray(), tg: camControls.target.toArray(), f: rec ? rec.f : c.f, roll: c.roll, fd: c.fd };
  }
  shotCam.aspect = arOf(state.settings.aspect); shotCam.filmGauge = 36; shotCam.setFocalLength(camState.f);
  skyDome.setTime(t); /* cloud drift follows shot time, so every render of a frame shows the same clouds */
}
/* the wheels roll with the distance driven; the front ones steer into a curve (how fast the heading changes per metre) */
function updateWheels(v, o, t, info) {
  const w = v.wheels; let steer = 0;
  if (info.moving) {
    const a = travelYaw(o, t - 0.12), l = travelYaw(o, t + 0.12), tc = x => clamp(x, 0, lastT());
    const p1 = evalLocal(o, tc(t - 0.12)).p, p2 = evalLocal(o, tc(t + 0.12)).p, u = Math.hypot(p2[0] - p1[0], p2[2] - p1[2]);
    if (a != null && l != null && u > 0.02) { let d = l - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; steer = clamp(Math.atan(2.7 * d / u), -0.6, 0.6); }
  }
  const spin = info.dist != null ? info.dist / w.r : 0;
  for (const x of w.list) { x.spin.rotation.x = spin; if (x.front) x.piv.rotation.y = steer; }
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
camPath.line.userData.pick = 'cpath'; /* right-click the path to add a point */
/* a handle on every camera key (drag to reshape the move; Alt-drag for height) */
const ckGeo = new THREE.SphereGeometry(0.11, 16, 10), ckMat = new THREE.MeshBasicMaterial({ color: 0xffd05a, depthTest: false }), ckHotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
const ckPts = []; let ckHot = -1;
/* the sun: a yellow ball with rays, on a dashed line from the spot the camera looks at. Drag it to turn the light (editor and top view). */
const sunGrp = new THREE.Group(); sunGrp.visible = false; helpers.add(sunGrp);
const sunBall = mk(new THREE.SphereGeometry(0.42, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffcd4d, depthTest: false }));
sunBall.renderOrder = 8; sunBall.userData.pick = 'sun';
const sunRays = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 24 }, (_, i) => { const a = Math.floor(i / 2) / 12 * Math.PI * 2, r = i % 2 ? 0.95 : 0.6; return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0); })), new THREE.LineBasicMaterial({ color: 0xffcd4d, depthTest: false }));
sunRays.renderOrder = 8;
const sunPick = mk(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ visible: false })); sunPick.userData.pick = 'sun';
const sunLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xffcd4d, dashSize: 0.4, gapSize: 0.3, transparent: true, opacity: 0.55, depthTest: false }));
sunLine.renderOrder = 8; sunLine.visible = false;
sunGrp.add(sunBall, sunRays, sunPick); helpers.add(sunLine);
let sunDist = 12, sunDragging = false;
const selBox = new THREE.BoxHelper(undefined, 0xff9a3c); selBox.visible = false; helpers.add(selBox);
const selBoxes = []; /* one outline for every further selected item */
const camProxy = new THREE.Object3D(), tgtProxy = new THREE.Object3D(); scene.add(camProxy, tgtProxy);
const ringGrp = new THREE.Group(); ringGrp.visible = false; helpers.add(ringGrp);
const ringVis = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 8, 80), new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.95, depthTest: false }));
ringVis.rotation.x = -Math.PI / 2; ringVis.renderOrder = 5;
const ringPick = new THREE.Mesh(new THREE.TorusGeometry(1, 0.13, 6, 48), new THREE.MeshBasicMaterial({ visible: false }));
ringPick.rotation.x = -Math.PI / 2; ringPick.userData.pick = 'ring';
const ringKnob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffd2a3, depthTest: false }));
ringKnob.renderOrder = 6; ringKnob.userData.pick = 'ring';
ringGrp.add(ringVis, ringPick, ringKnob);
/* the green arrow over a floating item: drag it up or down */
/* floating things (Can float, or the ground rule is off) can be raised with the green arrow; things resting on the floor cannot */
const liftable = o => o.type !== 'mark' && !o.locked && !isGrounded(o) && !(o.opts && o.opts.seated);
const liftGrp = new THREE.Group(); liftGrp.visible = false; helpers.add(liftGrp);
const liftMat = new THREE.MeshBasicMaterial({ color: 0x7fe020, depthTest: false, transparent: true, opacity: 0.95 });
const liftShaft = mk(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 8), liftMat, 0, 0.21, 0), liftUp = mk(new THREE.ConeGeometry(0.085, 0.2, 14), liftMat, 0, 0.52, 0), liftDn = mk(new THREE.ConeGeometry(0.06, 0.12, 12), liftMat, 0, -0.05, 0);
liftDn.rotation.x = Math.PI; liftShaft.renderOrder = liftUp.renderOrder = liftDn.renderOrder = 6;
const liftPick = mk(new THREE.CylinderGeometry(0.17, 0.17, 0.8, 8), new THREE.MeshBasicMaterial({ visible: false }), 0, 0.3, 0); liftPick.userData.pick = 'lift';
liftGrp.add(liftShaft, liftUp, liftDn, liftPick);
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
    setPath(objPath, pts, o.keys.map(k => { const w = toWorldPose(o, k, k.t).p; return new THREE.Vector3(w[0], w[1] + 0.03, w[2]); }));
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
  const others = isMulti() ? selIds.filter(id => id !== selected).map(id => views.get(id)).filter(x => x && x.group.visible) : [];
  while (selBoxes.length < others.length) { const b = new THREE.BoxHelper(undefined, 0xff9a3c); helpers.add(b); selBoxes.push(b); }
  selBoxes.forEach((b, i) => { if (i < others.length) { b.setFromObject(others[i].group); b.visible = true; } else b.visible = false; });
  // turn ring around the selection (hidden when everything selected is locked)
  const allLocked = isMulti() ? selObjs().every(x => x.locked) : !!(getObj(selected) || {}).locked;
  if (v && v.group.visible && view !== 'camera' && !v.isMark && !allLocked) {
    _bb.setFromObject(v.group);
    if (isMulti()) for (const x of others) _bb.expandByObject(x.group);
    const r = Math.max(0.45, Math.max(_bb.max.x - _bb.min.x, _bb.max.z - _bb.min.z) / 2 + 0.25);
    const cx = isMulti() ? (_bb.min.x + _bb.max.x) / 2 : v.group.position.x, cz = isMulti() ? (_bb.min.z + _bb.max.z) / 2 : v.group.position.z;
    ringGrp.visible = true; ringGrp.position.set(cx, _bb.min.y + 0.03, cz); ringGrp.scale.setScalar(r);
    const yaw = v.group.rotation.y; ringKnob.position.set(Math.sin(yaw), 0, Math.cos(yaw)); ringKnob.scale.setScalar(1 / r);
    liftGrp.visible = view === 'editor' && selObjs().some(liftable);
    if (liftGrp.visible) { liftGrp.position.set(cx, _bb.max.y + 0.18, cz); liftGrp.scale.setScalar(clamp(r / 0.7, 0.8, 3)); }
  } else { ringGrp.visible = false; liftGrp.visible = false; }
  // facing arrows under people
  const seen = new Set();
  for (const o of state.objects) {
    const vv = views.get(o.id); if (!vv || !vv.person) continue;
    seen.add(o.id);
    let a = arrows.get(o.id); if (!a) { a = new THREE.Mesh(arrowGeo, arrowMat); a.renderOrder = 3; helpers.add(a); arrows.set(o.id, a); }
    a.visible = vv.group.visible && pref('showArrows'); a.position.set(vv.group.position.x, vv.group.position.y + 0.02, vv.group.position.z); a.rotation.y = vv.group.rotation.y;
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
  updateCamPoints();
  placeSun(); updateSunGizmo();
}
/* the light sits 60 m out in the sun's direction, aimed at the ground under what the camera looks at: shadows follow the action.
   (Also called before an export frame, so an export never uses a stale sun.) */
const _sunDir = new THREE.Vector3();
function placeSun() {
  const az = state.settings.sunAz * D2R, el = state.settings.sunEl * D2R;
  const c = sun.target.position.set(camState.tg[0], 0, camState.tg[2]);
  _sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  sun.position.copy(c).addScaledVector(_sunDir, 60);
  sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
  skyDome.update({ sunDir: _sunDir });
}
const camPointsOn = () => view !== 'camera' && state.camera.keys.length >= 2 && getPref('camPoints', true) !== false && camPath.line.visible;
function updateCamPoints() {
  const keys = state.camera.keys, show = camPointsOn();
  while (ckPts.length < (show ? keys.length : 0)) { const m = new THREE.Mesh(ckGeo, ckMat); m.renderOrder = 9; helpers.add(m); ckPts.push(m); }
  const top = view === 'top', cam = top ? topCam : edCam;
  ckPts.forEach((m, i) => {
    m.visible = show && i < keys.length; if (!m.visible) return;
    m.userData.pick = 'ck:' + i; m.position.fromArray(camToWorld(keys[i].p, keys[i].t));
    m.scale.setScalar(top ? 1.4 / topCam.zoom : clamp(cam.position.distanceTo(m.position) * 0.075, 0.3, 8));
    m.material = ckHot === i ? ckHotMat : ckMat;
  });
  camPath.pts.visible = camPath.line.visible && !show; /* the handles replace the plain dots */
}
function updateSunGizmo() {
  const show = view !== 'camera' && getPref('showSun', true) !== false;
  sunGrp.visible = sunLine.visible = show; if (!show) return;
  const top = view === 'top', cam = top ? topCam : edCam, c = sun.target.position;
  if (!sunDragging) sunDist = top ? 4.2 / topCam.zoom * 1.2 : clamp(cam.position.distanceTo(c) * 0.42, 4, 60);
  sunGrp.position.copy(c).addScaledVector(_sunDir, sunDist);
  sunGrp.scale.setScalar(top ? 0.9 / topCam.zoom : clamp(cam.position.distanceTo(sunGrp.position) * 0.035, 0.25, 4));
  sunRays.quaternion.copy(cam.quaternion); /* the rays face the viewer */
  sunPick.scale.setScalar(1.4);
  const q = sunLine.geometry.attributes.position; q.setXYZ(0, c.x, 0.02, c.z); q.setXYZ(1, sunGrp.position.x, sunGrp.position.y, sunGrp.position.z); q.needsUpdate = true; sunLine.computeLineDistances();
  sunBall.material.color.set(selected === 'sun' ? 0xffe8a8 : 0xffcd4d);
}

/* ---- the floating toolbar over the selection ---- */
let selBarKey = '';
const _sbBox = new THREE.Box3(), _sbPt = new THREE.Vector3();
function selBarButtons(list) {
  const btn = (icon, tip, fn, cls) => h('button', { class: cls || '', 'data-tip': tip, 'aria-label': tip.replace(/ \(.*\)$/, ''), html: svgI(icon), onclick: e => { e.stopPropagation(); fn(); } });
  const sep = () => h('span', { class: 'sb-sep' }), locked = list.every(o => o.locked), out = [];
  if (list.length > 1) { const whole = isGroupSel(list); out.push(btn('group', whole ? 'Ungroup (Ctrl Shift G)' : 'Group (Ctrl G)', whole ? ungroupSel : groupSel)); }
  else {
    const o = list[0];
    if (o.type === 'person') {
      const eyeOn = o.opts.lookAt === 'camera';
      out.push(btn('path', 'Draw walk path', () => startPath(o.id)), btn('frame', 'Frame with the camera (medium shot)', () => frameShot('medium', o.id)),
        btn('eye', eyeOn ? 'Stop looking at the camera' : 'Look at the camera', () => setLookAt(o, eyeOn ? null : 'camera'), eyeOn ? 'on' : ''));
      if (isSeated(o)) out.push(btn('stand', 'Stand up', () => standPerson(o)));
      else if (anySeat(o)) out.push(btn('sit', 'Sit on the nearest seat', () => {
        const q = getObj(o.id), s = q && nearestSeatFor(q); /* by id: undo replaces the objects a button was built with */
        if (s) sitPerson(q, freeSeat(s.o, q)); else toast('No seat within ' + SIT_REACH + ' m of ' + o.name + '. Move them closer, or right-click a seat and choose Sit here.', 4000);
      }));
    }
    else if (o.type !== 'mark') out.push(btn('path', o.type === 'car' ? 'Draw drive path' : 'Draw path', () => startPath(o.id)), btn('target', 'Keep the camera on this', () => keepCameraOn(o)));
    out.push(sep());
  }
  out.push(btn('dup', 'Duplicate (Ctrl D)', duplicateSel), btn(locked ? 'unlock' : 'lock', locked ? 'Unlock (Ctrl L)' : 'Lock: stop accidental moves (Ctrl L)', () => { const l = selObjs(); lockObjs(l, !l.every(o => o.locked)); }, locked ? 'on' : ''), btn('trash', 'Delete (Del)', deleteSel, 'danger'));
  return out;
}
function updateSelBar() {
  const bar = $('#selBar'), list = selObjs();
  const hide = () => putStyle(bar, 'display', 'none');
  if (!list.length || view === 'camera' || playing || dragActive || placing || pathMode || focusPick || rec || gizmo.dragging || getPref('selBar', true) === false || list.some(o => { const v = views.get(o.id); return !v || !v.group.visible; })) return hide();
  const key = list.map(o => o.id + (o.locked ? 'L' : '') + (o.grp || '') + (o.opts.lookAt === 'camera' ? 'E' : '') + (isSeated(o) ? 'S' : '') + (list.length === 1 && o.type === 'person' && !isSeated(o) && anySeat(o) ? 'N' : '')).join(',');
  if (key !== selBarKey) { selBarKey = key; bar.innerHTML = ''; bar.append(...selBarButtons(list)); }
  _sbBox.makeEmpty(); for (const o of list) _sbBox.expandByObject(views.get(o.id).group);
  if (_sbBox.isEmpty()) return hide();
  const cam = view === 'top' ? topCam : edCam; cam.updateMatrixWorld();
  _sbBox.getCenter(_sbPt); _sbPt.y = liftGrp.visible ? Math.max(_sbBox.max.y, liftGrp.position.y + 0.72 * liftGrp.scale.y) : _sbBox.max.y; _sbPt.project(cam); /* clear of the lift arrow */
  if (_sbPt.z > 1 || _sbPt.z < -1) return hide();
  const wr = viewRects(vpEl.clientWidth, vpEl.clientHeight).work, w = wr ? wr.w : vpEl.clientWidth, hh = vpEl.clientHeight, gap = list.some(o => o.type === 'person') ? 30 : 10; /* people carry a name label above them */
  putStyle(bar, 'left', clamp((_sbPt.x * 0.5 + 0.5) * w, 110, Math.max(110, w - 110)) + 'px');
  putStyle(bar, 'top', clamp((-_sbPt.y * 0.5 + 0.5) * hh - gap, 100, Math.max(100, hh - 60)) + 'px');
  putStyle(bar, 'display', 'flex');
}

/* ---- gizmo ---- */
const gizmo = new TransformControls(edCam, canvas);
gizmo.setSize(0.9);
const gizmoHelper = gizmo.getHelper(); scene.add(gizmoHelper);
let gizmoMode = 'translate', snapOn = false, gizmoUsed = false;
gizmo.addEventListener('dragging-changed', e => {
  if (e.value) edControls.enabled = false; else syncControls();
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
function setGizmoMode(m) { gizmoMode = m; updateGizmo(); $$('#vpRight [data-g]').forEach(b => b.classList.toggle('on', b.dataset.g === m)); }
function updateGizmo() {
  gizmo.detach();
  gizmo.camera = view === 'top' ? topCam : edCam;
  if (view === 'camera' || !selected) return;
  if (selected === 'camera') { gizmo.attach(camProxy); gizmo.setMode('translate'); }
  else if (selected === 'target') { if (!subject()) { gizmo.attach(tgtProxy); gizmo.setMode('translate'); } }
  /* the arrows move one unlocked item; several at once are moved by dragging or turned with the ring */
  else if (!simple && !isMulti() && !(getObj(selected) || {}).locked) { const v = views.get(selected); if (v && v.group.visible) { gizmo.attach(v.group); gizmo.setMode(gizmoMode); } }
  gizmo.setTranslationSnap(snapOn ? pref('snapStep') : null); gizmo.setRotationSnap(snapOn ? pref('rotSnap') * D2R : null); gizmo.setScaleSnap(snapOn ? 0.1 : null);
}

/* ---- writers ---- */
/* a drag's in-between writes redraw the view but don't rebuild the outliner and timeline, unless a key was added (P2) */
function quietChange(commit, keysChanged) { if (commit || keysChanged) changed(commit); else editRev++; }
/* tr is a pose in the world; an item that rides on a parent stores it relative to that parent */
function writeObj(o, tr, commit) {
  const nk = o.keys.length;
  tr = toLocalPose(o, tr, T);
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
  if (fields.p) cur.p = camToLocal(fields.p, T).map(r4); /* a world position; stored relative to the mount (or minus the follow offset) */
  if (fields.tg && !subject()) cur.tg = (mountObj() ? camToLocal(fields.tg, T) : fields.tg).map(r4);
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
/* Split view: the editor (or Top) on the left and the shot on the right, in one canvas. In split view `view` is the left half's
   view; Camera view is always the whole canvas. `pane` is the half the pointer is over (or was pressed in): it decides which view the
   mouse, wheel and fly keys steer. */
let layout = pref('layout'), pane = 'work';
const splitOn = () => layout === 'split' && view !== 'camera';
const camPane = () => view === 'camera' || (splitOn() && pane === 'cam');
/* the shot's frame inside a region, letterboxed to the aspect: whole window in Camera view, the right half in split view */
function camRectIn(r, split) {
  const ar = arOf(state.settings.aspect), m = split ? 14 : 28, top = split ? 34 : 20;
  let rw = r.w - 2 * m, rh = rw / ar;
  if (rh > r.h - 2 * m - top) { rh = r.h - 2 * m - top; rw = rh * ar; }
  return { x: Math.round(r.x + (r.w - rw) / 2), y: Math.round(r.y + (r.h - rh) / 2 + (split ? 12 : 8)), w: Math.round(rw), h: Math.round(rh) };
}
const camRect = (w, hh) => camRectIn({ x: 0, y: 0, w, h: hh }, false);
/* where each thing is drawn, in pixels from the top left of the canvas: work = the editor/top half, cam = the shot's half, frame = the shot's picture */
function viewRects(w, hh) {
  if (view === 'camera') return { work: null, cam: { x: 0, y: 0, w, h: hh }, frame: camRect(w, hh) };
  if (!splitOn()) return { work: { x: 0, y: 0, w, h: hh }, cam: null, frame: null };
  const half = Math.floor(w / 2), cam = { x: half + 1, y: 0, w: w - half - 1, h: hh };
  return { work: { x: 0, y: 0, w: half - 1, h: hh }, cam, frame: camRectIn(cam, true) };
}
/* which half a pointer event is in */
function paneOf(e) {
  if (!splitOn()) return view === 'camera' ? 'cam' : 'work';
  const r = canvas.getBoundingClientRect();
  return e.clientX - r.left < Math.floor(r.width / 2) ? 'work' : 'cam';
}
/* only the view under the pointer listens to the mouse (the three orbit controls share the canvas) */
function syncControls() {
  const sp = splitOn();
  edControls.enabled = view === 'editor' && (!sp || pane === 'work'); topControls.enabled = view === 'top' && (!sp || pane === 'work'); camControls.enabled = view === 'camera' || (sp && pane === 'cam');
  gizmo.enabled = !dragActive && (!sp || pane === 'work');
}
function setPane(p) { if (p === pane) return; pane = p; if (gizmo.axis) { gizmo.axis = null; } syncControls(); }
function setLayout(l, toastIt = true) {
  l = l === 'split' ? 'split' : 'single'; layout = l; setPref('layout', l);
  if (l === 'split' && view === 'camera') setView(lastWorkView); else setView(view);
  if (toastIt) toast(l === 'split' ? 'Split view: build on the left, see the shot on the right' : 'Single view');
  requestRender();
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
  const bg = scene.background, fog = scene.fog, gv = gizmoHelper.visible, dv = skyDome.mesh.visible;
  helpers.visible = false; gizmoHelper.visible = false;
  showDome(style === 'shaded'); /* clay, depth and normal keep their flat backgrounds (set below) */
  const marks = [...views.values()].filter(v => v.isMark && v.group.visible); marks.forEach(v => { v.group.visible = false; }); grid.visible = state.settings.exportGrid;
  if (style === 'clay') { scene.overrideMaterial = clayMat; scene.background = clayBg; scene.fog = null; }
  else if (style === 'depth') { const r = depthRange(); depthMat.uniforms.uNear.value = r.near; depthMat.uniforms.uFar.value = r.far; scene.overrideMaterial = depthMat; scene.background = black; scene.fog = null; }
  else if (style === 'normal') { scene.overrideMaterial = normalMat; scene.background = normalBg; scene.fog = null; }
  const usePlate = plateActive(style), gMat = ground.material, gVis = ground.visible;
  if (usePlate) {
    fitPlate(); skyDome.mesh.visible = false; scene.background = plateTex; scene.fog = null;
    const gm = state.plate.ground || 'shadow';
    if (gm === 'shadow') { ground.material = shadowMat; ground.visible = true; } else if (gm === 'hide') ground.visible = false;
  }
  try { fn(); } finally {
    ground.material = gMat; ground.visible = gVis;
    scene.overrideMaterial = null; scene.background = bg; scene.fog = fog; skyDome.mesh.visible = dv;
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
  const pip = $('#pipFrame'), cf = $('#camFrame'), sl = $('#splitLine'), sp = splitOn(), R = viewRects(w, hh);
  putStyle(sl, 'display', sp ? 'block' : 'none');
  if (view === 'camera') {
    renderer.setViewport(0, 0, w, hh); renderer.setClearColor(0x0e0f11, 1); renderer.clear();
    renderShotInto(renderer, R.frame, hh); place(cf, R.frame); cf.style.display = 'block'; pip.style.display = 'none';
    return;
  }
  const o = R.work, wy = hh - o.y - o.h;
  renderer.setViewport(o.x, wy, o.w, o.h);
  if (sp) { renderer.setScissor(o.x, wy, o.w, o.h); renderer.setScissorTest(true); }
  showDome(view !== 'top'); /* the top view keeps the flat gradient */
  if (view === 'editor') {
    edCam.aspect = o.w / o.h; edCam.updateProjectionMatrix();
    camRig.visible = true;
    renderer.render(scene, edCam);
  } else {
    const half = 5.5; topCam.left = -half * o.w / o.h; topCam.right = half * o.w / o.h; topCam.top = half; topCam.bottom = -half; topCam.updateProjectionMatrix();
    const gv = grid.visible; grid.visible = true;
    renderer.render(scene, topCam);
    grid.visible = gv;
  }
  renderer.setScissorTest(false);
  if (sp) {
    const c = R.cam; renderer.setViewport(c.x, hh - c.y - c.h, c.w, c.h); renderer.setScissor(c.x, hh - c.y - c.h, c.w, c.h); renderer.setScissorTest(true);
    renderer.setClearColor(0x0e0f11, 1); renderer.clear(); renderer.setScissorTest(false);
    renderShotInto(renderer, R.frame, hh); place(cf, R.frame); cf.style.display = 'block'; pip.style.display = 'none';
    putStyle(sl, 'left', (c.x - 1) + 'px');
    gizmo.viewport = (gizmo.viewport || new THREE.Vector4()).set(o.x, wy, o.w, o.h); /* the arrows' pointer maths covers the left half only */
  } else {
    gizmo.viewport = null;
    if (pipOn) { const r = pipRect(w, hh); renderShotInto(renderer, r, hh); place(pip, r); pip.style.display = 'block'; } else pip.style.display = 'none';
    cf.style.display = 'none';
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
const flySpeedNow = shift => pref('flySpeed') * (shift ? 3 : 1); /* metres per second; Shift is three times faster */
function fly(dt) {
  if (!camPane() || !flyKeys.size) return;
  const sp = flySpeedNow(flyKeys.has('shift')) * dt;
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
  return [editRev, T, view, selected, selIds.join(), dragActive, playing, rec ? rec.phase : '', pipOn, simple, vpEl.clientWidth, vpEl.clientHeight, window.devicePixelRatio,
    gizmo.dragging, gizmo.axis, e.x, e.y, e.z, q.x, q.y, q.z, q.w, edCam.zoom, tp.x, tp.y, tp.z, topCam.zoom,
    layout, plateKey, plateBusy, placing, focusPick, hi, hist.length, pm ? pm.pts.length + ':' + pm.cursor : ''].join('|');
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
  if (exporting) { wasExporting = true; return; } // the export owns the scene and the renderers until it finishes
  if (wasExporting) { wasExporting = false; needsRender = true; }
  if (tourActive()) tourTick();
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
    if ((groundDirty || groundMigrate.size) && !dragActive && !placing && !pathMode && !playing && !gizmo.dragging && !rec) { migrateGround(); if (groundDirty) settleGround(); } /* things come to rest on what is under them once the edit is over */
    if (rec && rec.phase === 'rec') recSample();
    updateHelpers(); updateSelBar();
    renderer.shadowMap.needsUpdate = true;
    draw();
  }
  if (uiDirty) { uiDirty = false; rebuilds++; renderOutliner(); renderTimeline(); renderShotBar(); }
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
function addObject(type, extra, place = false, at = null, init = null) {
  if (placing) commitPlacing();
  if (pathMode) cancelPath();
  const o = makeObject(type, at || groundPointInView(), extra);
  if (type === 'person') o.color = SHIRTS[persons().length % SHIRTS.length];
  if (init) init(o);
  if (type === 'mark') { o.opts.letter = nextMarkLetter(); o.name = 'Mark ' + o.opts.letter; }
  state.objects.push(o); syncScene(); select(o.id);
  if (place) { changed(false, true); startPlacing(o.id); } else { changed(true, true); toast(o.name + ' added'); }
  return o;
}
const SIMPLE_SHAPES = ['box', 'wall', 'plane', 'stairs', 'cylinder']; /* the shapes Simple mode lists; "More shapes" shows the rest */
/* a man, woman or child: their own height and colours, and (after the first of a kind) a different top */
function addPerson(body, place = true, at = null) {
  const b = BODIES[body] || BODIES.man, key = BODIES[body] ? body : 'man', n = persons().filter(q => bodyOf(q) === key).length;
  return addObject('person', null, place, at, o => {
    Object.assign(o.opts, { body: key, height: b.height, pants: b.pants, hair: b.hair, skin: b.skin });
    o.color = n ? SHIRTS[(n + 2) % SHIRTS.length] : b.color; o.name = nextName(b.label);
  });
}
/* the Add | Scene tabs on the left; the last one is remembered */
function setLeftTab(t, save = true) {
  if (t !== 'scene') t = 'add';
  if (save) setPref('leftTab', t);
  $('#addArea').style.display = t === 'add' ? '' : 'none'; $('#outliner').style.display = t === 'scene' ? '' : 'none';
  $$('#leftTabs button').forEach(b => { const on = b.dataset.lt === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
}
function buildAddPanel() {
  const area = $('#addArea'); area.innerHTML = '';
  const cats = { People: [], Shapes: [], Props: [], Import: [], Blocking: [] };
  for (const [k, c] of Object.entries(CATALOG)) cats[c.cat].push(k);
  area.append(h('div', { class: 'addgrid' },
    ...Object.entries(BODIES).map(([k, b]) => dndTile(h('button', { class: 'tile', 'data-body': k, title: 'Add a ' + b.label.toLowerCase() + ': click, then click where they stand, or drag it onto the view', onclick: () => addPerson(k) }, h('span', { html: svgI(k === 'man' ? 'person' : k) }), b.label), () => addPerson(k))),
    dndTile(h('button', { class: 'tile big', title: 'Floor mark (like tape on set). Not visible in the shot. Click, or drag it onto the view.', onclick: () => addObject('mark', null, true) }, h('span', { html: svgI('mark') }), 'Add floor mark'), () => addObject('mark', null, true))));
  const mine = librarySets();
  if (mine.length) {
    area.append(h('div', { class: 'addcat' }, 'My sets'));
    area.append(h('div', { class: 'addgrid' }, mine.map(set => h('div', { class: 'setile' },
      dndTile(h('button', { class: 'tile', title: 'Add "' + set.name + '" (' + set.items.length + ' item' + (set.items.length > 1 ? 's' : '') + '): click, then click where it goes, or drag it onto the view', onclick: () => placeSet(set) }, h('span', { html: svgI('group') }), set.name), () => placeSet(set)),
      h('button', { class: 'setdel', title: 'Delete this set', 'aria-label': 'Delete the set ' + set.name, onclick: e => { e.stopPropagation(); deleteSet(set); } }, '\u00d7')))));
  }
  for (const cat of ['Props', 'Shapes']) {
    const fewer = cat === 'Shapes' && simple && !getPref('moreShapes', false);
    const list = fewer ? cats[cat].filter(k => SIMPLE_SHAPES.includes(k)) : cats[cat];
    const grid = h('div', { class: 'addgrid' }, list.map(k => dndTile(h('button', { class: 'tile', title: 'Add ' + CATALOG[k].label.toLowerCase() + ': click, then click where it goes, or drag it onto the view', onclick: () => addObject(k, null, true) }, h('span', { html: svgI(k) }), CATALOG[k].label), () => addObject(k, null, true))));
    if (cat === 'Shapes' && simple) grid.append(h('button', { class: 'tile more', title: fewer ? 'Show every shape' : 'Show fewer shapes', onclick: () => { setPref('moreShapes', fewer); buildAddPanel(); } },
      h('span', { html: fewer ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>' }), fewer ? 'More shapes' : 'Fewer'));
    area.append(h('div', { class: 'addcat' }, cat), grid);
  }
  area.append(h('div', { class: 'addcat' }, 'Import'));
  area.append(h('div', { class: 'addgrid' },
    h('button', { class: 'tile', title: 'Import a photo or drawing as a flat card (backdrop, poster, reference)', onclick: () => pickImport('#fImage', importImage, IMG_FILTER) }, h('span', { html: svgI('image') }), 'Image'),
    h('button', { class: 'tile', title: 'Import a 3D model (.glb)', onclick: () => pickImport('#fModel', importModel, MODEL_FILTER) }, h('span', { html: svgI('model') }), 'Model .glb'),
  ));
}
function iconFor(o) { return svgI(o.type === 'person' ? (bodyOf(o) === 'man' ? 'person' : bodyOf(o)) : o.type); }
/* Shift/Ctrl-click toggles a row in the selection; Alt-click picks one inside a group */
const rowClick = id => e => select(id, id === 'camera' || id === 'sun' ? undefined : e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : e.altKey ? 'single' : undefined);
function renderOutliner() {
  const el = $('#outliner'), fid = focusedRowId(el); el.innerHTML = '';
  const row = (id, icon, name, nk, hidden, onEye, o) => h('div', { class: 'ol' + (selected === id || selIds.includes(id) ? ' sel' : '') + (hidden ? ' hid' : '') + (o && o.grp ? ' ingrp' : ''), tabindex: 0, 'data-id': id, onclick: rowClick(id), onkeydown: rowKeys(id), ondblclick: () => { if (id !== 'camera') renameObj(id); } },
    h('span', { html: icon }), h('span', { class: 'nm' }, name),
    o && o.grp ? h('span', { class: 'gtag', title: 'In ' + groupName(o.grp) }, groupName(o.grp)) : null,
    o && parentOf(o) ? h('span', { class: 'ptag', title: 'Rides with ' + parentOf(o).name }, '↳ ' + parentOf(o).name) : null,
    nk ? h('span', { class: 'kd', title: nk + ' keyframes' }, '◆' + nk) : null,
    o ? h('button', { class: 'eye lockb' + (o.locked ? ' on' : ''), title: o.locked ? 'Locked: click to unlock' : 'Lock (stops it being moved by accident)', 'aria-label': o.locked ? 'Unlock ' + name : 'Lock ' + name, html: svgI(o.locked ? 'lock' : 'unlock'), onclick: e => { e.stopPropagation(); lockObjs([o], !o.locked); } }) : null,
    onEye ? h('button', { class: 'eye', title: hidden ? 'Show' : 'Hide', onclick: e => { e.stopPropagation(); onEye(); } }, hidden ? '◌' : '●') : null);
  el.append(row('camera', svgI('camera'), 'Shot camera', state.camera.keys.length));
  el.append(row('sun', svgI('sun'), 'Sun', 0));
  for (const o of state.objects) el.append(row(o.id, iconFor(o), o.name, o.keys.length, o.visible === false, () => { o.visible = o.visible === false; syncScene(); updateGizmo(); changed(true); }, o));
  if (!state.objects.length) el.append(h('div', { class: 'note', style: 'padding:6px 8px' }, 'Nothing here yet. Add a person or an object from the Add tab.'));
  putText($('#sceneCnt'), state.objects.length ? String(state.objects.length) : '');
  refocusRow(el, fid);
}
/* list rows (outliner, timeline labels) are keyboard-reachable: Enter or Space selects (U4) */
function rowKeys(id) { return e => { if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); e.stopPropagation(); rowClick(id)(e); }; }
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
/* ---- selection: `selected` is the main item (also 'camera' / 'target'); `selIds` holds every selected object, a whole group at once ---- */
const selObjs = () => selIds.map(getObj).filter(Boolean);
const isMulti = () => selIds.length > 1;
const groupMembers = id => { const o = getObj(id); return o && o.grp ? state.objects.filter(x => x.grp === o.grp).map(x => x.id) : [id]; };
const groupName = gid => (state.groups && state.groups[gid] && state.groups[gid].name) || 'Group';
/* mode: undefined = this item (and its whole group), 'single' = just this one, 'toggle' = add or remove (Shift/Ctrl-click) */
function select(id, mode) {
  const o = id && id !== 'camera' && id !== 'target' && id !== 'sun' && id !== 'export' ? getObj(id) : null;
  if (o) {
    const set = mode === 'single' ? [id] : groupMembers(id);
    if (mode === 'toggle') {
      const had = selIds.includes(id);
      selIds = had ? selIds.filter(x => !set.includes(x)) : [...selIds.filter(x => !set.includes(x)), ...set.filter(x => x !== id), id];
      id = had ? selIds[selIds.length - 1] || null : id;
    } else selIds = set.slice();
  } else if (mode === 'toggle') return;
  else selIds = [];
  selected = id; updateGizmo(); uiDirty = true; propsDirty = true; pathRev = -1;
}
/* after undo, delete, open: forget ids that are gone and keep `selected` and `selIds` in step */
function sanitizeSel() {
  selIds = selIds.filter(id => getObj(id));
  if (selected && selected !== 'camera' && selected !== 'target' && selected !== 'sun' && selected !== 'export' && !getObj(selected)) selected = selIds[selIds.length - 1] || null;
  if (getObj(selected) && !selIds.includes(selected)) selIds.push(selected);
  if (!getObj(selected) && selected !== 'camera' && selected !== 'target' && selected !== 'sun' && selected !== 'export') selected = null;
}
/* a group left with fewer than two members is dissolved; groups with nobody in them go */
function pruneGroups() {
  if (!state.groups) return;
  const n = {}; for (const o of state.objects) if (o.grp) n[o.grp] = (n[o.grp] || 0) + 1;
  for (const o of state.objects) if (o.grp && n[o.grp] < 2) o.grp = null;
  for (const g of Object.keys(state.groups)) if (!(n[g] >= 2)) delete state.groups[g];
}
function lockObjs(list, on) {
  list = list.map(o => getObj(o.id)).filter(Boolean); /* by id: undo and redo replace the objects a button was built with */
  if (!list.length) return;
  for (const o of list) o.locked = on;
  const w = list.length === 1 ? list[0].name : list.length + ' items';
  updateGizmo(); changed(true, true);
  toast(on ? w + ' locked. Dragging ' + (list.length === 1 ? 'it' : 'them') + ' now moves the view instead.' : w + ' unlocked');
}
const isGroupSel = list => list.length > 1 && list.every(o => o.grp) && new Set(list.map(o => o.grp)).size === 1 && state.objects.filter(x => x.grp === list[0].grp).length === list.length;
function groupSel() {
  const list = selObjs(); if (list.length < 2) { toast('Select two or more things to group them'); return; }
  state.groups = state.groups || {};
  let n = 1; const names = new Set(Object.values(state.groups).map(g => g.name)); while (names.has('Group ' + n)) n++;
  const gid = 'g' + uid(); state.groups[gid] = { name: 'Group ' + n };
  for (const o of list) o.grp = gid;
  pruneGroups(); changed(true, true);
  toast(list.length + ' items grouped as "Group ' + n + '". Click any of them to select the whole group (Alt-click for one).', 4500);
}
function ungroupSel() {
  const gids = new Set(selObjs().map(o => o.grp).filter(Boolean)); if (!gids.size) return;
  for (const o of state.objects) if (gids.has(o.grp)) o.grp = null;
  for (const g of gids) if (state.groups) delete state.groups[g];
  changed(true, true); toast('Ungrouped');
}
const toggleGroupSel = () => { if (isGroupSel(selObjs()) || (selObjs().length === 1 && selObjs()[0].grp)) ungroupSel(); else groupSel(); };
function selectAll() {
  const all = state.objects.filter(o => o.visible !== false); if (!all.length) return;
  selIds = all.map(o => o.id); selected = selIds[selIds.length - 1];
  updateGizmo(); uiDirty = true; propsDirty = true; pathRev = -1; toast(all.length + ' items selected');
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
  const row = h('div', { class: 'row' }, h('label', null, label), h('div', { class: 'vec' }, ['X', 'Y', 'Z'].map((ax, i) => numField(ax, () => get()[i], (v, c) => { const a = get().slice(); a[i] = v; set(a, c); }, { ...o, cls: ax.toLowerCase() }))));
  if (o.lockY) { /* o.lockY is the reason the height cannot be typed */
    const inp = row.querySelectorAll('input')[1], lab = row.querySelectorAll('.nf-l')[1];
    inp.disabled = true; inp.title = o.lockY; lab.style.pointerEvents = 'none'; lab.title = o.lockY; lab.style.opacity = '0.5';
  }
  return row;
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
      h('button', { onclick: () => { if (kind === 'camera') { state.camera.base = clone(evalCamRaw(T)); state.camera.keys = []; } else { const o = getObj(kind); o.base = clone(evalLocal(o, T)); o.keys = []; } changed(true, true); toast('Animation cleared'); }, disabled: !keys.length }, 'Clear')),
    h('p', { class: 'note' }, keys.length ? 'Move the playhead, then change anything. A key is added for you at that time.' : 'Press ◆ Add key to start animating. Then move the playhead and change position. A second key is added for you.'));
}

/* the right panel's sections: explanatory notes fold into a "?" on the heading, and clicking a heading folds the section (remembered per heading in prefs.closedSecs) */
function decorateSections(root) {
  const closed = getPref('closedSecs', {}) || {};
  for (const sc of root.querySelectorAll('.sec')) {
    const hd = sc.querySelector(':scope > h3'); if (!hd) continue;
    const name = (hd.firstChild && hd.firstChild.nodeType === 3 ? hd.firstChild.textContent : hd.textContent).trim();
    const notes = [...sc.querySelectorAll(':scope > p.note, :scope > div > p.note')].filter(n => !n.classList.contains('keep'));
    const rest = [...sc.children].filter(n => n !== hd && !notes.includes(n));
    if (notes.length && rest.length) {
      const text = notes.map(n => n.textContent.trim()).filter(Boolean).join('\n\n');
      notes.forEach(n => n.remove());
      if (text) hd.append(h('span', { class: 'qtip', tabindex: 0, 'data-q': text, onclick: e => e.stopPropagation() }, '?'));
    }
    if (!name) continue;
    if (closed[name]) sc.classList.add('closed');
    hd.addEventListener('click', () => {
      const on = sc.classList.toggle('closed'), now = { ...(getPref('closedSecs', {}) || {}) };
      if (on) now[name] = true; else delete now[name];
      setPref('closedSecs', now);
    });
  }
}
function renderProps() {
  renderPropsInner();
  decorateSections($('#props'));
}
function renderPropsInner() {
  live.length = 0;
  const p = $('#props'); p.innerHTML = '';
  /* in Camera view with nothing selected, show the camera tools; the selection stays empty (U3) */
  if (selected === 'export') return propsExport(p);
  if (selected === 'sun') return propsSun(p);
  if (selected === 'camera' || selected === 'target' || (view === 'camera' && !selected)) return propsCamera(p);
  const o = selected && getObj(selected);
  if (o && isMulti()) { propsMulti(p); p.append(setSaveSection(() => selObjs(), 'the ' + selIds.length + ' selected items')); return; }
  if (o) { propsObject(p, o); if (o.type !== 'image' && o.type !== 'model') p.append(setSaveSection(() => [o], o.name)); return; }
  propsScene(p);
  if (state.objects.length) p.append(setSaveSection(() => state.objects, 'everything in the scene'));
}
function propsScene(p) {
  const s = state.settings;
  const set = (k, v, c = true) => { s[k] = v; applyEnv(); changed(c); };
  p.append(sec('Scene', h('p', { class: 'note', style: 'margin:0 0 8px' }, 'Nothing selected. Click an object, or click Shot camera in the list or the timeline.'),
    h('div', { class: 'chips' }, Object.entries(ENV).map(([k, e]) => h('button', { class: s.env === k ? 'on' : '', onclick: () => pickEnv(k) }, e.label)))));
  p.append(skySection(!simple));
  p.append(sec('Start from a set', h('p', { class: 'note', style: 'margin:0 0 6px' }, 'Ready-made layouts for common blocking situations.'),
    h('button', { class: 'primary', style: 'width:100%', onclick: () => openStarters() }, 'Browse starter sets…')));
  if (simple) {
    p.append(sec('Ground', check('Show ground', () => s.groundOn, v => set('groundOn', v)), check('Grid in editor', () => s.gridOn, v => { set('gridOn', v); syncTopUI(); }),
      h('p', { class: 'note' }, 'Sky colours and fog are in Advanced mode (gear menu, top right).')));
  }
  p.append(sunSection(!simple));
  p.append(sec('Getting started', h('ol', { class: 'steps', style: 'font-size:12px;margin:0' },
    h('li', null, 'Add people and props from the left: click a tile, then click where it goes, or drag the tile onto the view.'),
    h('li', null, 'Drag them on the floor, turn them with the orange ring, draw walk paths.'),
    h('li', null, 'Frame the shot: Set start, reframe, Set end. Or use a shot size or move.'),
    h('li', null, 'Export the video or frames.')),
    h('button', { style: 'margin-top:8px', onclick: () => openModal('mHelp') }, 'Show quick start & shortcuts')));
}
/* ---- shot description and move detection (the camera view's top line, the Camera move card) ---- */
/* "Medium shot · 50 mm · eye level": the size is worked out from the person nearest the middle of the frame */
function describeShot() {
  const cs = camState, out = [], ar = arOf(state.settings.aspect), sv = ar >= 1 ? 36 / ar : 36, vfov = 2 * Math.atan(sv / (2 * cs.f));
  const P = new THREE.Vector3().fromArray(cs.p), o = new THREE.Vector3().fromArray(cs.tg).sub(P).normalize();
  let best = null, bs = Infinity;
  for (const u of persons()) {
    const v = views.get(u.id); if (!v || !v.group.visible) continue;
    const g = personGeom(u), m = new THREE.Vector3(g.P.x, g.P.y + (g.top - g.P.y) * 0.6, g.P.z), d = m.clone().sub(P), along = d.dot(o);
    if (along <= 0.2) continue;
    const off = d.clone().sub(o.clone().multiplyScalar(along)).length() / along;
    if (off > Math.tan(vfov / 2) * ar * 1.1) continue; /* not in the frame */
    const score = off + along * 2e-3; if (score < bs) { bs = score; best = { g, along }; }
  }
  if (best) {
    const ratio = 2 * best.along * Math.tan(vfov / 2) / (best.g.top - best.g.P.y); /* how much of the person's height the frame shows */
    out.push(ratio <= 0.13 ? 'Extreme close-up' : ratio <= 0.3 ? 'Close-up' : ratio <= 0.45 ? 'Medium close-up' : ratio <= 0.75 ? 'Medium shot' : ratio <= 1.35 ? 'Full shot' : ratio <= 3.2 ? 'Wide shot' : 'Extreme wide');
  }
  out.push(Math.round(cs.f) + ' mm');
  const ang = Math.asin(clamp(o.y, -1, 1)) * R2D;
  out.push(ang < -60 ? 'overhead' : ang < -14 ? 'high angle' : ang > 12 || (cs.p[1] < 0.8 && ang > 3) ? 'low angle' : 'eye level');
  if (Math.abs(cs.roll || 0) > 3) out.push('dutch angle');
  const mv = detectMove().title.toLowerCase();
  if (mv !== 'static camera') out.push(mv);
  return out.join(' · ');
}
/* names the camera move from its first and last key: dolly, truck, crane, orbit, pan, tilt, zoom, dolly zoom */
function detectMove() {
  const c = state.camera, subj = subject(), track = c.follow && subj;
  if (c.keys.length < 2 && !track) return { title: 'Static camera', sub: 'The camera does not move. Set a start and end frame, pick a move, or record one.' };
  const a = evalCam(c.keys.length ? c.keys[0].t : 0), b = evalCam(c.keys.length ? c.keys[c.keys.length - 1].t : lastT());
  const P0 = new THREE.Vector3().fromArray(a.p), P1 = new THREE.Vector3().fromArray(b.p), G0 = new THREE.Vector3().fromArray(a.tg), G1 = new THREE.Vector3().fromArray(b.tg);
  const D = Math.max(0.3, P0.distanceTo(G0)), fwd = G0.clone().sub(P0).normalize(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const d = P1.clone().sub(P0), dF = d.dot(fwd), dR = d.dot(right), dY = d.y, aim = G1.distanceTo(G0), parts = [];
  if (track) parts.push('Tracking ' + subj.name);
  if (!(track && c.keys.length < 2)) {
    if (c.keys.length > 8) parts.push('Free / recorded move');
    else {
      const zoom = b.f / a.f;
      if (d.length() < 0.15 * D) { /* the camera stays: it turns */
        const yaw = Math.atan2(G1.x - P1.x, G1.z - P1.z) - Math.atan2(G0.x - P0.x, G0.z - P0.z), pan = Math.atan2(Math.sin(yaw), Math.cos(yaw)) * R2D;
        const tilt = (Math.asin(clamp(G1.clone().sub(P1).normalize().y, -1, 1)) - Math.asin(clamp(fwd.y, -1, 1))) * R2D;
        if (Math.abs(pan) > 4) parts.push(pan > 0 ? 'Pan left' : 'Pan right');
        if (Math.abs(tilt) > 4) parts.push(tilt > 0 ? 'Tilt up' : 'Tilt down');
      } else if (aim < 0.35 * D && Math.abs(dR) > 0.3 * D) parts.push(dR > 0 ? 'Orbit right' : 'Orbit left');
      else {
        if (Math.abs(dF) > 0.12 * D) parts.push(zoom < 0.85 && dF > 0 ? 'Dolly zoom' : dF > 0 ? 'Dolly in' : 'Dolly out');
        if (Math.abs(dR) > 0.15 * D) parts.push(dR > 0 ? 'Truck right' : 'Truck left');
        if (Math.abs(dY) > 0.4) parts.push(dY > 0 ? 'Crane up' : 'Crane down');
      }
      if (!parts.includes('Dolly zoom')) { if (zoom > 1.15) parts.push('Zoom in'); else if (zoom < 0.87) parts.push('Zoom out'); }
      if (!parts.length) parts.push('Subtle move');
    }
  }
  const feel = { constant: 'constant speed', gentle: 'gentle ease', strong: 'strong ease' }[c.feel || 'gentle'];
  return { title: parts.slice(0, 3).join(' + '), sub: `${state.settings.duration.toFixed(1)} s · ${feel} · ${c.keys.length} key${c.keys.length === 1 ? '' : 's'}` };
}
/* the Start and End frames as small JPEG data: URLs (no blob: URLs: the claude.ai sandbox forbids them), cached until the scene or frame changes */
let thumbCache = { key: '', s: '', e: '' };
function camThumbs() {
  const key = editRev + '|' + state.settings.aspect + '|' + state.settings.style + '|' + plateKey;
  if (thumbCache.key === key || exporting) return thumbCache;
  try {
    const w = 240, hh = Math.max(2, Math.round(w / arOf(state.settings.aspect) / 2) * 2), r = getExportRenderer(w, hh);
    const grab = t => { renderExportFrame(r, t, w, hh); return r.domElement.toDataURL('image/jpeg', 0.8); };
    thumbCache = { key, s: grab(0), e: grab(lastT()) };
  } catch (e) { console.error(e); thumbCache = { key, s: '', e: '' }; }
  applyAll(T); requestRender();
  return thumbCache;
}
function moveCard() {
  const ends = camEnds(), mv = detectMove(), th = camThumbs(), keyed = state.camera.keys.length > 0;
  const thumb = (label, src, on, t) => h('button', { class: 'mthumb' + (on ? ' ok' : ''), title: 'Go to the ' + label.toLowerCase() + ' frame', onclick: () => setTime(t) },
    src ? h('img', { src, alt: label + ' frame' }) : h('div', { class: 'noimg' }), h('span', null, (on ? '✓ ' : '') + label));
  return sec('Camera move', h('div', { class: 'movecard' },
    h('div', { class: 'mc-title' }, mv.title), h('div', { class: 'mc-sub' }, mv.sub),
    h('div', { class: 'mc-thumbs' }, thumb('Start', th.s, ends.s, 0), h('span', { class: 'mc-arrow' }, '→'), thumb('End', th.e, ends.e, lastT())),
    h('div', { class: 'btns big2' },
      h('button', { class: ends.s ? 'on' : '', onclick: () => setShotEnd('start'), title: 'Save what the camera sees now as the first frame' }, 'Set start'),
      h('button', { class: ends.e ? 'on' : '', onclick: () => setShotEnd('end'), title: 'Save what the camera sees now as the last frame' }, 'Set end')),
    keyed ? h('div', { class: 'btns' }, h('button', { onclick: () => { setTime(0); setPlaying(true); } }, '▶ Play the move'), h('button', { onclick: makeCameraStatic }, 'Make static')) : null,
    h('p', { class: 'note' }, ends.s && ends.e ? 'Reframe at either end and press Set start or Set end again to change it.' : 'Frame the opening shot → Set start. Frame the closing shot → Set end.')));
}

/* "Sky": how cloudy it is, what the clouds look like and how they drift. Advanced adds exact amounts and the sky, ground and fog colours */
function skySection(adv) {
  const s = state.settings, cl = () => s.clouds || CLOUDS_NEW, cover = cl().cover > 0;
  const setC = (patch, c = true) => { s.clouds = cleanClouds({ ...cl(), ...patch }); applyEnv(); changed(c, c); if (c) { propsDirty = false; renderProps(); } }; /* rows come and go, so the panel is rebuilt now, not a frame later */
  const set = (k, v, c = true) => { s[k] = v; applyEnv(); changed(c); };
  const chips = (list, cur, pick, swatch) => h('div', { class: 'chips grow' + (swatch ? ' cover' : '') }, list.map(([k, l]) =>
    h('button', { class: (cur === k ? 'on' : '') + (swatch ? ' cc' : ''), onclick: () => pick(k) }, swatch ? h('i', { class: 'csw ' + k }) : null, l)));
  const row = (label, kid) => h('div', { class: 'row chiprow' }, h('label', null, label), kid);
  const note = h('span', { class: 'note', style: 'margin:0' }), wording = () => putText(note, skyWording(cl(), s)); wording(); live.push(wording);
  const nearest = nearestCover(cl().cover);
  return sec('Sky',
    h('div', { class: 'lbl', style: 'width:auto;margin:2px 0 4px' }, 'Clouds'),
    chips(COVER.map(e => [e[0], e[2]]), nearest, k => setC({ cover: COVER.find(e => e[0] === k)[1] }), true),
    cover ? row('Look', chips(LOOKS, cl().look, k => setC({ look: k }))) : null,
    cover ? row('Drift', chips(DRIFTS, cl().drift, k => setC({ drift: k }))) : null,
    cover ? h('button', { class: 'wide', style: 'width:100%;margin-top:4px', title: 'Try a different arrangement of clouds', onclick: () => {
      let n; do n = 1 + Math.floor(Math.random() * 9999); while (n === cl().seed); setC({ seed: n });
    } }, 'Shuffle clouds') : null,
    h('div', { class: 'row' }, note),
    adv ? slider('Amount', () => cl().cover, (v, c) => setC({ cover: v }, c), { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }) : null,
    adv && cover ? slider('Edges', () => cl().soft, (v, c) => setC({ soft: v }, c), { min: 0, max: 1, step: 0.01, fmt: v => v < 0.25 ? 'crisp' : v < 0.65 ? 'medium' : 'soft' }) : null,
    adv && cover && cl().drift !== 'still' ? slider('Drift direction', () => cl().dir, (v, c) => setC({ dir: v }, c), { min: 0, max: 360, step: 1, fmt: v => v.toFixed(0) + '°' }) : null,
    adv ? h('hr', { class: 'div' }) : null,
    adv ? colorRow('Sky colour', () => s.sky, (v, c) => { s.env = 'custom'; set('sky', v, c); }) : null,
    adv ? check('Show ground', () => s.groundOn, v => set('groundOn', v)) : null,
    adv ? colorRow('Ground', () => s.groundColor, (v, c) => set('groundColor', v, c)) : null,
    adv ? check('Grid in editor', () => s.gridOn, v => { set('gridOn', v); syncTopUI(); }) : null,
    adv ? check('Fog / haze', () => s.fog, v => set('fog', v)) : null,
    adv ? slider('Fog amount', () => s.fogDensity, (v, c) => set('fogDensity', v, c), { min: 0.002, max: 0.08, step: 0.001, fmt: v => v.toFixed(3) }) : null,
    h('p', { class: 'note' }, 'Clouds also soften the sun. Drift moves them during the shot; set Still for a frozen sky.'));
}
/* "Sun & shadows": light the shot from a side, time of day, direction and height, shadows on or off, softness and depth */
function sunSection(adv) {
  const s = state.settings, set = (k, v, c = true) => { s[k] = v; applyEnv(); changed(c); };
  const note = h('span', { class: 'note', style: 'margin:0' }); live.push(() => putText(note, sunWording()));
  return sec('Sun & shadows',
    h('div', { class: 'lbl', style: 'width:auto;margin-bottom:4px' }, 'Light the shot from'),
    h('div', { class: 'chips' }, [['front', 'Front'], ['left', 'Side left'], ['right', 'Side right'], ['back', 'Backlight'], ['top', 'Top']].map(([k, l]) => h('button', { onclick: () => lightFrom(k), title: 'Place the sun relative to where the camera looks' }, l))),
    slider('Time of day', () => typeof s.tod === 'number' ? s.tod : 14, (v, c) => { const a = todSun(v); s.tod = v; s.sunEl = a.el; s.sunColor = a.color; s.sunInt = a.int; applyEnv(); changed(c); }, { min: 5, max: 20, step: 0.25, fmt: todLabel }),
    h('div', { class: 'row' }, note),
    slider('Direction', () => s.sunAz, (v, c) => set('sunAz', v, c), { min: 0, max: 360, step: 1, fmt: v => v.toFixed(0) + '\u00b0' }),
    slider('Height', () => s.sunEl, (v, c) => set('sunEl', v, c), { min: 2, max: 90, step: 1, fmt: v => v.toFixed(0) + '\u00b0' }),
    check('Cast shadows', () => s.shadows !== false, v => { s.shadows = v; applyEnv(); changed(true, true); }),
    s.shadows !== false ? slider('Softness', () => typeof s.shadowSoft === 'number' ? s.shadowSoft : 0.3, (v, c) => set('shadowSoft', v, c), { min: 0, max: 1, step: 0.01, fmt: v => v < 0.15 ? 'hard' : v < 0.5 ? 'medium' : 'soft' }) : null,
    slider('Shadow depth', () => clamp(1 - (s.ambInt - 0.2) / 2.3, 0, 1), (v, c) => set('ambInt', r4(0.2 + (1 - v) * 2.3), c), { min: 0, max: 1, step: 0.01, fmt: v => v < 0.35 ? 'light' : v < 0.7 ? 'normal' : 'deep' }),
    slider('Sun strength', () => s.sunInt, (v, c) => set('sunInt', v, c), { min: 0, max: 5, step: 0.05 }),
    adv ? colorRow('Sun colour', () => s.sunColor, (v, c) => set('sunColor', v, c)) : null,
    h('p', { class: 'note' }, 'Tip: drag the yellow sun in the editor or top view and watch the shadows move. Shadows follow the area the camera is looking at.'));
}
/* the panel for the Sun row (and the sun in the 3D view) */
function propsSun(p) {
  const s = state.settings;
  p.append(sec('Sun', h('p', { class: 'note', style: 'margin:0' }, 'Drag the sun in the 3D view, or use the controls below. It lights the whole scene.')));
  p.append(sunSection(true));
  p.append(sec('Environment', h('div', { class: 'chips' }, Object.entries(ENV).map(([k, e]) => h('button', { class: s.env === k ? 'on' : '', onclick: () => pickEnv(k) }, e.label))),
    h('p', { class: 'note' }, 'Presets change the sky, sun and fill light together.')));
  p.append(skySection(!simple));
}
/* ---- the camera panel: Shot | Move | Lens | Photo | Output ---- */
const CAM_TABS = [['shot', 'Shot'], ['move', 'Move'], ['lens', 'Lens'], ['photo', 'Photo'], ['output', 'Output']];
function propsCamera(p) {
  const c = state.camera, s = state.settings, dof = ensureDof();
  p.append(sec('Shot camera',
    h('div', { class: 'btns' },
      h('button', { class: view === 'camera' ? 'on' : '', onclick: () => setView(view === 'camera' ? 'editor' : 'camera') }, view === 'camera' ? 'Back to editor' : 'Look through camera'),
      view === 'editor' ? h('button', { onclick: camToEditorView, title: 'Place the camera where the editor view is' }, 'Camera to editor view') : null),
  ));
  const tab = CAM_TABS.some(t => t[0] === getPref('camTab')) ? getPref('camTab') : 'move';
  const inUse = { photo: !!state.plate, move: c.keys.length > 0, lens: !!dof.on };
  p.append(h('div', { class: 'tabs', role: 'tablist' }, CAM_TABS.map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', onclick: () => { setPref('camTab', k); propsDirty = true; } }, l, inUse[k] ? h('i', { class: 'tdot' }) : null))));
  if (tab === 'shot') {
    const ps = persons();
    if (ps.length) {
      if (!shotPerson || !getObj(shotPerson)) shotPerson = defaultShotPerson();
      p.append(sec('Frame a person',
        ps.length > 1 ? selectRow('Person', ps.map(x => [x.id, x.name]), () => shotPerson, v => { shotPerson = v; }) : null,
        shotGrid(() => shotPerson),
        h('p', { class: 'note' }, 'Uses the current lens. Try: Wide → Set start, Close-up → Set end.')));
    } else p.append(sec('Frame a person', h('p', { class: 'note' }, 'Add a person to use one-click shot sizes (wide, medium, close-up…).')));
    const subjOpts = [['', 'None (use the target point)'], ...state.objects.map(o => [o.id, o.name])];
    p.append(sec('Subject',
      selectRow('Look at', subjOpts, () => c.lookAtId || '', v => { if (v && !c.lookAtId) { c.base.tg = evalCam(T).tg; } c.lookAtId = v || null; if (!v) c.follow = false; updateGizmo(); changed(true, true); }),
      c.lookAtId ? check('Follow the subject (camera travels with it)', () => c.follow, v => { const cur = evalCam(T).p; c.follow = v; writeCam({ p: cur }, true); propsDirty = true; }) : null,
      h('p', { class: 'note' }, c.lookAtId ? 'The camera keeps aiming at the subject while it moves.' : 'Pick a person or object to keep it centred automatically.')));
    const mountSel = selectRow('Mount on', [['', 'Nothing (tripod or free)'], ...state.objects.filter(o => o.type !== 'mark').map(o => [o.id, o.name])], () => c.mount || '', v => mountCamera(v || null));
    mountSel.querySelector('select').dataset.role = 'mount';
    p.append(sec('Mount', mountSel, h('p', { class: 'note' }, 'The camera rides with it, like a car mount or a camera on a moving cart. Your camera moves still work on top.')));
  } else if (tab === 'move') {
    p.append(moveCard());
    const mg = h('div', { class: 'movegrid' }, MOVES.map(([k, ic, l]) => h('button', { onclick: () => applyMove(k), title: 'Animate the camera: ' + l.toLowerCase() + ', from the current framing' }, h('b', null, ic), l)));
    p.append(sec('One-click camera moves',
      slider('Strength', () => moveAmt, v => { moveAmt = v; }, { min: 0.25, max: 2.5, step: 0.05, fmt: v => v.toFixed(2) + '×' }),
      mg, h('p', { class: 'note' }, 'Starts from the current framing and runs for the whole shot.')));
    p.append(sec('Record a move live',
      h('div', { class: 'btns' }, h('button', { class: 'recbtn', onclick: startRecord }, '● Record camera')),
      h('p', { class: 'note' }, 'After a 3 s countdown the shot plays and you operate the camera: drag to orbit, right-drag to pan, scroll to dolly, W A S D Q E to fly. Your move is smoothed into keyframes.')));
    p.append(sec('Motion feel', feelSeg(), h('p', { class: 'note' }, 'How the camera starts and stops across the whole move.')));
    p.append(keySection('camera'));
  } else if (tab === 'lens') {
    const fr = slider('Focal length', () => camState.f, (v, cm) => writeCam({ f: v }, cm), { min: 10, max: 200, step: 1, fmt: v => v.toFixed(0) + ' mm' });
    p.append(sec('Lens', fr,
      h('div', { class: 'chips' }, [14, 18, 24, 35, 50, 85, 135].map(f => h('button', { onclick: () => writeCam({ f }, true), title: f < 24 ? 'Ultra wide' : f < 35 ? 'Wide' : f < 60 ? 'Normal' : 'Telephoto' }, f + 'mm'))),
      simple ? null : slider('Dutch roll', () => camState.roll || 0, (v, cm) => writeCam({ roll: v }, cm), { min: -45, max: 45, step: 0.5, fmt: v => v.toFixed(1) + '°' }),
      slider('Handheld', () => c.shake || 0, (v, cm) => { c.shake = v; changed(cm); }, { min: 0, max: 2, step: 0.05, fmt: v => v ? v.toFixed(2) : 'off' })));
    const fstops = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
    p.append(sec('Depth of field',
      check('Blur what is out of focus', () => dof.on, v => { dof.on = v; changed(true, true); }),
      dof.on ? h('div', null,
        slider('Aperture', () => dof.fstop, (v, cm) => { dof.fstop = v; changed(cm); }, { min: 1, max: 22, step: 0.1, fmt: v => 'f/' + v.toFixed(1) }),
        h('div', { class: 'chips' }, fstops.map(n => h('button', { class: Math.abs(dof.fstop - n) < 0.05 ? 'on' : '', onclick: () => { dof.fstop = n; changed(true, true); } }, 'f/' + n))),
        slider('Strength', dofStrength, (v, cm) => { dof.strength = v; changed(cm); }, { min: 1, max: 4.5, step: 0.1, fmt: v => v.toFixed(1) + '×' }),
        h('div', { class: 'chips' }, [[1, 'Real lens'], [2, 'Soft'], [3, 'Cinematic'], [4.5, 'Dreamy']].map(([n, l]) => h('button', { class: Math.abs(dofStrength() - n) < 0.05 ? 'on' : '', title: 'Blur strength ' + n + '×', onclick: () => { dof.strength = n; changed(true, true); } }, l))),
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
  } else if (tab === 'photo') {
    p.append(plateSection());
  } else {
    p.append(sec('Frame',
      selectRow('Aspect', ASPECTS.map(a => [a[0], a[2]]), () => s.aspect, v => { s.aspect = v; changed(true, true); syncTopUI(); }),
      selectRow('Size', SIZES, () => String(s.size), v => { s.size = +v; changed(true); }),
      selectRow('Guides', [['thirds', 'Rule of thirds'], ['center', 'Centre cross'], ['safe', 'Safe areas'], ['none', 'None']], () => s.guides, v => { s.guides = v; drawGuides(); changed(true); }),
      selectRow('View style', STYLES.map(x => [x[0], x[1]]), () => s.style, v => { s.style = v; changed(true); syncTopUI(); })));
    if (!simple) p.append(sec('Placement',
      vecRow('Position', () => camState.p, (v, cm) => writeCam({ p: v }, cm), { step: 0.02 }),
      c.lookAtId ? null : vecRow('Aims at', () => camState.tg, (v, cm) => writeCam({ tg: v }, cm), { step: 0.02 })));
  }
}
function shotGrid(pid) { return h('div', { class: 'posegrid' }, SHOTS.map(([k, l]) => h('button', { onclick: () => frameShot(k, pid()) }, l))); }
function feelSeg() {
  const c = state.camera;
  return h('div', { class: 'seg feel' }, [['constant', 'Constant'], ['gentle', 'Gentle ease'], ['strong', 'Strong ease']].map(([k, l]) =>
    h('button', { class: (c.feel || 'gentle') === k ? 'on' : '', onclick: () => { c.feel = k; changed(true, true); syncTopUI(); } }, l)));
}
/* the panel for two or more selected things: what they are, and the group / lock / duplicate / delete actions */
function propsMulti(p) {
  const list = selObjs(), whole = isGroupSel(list), g = whole ? state.groups[list[0].grp] : null;
  const sc = sec(whole ? 'Group' : list.length + ' items selected');
  if (g) {
    const nm = h('input', { type: 'text', value: g.name, class: 'grow' });
    nm.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') nm.blur(); });
    nm.addEventListener('change', () => { g.name = nm.value.trim() || g.name; changed(true, true); });
    sc.append(h('div', { class: 'row' }, h('label', null, 'Name'), nm));
  }
  sc.append(h('div', { class: 'chips', style: 'margin:4px 0 6px' }, list.map(o => h('button', { onclick: () => select(o.id, 'single'), title: 'Select only this one (or Alt-click it)' }, o.name))),
    h('p', { class: 'note' }, 'Drag any of them to move them all. The orange ring turns them together. Shift-click adds or removes items. ' + (whole ? '' : list.length + ' items selected.')));
  p.append(sc);
  const allLocked = list.every(o => o.locked), people = list.filter(o => o.type === 'person');
  p.append(sec('Arrange',
    h('div', { class: 'btns' },
      whole ? h('button', { onclick: ungroupSel }, 'Ungroup') : h('button', { class: 'primary', onclick: groupSel, title: 'Keep these together: clicking one selects them all (Ctrl+G)' }, 'Group'),
      h('button', { onclick: () => lockObjs(list, !allLocked), title: 'Ctrl+L' }, allLocked ? 'Unlock all' : 'Lock all')),
    h('div', { class: 'btns' },
      h('button', { onclick: dropToFloor }, 'Drop to floor'),
      people.some(o => !o.locked) ? h('button', { onclick: () => { for (const o of people.filter(x => !x.locked)) { const cur = clone(evalObj(o, T)); cur.r[1] = Math.atan2(camState.p[0] - cur.p[0], camState.p[2] - cur.p[2]) * R2D; if (o.opts.faceTravel && o.keys.length > 1) o.opts.faceTravel = false; writeObj(o, cur, false); } changed(true, true); toast('People face the camera'); } }, 'People face camera') : null),
    h('div', { class: 'btns' }, h('button', { onclick: duplicateSel }, 'Duplicate'), h('button', { onclick: deleteSel, style: 'color:#ff9c9c' }, 'Delete'))));
}
function propsObject(p, o) {
  const tr = () => evalObj(o, T);
  const setPart = (part) => (v, cm) => { const cur = clone(tr()); cur[part] = v; writeObj(o, cur, cm); };
  const name = h('input', { type: 'text', value: o.name, class: 'grow' });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; changed(true, true); });
  name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
  p.append(sec(o.type === 'person' ? BODIES[bodyOf(o)].label : catalogOf(o.type).label, h('div', { class: 'row' }, h('label', null, 'Name'), name),
    o.locked ? h('div', { class: 'lockline' }, h('span', { html: svgI('lock') }), 'Locked: it will not move when dragged. ', h('button', { onclick: () => lockObjs([o], false) }, 'Unlock')) : null,
    o.grp ? h('div', { class: 'note' }, 'Part of ' + groupName(o.grp) + '. ', h('a', { href: '#', onclick: e => { e.preventDefault(); select(o.id); } }, 'Select the whole group')) : null));
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
    const cur = poseAt(o, T), atStart = snapT(T) < 0.5 / state.settings.fps;
    const pg = h('div', { class: 'posegrid' }, Object.entries(POSES).map(([k, d]) => h('button', { class: cur === k ? 'on' : '', onclick: () => setPoseAt(o, k, T) }, d.label, d.anim ? h('i', null, d.loco ? 'moves' : 'animated') : null)));
    const def = POSES[cur] || POSES.stand;
    p.append(sec('Pose', h('div', { class: 'keyline' }, h('span', { class: 'kdia', style: 'color:#6fc3ea' }, '●'), atStart ? (o.acts ? 'Starting pose (at 0 s)' : 'Pose for the whole shot') : 'Pose from ' + snapT(T).toFixed(2) + ' s'), pg,
      def.anim && !(def.loco && o.keys.length > 1) ? slider('Action speed', () => o.opts.speed || 1, (v, cm) => { o.opts.speed = v; changed(cm); }, { min: 0.2, max: 3, step: 0.05, fmt: v => v.toFixed(2) + '×' }) : null,
      h('p', { class: 'note' }, 'Pick a pose at the playhead. At 0 s it is the starting pose; later in the shot it becomes a change of action (shown on the timeline), so they can walk in, stop, sit, then wave.'),
      def.loco ? h('p', { class: 'note' }, o.keys.length > 1 ? 'Steps match the distance walked, so the feet do not slide.' : 'Walking on the spot. Draw a path below to make them travel.') : null,
      isSeated(o) ? h('div', { class: 'btns' }, h('button', { onclick: () => standPerson(o) }, h('span', { html: svgI('stand'), class: 'bi' }), 'Stand up'), h('span', { class: 'note', style: 'margin:0 0 0 6px;align-self:center' }, 'Sitting on ' + ((getObj(o.opts.seated) || {}).name || 'a seat') + '. Drag them away to stand.')) : null));
    if (o.acts) {
      const rows = o.acts.map(a => {
        const s = h('select', null, Object.entries(POSES).map(([k, d]) => h('option', { value: k }, d.label)));
        s.value = a.pose; s.onchange = () => { a.pose = s.value; if (a.pose !== 'sit') delete a.at; changed(true, true); };
        return h('div', { class: 'actrow' }, h('span', { class: 't', title: 'Go to this moment', onclick: () => setTime(a.t) }, a.t.toFixed(2) + ' s'), s, a.at ? h('span', { title: 'Sits on the nearest seat', style: 'color:#6fc3ea' }, '⌂') : null,
          h('button', { title: 'Remove this action', 'aria-label': 'Remove this action', onclick: () => removeAct(o, a) }, '×'));
      });
      p.append(sec('Actions over time', h('div', { class: 'actrow' }, h('span', { class: 't' }, '0.00 s'), h('span', { style: 'flex:1;color:#c9cdd3' }, poseLabel(o.opts.pose || 'stand')), h('span', { class: 'note', style: 'margin:0' }, 'start')), ...rows,
        h('div', { class: 'btns', style: 'margin-top:6px' }, h('button', { onclick: () => { const cp = poseAt(o, T); delete o.acts; o.opts.pose = cp; changed(true, true); } }, 'One pose for the whole shot')),
        h('p', { class: 'note' }, 'Drag the blue tags on the timeline to retime them. Right-click a tag to remove it. Changes blend over about half a second.')));
    }
  }
  // ---- movement
  const who = o.type === 'person' ? 'walk ' : '';
  const moveKids = [
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => startPath(o.id), title: 'Click points on the floor; ' + (o.type === 'person' ? 'they walk' : 'it moves') + ' through them' }, h('span', { html: svgI('path'), class: 'bi' }), 'Draw ' + who + 'path')),
    slider('Speed', () => pathSpeedOf(o), (v, cm) => { o.opts.pathSpeed = v; changed(cm); }, { min: 0.3, max: o.type === 'car' ? 30 : 8, step: 0.1, fmt: v => v.toFixed(1) + ' m/s' }),
    check('Fit the path to the end of the shot', () => pathFit, v => { pathFit = v; }, 'Ignore the speed: arrive exactly on the last frame'),
    h('p', { class: 'note' }, 'Starts at the playhead (' + snapT(T).toFixed(2) + ' s). Walking ≈ ' + pref('walkSpeed') + ' m/s, jogging ≈ 3 m/s.'),
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
  if (o.keys.length > 1 || o.type === 'person' || o.type === 'car') moveKids.push(check('Face the way ' + (o.type === 'person' ? 'they' : 'it') + ' travel' + (o.type === 'person' ? '' : 's'), () => o.opts.faceTravel, v => { o.opts.faceTravel = v; changed(true); }));
  if (o.type === 'car') moveKids.push(h('p', { class: 'note' }, 'Wheels roll with the distance driven and the front wheels steer into the curves.'));
  p.append(sec('Move & face', ...moveKids));
  if (o.type === 'person') {
    const targets = [...state.objects.filter(x => x !== o && x.type === 'person'), ...state.objects.filter(x => x !== o && x.type !== 'person' && x.type !== 'mark')];
    p.append(sec('Eyeline', selectRow('Look at', [['', 'Ahead (no target)'], ['camera', 'The camera'], ...targets.map(x => [x.id, x.name])], () => o.opts.lookAt || '', v => setLookAt(o, v || null)),
      h('p', { class: 'note' }, 'The head and upper body turn to keep looking, even while either of them moves.')));
    p.append(sec('Frame with the camera', shotGrid(() => o.id), h('p', { class: 'note' }, 'Moves the shot camera to frame ' + o.name + '.')));
  }
  // ---- attach: ride with another item (people in a car, a cup on a tray)
  {
    const par = parentOf(o), under = par ? null : underneath(o);
    const ride = selectRow('Ride with', [['', 'Nothing (moves on its own)'], ...state.objects.filter(x => x.type !== 'mark' && !ridesWith(o, x.id)).map(x => [x.id, x.name])], () => o.parent || '', v => attachObj(o, v || null));
    ride.querySelector('select').dataset.role = 'ride';
    p.append(sec('Attach', ride,
      under ? h('div', { class: 'btns' }, h('button', { onclick: () => attachObj(o, under.id) }, 'Attach to ' + under.name + ' (underneath)')) : null,
      h('p', { class: 'note' }, par ? o.name + ' moves and turns with ' + par.name + '. Its own moves happen relative to it.' : 'Attach it to something so it moves along: people riding in a car, a cup on a table, a bag on a cart.')));
  }
  // ---- look
  if (o.type === 'person') {
    p.append(sec('Look',
      h('div', { class: 'seg feel', style: 'margin-bottom:6px' }, Object.entries(BODIES).map(([k, b]) => h('button', { class: bodyOf(o) === k ? 'on' : '', 'data-body': k, onclick: () => {
        o.opts.body = k; o.opts.height = b.height; if (k === 'woman' && o.opts.hair === BODIES.man.hair) o.opts.hair = b.hair;
        syncScene(); updateGizmo(); changed(true, true);
      } }, b.label))),
      slider('Height', () => o.opts.height || 1.75, (v, cm) => { o.opts.height = v; rebuild(cm); }, { min: 0.8, max: 2.2, step: 0.01, fmt: v => v.toFixed(2) + ' m' }),
      colorRow('Top', () => o.color, (v, cm) => { o.color = v; rebuild(cm); }),
      colorRow('Trousers', () => o.opts.pants, (v, cm) => { o.opts.pants = v; rebuild(cm); }),
      simple ? null : colorRow('Skin', () => o.opts.skin, (v, cm) => { o.opts.skin = v; rebuild(cm); }),
      simple ? null : colorRow('Hair', () => o.opts.hair, (v, cm) => { o.opts.hair = v; rebuild(cm); })));
  } else if (o.type === 'image') {
    p.append(sec('Image card', check('Unlit (no shading, like a backdrop)', () => o.opts.unlit, v => { o.opts.unlit = v; rebuild(); })));
  } else if (o.type !== 'model') {
    p.append(sec('Look', colorRow('Colour', () => o.color, (v, cm) => { o.color = v; rebuild(cm); }),
      o.type === 'car' ? check('Convertible (open top)', () => !!o.opts.convertible, v => { o.opts.convertible = v; rebuild(); propsDirty = true; }) : null));
  }
  // ---- placement
  const grounded = isGrounded(o);
  /* a grounded item rests on the floor or on what is under it; "Can float" is for things in the air */
  const floatChk = groundOn() && !o.parent && !(o.opts.seated) ? check('Can float (not kept on the ground)', () => !!o.opts.free, v => { o.opts.free = v; propsDirty = true; syncScene(); updateGizmo(); changed(true, true); toast(v ? o.name + ' can float' : o.name + ' kept on the ground'); }, 'For things in the air: a drone, a bird, a hanging lamp, a thrown ball') : null;
  const tools = h('div', { class: 'btns', style: 'margin-top:8px' },
    grounded ? null : h('button', { onclick: dropToFloor }, 'Drop to floor'),
    h('button', { onclick: duplicateSel }, 'Duplicate'),
    h('button', { onclick: deleteSel, style: 'color:#ff9c9c' }, 'Delete'));
  const travelNote = o.opts.faceTravel && o.keys.length > 1 ? h('p', { class: 'note' }, 'Turning follows the path. Untick "Face the way they travel" to turn them yourself.') : null;
  if (simple) {
    p.append(sec('Placement',
      slider('Turn', () => { let y = tr().r[1] % 360; if (y > 180) y -= 360; if (y < -180) y += 360; return y; }, (v, cm) => { const cur = clone(tr()); cur.r[1] = v; writeObj(o, cur, cm); }, { min: -180, max: 180, step: 1, fmt: v => v.toFixed(0) + '°' }),
      slider('Size', () => tr().s[0], (v, cm) => { const cur = clone(tr()); const k = v / (cur.s[0] || 1); cur.s = cur.s.map(x => Math.max(0.01, x * k)); writeObj(o, cur, cm); }, { min: 0.1, max: 5, step: 0.01, fmt: v => v.toFixed(2) + '×' }),
      grounded ? null : slider('Lift', () => tr().p[1], (v, cm) => { const cur = clone(tr()); cur.p[1] = v; writeObj(o, cur, cm); }, { min: 0, max: 5, step: 0.01, fmt: v => v.toFixed(2) + ' m' }),
      floatChk, travelNote, h('p', { class: 'note' }, grounded ? 'Drag it across the floor to move it; it rests on the floor or on whatever is under it. Drag the orange ring to turn it.' : 'Drag it across the floor to move it. Drag the orange ring to turn it, the green arrow to raise it.'), tools));
  } else {
    const uni = numField('×', () => tr().s[0], (v, cm) => { const cur = clone(tr()); const k = v / (cur.s[0] || 1); cur.s = cur.s.map(x => Math.max(0.01, x * k)); writeObj(o, cur, cm); }, { step: 0.01, min: 0.01, dec: 2 });
    p.append(sec('Transform',
      vecRow('Position', () => tr().p, setPart('p'), { step: 0.02, lockY: grounded ? 'Height is set by the floor or the surface underneath. Tick "Can float" to set it yourself.' : null }),
      vecRow('Rotation', () => tr().r, setPart('r'), { step: 0.5, dec: 1 }),
      h('div', { class: 'row' }, h('label', null, 'Size'), h('div', { style: 'width:90px' }, uni), h('span', { class: 'note', style: 'margin:0' }, 'uniform')),
      vecRow('Scale', () => tr().s, (v, cm) => setPart('s')(v.map(x => Math.max(0.01, x)), cm), { step: 0.01, min: 0.01 }),
      floatChk, travelNote, tools));
  }
  p.append(keySection(o.id));
  p.append(sec('Camera', h('div', { class: 'btns' },
    h('button', { onclick: () => { state.camera.lookAtId = o.id; state.camera.base.tg = evalCam(T).tg; changed(true); toast('Camera now keeps ' + o.name + ' in frame'); } }, 'Keep camera on this'),
    state.camera.mount === o.id ? h('button', { onclick: () => mountCamera(null) }, 'Unmount the camera') : h('button', { onclick: () => mountCamera(o.id), title: 'The camera rides with it, like a car mount' }, 'Mount camera on this'))));
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
    const who = isCam ? null : getObj(id);
    if (who && who.acts) for (const a of who.acts) {
      if (a.t > L + 1e-6) continue;
      const tag = h('div', { class: 'act', style: `left:${a.t / L * 100}%`, title: `${poseLabel(a.pose)} at ${a.t.toFixed(2)} s · drag to retime · right-click to remove` }, poseLabel(a.pose));
      actDrag(tag, who, a, laneEl); laneEl.append(tag);
    }
    scrubOn(laneEl);
    return h('div', { class: 'tlr' + (selected === id || (isCam && selected === 'target') ? ' sel' : '') }, h('div', { class: 'lab', tabindex: 0, 'data-id': id, title: name, onclick: () => select(id), onkeydown: rowKeys(id) }, h('span', { html: isCam ? svgI('camera') : iconFor(getObj(id)), style: 'display:flex;width:14px;flex:none' }), h('span', { class: 'nm' }, name)), laneEl);
  };
  rows.append(mk('camera', 'Shot camera', state.camera.keys, true));
  for (const o of state.objects) if (o.keys.length || o.acts || selected === o.id) rows.append(mk(o.id, o.name, o.keys, false));
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
/* a blue pose-change tag on a person's row: drag to retime, right-click to remove */
function actDrag(tag, o, act, laneEl) {
  tag.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); removeAct(o, act); });
  tag.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation(); if (playing) setPlaying(false);
    tag.setPointerCapture(e.pointerId);
    const sx = e.clientX; let moved = false;
    const mv = ev => {
      if (Math.abs(ev.clientX - sx) > 3) moved = true;
      if (!moved) return;
      const nt = Math.max(1 / state.settings.fps, snapT(timeFromX(ev.clientX, laneEl)));
      act.t = nt; tag.style.left = (nt / lastT() * 100) + '%'; setTime(nt, false); editRev++;
    };
    const up = () => {
      tag.removeEventListener('pointermove', mv); for (const ev of ['pointerup', 'pointercancel']) tag.removeEventListener(ev, up);
      if (moved) {
        /* two tags on one frame: the one just moved wins */
        setActs(o, o.acts.filter(x => x === act || Math.abs(x.t - act.t) > 0.5 / state.settings.fps));
        changed(true, true);
      } else { setTime(act.t); if (selected !== o.id) select(o.id); }
    };
    tag.addEventListener('pointermove', mv); for (const ev of ['pointerup', 'pointercancel']) tag.addEventListener(ev, up);
  });
}
function selKeysTarget() {
  if (camPane()) return 'camera';
  if (selected === 'target') return 'camera';
  if (selected === 'sun' || selected === 'export') return null;
  return selected || (view === 'camera' ? 'camera' : null);
}
function addKeySel() {
  const id = selKeysTarget();
  if (!id) { toast('Select something first (or switch to Camera view to key the camera)'); return; }
  if (id === 'camera') { const cur = clone(evalCamRaw(T)); setKey(state.camera.keys, T, cur); }
  else { const o = getObj(id); setKey(o.keys, T, clone(evalLocal(o, T))); } /* keys are stored relative to the parent */
  changed(true, true); toast('◆ Key added at ' + fmtTime(snapT(T)));
}
function removeKey(id, idx) {
  const isCam = id === 'camera';
  const holder = isCam ? state.camera : getObj(id);
  if (!holder || idx < 0) return;
  const before = clone(isCam ? evalCamRaw(T) : evalLocal(holder, T));
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
  if (view === 'camera' || !pref('showLabels')) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const cam = view === 'top' ? topCam : edCam, wr = viewRects(vpEl.clientWidth, vpEl.clientHeight).work, w = wr ? wr.w : vpEl.clientWidth, hh = vpEl.clientHeight, seen = new Set();
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
  const camUI = view === 'camera' || splitOn();
  if (camUI) { const en = camEnds(); $('#cbStart').classList.toggle('on', en.s); $('#cbEnd').classList.toggle('on', en.e); putText($('#cbStart'), (en.s ? '✓ ' : '') + 'Set start'); putText($('#cbEnd'), (en.e ? '✓ ' : '') + 'Set end'); $('#cbRec').classList.toggle('on', !!rec); }
  const L = lastT(), W = laneW();
  putStyle($('#tlHead'), 'left', (168 + T / L * W) + 'px');
  putText($('#tcode'), fmtTime(T));
  putText($('#tframe'), 'frame ' + (Math.round(T * state.settings.fps) + 1) + ' / ' + frames());
  for (const f of live) f();
  const hint = $('#hint');
  putStyle(hint, 'display', pref('showHints') ? '' : 'none');
  if (camUI) {
    putHTML($('#hud'), `<span><b>CAMERA</b></span><span class="shotdesc">${describeShot()}</span>${dofActive() ? `<span>f/${ensureDof().fstop.toFixed(1)} · focus ${focusDist(camState).toFixed(2)} m</span>` : ''}${focusPick ? '<span class="rec">Click to set focus</span>' : ''}${playing ? '<span class="rec">● PLAY</span>' : ''}`);
    putStyle($('#hud'), 'display', 'flex');
  } else putStyle($('#hud'), 'display', 'none');
  /* the overlays sit over the half they belong to */
  { const sp = splitOn(), R = viewRects(vpEl.clientWidth, vpEl.clientHeight), bar = $('#camBar');
    putStyle(bar, 'left', (sp ? R.cam.x : 0) + 10 + 'px'); putStyle(bar, 'maxWidth', sp ? (R.cam.w - 20) + 'px' : '');
    putStyle($('#hud'), 'left', sp ? R.cam.x + 'px' : '0px'); putStyle($('#hud'), 'top', sp ? (10 + bar.offsetHeight + 6) + 'px' : '');
    putStyle($('#vpRight'), 'right', (sp ? vpEl.clientWidth - R.work.w + 10 : 10) + 'px'); putStyle(hint, 'maxWidth', sp ? (R.work.w - 30) + 'px' : ''); }
  if (camPane()) {
    putHTML(hint, rec ? (rec.phase === 'rec' ? '<b style="color:#ff6b6b">● Recording</b> · steer the camera · <kbd>Esc</kbd> cancel' : 'Get ready… position the camera now')
      : 'Drag: orbit · Right-drag: pan · Scroll: dolly · <kbd>Alt</kbd>+scroll: lens · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <kbd>Q</kbd><kbd>E</kbd> fly · <kbd>K</kbd> key camera');
  } else {
    const nav = view === 'top' ? 'Drag empty space: pan · Scroll: zoom' : 'Drag empty space: orbit · Right-drag: pan · Scroll: zoom';
    putHTML(hint, placing || pathMode ? '<kbd>Esc</kbd> cancel' + (pathMode ? ' · <kbd>Enter</kbd> done · right-click removes the last point' : '')
      : isMulti() ? 'Drag any of them to move them all · drag the orange ring to turn them together · <kbd>Shift</kbd> click adds or removes · <kbd>Ctrl</kbd><kbd>G</kbd> group · <kbd>Ctrl</kbd><kbd>L</kbd> lock'
      : selected === 'export' ? 'Choose what to export in the panel on the right'
      : selected === 'sun' ? 'Drag the yellow sun to turn the light and the shadows · right-click it for light-from presets · or use the panel'
      : selected && selected !== 'camera' && selected !== 'target'
        ? 'Drag it on the floor to move · drag the orange ring to turn · right-click for more · <kbd>K</kbd> key · <kbd>Del</kbd> delete'
        : selected ? 'Drag the camera or its aim point on the floor · or use the panel'
          : nav + ' · Click something to select it · right-click for options · double-click an object to focus the lens · <kbd>T</kbd> top view · <kbd>C</kbd> camera view');
  }
  $('#bUndo').disabled = hi <= 0; $('#bRedo').disabled = hi >= hist.length - 1;
  undoTitles();
  const step = currentStep();
  $$('#stepSeg button').forEach(b => { const on = b.dataset.step === step; if (b.classList.contains('on') !== on) b.classList.toggle('on', on); });
  syncTracks();
}
/* the step bar: 1 Build, 2 Frame, 3 Export. The active pill follows what you are doing. */
const currentStep = () => selected === 'export' || openModals().some(m => m.id === 'mExport') ? 'export' : view === 'camera' || selected === 'camera' || selected === 'target' ? 'frame' : 'build';
function goStep(s) {
  if (exporting || rec) return;
  if (placing) cancelPlacing();
  if (pathMode) cancelPath();
  if (s === 'build') { if (view === 'camera') setView(lastWorkView); if (selected === 'camera' || selected === 'target' || selected === 'export') select(null); setLeftTab('add'); }
  else if (s === 'frame') { if (!splitOn()) setView('camera'); select('camera'); }
  else if (s === 'export') { if (view !== 'camera' && !splitOn()) setView('camera'); select('export'); }
  requestRender();
}
/* timeline tracks: open while something is keyed, unless you opened or closed them by hand */
let tracksMode = null;
const anyKeys = () => state.camera.keys.length > 0 || state.objects.some(o => o.keys.length > 0 || actList(o));
const tracksOpen = () => tracksMode ? tracksMode === 'open' : anyKeys();
function syncTracks() { const open = tracksOpen(); $('#tl').classList.toggle('closed', !open); putText($('#bTracks'), open ? 'Tracks ▾' : 'Tracks ▴'); }
/* the undo and redo buttons say which step they would undo or redo (worked out only when the history changes) */
let ttKey = null;
function undoTitles() {
  const a = hist[hi - 1], b = hist[hi], c = hist[hi + 1];
  if (ttKey && ttKey[0] === a && ttKey[1] === b && ttKey[2] === c) return;
  ttKey = [a, b, c];
  const lab = (w, x, y) => { const d = describeChange(x, y); return w + (d ? ': ' + d : ''); };
  $('#bUndo').title = hi > 0 ? lab('Undo', a, b) + ' (Ctrl+Z)' : 'Nothing to undo';
  $('#bRedo').title = hi < hist.length - 1 ? lab('Redo', b, c) + ' (Ctrl+Y)' : 'Nothing to redo';
}


/* ============================== menus ============================== */
/* One menu element (#ctxMenu) serves dropdown buttons and the right-click menu.
   items: { head } | { label, fn, id?, key?, check?, danger?, disabled? } | '-' */
let menuBtn = null, menuClosedAt = 0;
const menuOpen = () => $('#ctxMenu').style.display === 'block';
function hideMenu(refocus) {
  const m = $('#ctxMenu'); if (m.style.display !== 'block') return;
  menuClosedAt = performance.now(); m.style.display = 'none'; m.innerHTML = '';
  if (refocus) { try { (menuBtn || $('#c')).focus(); } catch (e) { } menuBtn = null; }
}
function showMenu(x, y, items, opener = null) {
  if (!items || !items.length) return false;
  menuBtn = opener;
  const m = $('#ctxMenu'); m.innerHTML = '';
  for (const it of items) {
    if (it === '-') m.append(h('div', { class: 'sep', role: 'separator' }));
    else if (it.head) m.append(h('div', { class: 'head' }, it.head));
    else m.append(h('button', { role: it.check !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.check !== undefined ? String(!!it.check) : null, 'data-cmd': it.id, class: it.danger ? 'danger' : '', disabled: !!it.disabled, onclick: () => { hideMenu(true); it.fn(); } },
      h('span', null, it.check !== undefined ? h('span', { class: 'ck' }, it.check ? '\u2713' : '') : null, it.label), it.key ? h('kbd', null, it.key) : null));
  }
  m.style.display = 'block';
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  m.focus();
  return true;
}
/* a button that opens a dropdown below itself; clicking it again closes the menu */
function menuButton(btn, itemsFn) {
  btn.addEventListener('click', () => {
    if (menuBtn === btn && performance.now() - menuClosedAt < 250) { menuBtn = null; return; }
    const r = btn.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, itemsFn(), btn);
  });
}
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
function fileMenuItems() {
  return [{ head: 'Project' },
    { id: 'new', label: 'New\u2026', fn: () => openStarters() },
    { id: 'open', label: 'Open\u2026', fn: openProjectUI, key: 'Ctrl O' },
    ...(platform.kind === 'desktop' ? [{ id: 'recent', label: 'Recent projects\u2026', fn: openRecent }] : []), /* on the web, Open\u2026 already shows the recent projects */
    '-',
    { id: 'save', label: 'Save', fn: () => saveProject(false), key: 'Ctrl S' },
    { id: 'saveas', label: 'Save as\u2026', fn: () => saveProject(true), key: 'Ctrl Shift S' },
    '-',
    { id: 'export', label: 'Export\u2026', fn: () => goStep('export'), key: '3' }];
}
function gearMenuItems() {
  return [{ id: 'advanced', label: 'Advanced controls', check: !simple, fn: () => setSimple(!simple) },
    { id: 'ground', label: 'Keep things on the ground', check: groundOn(), fn: () => setGround(!groundOn()) }, /* the same switch as in Settings */
    { id: 'settings', label: 'Settings\u2026', fn: openSettings },
    '-',
    { head: TOUR_COPY.menu.heading },
    { id: 'tour-basic', label: TOUR_COPY.menu.quick, check: !!getPref('tourBasicDone', false), fn: () => startTour('basic') },
    ...(handsTourOn() ? [{ id: 'tour-hands', label: TOUR_COPY.menu.hands, check: !!getPref('tourHandsDone', false), fn: () => startTour('hands') }] : []),
    { id: 'help', label: 'Quick start and shortcuts', fn: () => openModal('mHelp'), key: '?' },
    { id: 'about', label: 'About ShotRef', fn: openAbout }];
}
/* About ShotRef: version, where it runs and when it was built; privacy; copyright; the bundled libraries' licences.
   On the desktop it also offers What's new and Check for updates (both shown by the main process). */
const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : '';
const LICENSES = typeof __LICENSES__ !== 'undefined' ? __LICENSES__ : [];
function niceDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return '';
  return (+m[3]) + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[m[2] - 1] + ' ' + m[1];
}
function openAbout() {
  const desk = platform.kind === 'desktop';
  const v = platform.version || APP_VERSION, d = niceDate(BUILD_DATE);
  $('#aboutVer').textContent = [v && 'Version ' + v, { desktop: 'Desktop app', claude: 'On claude.ai', web: 'Web page' }[platform.kind], d && 'built ' + d].filter(Boolean).join(' \u00b7 ');
  $('#aboutPrivacy').textContent = desk
    ? 'Works offline. Your scenes, photos and models stay on this computer. ShotRef only goes online to check for updates, and you can turn the automatic check off in the Help menu.'
    : 'Works offline. ShotRef never uploads your scenes, photos or models. They stay in this browser and in the files you save.';
  $('#aboutNews').hidden = $('#aboutUpd').hidden = !desk;
  const box = $('#aboutLic'); box.hidden = true; $('#aboutLicBtn').setAttribute('aria-expanded', 'false');
  box.replaceChildren(h('p', { class: 'note', style: 'margin:0' }, 'ShotRef is built with these open-source libraries. Thank you to their authors.'),
    ...LICENSES.filter(l => desk || !l.desktop).flatMap(l => [h('h3', null, l.name + ' ', h('span', null, l.version)), h('pre', null, l.text)]),
    ...(desk ? [h('p', { class: 'note' }, 'The licences for Chromium, which Electron includes, are in LICENSES.chromium.html in the folder where ShotRef is installed.')] : []));
  openModal('mAbout');
}
function wireAbout() {
  $('#aboutLicBtn').addEventListener('click', () => { const box = $('#aboutLic'); box.hidden = !box.hidden; $('#aboutLicBtn').setAttribute('aria-expanded', String(!box.hidden)); if (!box.hidden) box.scrollIntoView({ block: 'nearest' }); });
  $('#aboutNews').addEventListener('click', () => platform.whatsNew());
  $('#aboutUpd').addEventListener('click', () => platform.checkUpdates());
}
function wireMenu() {
  const m = $('#ctxMenu');
  m.addEventListener('keydown', e => {
    const k = e.key;
    e.stopPropagation(); /* while a menu is open it owns the keyboard: no other shortcut runs */
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(k)) return; /* Enter and Space press the focused item */
    e.preventDefault();
    if (k === 'Escape' || k === 'Tab') { hideMenu(true); return; }
    const bs = [...m.querySelectorAll('button:not(:disabled)')]; if (!bs.length) return;
    let i = bs.indexOf(document.activeElement);
    i = k === 'Home' ? 0 : k === 'End' ? bs.length - 1 : k === 'ArrowDown' ? (i + 1) % bs.length : (i <= 0 ? bs.length - 1 : i - 1);
    bs[i].focus();
  });
  document.addEventListener('pointerdown', e => { if (menuOpen() && !(e.target.closest && e.target.closest('#ctxMenu'))) hideMenu(); }, true);
  window.addEventListener('blur', () => hideMenu());
  window.addEventListener('resize', () => hideMenu());
  window.addEventListener('wheel', () => hideMenu(), { passive: true, capture: true });
}

/* ---- right-click menu on the 3D view ---- */
/* a new camera point on the path at time t, with the camera exactly as it is there (the shape of the move stays) */
function addCamPoint(t) {
  t = snapT(clamp(t, 0, lastT()));
  setKey(state.camera.keys, t, clone(evalCamRaw(t)));
  changed(true, true); toast('Camera point added at ' + t.toFixed(2) + ' s. Drag it to reshape the path.', 3500);
}
function makeCameraStatic() {
  const c = state.camera; c.base = clone(evalCamRaw(T)); c.keys = []; changed(true, true); toast('Camera move cleared: it now stays where it is');
}
/* focus the lens on a world point (double-click, or the menu): depth of field on, auto off, keyed if the camera already has keys */
function focusLensAt(pt, name) {
  prepRenderCam(T);
  const fwd = new THREE.Vector3(); renderCam.getWorldDirection(fwd);
  const d = pt.clone().sub(renderCam.position).dot(fwd);
  if (d < 0.1) { toast(name + ' is behind the camera'); return; }
  const dof = ensureDof(), wasOff = !dof.on, keyed = state.camera.keys.length > 0;
  dof.on = true; dof.auto = false;
  writeCam({ fd: d }, true); propsDirty = true; focusPicks++;
  toast(`Focus on ${name} (${d.toFixed(2)} m)` + (wasOff ? '. Depth of field is now on' : '') + (keyed ? `. Keyed at ${snapT(T).toFixed(2)} s: double-click something else later in the shot to pull focus` : ''), 4200);
}
function mountCamera(id) {
  const o = id && getObj(id); if (id && !o) return;
  setMount(id || null); changed(true, true);
  toast(o ? 'The camera now rides on ' + o.name : 'The camera is free again');
}
function keepCameraOn(o) { o = getObj(o.id); if (!o) return; state.camera.lookAtId = o.id; state.camera.base.tg = evalCam(T).tg; changed(true, true); toast('Camera now keeps ' + o.name + ' in frame'); }
function ctxItems(hit, floor) {
  const items = [], sel = selected && getObj(selected), selP = sel && sel.type === 'person' ? sel : null;
  if (hit && (hit.id === 'camera' || hit.id === 'target')) {
    select('camera');
    items.push({ head: 'Shot camera' }, { label: 'Look through camera', fn: () => setView('camera'), key: 'C' }, { label: 'Set start frame', fn: () => setShotEnd('start') }, { label: 'Set end frame', fn: () => setShotEnd('end') });
    if (state.camera.keys.length) items.push({ label: 'Make static (clear move)', fn: makeCameraStatic });
    return items;
  }
  if (hit && hit.id.startsWith('ck:')) {
    const i = +hit.id.slice(3), k = state.camera.keys[i]; select('camera');
    return k ? [{ head: 'Camera point at ' + k.t.toFixed(2) + ' s' }, { label: 'Go to this moment', fn: () => setTime(k.t) }, { label: 'Look through the camera here', fn: () => { setTime(k.t); setView('camera'); } }, '-',
      { label: 'Delete this point', danger: true, disabled: state.camera.keys.length < 2, fn: () => removeKey('camera', i) }] : [];
  }
  if (hit && hit.id === 'cpath') {
    const t = snapT(clamp((hit.index || 0) / 140 * lastT(), 0, lastT())); select('camera');
    return [{ head: 'Camera path' }, { label: 'Add a camera point here (' + t.toFixed(2) + ' s)', fn: () => addCamPoint(t) }, { label: 'Go to this moment', fn: () => setTime(t) }];
  }
  if (hit && hit.id === 'sun') {
    select('sun');
    return [{ head: 'Sun' }, ...Object.entries(LIGHT_FROM).map(([k, d]) => ({ label: d[2], fn: () => lightFrom(k) })), '-',
      { label: state.settings.shadows === false ? 'Turn shadows on' : 'Turn shadows off', fn: () => setShadows(state.settings.shadows === false) }];
  }
  const o = hit && getObj(hit.id);
  if (o) {
    /* right-clicking something already in the selection keeps the selection (and acts on all of it) */
    if (selected !== o.id && !selIds.includes(o.id)) select(o.id);
    const list = selObjs();
    if (list.length > 1) {
      const whole = isGroupSel(list), allLocked = list.every(x => x.locked), sameGroup = list.some(x => x.grp);
      items.push({ head: whole ? groupName(list[0].grp) + ' (' + list.length + ' items)' : list.length + ' items selected' },
        whole || (sameGroup && list.every(x => x.grp)) ? { label: 'Ungroup', fn: ungroupSel, key: 'Ctrl Shift G' } : { label: 'Group ' + list.length + ' items', fn: groupSel, key: 'Ctrl G' },
        { label: allLocked ? 'Unlock ' + list.length + ' items' : 'Lock ' + list.length + ' items', fn: () => lockObjs(list, !allLocked), key: 'Ctrl L' }, '-',
        { label: 'Duplicate', fn: duplicateSel, key: 'Ctrl D' },
        { label: 'Drop to floor', fn: dropToFloor },
        { label: 'Hide', fn: () => { for (const x of list.map(q => getObj(q.id)).filter(Boolean)) x.visible = false; syncScene(); updateGizmo(); changed(true, true); toast(list.length + ' items hidden (the eye in the Scene list brings them back)'); } },
        { label: 'Delete', fn: deleteSel, key: 'Del', danger: true });
      return items;
    }
    items.push({ head: o.name });
    if (o.type === 'mark') {
      const w = selP || persons()[0];
      if (w) {
        const a = evalObj(w, T).p, m = evalObj(o, T).p;
        const arrive = Math.min(lastT(), snapT(T + Math.max(0.5, Math.hypot(a[0] - m[0], a[2] - m[2]) / pathSpeedOf(w))));
        items.push({ label: `Walk ${w.name} here (arrive ${arrive.toFixed(1)} s)`, fn: () => walkToMark(w, o.id, arrive) });
      }
    } else {
      if (o.type === 'person') {
        items.push({ label: 'Draw walk path', fn: () => startPath(o.id) });
        if (isSeated(o)) items.push({ label: 'Stand up', fn: () => standPerson(o) });
        items.push({ label: 'Frame: Medium shot', fn: () => frameShot('medium', o.id) }, { label: 'Frame: Close-up', fn: () => frameShot('cu', o.id) },
          { label: o.opts.lookAt === 'camera' ? 'Stop looking at the camera' : 'Look at the camera', fn: () => setLookAt(o, o.opts.lookAt === 'camera' ? null : 'camera') });
        if (selP && selP !== o) items.push({ label: `${o.name} looks at ${selP.name}`, fn: () => setLookAt(o, selP.id) });
      } else items.push({ label: 'Draw path', fn: () => startPath(o.id) });
      items.push({ label: 'Face the camera', fn: () => faceToward(o, camState.p, 'the camera') });
      if (seatsOf(o).length) {
        const who = persons().length ? (selP && selP !== o ? selP : persons().find(q => q.opts.seated !== o.id) || persons()[0]) : null;
        if (who) items.push({ label: `Sit ${who.name} here`, fn: () => sitPerson(who, freeSeat(o, who)) });
      }
      items.push({ label: 'Keep camera on this', fn: () => keepCameraOn(o) },
        state.camera.mount === o.id ? { label: 'Unmount the camera', fn: () => mountCamera(null) } : { label: 'Mount the camera on this', fn: () => mountCamera(o.id) });
      const par = parentOf(o), under = !par && underneath(o);
      if (par) items.push({ label: 'Detach from ' + par.name, fn: () => attachObj(o, null) });
      else if (under) items.push({ label: 'Attach to ' + under.name + ' (rides with it)', fn: () => attachObj(o, under.id) });
    }
    items.push({ label: 'Focus the lens here', key: 'double-click', fn: () => focusLensAt(new THREE.Vector3().fromArray(aimPoint(o, T)), o.name) }, '-');
    if (o.grp) items.push({ label: 'Ungroup', fn: ungroupSel, key: 'Ctrl Shift G' });
    items.push({ label: o.locked ? 'Unlock' : 'Lock (stop accidental moves)', fn: () => lockObjs([o], !o.locked), key: 'Ctrl L' },
      { label: 'Duplicate', fn: duplicateSel, key: 'Ctrl D' },
      ...(o.type !== 'mark' && !isGrounded(o) ? [{ label: 'Drop to floor', fn: dropToFloor }] : []),
      { label: 'Hide', fn: () => { const q = getObj(o.id); if (!q) return; q.visible = false; syncScene(); updateGizmo(); changed(true, true); toast(o.name + ' hidden (the eye in the Scene list brings it back)'); } },
      { label: 'Delete', fn: deleteSel, key: 'Del', danger: true });
    return items;
  }
  if (floor) {
    const at = [snapV(floor.x), 0, snapV(floor.z)];
    items.push({ head: 'On the floor here' }, ...Object.entries(BODIES).map(([k, b]) => ({ label: 'Add a ' + b.label.toLowerCase() + ' here', fn: () => addPerson(k, false, at) })), { label: 'Add floor mark here', fn: () => addObject('mark', null, false, at) });
    if (selP) items.push({ label: `Walk ${selP.name} here`, fn: () => { const c = evalObj(selP, T).p; pathMode = { id: selP.id, pts: [[c[0], c[2]], [at[0], at[2]]], y: c[1], cursor: null }; finishPath(); } });
    if (sel && !isMulti()) items.push({ label: `Move ${sel.name} here`, fn: () => { const cur = clone(evalObj(sel, T)); cur.p = [at[0], cur.p[1], at[2]]; writeObj(sel, cur, true); propsDirty = true; toast(sel.name + ' moved'); } });
    items.push({ label: 'Aim the camera here', fn: () => writeCam({ tg: [at[0], 1, at[2]] }, true) });
    if (view === 'top') items.push({ label: 'Move the camera here', fn: () => writeCam({ p: [at[0], camState.p[1], at[2]] }, true) });
  }
  return items;
}

/* ============================== interaction modes ============================== */
let simple = true; try { simple = localStorage.getItem('shotref.simple') !== '0'; } catch (e) { }
let placing = null, pathMode = null, pathFit = false, rec = null;
const MODE_TIP_MS = 6500; /* path and recording tips stay up long enough to read (U7) */
const snapWith = (v, on) => on ? r4(Math.round(v / pref('snapStep')) * pref('snapStep')) : r4(v); /* the Snap button rounds to the step chosen in Settings */
const snapV = v => snapWith(v, snapOn);
const _rc = new THREE.Raycaster();
function rayFromEvent(e) {
  const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
  const R = viewRects(rect.width, rect.height);
  let r = R.work || { x: 0, y: 0, w: rect.width, h: rect.height }, cam = view === 'top' ? topCam : edCam;
  if (camPane() && R.frame) { r = R.frame; cam = renderCam; prepRenderCam(T); }
  if (px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) return null;
  if (view === 'top') topCam.updateMatrixWorld();
  _rc.setFromCamera(new THREE.Vector2((px - r.x) / r.w * 2 - 1, -((py - r.y) / r.h) * 2 + 1), cam);
  return _rc;
}
function planeHit(rc, y = 0) { const pt = new THREE.Vector3(); return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), pt) ? pt : null; }
function pickAt(rc, noRing = false) {
  const targets = [...views.values()].filter(v => v.group.visible && !(camPane() && v.isMark)).map(v => v.group);
  if (!camPane()) {
    /* the camera's path points and the sun win over what is behind them */
    const hs = ckPts.filter(m => m.visible);
    const hh = hs.length ? rc.intersectObjects(hs, false) : [];
    if (hh.length) return { id: hh[0].object.userData.pick, point: hh[0].point };
    if (sunGrp.visible) targets.push(sunBall); /* the sun is picked by distance like everything else, so an object in front of it wins */
    targets.push(camBody); if (targetMarker.visible) targets.push(targetMarker); if (ringGrp.visible && !noRing) targets.push(ringPick, ringKnob); if (liftGrp.visible && !noRing) targets.push(liftPick);
  }
  const hits = rc.intersectObjects(targets, true);
  for (const hit of hits) {
    let ob = hit.object;
    while (ob) { if (ob.userData.pick) return { id: ob.userData.pick, point: hit.point }; if (ob.userData.objId) return { id: ob.userData.objId, point: hit.point }; ob = ob.parent; }
  }
  /* nothing solid: the camera's path line (right-click it to add a point) */
  if (!camPane() && camPath.line.visible && !noRing) {
    const L = rc.params.Line, old = L.threshold;
    L.threshold = view === 'top' ? 0.16 / topCam.zoom : clamp(edCam.position.distanceTo(edControls.target) * 0.012, 0.09, 0.6);
    const lh = rc.intersectObject(camPath.line, false); L.threshold = old;
    if (lh.length) return { id: 'cpath', point: lh[0].point, index: lh[0].index };
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
  const o = getObj(placing), what = placeSetName || (o && o.name); placing = null; placeRest = []; placeSetName = null; hideModeBar(); canvas.style.cursor = '';
  changed(true, true); if (o) toast(what + ' placed');
}
function cancelPlacing() {
  const id = placing, gone = new Set([id, ...placeRest.map(r => r.id)]); placing = null; placeRest = []; placeSetName = null; hideModeBar(); canvas.style.cursor = '';
  if (id) { state.objects = state.objects.filter(o => !gone.has(o.id)); selIds = selIds.filter(x => !gone.has(x)); if (gone.has(selected)) selected = selIds[selIds.length - 1] || null; pruneGroups(); if (state.groups && !Object.keys(state.groups).length) delete state.groups; syncScene(); updateGizmo(); changed(false, true); autosave(); }
}
function movePlacing(e) {
  const rc = rayFromEvent(e); if (!rc) return; const g = planeHit(rc, 0); const o = getObj(placing); if (!g || !o) return;
  o.base.p = [snapV(g.x), o.base.p[1], snapV(g.z)]; editRev++;
  for (const r of placeRest) { const q = getObj(r.id); if (q) q.base.p = [r4(o.base.p[0] + r.dx), q.base.p[1], r4(o.base.p[2] + r.dz)]; }
}

/* ---- drag a tile from the Add panel onto the view ----
   The tile's own click-to-place action runs the moment the pointer first reaches the floor, so the real item
   follows the pointer (it is the preview) and letting go is the same commit as a click: one undo step, selected,
   settled by the ground rule. Let go anywhere else, or press Esc, and nothing is left behind. */
const tileAct = new WeakMap();
function dndTile(el, act) { tileAct.set(el, act); return el; }
let tileDrag = null, tileClickBlock = 0, tileSwallowUp = false; /* {el, act, x0, y0, on, made, id}; the release and click that end a drag are swallowed */
/* the floor point under the pointer, anywhere over the view (labels and bars drawn on top of it count as the view) */
function tileFloor(e) {
  const r = canvas.getBoundingClientRect();
  if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) return null;
  const was = pane; setPane(paneOf(e)); /* the half under the pointer takes the drop */
  const rc = rayFromEvent(e), g = rc && planeHit(rc, 0);
  if (!g) setPane(was);
  return g;
}
function tileChip(d, show, e) {
  let c = $('#dragChip');
  if (!c) { c = h('div', { id: 'dragChip', 'aria-hidden': 'true' }); document.body.append(c); }
  if (show && !c.dataset.for) { c.innerHTML = d.el.innerHTML; c.dataset.for = '1'; }
  c.style.display = show ? 'flex' : 'none';
  if (show && e) { c.style.left = e.clientX + 14 + 'px'; c.style.top = e.clientY + 10 + 'px'; }
}
function endTileDrag(drop, e) {
  const d = tileDrag; if (!d) return; tileDrag = null;
  if (d.on) {
    if (d.made && placing && placing === d.id) {
      const g = drop && e ? tileFloor(e) : null;
      if (g) { movePlacing(e); commitPlacing(); } else cancelPlacing();
    }
    document.body.classList.remove('tiledrag'); tileChip(d, false);
    const c = $('#dragChip'); if (c) delete c.dataset.for;
    if (!drop) tileSwallowUp = true; /* cancelled with the button still down: its release ends nothing else */
    requestRender();
  }
}
function wireTileDrag() {
  window.addEventListener('pointerdown', () => { tileClickBlock = 0; tileSwallowUp = false; }, true);
  $('#addArea').addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.pointerType === 'touch' || tileDrag || openModals().length) return;
    if (menuOpen()) hideMenu();
    const el = e.target.closest('.tile'), act = el && tileAct.get(el);
    if (act) tileDrag = { el, act, x0: e.clientX, y0: e.clientY, on: false, made: false, id: null };
  });
  window.addEventListener('pointermove', e => {
    const d = tileDrag; if (!d) return;
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      if (!e.buttons) { tileDrag = null; return; }
      d.on = true; document.body.classList.add('tiledrag');
      if (placing) cancelPlacing(); /* a click-to-place still waiting: the drag replaces it */
      if (pathMode) cancelPath();
    }
    e.preventDefault();
    if (!e.buttons) { endTileDrag(false); return; } /* the release was missed (outside the window) */
    if (d.made && placing !== d.id) { endTileDrag(false); return; } /* something else ended the placing */
    const g = tileFloor(e);
    if (g && !d.made) {
      d.act(); d.made = true; d.id = placing;
      if (!placing) { endTileDrag(false); return; }
      showModeBar('Let go on the floor to place ' + (placeSetName ? '"' + placeSetName + '"' : getObj(placing).name) + ' · Esc cancels', []);
    }
    if (g) movePlacing(e);
    tileChip(d, !g, e); requestRender();
  }, true);
  window.addEventListener('pointerup', e => {
    const d = tileDrag;
    if (!d && !tileSwallowUp) return;
    if (d && !d.on) { tileDrag = null; return; } /* a plain click: the tile's click runs as before */
    e.preventDefault(); e.stopPropagation();
    if (d) endTileDrag(true, e);
    tileSwallowUp = false; tileClickBlock = performance.now() + 400; /* the click that follows this release */
  }, true);
  window.addEventListener('pointercancel', () => endTileDrag(false), true);
  window.addEventListener('blur', () => endTileDrag(false));
  window.addEventListener('click', e => { if (performance.now() < tileClickBlock) { tileClickBlock = 0; e.preventDefault(); e.stopPropagation(); } }, true);
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !tileDrag || !tileDrag.on) return;
    e.preventDefault(); e.stopImmediatePropagation(); endTileDrag(false); /* immediate: the tour listens on window too */
  }, true);
}

/* ---- draw a path ---- */
function pathSpeedOf(o) {
  if (o.opts.pathSpeed) return o.opts.pathSpeed;
  if (o.type === 'person') return o.opts.pose === 'run' ? 3.5 : pref('walkSpeed');
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
  pm.pts.forEach((pt, i) => { const tk = t0 + cum[i] / speed, l = toLocalPose(o, { p: [r4(pt[0]), pm.y, r4(pt[1])], r: cur.r, s: cur.s }, tk); setKey(o.keys, tk, { p: l.p.map(r4), r: l.r.map(r4), s: l.s }); });
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
  const loc = (tr, tt) => { const l = toLocalPose(o, tr, tt); return { p: l.p.map(r4), r: l.r.map(r4), s: l.s }; };
  setKey(o.keys, t0, loc(cur, t0));
  setKey(o.keys, tA, loc({ ...cur, p: [r4(mp[0]), cur.p[1], r4(mp[2])] }, tA));
  const sp = Math.hypot(mp[0] - cur.p[0], mp[2] - cur.p[2]) / (tA - t0);
  if (o.type === 'person' && !(POSES[o.opts.pose] || {}).loco) o.opts.pose = sp > 2.6 ? 'run' : 'walk';
  o.opts.faceTravel = true;
  changed(true, true); toast(`${o.name} reaches ${m.name} at ${tA.toFixed(1)} s`);
}
function faceToward(o, pt, label) {
  const cur = clone(evalObj(o, T));
  cur.r[1] = Math.atan2(pt[0] - cur.p[0], pt[2] - cur.p[2]) * R2D;
  o.opts.faceTravel = false; /* turned by hand, so the path no longer steers them */
  writeObj(o, cur, true); propsDirty = true; toast(o.name + ' now faces ' + label);
}

/* ============================== people: seats, eyeline, pose changes ============================== */
/* seats on furniture: x, z across and along the item, top = seat height, yaw = which way a sitter faces (0 = like the item) */
const SEATS = {
  chair: [{ x: 0, z: 0.02, top: 0.455, yaw: 0 }],
  sofa: [{ x: -0.55, z: 0.06, top: 0.52, yaw: 0 }, { x: 0, z: 0.06, top: 0.52, yaw: 0 }, { x: 0.55, z: 0.06, top: 0.52, yaw: 0 }],
  bed: [{ x: 0.7, z: 0.3, top: 0.57, yaw: 90 }, { x: -0.7, z: 0.3, top: 0.57, yaw: -90 }],
};
/* a convertible car has two seats; a closed one has none */
const CAR_SEATS = [{ x: 0.4, z: -0.28, top: 1.1, yaw: 0 }, { x: -0.4, z: -0.28, top: 1.1, yaw: 0 }];
const seatsOf = o => o.type === 'car' ? (o.opts.convertible ? CAR_SEATS : []) : SEATS[o.type] || [];
/* a seat in the world at time t, as the seat is drawn (turning with its path, riding on a parent): where a sitter's hips go and which way they face */
function seatSpot(o, s, t = T) {
  const tr = shownObj(o, t), yaw = tr.r[1] * D2R, sx = s.x * tr.s[0], sz = s.z * tr.s[2];
  return { x: tr.p[0] + sx * Math.cos(yaw) + sz * Math.sin(yaw), z: tr.p[2] - sx * Math.sin(yaw) + sz * Math.cos(yaw), top: tr.p[1] + s.top * tr.s[1], yaw: tr.r[1] + s.yaw };
}
/* the closest seat to a floor point (within radius metres), not counting the person themselves */
function nearestSeat(x, z, exceptId, radius = 0.55, t = T) {
  let best = null, bd = radius;
  for (const o of state.objects) {
    if (o.id === exceptId || o.visible === false) continue;
    seatsOf(o).forEach((s, i) => { const w = seatSpot(o, s, t), d = Math.hypot(w.x - x, w.z - z); if (d < bd) { bd = d; best = { o, i, w }; } });
  }
  return best;
}
/* the first seat on this item nobody is sitting in */
function freeSeat(item, person) {
  const taken = persons().filter(q => q !== person && q.opts.seated === item.id).map(q => shownObj(q, T).p);
  const all = seatsOf(item).map((s, i) => ({ o: item, i, w: seatSpot(item, s) }));
  return all.find(s => !taken.some(p => Math.hypot(p[0] - s.w.x, p[2] - s.w.z) < 0.3)) || all[0];
}
/* feet stay on the floor unless the seat is high (a bed's edge is still low enough to sit with feet down) */
const seatY = (o, seat) => { const y = seat.w.top - 0.21 * (o.opts.height || 1.75) * evalObj(o, T).s[1]; return y < 0.25 ? 0 : y; };
function sitPerson(o, seat) {
  o = getObj(o.id); if (!o || !seat) return;
  const cur = clone(evalObj(o, T));
  cur.p = [r4(seat.w.x), r4(seatY(o, seat)), r4(seat.w.z)]; cur.r[1] = r4(seat.w.yaw);
  o.opts.pose = 'sit'; o.opts.seated = seat.o.id; o.opts.faceTravel = false;
  writeObj(o, cur, false);
  const rides = seat.o.type === 'car' && o.parent !== seat.o.id && attachTo(o, seat.o.id); /* a seat in a car goes with the car */
  changed(true, true); toast(o.name + ' sits on ' + seat.o.name + (rides ? ' and rides along' : ''));
}
function standPerson(o) {
  o = getObj(o.id); if (!o) return;
  if (o.parent && (parentOf(o) || {}).type === 'car') attachTo(o, null); /* out of the car, where they sit */
  const cur = clone(evalObj(o, T)); cur.p[1] = 0;
  o.opts.pose = 'stand'; o.opts.seated = null;
  writeObj(o, cur, false); changed(true, true); toast(o.name + ' stands up');
}
const isSeated = o => o.type === 'person' && !!o.opts.seated && o.opts.pose === 'sit';
/* the seat a person would take if asked to sit: nearest free one in the scene */
const SIT_REACH = 3; /* metres: how far away the toolbar's "Sit on the nearest seat" looks */
function nearestSeatFor(o, reach = SIT_REACH) {
  const p = shownObj(o, T).p; return nearestSeat(p[0], p[2], o.id, reach);
}
const anySeat = o => state.objects.some(q => q !== o && q.visible !== false && seatsOf(q).length);
/* eyeline: a person looks at the camera, at another person or object, or straight ahead (target = null) */
function setLookAt(o, target) {
  o = getObj(o.id); if (!o) return;
  if (target) o.opts.lookAt = target; else delete o.opts.lookAt;
  const t = target && target !== 'camera' ? getObj(target) : null;
  changed(true, true); toast(target ? o.name + ' looks at ' + (target === 'camera' ? 'the camera' : t ? t.name : '…') : o.name + ' looks ahead');
}
/* pick a pose at the playhead: at 0 s it is the starting pose, later it becomes a change of action on the timeline */
function setPoseAt(o, pose, t = T) {
  o = getObj(o.id); if (!o) return;
  t = snapT(t);
  const eps = 0.5 / state.settings.fps, label = poseLabel(pose);
  if (t < eps) { o.opts.pose = pose; if (pose !== 'sit') o.opts.seated = null; changed(true, true); return; }
  const list = (o.acts || []).filter(a => Math.abs(a.t - t) > eps), act = { t, pose };
  if (pose === 'sit') { /* sitting as an action goes to the nearest seat */
    const tr = shownObj(o, t), seat = nearestSeat(tr.p[0], tr.p[2], o.id, 1, t);
    if (seat) { /* stored in the parent's own frame, like the item's keys (the same as the world when it has no parent) */
      const y = seat.w.top - 0.21 * (o.opts.height || 1.75) * tr.s[1], l = toLocalPose(o, { p: [seat.w.x, y < 0.25 ? 0 : y, seat.w.z], r: [0, seat.w.yaw, 0], s: tr.s }, t);
      act.at = { p: l.p.map(r4), yaw: r4(l.r[1]) };
    }
  }
  list.push(act); setActs(o, list); changed(true, true);
  toast(o.name + ' switches to ' + label.toLowerCase() + ' at ' + t.toFixed(2) + ' s' + (act.at ? ' (on the nearest seat)' : ''), 3500);
}
function removeAct(o, act) { setActs(o, o.acts.filter(a => a !== act)); changed(true, true); toast('Action removed'); }

/* ============================== riding, resting on the floor, mounting ============================== */
/* ride with a parent (pid), or stop riding (null). The item keeps its place in the world at the playhead, and every key
   keeps the world pose it had at its own time. False when the parent would ride on the item (or on itself). */
function attachTo(o, pid) {
  o = typeof o === 'string' ? getObj(o) : getObj(o && o.id); if (!o) return false;
  pid = pid || null;
  if (pid && (!getObj(pid) || ridesWith(o, pid))) return false;
  const here = clone(evalObj(o, T)), ks = o.keys.map(k => ({ k, w: toWorldPose(o, k, k.t) }));
  if (pid) o.parent = pid; else delete o.parent;
  const l = toLocalPose(o, here, T); o.base = { p: l.p.map(r4), r: l.r.map(r4), s: l.s.map(r4) };
  for (const { k, w } of ks) { const q = toLocalPose(o, w, k.t); k.p = q.p.map(r4); k.r = q.r.map(r4); }
  for (let i = 1; i < o.keys.length; i++) o.keys[i].r = o.keys[i].r.map((v, j) => r4(unwrap(v, o.keys[i - 1].r[j])));
  return true;
}
/* the panel and menu way: with a message, and one undo step */
function attachObj(o, pid) {
  o = getObj(o.id); if (!o) return;
  const par = pid ? getObj(pid) : null, old = parentOf(o);
  if (!attachTo(o, pid)) { toast("Can't attach " + o.name + ' to ' + (par ? par.name : 'that') + ': it would ride on itself'); return; }
  changed(true, true); toast(par ? o.name + ' now moves with ' + par.name : o.name + ' no longer moves with ' + (old ? old.name : 'it'));
}
/* the item itself and everything that rides on it, as ids */
function rideIds(o) { const set = new Set([o.id]); for (const q of state.objects) if (ridesWith(o, q.id)) set.add(q.id); return set; }
/* an item that rides on others when they go: it stays where it is in the world and stops riding */
function releaseRiders(gone) { for (const q of state.objects) if (!gone.has(q.id) && q.parent && gone.has(q.parent)) attachTo(q, null); }
const _gr = new THREE.Raycaster(), _down = new THREE.Vector3(0, -1, 0), _gn = new THREE.Vector3(), _gb = new THREE.Box3();
/* what an item can rest on: everything visible that is not a mark or a person (and not the item itself or what rides on it) */
const restTargets = skip => [...views.values()].filter(v => v.group.visible && !v.isMark && !v.person && !v.pending && !skip.has(v.group.userData.objId)).map(v => v.group);
function firstUpFace(hits) {
  for (const h of hits) if (h.face) { _gn.copy(h.face.normal).transformDirection(h.object.matrixWorld); if (_gn.y > 0.5) return h.point; }
  return null;
}
/* the thing right under an item (within about half a metre), for "Attach to ...": undefined when there is nothing */
function underneath(o) {
  const tr = evalObj(o, T);
  scene.updateMatrixWorld(true);
  _gr.set(new THREE.Vector3(tr.p[0], tr.p[1] + 0.2, tr.p[2]), _down);
  for (const h of _gr.intersectObjects(restTargets(rideIds(o)), true)) {
    let ob = h.object; while (ob && !ob.userData.objId) ob = ob.parent;
    if (ob && tr.p[1] + 0.3 - h.point.y < 0.8) return getObj(ob.userData.objId);
  }
  return null;
}
/* ground rule: an item rests on the floor, or on what is under it, unless it rides on a parent, sits, or "Can float" is ticked.
   The preference "ground" (default on) switches the whole rule off. */
const groundOn = () => getPref('ground', true) !== false;
/* switching on never moves anything: raised items become "Can float". The gear menu and Settings both come here. */
function setGround(on, quiet = false) {
  setPref('ground', on); if (on) migrateAll(); requestRender(); propsDirty = true; updateGizmo();
  if (!quiet) toast(on ? 'Things now rest on the floor or on what is under them. Raised items were left where they are.' : 'Things are no longer kept on the ground.', 3500);
}
const isGrounded = o => !!o && o.type !== 'mark' && groundOn() && !o.parent && !(o.opts && (o.opts.seated || o.opts.free));
/* how far the item's underside is below its origin when turned and scaled like this (0 or less): that is what rests, not the origin */
function restOffset(v, r, s) {
  if (!v || v.person || v.isMark) return 0;
  const g = v.group, p0 = g.position.clone(), q0 = g.quaternion.clone(), s0 = g.scale.clone();
  /* measured with the wheels straight and not turning: the height must not depend on where the playhead was */
  const wl = v.wheels ? v.wheels.list.map(w => [w, w.spin.rotation.x, w.piv.rotation.y]) : [];
  for (const [w] of wl) { w.spin.rotation.x = 0; w.piv.rotation.y = 0; }
  g.position.set(0, 0, 0); g.rotation.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ'); g.scale.fromArray(s); g.updateMatrixWorld(true);
  _gb.setFromObject(g); const m = _gb.isEmpty() ? 0 : Math.min(0, _gb.min.y);
  for (const [w, sp, st] of wl) { w.spin.rotation.x = sp; w.piv.rotation.y = st; }
  g.position.copy(p0); g.quaternion.copy(q0); g.scale.copy(s0); g.updateMatrixWorld(true);
  return m;
}
/* the height of the first surface facing up below (x, z), starting fromY. People only walk on floor tiles and stairs. */
function surfaceUnder(x, z, fromY, skip, floorsOnly) {
  let list = restTargets(skip);
  if (floorsOnly) list = list.filter(g => { const q = getObj(g.userData.objId); return q && (q.type === 'plane' || q.type === 'stairs'); });
  _gr.set(new THREE.Vector3(x, fromY, z), _down);
  const hit = firstUpFace(_gr.intersectObjects(list, true));
  return hit ? Math.max(0, hit.y) : 0;
}
/* the origin height that puts the item's underside on what is below it (people: on the floor, tiles and stairs) */
function groundYFor(o, v, k) {
  if (v.isMark) return 0;
  const off = restOffset(v, k.r, k.s);
  return r4(surfaceUnder(k.p[0], k.p[2], v.person ? 50 : k.p[1] + off + 0.35, rideIds(o), !!v.person) - off);
}
/* settle every grounded item's base and keys onto what is under them. */
function solveGround() {
  for (let pass = 0; pass < 2; pass++) {
    let any = false;
    scene.updateMatrixWorld(true);
    for (const o of state.objects) {
      if (!isGrounded(o)) continue;
      const v = views.get(o.id); if (!v || v.pending) continue; /* a model still loading has no real bounds yet */
      for (const k of (o.keys.length ? o.keys : [o.base])) {
        const y = groundYFor(o, v, k);
        if (Math.abs(y - k.p[1]) > 2e-3) { k.p = [k.p[0], y, k.p[2]]; any = true; }
      }
    }
    if (!any) break;
    editRev++; applyAll(T);
  }
}
/* Settling happens only after a real edit (groundDirty). A project that was just opened, restored or switched on must never be
   moved: groundMigrate holds the items not yet checked, and anything the rule would move there is set to "Can float" instead,
   so it stays exactly where it was. */
let groundDirty = false;
const groundMigrate = new Set();
const migrateAll = () => { for (const o of state.objects) groundMigrate.add(o.id); };
function migrateGround() {
  if (!groundMigrate.size) return;
  let n = 0;
  scene.updateMatrixWorld(true);
  for (const id of [...groundMigrate]) {
    const o = getObj(id), v = views.get(id);
    if (!o || !isGrounded(o)) { groundMigrate.delete(id); continue; }
    if (!v || v.pending) continue; /* try again when the model has loaded */
    groundMigrate.delete(id);
    if ((o.keys.length ? o.keys : [o.base]).some(k => Math.abs(groundYFor(o, v, k) - k.p[1]) > 2e-3)) { o.opts.free = true; n++; }
  }
  if (n) { hist[hi] = snapshot(); autosave(); uiDirty = true; propsDirty = true; toast(n === 1 ? 'A raised item was set to "Can float", so it stays where it is.' : n + ' raised items were set to "Can float", so they stay where they are.', 4500); }
}
function settleGround() {
  groundDirty = false;
  if (!groundOn()) return;
  const before = editRev;
  solveGround();
  if (editRev !== before) { hist[hi] = snapshot(); autosave(); uiDirty = true; propsDirty = true; pathRev = -1; } /* part of the edit's own undo step */
}

/* ---- shot sizes ---- */
const SHOTS = [['wide', 'Wide'], ['full', 'Full body'], ['medium', 'Medium'], ['mcu', 'Medium close'], ['cu', 'Close-up'], ['ecu', 'Extreme close'], ['low', 'Low angle'], ['high', 'High angle'], ['top', 'Top-down'], ['ots', 'Over shoulder'], ['two', 'Two-shot']];
const persons = () => state.objects.filter(o => o.type === 'person');
function personGeom(o) {
  const v = views.get(o.id), tr = shownObj(o, T), P = new THREE.Vector3().fromArray(tr.p);
  const H = (o.opts.height || 1.75) * tr.s[1];
  let headY = P.y + 0.93 * H;
  if (v && v.person) { v.group.updateMatrixWorld(true); const hp = new THREE.Vector3(); v.person.head.getWorldPosition(hp); headY = hp.y; }
  return { P, H, headY, top: headY + 0.07 * H, yaw: v ? v.group.rotation.y : tr.r[1] * D2R };
}
function nearestOther(o) {
  let best = null, bd = Infinity; const a = shownObj(o, T).p;
  for (const q of persons()) { if (q === o) continue; const b = shownObj(q, T).p; const d = Math.hypot(a[0] - b[0], a[2] - b[2]); if (d < bd) { bd = d; best = q; } }
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
  const others = persons().filter(q => q !== o).map(q => shownObj(q, T).p);
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
  const c = state.camera;
  if (mountObj()) for (const k of keys) { k.p = camToLocal(k.p, k.t).map(r4); k.tg = camToLocal(k.tg, k.t).map(r4); } /* a mounted camera stores its move relative to the mount */
  c.keys = []; for (const k of keys) setKey(c.keys, k.t, k);
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
/* pose changes keep to whole frames too; two on one frame merge (the later wins) */
function resnapActs(o, map) {
  if (!o.acts) return;
  const fps = state.settings.fps, byFrame = new Map();
  for (const a of o.acts) { a.t = Math.max(0, Math.round(map(a.t) * fps)) / fps; byFrame.set(Math.round(a.t * fps), a); }
  setActs(o, [...byFrame.values()]);
}
const resnapAll = map => { resnapKeys(state.camera.keys, map); state.objects.forEach(o => { resnapKeys(o.keys, map); resnapActs(o, map); }); };

/* ---- shot length presets (stretch animation to fit) ---- */
function setDuration(v) {
  if (exporting) return;
  v = clamp(v, 1, 120);
  const old = lastT(); state.settings.duration = v; const nw = lastT(), k = old > 0 ? nw / old : 1;
  if (Math.abs(k - 1) > 1e-6) {
    /* with several shots the action is shared: only this shot's camera is re-timed */
    if (state.shots && state.shots.length > 1) resnapKeys(state.camera.keys, t => t * k); else resnapAll(t => t * k);
    setTime(clamp(snapT(T * k), 0, nw));
  }
  changed(true, true); syncTopUI();
}
function setSimple(v) {
  simple = v; try { localStorage.setItem('shotref.simple', v ? '1' : '0'); } catch (e) { }
  document.body.classList.toggle('simple', v); updateGizmo(); propsDirty = true; buildAddPanel(); syncTopUI();
}

/* ============================== commands ============================== */
let focusPick = false;
let focusPicks = 0; /* how many times the lens was focused on something (double-click, the menu, a pick): the hands-on tour waits for a new one */
function startFocusPick() {
  ensureDof().on = true;
  if (view !== 'camera' && !splitOn()) setView('camera');
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
  writeCam({ fd: d }, true); propsDirty = true; focusPicks++;
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
  syncControls();
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('#vpRight [data-g], #vpRight [data-g2], #bSnapGrid, #bFocus').forEach(b => { b.style.display = v === 'camera' ? 'none' : ''; }); /* in Camera view only Grid stays */
  $('#camBar').style.display = v === 'camera' || splitOn() ? 'flex' : 'none';
  $('#bCamHere').style.display = v === 'editor' ? '' : 'none';
  $('#bPip').style.display = v !== 'camera' && !splitOn() ? '' : 'none';
  $('#bSplit').classList.toggle('on', layout === 'split'); $('#bSplit').setAttribute('aria-pressed', String(layout === 'split'));
  if (focusPick && v !== 'camera' && !splitOn()) { focusPick = false; canvas.style.cursor = ''; }
  updateGizmo(); propsDirty = true;
}
function camToEditorView() {
  const p = edCam.position.toArray(), tg = edControls.target.toArray();
  writeCam({ p, tg }, true);
  toast('Camera placed at your editor view'); propsDirty = true;
}
/* what Delete, Duplicate and the menus act on: every selected object, or the one main item */
const targetObjs = () => selIds.length ? selObjs() : (selected && getObj(selected) ? [getObj(selected)] : []);
/* the live camera (state.camera) frees itself from deleted items without moving: read everything in world space while they still exist */
function freeCamera(gone) {
  const c = state.camera, mGone = !!c.mount && gone.has(c.mount), sGone = !!c.lookAtId && gone.has(c.lookAtId);
  if (!mGone && !sGone) return;
  const subj = sGone ? subject() : null;
  if (subj) { /* the aim, read while the subject still exists (A11); the other ends of the move are converted below */
    const aim = [{ k: c.base, t: T }, ...c.keys.map(k => ({ k, t: k.t }))].map(r => ({ r, tg: aimPoint(subj, r.t) }));
    if (mGone) setMount(null);
    else if (c.follow) { c.base.p = camToWorld(c.base.p, T).map(r4); for (const k of c.keys) k.p = camToWorld(k.p, k.t).map(r4); }
    for (const a of aim) a.r.k.tg = a.tg.map(r4);
    c.lookAtId = null; c.follow = false;
  } else if (mGone) setMount(null);
}
/* the same for every other shot's saved camera: swap each in as the live camera for a moment */
function keepCamerasPut(gone) {
  const live = state.camera;
  try {
    for (const s of state.shots || []) {
      if (s.id === state.shotId || !s.camera) continue;
      state.camera = s.camera; try { freeCamera(gone); } finally { s.camera = state.camera; }
    }
  } finally { state.camera = live; }
  freeCamera(gone);
}
function deleteSel() {
  const all = targetObjs(); if (!all.length) return;
  /* locked items are never deleted by accident: unlock them first */
  const list = all.filter(o => !o.locked), kept = all.length - list.length;
  if (!list.length) { toast((all.length === 1 ? all[0].name + ' is locked' : 'Those are locked') + '. Unlock ' + (all.length === 1 ? 'it' : 'them') + ' first (Ctrl+L).', 3500); return; }
  const gone = new Set(list.map(o => o.id));
  /* every shot's camera that rides on or looks at a deleted item keeps its place in the world (the live one and the saved copies of the other shots) */
  keepCamerasPut(gone);
  releaseRiders(gone); /* what rode on a deleted item stays where it stood */
  state.objects = state.objects.filter(x => !gone.has(x.id));
  for (const q of state.objects) { if (gone.has(q.opts.lookAt)) delete q.opts.lookAt; if (gone.has(q.opts.seated)) { q.opts.seated = null; if (q.opts.pose === 'sit') q.opts.pose = 'stand'; } } /* nobody looks at or sits on what is gone */
  selIds = selIds.filter(id => !gone.has(id)); selected = selIds[selIds.length - 1] || null;
  pruneGroups(); syncScene(); updateGizmo(); changed(true, true);
  toast((list.length === 1 ? list[0].name : list.length + ' items') + ' deleted' + (kept ? ' (' + kept + ' locked ' + (kept === 1 ? 'item' : 'items') + ' kept)' : ''));
}
function duplicateSel() {
  const src = targetObjs(); if (!src.length) return;
  const off = [0.8, 0, 0.4], gmap = {}, made = [], idMap = new Map(src.map(o => [o.id, uid()]));
  for (const o of src) {
    const c = clone(o); c.id = idMap.get(o.id); if ('locked' in c) c.locked = false; c.name = nextName(catalogOf(o.type).label);
    /* a copy of something that rides on a copied parent rides on the copy, and is not nudged again; a seat on a copied car is the copied car */
    const rides = !!(o.parent && idMap.has(o.parent)); if (rides) c.parent = idMap.get(o.parent);
    if (c.opts.seated && idMap.has(c.opts.seated)) c.opts.seated = idMap.get(c.opts.seated);
    if (o.grp) {
      if (!gmap[o.grp]) { gmap[o.grp] = 'g' + uid(); state.groups = state.groups || {}; state.groups[gmap[o.grp]] = { name: groupName(o.grp) + ' copy' }; }
      c.grp = gmap[o.grp];
    }
    if (!rides) { c.base.p = c.base.p.map((v, i) => r4(v + off[i])); c.keys.forEach(k => { k.p = k.p.map((v, i) => r4(v + off[i])); }); }
    state.objects.push(c); made.push(c);
  }
  pruneGroups(); syncScene();
  selIds = made.map(o => o.id); selected = selIds[selIds.length - 1]; updateGizmo(); uiDirty = true; propsDirty = true; pathRev = -1;
  changed(true, true); toast(made.length === 1 ? 'Duplicated' : 'Duplicated ' + made.length + ' items');
}
function dropToFloor() {
  let n = 0;
  for (const o of targetObjs().filter(x => !x.locked)) {
    const v = views.get(o.id); if (!v) continue;
    v.group.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(v.group);
    if (bb.isEmpty()) continue;
    const cur = clone(evalObj(o, T)); cur.p[1] = r4(cur.p[1] - bb.min.y); writeObj(o, cur, false); n++;
  }
  if (n) changed(true, true);
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
  if (practicing) return endPracticeFirst(() => openStarters(firstLaunch));
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
  if (tourHandle) { try { tourHandle.end('external'); } catch (e) { console.error('ShotRef: the tour did not end cleanly', e); } } /* a quick tour is looking at the scene being swapped; the hands-on one also leaves practice here */
  if (practicing) endPracticeFirst(() => {}); /* every caller asks first; this keeps a missed one from mixing the two scenes */
  recentFlush(); /* the project being left, if it has edits the list does not have */
  snapHold = true;
  const prev = { state, assets, selected, selIds: selIds.slice(), T, hist: hist.slice(), histDoc: histDoc.slice(), doc: platform.getDoc(), hi };
  try {
    for (const [id, a] of Object.entries(newAssets)) if (assets[id] && assets[id].b64 !== (a && a.b64)) dropModel(id);
    assets = { ...assets, ...newAssets };
    recentSession = uid(); state = newState; cleanTakes(); selected = null; selIds = []; promptEdit = null; shotEditId = null; setTime(0); migrateAll();
    platform.startDoc(); /* Open, New and starters are a new document: Save must not reuse the previous file */
    restore(snapshot()); pushHistory(); resetEditorCam();
    snapHold = false; if (snapLive > snapPruneAt) pruneSnapPool();
    if (label) toast(label);
  } catch (e) {
    snapHold = false;
    state = prev.state; assets = prev.assets; selected = prev.selected; selIds = prev.selIds; setTime(prev.T); hist = prev.hist; histDoc = prev.histDoc; platform.restoreDoc(prev.doc); hi = prev.hi;
    try { restore(snapshot()); } catch (e2) { console.error('ShotRef: could not put the previous scene back', e2); }
    throw e;
  }
}
function loadStarter(kind) {
  let sel = null;
  const built = buildState(() => fillStarter(kind, id => { sel = id; }));
  replaceProject(built, {}, (STARTERS.find(x => x[0] === kind) || [, kind])[1] + ' ready');
  platform.newProject();
  if (sel) { select(sel); }
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
      setEnv(state.settings, 'overcast');
      break;
    }
    case 'room': {
      setEnv(state.settings, 'studio');
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
  if (practicing) return endPracticeFirst(() => saveProject(saveAs));
  if (saving) return { ok: false, busy: true };
  saving = true;
  try { return await doSaveProject(saveAs); } finally { saving = false; }
}
/* the project name as a file name part: "Desert chase" -> desert-chase */
const projectSlug = () => String(state.meta && state.meta.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
/* the project as a file's text: only the files this scene uses (memory also keeps older ones for undo) */
function projectText() {
  const used = {};
  for (const id of usedAssetIds(state)) if (assets[id]) used[id] = assets[id];
  return JSON.stringify({ app: 'ShotRef', version: FORMAT_VERSION, state: stateForSave(), assets: used });
}
async function doSaveProject(saveAs) {
  const data = projectText();
  const r = await platform.saveProject(data, { saveAs: saveAs === true, name: `${projectSlug() || 'shotref'}-${stamp()}.shotref` });
  if (r.ok) { toast('Saved ' + (r.name || 'project')); autosave(); saveRecentNow(); } /* the autosave records that nothing is unsaved now */
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
let launchFile = false; /* a file came from the desktop shell (launch, double-click, Recent): the starter sets must not open over it */
function loadProjectText(txt, file, fromShell = false, unsaved = false) {
  if (practicing) return endPracticeFirst(() => loadProjectText(txt, file, fromShell, unsaved)); /* Open, Recent, a dropped file, a file from Windows */
  if (exporting) { toast('Wait for the export to finish.'); return; }
  let d;
  try { d = normalizeProject(JSON.parse(txt), projectDefaults()); }
  catch (e) { console.error('ShotRef: could not read the project file', e); toast(BAD_FILE, 4000); return; }
  const go = () => {
    try { replaceProject(d.state, d.assets, 'Project opened'); platform.setCurrent(file && file.name, file && file.path); if (unsaved) platform.setDirty(true); }
    catch (e) { console.error('ShotRef: could not open the project', e); toast(BAD_FILE, 4000); }
  };
  if (platform.kind === 'desktop' && platform.isDirty()) guardUnsaved(go);
  else if (!fromShell && (state.objects.length || state.plate)) confirmBox('Open this file?', 'It will replace the current scene. You can undo this with Ctrl+Z.', go, 'Open file');
  else go();
}
function readFile(file, as) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; if (as === 'text') r.readAsText(file); else r.readAsArrayBuffer(file); }); }
const IMG_FILTER = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }], PLATE_FILTER = [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp'] }], MODEL_FILTER = [{ name: '3D models', extensions: ['glb', 'gltf'] }];
/* desktop: native dialog that remembers the import folder; web: the hidden file input */
async function pickImport(sel, handler, filters) {
  const f = await platform.pickFile(filters);
  if (f === undefined) $(sel).click(); else if (f) handler(f);
}
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
    h('button', { class: 'primary', style: 'width:100%', onclick: () => pickImport('#fPlate', importPlate, PLATE_FILTER) }, 'Load location photo…'));
  const fa = arOf(state.settings.aspect), ia = a.aspect || 1.5;
  const close = ASPECTS.reduce((b, x) => Math.abs(Math.log(x[1] / ia)) < Math.abs(Math.log(b[1] / ia)) ? x : b);
  const thumb = h('img', { src: assetURL(pl.asset), style: 'width:100%;border-radius:6px;display:block;border:1px solid var(--line2)' });
  return sec('Location photo', thumb,
    slider('See-through', () => pl.overlay || 0, (v, cm) => { pl.overlay = v; changed(cm); }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    h('p', { class: 'note', style: 'margin:-2px 0 6px' }, 'Raise it to see the photo on top of your 3D scene while you line things up.'),
    selectRow('Ground', [['shadow', 'Shadows only (blend with photo)'], ['hide', 'Hidden'], ['solid', 'Solid 3D ground']], () => pl.ground || 'shadow', v => { pl.ground = v; changed(true); }),
    check('Include the photo in exports', () => pl.export !== false, v => { pl.export = v; changed(true); }),
    Math.abs(Math.log(fa / ia)) > 0.04 ? h('div', { class: 'row' }, h('span', { class: 'note', style: 'margin:0;flex:1' }, `The photo is ${close[0]}-ish; the frame is ${state.settings.aspect}, so the photo is cropped to fill it.`), h('button', { onclick: () => { state.settings.aspect = close[0]; changed(true, true); syncTopUI(); } }, 'Use ' + close[0])) : null,
    h('div', { class: 'btns' }, h('button', { onclick: () => pickImport('#fPlate', importPlate, PLATE_FILTER) }, 'Replace…'), h('button', { style: 'color:#ff9c9c', onclick: () => { state.plate = null; changed(true, true); toast('Location photo removed'); } }, 'Remove')),
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

/* ============================== shots ============================== */
/* A project has one or more shots: each is its own camera and length on the same scene and action.
   state.camera and state.settings.duration always belong to the shot being worked on, so everything else keeps working.
   state.shots[] holds every shot's copy (the active one is brought up to date by syncShot before a save, a snapshot or a switch).
   A project that never made a second shot has no state.shots at all; the bar then shows one "Shot 1" chip. */
const hasShots = () => !!(state.shots && state.shots.length);
function ensureShots() {
  if (!hasShots()) { const id = uid(); state.shots = [{ id, name: 'Shot 1', camera: clone(state.camera), duration: state.settings.duration }]; state.shotId = id; }
  else if (!state.shots.some(s => s.id === state.shotId)) state.shotId = state.shots[0].id;
  return state.shots;
}
const activeShot = () => hasShots() ? state.shots.find(s => s.id === state.shotId) || state.shots[0] : null;
/* the project as it is written to a file or an autosave: the active shot's own copy matches the live camera (the state itself is left alone) */
function stateForSave() {
  if (!hasShots()) return state;
  return { ...state, shots: state.shots.map(s => s.id === state.shotId ? { ...s, camera: state.camera, duration: state.settings.duration } : s) };
}
function syncShot() { const s = activeShot(); if (s) { s.camera = clone(state.camera); s.duration = state.settings.duration; } }
/* the active shot's name, for file names and the summary: only when there is more than one */
const shotName = () => state.shots && state.shots.length > 1 ? activeShot().name : null;
/* makes `s` the live camera and length. No history step: the callers make that. */
function loadShot(s) {
  state.shotId = s.id; state.camera = clone(s.camera); state.settings.duration = s.duration;
  setTime(clamp(snapT(Math.min(T, lastT())), 0, lastT()));
  editRev++; uiDirty = true; propsDirty = true; pathRev = -1; requestRender();
}
const realShotId = id => id === '_' ? ensureShots()[0].id : id;
function switchShot(id) {
  if (exporting || rec) return;
  id = realShotId(id); if (id === state.shotId) return;
  const s = (state.shots || []).find(x => x.id === id); if (!s) return;
  syncShot(); loadShot(s); changed(true, true); syncTopUI();
}
function newShotName() {
  let n = state.shots.length + 1; const used = new Set(state.shots.map(s => s.name));
  while (used.has('Shot ' + n)) n++;
  return 'Shot ' + n;
}
/* a new shot starts from the framing at the playhead with no keys; a duplicate keeps the same move */
function newShot(dup) {
  if (exporting || rec) return;
  ensureShots(); syncShot();
  const cam = clone(state.camera), cur = activeShot();
  if (!dup) { cam.base = clone(evalCamRaw(T)); cam.keys = []; }
  const s = { id: uid(), name: dup ? cur.name + ' copy' : newShotName(), camera: cam, duration: state.settings.duration };
  state.shots.splice(state.shots.indexOf(cur) + 1, 0, s);
  loadShot(s); changed(true, true); syncTopUI();
  toast(dup ? s.name + ' added' : s.name + ' starts from the current framing. Frame it and set its move.', 4000);
}
function deleteShot(id) {
  if (exporting || rec) return;
  ensureShots(); id = realShotId(id);
  if (state.shots.length < 2) { toast('A project needs at least one shot'); return; }
  const i = state.shots.findIndex(s => s.id === id); if (i < 0) return;
  const name = state.shots[i].name;
  if (id === state.shotId) { state.shots.splice(i, 1); loadShot(state.shots[Math.max(0, i - 1)]); }
  else { syncShot(); state.shots.splice(i, 1); }
  changed(true, true); syncTopUI(); toast(name + ' deleted. Ctrl+Z brings it back.', 4000);
}
function moveShot(id, dir) {
  ensureShots(); id = realShotId(id);
  const l = state.shots, i = l.findIndex(s => s.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= l.length) return;
  syncShot(); [l[i], l[j]] = [l[j], l[i]]; changed(true, true);
}
let shotEditId = null, shotBarKey = '';
function renameShot(id) { shotEditId = realShotId(id); shotBarKey = ''; uiDirty = true; requestRender(); }
const fmtLen = n => (n % 1 ? n.toFixed(1) : n) + ' s';
/* the chips under the viewport; rebuilt only when what they show changes */
function renderShotBar() {
  const real = hasShots(), list = real ? state.shots : [{ id: '_', name: 'Shot 1', duration: state.settings.duration }], act = real ? activeShot().id : '_';
  const key = JSON.stringify([list.map(s => [s.id, s.name, s.id === act ? state.settings.duration : s.duration]), act, shotEditId]);
  if (key === shotBarKey) return;
  shotBarKey = key;
  const bar = $('#shotBar'); bar.innerHTML = '';
  bar.append(h('span', { class: 'lbl' }, 'Shots'));
  for (const s of list) {
    const on = s.id === act, len = fmtLen(on ? state.settings.duration : s.duration);
    if (s.id === shotEditId) {
      const inp = h('input', { type: 'text', value: s.name, maxlength: '40', 'aria-label': 'Shot name' }); let fin = false;
      const done = commit => {
        if (fin) return; fin = true; shotEditId = null; shotBarKey = ''; uiDirty = true;
        const v = inp.value.trim().slice(0, 40);
        if (commit && v && v !== s.name) { const t = realShotId(s.id), sh = ensureShots().find(x => x.id === t); if (sh) { sh.name = v; changed(true, true); } }
        requestRender();
      };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      bar.append(inp); setTimeout(() => { inp.focus(); inp.select(); }, 0);
      continue;
    }
    const chip = h('button', { class: 'shotchip' + (on ? ' on' : ''), title: on ? 'This shot. Double-click to rename, right-click for more.' : 'Switch to ' + s.name, 'aria-pressed': String(on), onclick: () => switchShot(s.id), ondblclick: () => renameShot(s.id) }, s.name, h('small', null, len));
    chip.addEventListener('contextmenu', e => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [{ head: s.name }, { id: 'rename', label: 'Rename…', fn: () => renameShot(s.id) },
        { id: 'dup', label: 'Duplicate (same move)', fn: () => { switchShot(s.id); newShot(true); } },
        { id: 'left', label: 'Move left', fn: () => moveShot(s.id, -1), disabled: list[0] === s }, { id: 'right', label: 'Move right', fn: () => moveShot(s.id, 1), disabled: list[list.length - 1] === s },
        '-', { id: 'del', label: 'Delete shot', danger: true, fn: () => deleteShot(s.id), disabled: list.length < 2 }]);
    });
    bar.append(chip);
  }
  bar.append(h('button', { class: 'shotchip add', onclick: () => newShot(false), title: 'A new camera setup on the same scene and action, starting from the current framing' }, '+ New shot'));
  const side = $('#shotSide'); side.innerHTML = '';
  side.append(...[list.length > 1 ? h('span', { id: 'lenNote', class: 'note', style: 'margin:0;align-self:center' }, "Changes this shot's camera move only. The action stays the same in every shot.") : null, list.length > 1 ? h('button', { id: 'bSheet', onclick: makeContactSheet, title: 'First and last frame of every shot on one page' }, 'Contact sheet') : null].filter(Boolean));
}

/* ============================== the prompt for the AI model ============================== */
/* Written from the scene in plain words: shot size, lens and angle, the camera move, who does what, the light.
   The person can edit it freely; their words are kept in promptEdit (not saved) until they press Rewrite from scene. */
const COLOR_NAMES = [['black', '#1d1d1f'], ['white', '#f2f2f2'], ['grey', '#8a8e94'], ['dark grey', '#45484e'], ['red', '#c0392b'], ['dark red', '#7a1f22'], ['orange', '#e67e22'], ['yellow', '#e3c034'], ['green', '#2e8b57'], ['dark green', '#2f5130'], ['teal', '#16a085'], ['blue', '#3d6fd8'], ['navy', '#25335c'], ['light blue', '#8fbbe8'], ['purple', '#7d3c98'], ['pink', '#d47a9a'], ['brown', '#6b4a32'], ['beige', '#d9c7a3'], ['tan', '#b88b5a']];
function colorName(hex) {
  const c = new THREE.Color(hex); let best = 'grey', bd = Infinity;
  for (const [name, v] of COLOR_NAMES) { const o = new THREE.Color(v), d = (c.r - o.r) ** 2 + (c.g - o.g) ** 2 + (c.b - o.b) ** 2; if (d < bd) { bd = d; best = name; } }
  return best;
}
const kindLabel = o => o.type === 'person' ? o.opts.body || 'man' : ((CATALOG[o.type] || {}).label || o.type).toLowerCase();
function describeObj(o) {
  if (o.type === 'person') {
    const b = kindLabel(o), e = `${b === 'man' ? 'a man' : b === 'woman' ? 'a woman' : 'a child'} in a ${colorName(o.color)} top`;
    return /^(Man|Woman|Child|Person) \d+$/.test(o.name) ? e : `${o.name} (${e})`;
  }
  if (o.type === 'car') return `a ${colorName(o.color)} ${o.opts.convertible ? 'convertible' : 'car'}`;
  return 'the ' + kindLabel(o);
}
const theOf = s => s.replace(/^an? /, 'the ');
const DOES = { stand: 'stands', walk: 'walks', run: 'runs', sit: 'sits', crouch: 'crouches', wave: 'waves', point: 'points', talk: 'talks, gesturing', cheer: 'cheers with arms raised', phone: 'talks on the phone', arms: 'holds their arms out', look: 'looks around' };
const THEN_DOES = { stand: 'stops and stands', walk: 'starts walking', run: 'breaks into a run', sit: 'sits down', crouch: 'crouches down', wave: 'waves', point: 'points', talk: 'starts talking', cheer: 'cheers', phone: 'answers the phone', arms: 'spreads their arms', look: 'looks around' };
const MOVE_WORDS = { 'static camera': 'stays locked off (static camera)', 'dolly in': 'dollies in', 'dolly out': 'dollies out', 'orbit left': 'orbits left around the subject', 'orbit right': 'orbits right around the subject', 'truck left': 'trucks left', 'truck right': 'trucks right', 'crane up': 'cranes up', 'crane down': 'cranes down', 'pan left': 'pans left', 'pan right': 'pans right', 'tilt up': 'tilts up', 'tilt down': 'tilts down', 'zoom in': 'zooms in', 'zoom out': 'zooms out', 'dolly zoom': 'does a dolly zoom (vertigo effect)', 'free / recorded move': 'moves freely like an operated camera', 'subtle move': 'drifts subtly' };
/* where a world point lands in the frame at time t: x and y from -1 to 1, in front of the lens or not, and whether it is in shot */
function frameOf(pt, t) {
  const c = evalCam(t), cam = new THREE.PerspectiveCamera();
  cam.aspect = arOf(state.settings.aspect); cam.filmGauge = 36; cam.setFocalLength(c.f);
  cam.position.fromArray(c.p); cam.lookAt(c.tg[0], c.tg[1], c.tg[2]); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const v = new THREE.Vector3().fromArray(pt).project(cam);
  return { x: v.x, y: v.y, inFront: v.z < 1, inFrame: v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.1 };
}
/* the middle of a person or thing, for "is it in shot" */
function bodyPoint(o, t) {
  const tr = shownObj(o, t), v = views.get(o.id), k = o.type === 'person' ? (o.opts.height || 1.75) * 0.55 : v && v.aimY != null ? v.aimY : 0.5;
  return [tr.p[0], tr.p[1] + k * tr.s[1], tr.p[2]];
}
const placeWord = x => x < -0.35 ? 'the left of frame' : x > 0.35 ? 'the right of frame' : 'the centre of frame';
/* "from the left of frame to the right of frame, toward the camera, into frame" */
function travelWords(o, t0, t1) {
  const a = shownObj(o, t0).p, b = shownObj(o, t1).p, fa = frameOf(bodyPoint(o, t0), t0), fb = frameOf(bodyPoint(o, t1), t1), out = [];
  const c = evalCam(t0), fwd = new THREE.Vector3(c.tg[0] - c.p[0], 0, c.tg[2] - c.p[2]).normalize(), right = new THREE.Vector3(-fwd.z, 0, fwd.x), d = new THREE.Vector3(b[0] - a[0], 0, b[2] - a[2]);
  const side = d.dot(right), depth = d.dot(fwd);
  if (Math.abs(side) > 0.6 && Math.abs(side) > Math.abs(depth) * 0.5) out.push(Math.abs(fb.x - fa.x) > 0.4 && placeWord(fa.x) !== placeWord(fb.x) ? `from ${placeWord(fa.x)} to ${placeWord(fb.x)}` : side > 0 ? 'from left to right' : 'from right to left');
  if (Math.abs(depth) > 0.6) out.push(depth < 0 ? 'toward the camera' : 'away from the camera');
  if (!fa.inFrame && fb.inFrame) out.push('into frame'); else if (fa.inFrame && !fb.inFrame) out.push('out of frame');
  return out.join(', ') || 'a short way';
}
const wrapNear = (n, ref) => { while (n - ref > 180) n -= 360; while (n - ref < -180) n += 360; return n; };
/* the shot description at time t (the camera and people are posed there for a moment) */
function atTime(t, fn) { applyAll(t); try { return fn(); } finally { applyAll(T); } }
const pluralWord = (label, n) => {
  if (n === 1) return (/^[aeiou]/.test(label) ? 'an ' : 'a ') + label;
  const words = ['', 'a', 'two', 'three', 'four', 'five', 'six'];
  return (words[n] || n) + ' ' + (label === 'cactus' ? 'cacti' : label.endsWith('s') ? label : label.replace(/y$/, 'ie') + 's');
};
function writePrompt() {
  const st = state.settings, cam = state.camera, end = lastT(), out = [];
  const first = atTime(0, describeShot).split(' · '), c0 = evalCam(0), mm = Math.round(c0.f);
  const lens = mm < 20 ? 'ultra-wide' : mm < 40 ? 'wide' : mm < 70 ? 'normal' : 'telephoto';
  const sizes = first.filter(x => /shot|close|wide/i.test(x)).map(x => x.toLowerCase());
  const angle = first.find(x => /angle|overhead|eye level/.test(x)) || 'eye level', subj = subject();
  out.push(`${sizes[0] ? sizes[0][0].toUpperCase() + sizes[0].slice(1) : 'Shot'}${subj ? ' of ' + theOf(describeObj(subj)) : ''}, ${mm}mm ${lens} lens, ${angle}${Math.abs(c0.roll || 0) > 3 ? ', dutch angle' : ''}.`);
  const mv = atTime(0, detectMove);
  let line = 'The camera ' + mv.title.split(' + ').map(part => { const x = part.toLowerCase(); return x.startsWith('tracking ') && subj ? 'tracks with ' + theOf(describeObj(subj)) : MOVE_WORDS[x] || x; }).join(' and ');
  if (mv.title !== 'Static camera' && cam.keys.length > 1) {
    const speed = dist3(evalCam(0).p, evalCam(end).p) / Math.max(0.5, end);
    line += speed < 0.35 ? ' slowly' : speed > 2 ? ' quickly' : '';
    line += cam.feel === 'constant' ? ' at a constant speed' : cam.feel === 'strong' ? ', easing in and out' : ', with a gentle ease';
    const endSize = atTime(end, describeShot).split(' · ').find(x => /shot|close|wide/i.test(x));
    if (endSize && sizes[0] && endSize.toLowerCase() !== sizes[0]) line += `, ending on a ${endSize.toLowerCase()}`;
  }
  if (mountObj()) line += `, mounted on ${theOf(describeObj(mountObj()))}`;
  if ((cam.shake || 0) > 0.05) line += ', handheld with a slight shake';
  out.push(line + '.');
  if (ensureDof().on) out.push('Shallow depth of field' + (ensureDof().fstop <= 2 ? ', strong background blur.' : '.'));
  for (const o of state.objects) {
    if (o.visible === false || (o.type !== 'person' && o.type !== 'car')) continue;
    const a = frameOf(bodyPoint(o, 0), 0), b = frameOf(bodyPoint(o, end), end);
    if (!a.inFrame && !b.inFrame && !(o.keys.length > 1) && !(o.acts && o.acts.length)) continue;
    const d = describeObj(o), par = parentOf(o);
    let s = d[0].toUpperCase() + d.slice(1);
    const moves = o.keys.length > 1 && dist3(evalLocal(o, 0).p, evalLocal(o, end).p) > 0.4;
    if (o.type === 'car') s += moves ? ` drives ${travelWords(o, 0, end)}` : ' is parked' + (a.inFrame ? ' in ' + placeWord(a.x) : '');
    else {
      const pose = o.opts.pose || 'stand';
      if (par) s += ` rides in ${theOf(describeObj(par))}`;
      else if (moves) {
        const L = o.keys[0].t, G = o.keys[o.keys.length - 1].t;
        s += ` ${DOES[poseAt(o, (L + G) / 2)] === 'runs' ? 'runs' : 'walks'} ${travelWords(o, L, G)}`;
        if (L > 0.3) s = s.replace(/ (walks|runs) /, ` waits, then at ${L.toFixed(1)} s $1 `);
      } else s += ` ${DOES[pose] || 'stands'}` + (a.inFrame ? ' in ' + placeWord(a.x) : ' just out of frame');
      for (const act of o.acts || []) s += `, then at ${act.t.toFixed(1)} s ${THEN_DOES[act.pose] || act.pose}`;
      if (o.opts.lookAt) {
        const tgt = o.opts.lookAt === 'camera' ? null : getObj(o.opts.lookAt);
        s += o.opts.lookAt === 'camera' ? ', looking into the camera' : tgt ? `, looking at ${theOf(describeObj(tgt))}` : '';
      } else if (!moves && !par) {
        const me = shownObj(o, 0), yaw = me.r[1];
        const near = persons().filter(q => q !== o).map(q => ({ q, p: shownObj(q, 0).p })).filter(q => Math.hypot(q.p[0] - me.p[0], q.p[2] - me.p[2]) < 3.5).find(q => Math.abs(wrapNear(Math.atan2(q.p[0] - me.p[0], q.p[2] - me.p[2]) * R2D, yaw) - yaw) < 35);
        if (near) s += `, facing ${theOf(describeObj(near.q))}`;
      }
    }
    out.push(s + '.');
  }
  const counts = {};
  for (const o of state.objects) {
    if (o.visible === false || ['person', 'car', 'mark', 'plane', 'image', 'model'].includes(o.type) || (!frameOf(bodyPoint(o, 0), 0).inFrame && !frameOf(bodyPoint(o, end), end).inFrame)) continue;
    const k = kindLabel(o); counts[k] = (counts[k] || 0) + 1;
  }
  const props = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, n]) => pluralWord(k, n));
  if (props.length) out.push('In the scene: ' + props.join(', ') + '.');
  if (state.plate && plateAsset()) out.push('The setting matches the reference location photo.');
  const az = Math.atan2(c0.p[0] - c0.tg[0], c0.p[2] - c0.tg[2]) * R2D, rel = ((st.sunAz - az) % 360 + 540) % 360 - 180;
  const dir = Math.abs(rel) < 45 ? 'front light' : Math.abs(rel) > 135 ? 'backlight' : `side light from the ${rel > 0 ? 'right' : 'left'}`;
  const light = st.env === 'night' ? 'Night' : st.env === 'overcast' ? 'Overcast, soft light' : st.env === 'studio' ? 'Studio lighting' : st.sunEl < 8 ? 'Sun on the horizon' : st.sunEl < 18 ? 'Golden hour' : st.sunEl < 40 ? 'Low sun' : 'Daylight, high sun';
  const sky = skyPhrase(st.clouds), skyOver = sky.startsWith('Overcast') && st.env === 'overcast';
  out.push(`${sky ? sky + (skyOver ? '' : ', ' + light.charAt(0).toLowerCase() + light.slice(1)) : light}, ${dir}${st.shadows === false ? ', no hard shadows' : st.sunEl < 18 ? ', long shadows' : ''}.`);
  out.push(`${st.aspect}, ${st.duration % 1 ? st.duration.toFixed(1) : st.duration} seconds.`);
  return out.join(' ');
}
/* the written prompt is worked out again only after an edit */
let promptEdit = null, promptCache = { rev: -1, text: '' };
function promptText() {
  if (promptCache.rev !== editRev) promptCache = { rev: editRev, text: writePrompt() };
  return promptCache.text;
}
const currentPrompt = () => promptEdit != null ? promptEdit : promptText();
async function copyPromptText(text, box) {
  try { await navigator.clipboard.writeText(text); toast('Prompt copied. Paste it next to the reference clip.'); return; } catch (e) { }
  if (box) { box.focus(); box.select(); try { if (document.execCommand('copy')) { toast('Prompt copied'); return; } } catch (e) { } }
  toast('Select the text and press Ctrl+C to copy it', 4000);
}

/* ============================== export panel ============================== */
function propsExport(p) {
  const s = state.settings, { w, h: hh } = exportSize(), sn = shotName();
  p.append(sec('Export',
    h('p', { class: 'note keep', style: 'margin:0 0 8px;font-size:12.5px;color:#cfd3d8' }, `${w}×${hh} · ${s.fps} fps · ${s.duration.toFixed(1)} s` + (sn ? ' · ' + sn : '')),
    selectRow('Aspect', ASPECTS.map(a => [a[0], a[2]]), () => s.aspect, v => { s.aspect = v; changed(true, true); syncTopUI(); }),
    selectRow('Size', SIZES.map(([v, l]) => [String(v), l]), () => String(s.size), v => { s.size = +v; changed(true, true); }),
    h('div', { class: 'lbl', style: 'width:auto;margin:8px 0 5px' }, 'Render style'),
    h('div', { class: 'stylechips' }, STYLES.map(([k, l, d, bg]) => h('button', { class: s.style === k ? 'on' : '', title: d, onclick: () => { s.style = k; changed(true, true); syncTopUI(); } }, h('div', { class: 'sw', style: 'background:' + bg }), l))),
    check('Show the floor grid in exports', () => s.exportGrid, v => { s.exportGrid = v; changed(true); })));
  p.append(sec('This shot', h('div', { class: 'expgrid' },
    h('button', { id: 'xoVideo', class: 'primary wide', onclick: () => { openModal('mExport'); exportVideo(); } }, 'Render video (MP4)'),
    h('button', { id: 'xoPack', onclick: exportFramePack, title: 'Start, middle and end frames plus the prompt, in one zip' }, 'Frame pack (zip)'),
    h('button', { id: 'xoPng', onclick: () => exportPNG(T) }, 'Current frame (PNG)'),
    h('button', { id: 'xoCopy', onclick: copyFrame }, 'Copy frame'),
    h('button', { id: 'xoOptions', onclick: () => openModal('mExport') }, 'Video options…')),
  h('p', { class: 'note' }, 'Frame pack: the first, middle and last frames as PNG plus the prompt as a text file, in one zip. Made for image-to-video and keyframe models.')));
  const n = hasShots() ? state.shots.length : 1;
  p.append(sec('All shots', n > 1 ? h('div', { class: 'expgrid' }, h('button', { id: 'xoAll', onclick: exportAllShots }, `Every shot (${n} videos)`), h('button', { id: 'xoSheet', onclick: makeContactSheet }, 'Contact sheet'))
    : h('p', { class: 'note' }, 'Add shots with "+ New shot" above the timeline to export them together or make a contact sheet.')));
  const box = h('textarea', { class: 'promptbox', spellcheck: 'false', 'aria-label': 'Prompt for the AI model' });
  box.value = currentPrompt();
  box.addEventListener('input', () => { promptEdit = box.value; });
  box.addEventListener('keydown', e => e.stopPropagation());
  p.append(sec('Prompt for the AI model', box,
    h('div', { class: 'btns', style: 'margin-top:6px' }, h('button', { id: 'xoCopyPrompt', class: 'primary', onclick: () => copyPromptText(box.value, box) }, 'Copy prompt'),
      h('button', { id: 'xoRewrite', onclick: () => { promptEdit = null; box.value = promptText(); toast('Prompt rewritten from the scene'); } }, 'Rewrite from scene')),
    h('p', { class: 'note' }, 'Written from the scene: framing, lens, camera move, who does what, and the light. Edit it freely; your edits stay until you press Rewrite.')));
}

/* ---- a zip with no compression: enough to bundle PNGs and a text file ---- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
/* files: [{ name, data: Uint8Array }] -> a zip Blob */
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [], d = new Date();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
/* the page is locked (as during a video export) while frames are being made, and always unlocked afterwards */
async function whileLocked(fn) {
  if (practicing) return endPracticeFirst(() => whileLocked(fn));
  exporting = true; setExportLock(true);
  try { return await fn(); } finally { exporting = false; setExportLock(false); requestRender(); }
}
/* the first, middle and last frame as PNG plus the prompt, in one zip */
async function exportFramePack() {
  if (exporting) { toast('Wait for the export to finish.'); return false; }
  const r = await whileLocked(buildFramePack);
  if (!r) return false;
  await saveFile(r.name, r.blob);
  return true;
}
async function buildFramePack() {
  setPlaying(false); toast('Rendering the frame pack…', 8000);
  const { w, h: hh } = exportSize(), last = lastT(), base = outName(state.settings.style), files = [];
  try {
    const r = getExportRenderer(w, hh);
    for (const [label, t] of [['1-start', 0], ['2-middle', snapT(last / 2)], ['3-end', last]]) {
      renderExportFrame(r, t, w, hh);
      const blob = await canvasBlob(r.domElement);
      if (!blob) throw new Error('no frame');
      files.push({ name: `${base}-${label}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  } catch (e) { console.error(e); applyAll(T); requestRender(); toast('Could not make that frame. Try a smaller export size.', 4000); return false; }
  applyAll(T); requestRender();
  files.push({ name: base + '-prompt.txt', data: new TextEncoder().encode(currentPrompt() + '\n') });
  return { name: base + '-frames.zip', blob: zipStore(files) };
}
/* one PNG with the first and last frame of every shot, its name, length, size and move */
let sheetBlob = null;
async function makeContactSheet() {
  if (exporting) { toast('Wait for the export to finish.'); return; }
  const url = await whileLocked(buildContactSheet);
  if (url) { $('#toast').classList.remove('show'); $('#sheetImg').src = url; openModal('mSheet'); }
}
async function buildContactSheet() {
  setPlaying(false);
  const list = ensureShots().slice(); syncShot();
  const keepId = state.shotId, keepT = T, ar = arOf(state.settings.aspect), cw = 360, ch = Math.round(cw / ar), pad = 16, top = 34, cap = 28, rows = [];
  toast('Building the contact sheet…', 8000);
  await new Promise(r => setTimeout(r, 30));
  try {
    const r = getExportRenderer(cw, ch);
    const grab = t => { renderExportFrame(r, t, cw, ch); return r.domElement.toDataURL('image/png'); };
    for (const s of list) {
      loadShot(s); applyAll(0);
      const size = describeShot().split(' · ').slice(0, 2).join(' · '), move = detectMove().title;
      rows.push({ name: s.name, dur: s.duration, move, size, a: grab(0), b: grab(lastT()) });
      await new Promise(res => setTimeout(res, 0));
    }
  } catch (e) { console.error(e); toast('Could not make the contact sheet. Try a smaller export size.', 4000); rows.length = 0; }
  loadShot(state.shots.find(s => s.id === keepId) || state.shots[0]); setTime(keepT); applyAll(T); requestRender(); syncTopUI();
  if (!rows.length) return null;
  const W = pad * 3 + cw * 2 + 260, H = top + pad + rows.length * (ch + cap + pad), c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#141518'; g.fillRect(0, 0, W, H); g.fillStyle = '#ffb870'; g.font = '600 18px Segoe UI, Arial, sans-serif';
  g.fillText(((state.meta && state.meta.name) || 'Scene') + (state.takes && state.takes.length > 1 ? ' · ' + activeTakeName() : '') + ' · contact sheet', pad, 24);
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  let y = top + pad;
  for (const [n, s] of rows.entries()) {
    const A = await load(s.a), B = await load(s.b);
    if (A) g.drawImage(A, pad, y, cw, ch); if (B) g.drawImage(B, pad * 2 + cw, y, cw, ch);
    g.fillStyle = '#8f959e'; g.font = '12px Segoe UI, Arial, sans-serif'; g.fillText('START', pad, y + ch + 17); g.fillText('END', pad * 2 + cw, y + ch + 17);
    const x = pad * 3 + cw * 2;
    g.fillStyle = '#e7e9ec'; g.font = '600 16px Segoe UI, Arial, sans-serif'; g.fillText((n + 1) + '. ' + s.name, x, y + 20);
    g.fillStyle = '#c9cdd3'; g.font = '13px Segoe UI, Arial, sans-serif'; g.fillText(s.dur.toFixed(1) + ' s', x, y + 44); g.fillText(s.size, x, y + 64); g.fillText(s.move, x, y + 84);
    y += ch + cap + pad;
  }
  sheetBlob = await canvasBlob(c);
  return c.toDataURL('image/png');
}
/* a video for every shot in turn, in one go: the page stays locked between them */
async function exportAllShots() {
  if (practicing) return endPracticeFirst(exportAllShots);
  if (exporting) return;
  const list = ensureShots().slice(); syncShot();
  const keepId = state.shotId, keepT = T;
  openModal('mExport');
  try {
    for (const [i, s] of list.entries()) {
      loadShot(s);
      if (!(await exportVideo({ label: `Shot ${i + 1} of ${list.length}: ${s.name}` }))) break;
    }
  } finally { loadShot(state.shots.find(s => s.id === keepId) || state.shots[0]); setTime(keepT); applyAll(T); requestRender(); syncTopUI(); }
}

/* ============================== takes ============================== */
/* A take is an alternative version of the whole scene (people, props, camera, settings). state.takes[] = { id, name, snap } and state.takeId is the one on screen.
   The take on screen IS the live state (its own snap is always null); every other take keeps a JSON copy of the scene in snap, made when you left it.
   Switching, making, renaming and deleting takes are undo steps: a step holds the other takes' copies by reference (see snapshot), so undo and redo
   always bring back exactly the copies that step had, and a step stays about as small as one scene.
   A project that never made a second take has no state.takes at all; the button then says "Take 1". */
const hasTakes = () => !!(state.takes && state.takes.length);
const activeTake = () => hasTakes() ? state.takes.find(t => t.id === state.takeId) || state.takes[0] : null;
const activeTakeName = () => (activeTake() || { name: 'Take 1' }).name;
function ensureTakes() {
  if (!hasTakes()) { const id = uid(); state.takes = [{ id, name: 'Take 1', snap: null }]; state.takeId = id; }
  return state.takes;
}
/* a project from a file or autosave: a take that is not on screen and has no copy of its scene can't be used, so it is left out */
function cleanTakes() {
  if (!state.takes) return;
  state.takes = state.takes.filter(t => t.id === state.takeId || typeof t.snap === 'string'); /* a copy that can't be read stays as it is (see takeReadable) */
  if (!state.takes.length) { delete state.takes; delete state.takeId; }
}
/* can this take be opened? The one on screen always can; another needs a copy that reads as a scene. An unreadable copy is kept untouched, shown disabled and saved back as it was. */
const readableCache = new Map();
function takeReadable(t) {
  if (t.id === state.takeId) return true;
  if (typeof t.snap !== 'string') return false;
  let r = readableCache.get(t.snap);
  if (r === undefined) {
    try { const o = JSON.parse(t.snap); r = !!o && typeof o === 'object' && !!o.camera && typeof o.camera === 'object'; } catch (e) { r = false; }
    if (readableCache.size > 40) readableCache.clear();
    readableCache.set(t.snap, r);
  }
  return r;
}
/* the live scene as the text kept in a take (everything except the takes themselves and the project name) */
function takeSceneJSON() { syncShot(); const { takes, takeId, meta, ...scene } = state; return JSON.stringify(scene); }
/* a take's copy read back through the one loader (copies made by the claude.ai version get the same repairs as an opened file) */
function takeState(text) { return normalizeProject({ app: 'ShotRef', state: JSON.parse(text) }, projectDefaults()).state; }
/* make `ns` the live scene: like opening a file, nothing is moved or settled, and the selection is cleared. No history step. */
function loadScene(ns) {
  setPlaying(false);
  ns.takes = state.takes; ns.takeId = state.takeId; if (state.meta) ns.meta = state.meta; else delete ns.meta;
  state = ns; selected = null; selIds = []; promptEdit = null; shotEditId = null; shotBarKey = '';
  migrateAll(); restore(snapshot());
  setTime(clamp(snapT(Math.min(T, lastT())), 0, lastT()));
  pathRev = -1; requestRender();
}
/* a take edit that is not a scene edit: nothing to settle or move */
function takeChanged() { editRev++; uiDirty = true; propsDirty = true; pushHistory(); syncTopUI(); requestRender(); }
function switchTake(id) {
  if (exporting || rec || id === '_') return false;
  ensureTakes(); if (id === state.takeId) return false;
  const t = state.takes.find(x => x.id === id); if (!t || !takeReadable(t)) return false;
  let ns; try { ns = takeState(t.snap); } catch (e) { console.error('ShotRef: could not open the take', e); toast("That take couldn't be opened."); return false; }
  const from = activeTake(), text = takeSceneJSON();
  from.snap = text; t.snap = null; state.takeId = id;
  loadScene(ns); pushHistory(); syncTopUI();
  toast(t.name);
  return true;
}
function nextTakeName() {
  let n = state.takes.length + 1; const used = new Set(state.takes.map(t => t.name));
  while (used.has('Take ' + n)) n++;
  return 'Take ' + n;
}
/* a copy of the take on screen. New take (go = true) moves to the copy; Duplicate keeps you where you are. */
function newTake(go) {
  if (exporting || rec) return;
  ensureTakes(); const from = activeTake(), text = takeSceneJSON();
  const t = { id: uid(), name: nextTakeName(), snap: go ? null : text };
  state.takes.push(t);
  if (go) { from.snap = text; state.takeId = t.id; } /* the scene on screen is already the copy */
  takeChanged();
  toast(go ? t.name + ' is a copy of ' + from.name + '. Change anything; ' + from.name + ' stays as it was.' : t.name + ' added, a copy of ' + from.name + '. Pick it from the Take menu.', 4500);
}
function deleteTake(id) {
  if (exporting || rec) return;
  ensureTakes();
  if (state.takes.length < 2) { toast('There is only one take'); return; }
  const i = state.takes.findIndex(t => t.id === id); if (i < 0) return;
  const t = state.takes[i];
  if (id === state.takeId) {
    const near = state.takes.filter(x => x !== t && takeReadable(x)).sort((x, y) => Math.abs(state.takes.indexOf(x) - i) - Math.abs(state.takes.indexOf(y) - i)), next = near[0];
    if (!next) { toast("The other takes can't be opened, so nothing was deleted."); return; }
    let ns; try { ns = takeState(next.snap); } catch (e) { console.error('ShotRef: could not open the take', e); toast("The other take couldn't be opened, so nothing was deleted."); return; }
    state.takes = state.takes.filter(x => x !== t); next.snap = null; state.takeId = next.id;
    loadScene(ns);
  } else state.takes = state.takes.filter(x => x !== t);
  takeChanged();
  toast(t.name + ' deleted. Ctrl+Z brings it back.', 4000);
}
function openTakeName() {
  ensureTakes();
  $('#nmInput').value = activeTake().name; openModal('mName'); $('#nmInput').select();
}
function renameTake() {
  const v = $('#nmInput').value.trim().slice(0, 60), t = activeTake();
  closeModal($('#nmInput'));
  if (!v || !t || v === t.name) return;
  t.name = v; takeChanged();
}
function takeMenuItems() {
  const real = hasTakes(), list = real ? state.takes : [{ id: '_', name: 'Take 1' }], act = real ? activeTake().id : '_', bad = list.filter(t => real && !takeReadable(t)), good = list.length - bad.length;
  return [{ head: 'Takes' },
    ...list.map(t => takeReadable(t) || !real ? { id: 'take:' + t.id, label: t.name, check: t.id === act, fn: () => switchTake(t.id) } : { id: 'take:' + t.id, label: t.name + " (can't be opened)", check: false, disabled: true }),
    '-',
    { id: 'newtake', label: 'New take (copy of this one)', fn: () => newTake(true) },
    { id: 'duptake', label: 'Duplicate this take', fn: () => newTake(false) },
    { id: 'renametake', label: 'Rename this take…', fn: openTakeName },
    { id: 'compare', label: 'Compare takes side by side…', fn: openCompare, disabled: good < 2 },
    '-',
    { id: 'deltake', label: 'Delete this take', danger: true, fn: () => deleteTake(act), disabled: list.length < 2 },
    ...bad.map(t => ({ id: 'deltake:' + t.id, label: 'Delete "' + t.name + '" (can\'t be opened)', danger: true, fn: () => deleteTake(t.id) }))];
}

/* ---- compare takes ----
   Each take plays its own current shot from its own start to its end, side by side. The frames are made one by one with the export
   renderer while the page is locked, and kept as JPEG data: URLs (no blob: URLs). The scene on screen is put back afterwards, even after an error. */
let cmp = null, cmpBusy = false, cmpStop = false, swapping = false; /* swapping: another take's scene is on screen for a moment, so nothing may be autosaved */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function openCompare() {
  if (practicing) return endPracticeFirst(openCompare);
  if (exporting) { toast('Wait for the export to finish.'); return; }
  const ok2 = hasTakes() ? state.takes.filter(takeReadable) : [];
  if (ok2.length < 2) { toast('Make a second take first: Take menu → New take'); return; }
  for (const sel of [$('#cmpA'), $('#cmpB')]) { sel.innerHTML = ''; for (const t of ok2) sel.append(h('option', { value: t.id }, t.name)); }
  $('#cmpA').value = state.takeId; $('#cmpB').value = ok2.find(t => t.id !== state.takeId).id;
  $('#cmpView').hidden = true; $('#cmpMsg').textContent = ''; cmp = null;
  openModal('mCompare'); renderCompare();
}
async function renderCompare() {
  if (exporting || cmpBusy) return;
  cmpBusy = true; cmp = null; $('#cmpView').hidden = true; $('#cmpMsg').textContent = 'Rendering…';
  const ids = [$('#cmpA').value, $('#cmpB').value], keep = { state, T, selected, selIds: selIds.slice() }, out = {};
  setPlaying(false); flushAutosave(); cmpStop = false; $('#cmpCancel').hidden = false;
  const cw = 400, ch = Math.max(2, Math.round(cw / arOf(state.settings.aspect) / 2) * 2), fps = 10;
  let failed = false;
  try {
    await whileLocked(async () => {
      try {
        const r = getExportRenderer(cw, ch);
        for (const id of ids) {
          const t = keep.state.takes.find(x => x.id === id) || activeTake();
          const ns = t.id === keep.state.takeId ? keep.state : takeState(t.snap);
          if (ns !== keep.state) { ns.takes = keep.state.takes; ns.takeId = keep.state.takeId; }
          if (cmpStop) throw new Error('cancelled');
          swapping = true; state = ns; syncScene(); applyEnv(); ensurePlate(); editRev++;
          for (let i = 0; i < 40 && !cmpStop && (plateBusy || [...views.values()].some(v => v.pending)); i++) await sleep(50); /* a model or photo still loading */
          const end = lastT(), n = clamp(Math.round(state.settings.duration * fps), 2, 150), frames = [];
          for (let f = 0; f < n; f++) {
            if (cmpStop) throw new Error('cancelled');
            renderExportFrame(r, f / (n - 1) * end, cw, ch); frames.push(r.domElement.toDataURL('image/jpeg', 0.82));
            if (f % 10 === 0) { $('#cmpMsg').textContent = `Rendering ${t.name}: ${f + 1}/${n}`; await sleep(0); }
          }
          const sh = activeShot();
          out[id] = { name: t.name, frames, len: end, shot: sh ? sh.name : 'Shot 1', move: detectMove().title };
        }
      } finally {
        state = keep.state; swapping = false; selected = keep.selected; selIds = keep.selIds; setTime(keep.T);
        syncScene(); applyEnv(); editRev++; uiDirty = true; propsDirty = true; updateGizmo(); syncTopUI(); applyAll(T);
      }
    });
  } catch (e) { if (!cmpStop) console.error('ShotRef: could not render the takes', e); failed = true; }
  cmpBusy = false; $('#cmpCancel').hidden = true; autosave();
  if (cmpStop && failed) { $('#cmpMsg').textContent = 'Cancelled.'; return; }
  if (failed) { $('#cmpMsg').textContent = 'Could not render the takes. Try again, or close other programs and try once more.'; return; }
  $('#cmpMsg').textContent = '';
  cmp = { A: out[ids[0]], B: out[ids[1]], idB: ids[1], u: 0, playing: true, last: performance.now() };
  $('#cmpLA').textContent = `${cmp.A.name} · ${cmp.A.shot} · ${cmp.A.move}`; $('#cmpLB').textContent = `${cmp.B.name} · ${cmp.B.shot} · ${cmp.B.move}`;
  const ar = String(arOf(state.settings.aspect)); $('#cmpImgA').style.aspectRatio = $('#cmpImgB').style.aspectRatio = ar;
  $('#cmpView').hidden = false; showCompareFrame(); requestAnimationFrame(compareTick);
}
function showCompareFrame() {
  if (!cmp) return;
  const pick = x => x.frames[Math.min(x.frames.length - 1, Math.round(cmp.u * (x.frames.length - 1)))];
  const a = pick(cmp.A), b = pick(cmp.B);
  if ($('#cmpImgA').src !== a) $('#cmpImgA').src = a;
  if ($('#cmpImgB').src !== b) $('#cmpImgB').src = b;
  $('#cmpScrub').value = cmp.u; $('#cmpPlay').textContent = cmp.playing ? '❚❚' : '▶';
}
function compareTick(now) {
  if (!cmp || $('#mCompare').classList.contains('hidden')) { if (cmp) cmp.playing = false; return; }
  const dt = (now - cmp.last) / 1000; cmp.last = now;
  if (cmp.playing) { cmp.u += dt / Math.max(cmp.A.len, cmp.B.len, 0.5); if (cmp.u > 1) cmp.u = 0; }
  showCompareFrame(); requestAnimationFrame(compareTick);
}
function wireTakes() {
  menuButton($('#bTake'), takeMenuItems);
  $('#nmOk').onclick = renameTake;
  $('#nmInput').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') renameTake(); else if (e.key === 'Escape') closeModal($('#nmInput')); });
  $('#cmpGo').onclick = renderCompare;
  $('#cmpCancel').onclick = () => { cmpStop = true; };
  $('#cmpPlay').onclick = () => { if (cmp) { cmp.playing = !cmp.playing; cmp.last = performance.now(); showCompareFrame(); } };
  $('#cmpScrub').addEventListener('input', e => { if (cmp) { cmp.u = +e.target.value; cmp.playing = false; showCompareFrame(); } });
  $('#cmpUseB').onclick = () => { if (!cmp || exporting) return; const id = cmp.idB; closeModal($('#cmpUseB')); switchTake(id); };
}

/* ============================== export ============================== */
function exportSize() {
  const ar = arOf(state.settings.aspect), L = state.settings.size;
  let w, hh; if (ar >= 1) { w = L; hh = L / ar; } else { hh = L; w = L * ar; }
  const ev = x => Math.max(2, Math.round(x / 2) * 2);
  return { w: ev(w), h: ev(hh) };
}
/* bits per second for an MP4: 'High' is what ShotRef always used; Standard makes smaller files, Maximum larger ones */
const videoBitrate = (w, hh, fps) => Math.round(clamp(w * hh * fps * { standard: 0.14, high: 0.22, max: 0.4 }[pref('videoQuality')], 3e6, 80e6));
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
  applyAll(t); prepRenderCam(t); placeSun();
  r.setViewport(0, 0, w, hh); r.setScissorTest(false);
  exportingRender = true;
  try { shotPass(r, w, hh); } finally { exportingRender = false; }
}
function canvasBlob(c, type = 'image/png') { return new Promise(res => c.toBlob(res, type)); }
const nameFrom = parts => [pref('filePrefix'), ...parts, pref('dateStamp') ? stamp() : null].filter(Boolean).join('-').replace(/[\\/:*?"<>|\s]+/g, '_');
const outName = (...parts) => nameFrom([shotName(), ...parts]);
const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
async function exportPNG(t, label) {
  if (practicing) return endPracticeFirst(() => exportPNG(t, label));
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
  await saveFile(outName(label || 'frame' + String(fr).padStart(4, '0'), state.settings.style) + '.png', blob);
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
  const br = videoBitrate(w, hh, fps);
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
  $$('#mCompare input, #mCompare select, #mCompare button').forEach(el => { el.disabled = on && el.id !== 'cmpCancel'; });
  // make everything outside the export dialog unreachable by Tab, Enter or Space
  for (const el of document.body.children) if (el.id !== 'mExport' && el.id !== 'mCompare' && el.id !== 'toast' && el.tagName !== 'SCRIPT') el.inert = on;
  if (on) { const c = $('#exCancel'); if (c && !c.hidden) c.focus(); else if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
}
function exProgressRaw(frac, txt) { $('#exBar').style.width = (frac * 100).toFixed(1) + '%'; $('#exTxt').textContent = txt; }
async function exportVideo(opts = {}) {
  if (practicing) return endPracticeFirst(() => exportVideo(opts));
  if (exporting) return false;
  exporting = true; exCancel = false;
  let done = false; const pre = opts.label ? opts.label + ' · ' : '';
  const exProgress = (f, t) => exProgressRaw(f, t ? pre + t : t);
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
      await saveFile(outName(state.settings.style, `${w}x${hh}`, `${fps}fps`) + '.mp4', blob); done = true;
    } else {
      // fallback: WebM in real time
      const c = r.domElement;
      if (!c.captureStream || typeof MediaRecorder === 'undefined') { const e = new Error('This browser cannot record video. Please use Chrome or Edge.'); e.plain = true; throw e; }
      const stream = c.captureStream(0), track = stream.getVideoTracks()[0];
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: { standard: 12e6, high: 16e6, max: 24e6 }[pref('videoQuality')] }); const parts = [];
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
      await saveFile(outName(state.settings.style, `${w}x${hh}`) + '.webm', blob); done = true;
    }
  } catch (e) {
    console.error(e);
    const msg = e && e.plain ? e.message : e && e.mp4 ? "Your PC couldn't make an MP4 at this size. Try 1280 px, or use Frame pack (zip)." : 'The export stopped because of an error. Try again, or try a smaller size.';
    toast(msg, 6000); exProgress(0, msg);
  } finally {
    if (vf) { try { vf.close(); } catch (e) { } }
    if (enc && enc.state !== 'closed') { try { enc.close(); } catch (e) { } }
    if (exCancel) exProgress(0, '');
    exporting = false; exCancel = false; $('#exCancel').hidden = true; setTime(saveT, false); applyAll(T); setExportLock(false);
    if (!$('#mExport').classList.contains('hidden')) $('#exVideo').focus(); /* Cancel just hid itself; keep focus in the dialog (M8) */
  }
  return done;
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

/* ============================== practice stage ============================== */
/* The hands-on tour runs on an empty stage. enterPractice sets the user's scene aside in memory (the same fields replaceProject keeps for its
   error path, as they are: no JSON round trip, so nothing is re-normalised) and shows a fresh empty scene with an undo history of its own.
   While `practicing` is set nothing is written: autosave (so a reload reopens the real scene), the Recent list, the unsaved mark and the window
   title (platform.hold). leavePractice is the only way back, safe to call twice: Finish, End tour, Esc and every action that would touch the
   real scene (Open, New, Save, a dropped file, an export, closing the desktop window...) end up there through endPracticeFirst. */
/* force skips the boot-load check: for the smoke test only */
function enterPractice(force) {
  if (practicing || (!autosaveReady && force !== true) || saving || exporting || rec || placing || pathMode || openModals().length) return false;
  let stage;
  try { stage = buildState(() => fillStarter('empty')); }
  catch (e) { console.error('ShotRef: could not make the practice stage', e); return false; }
  flushAutosave(); /* the real scene's pending autosave goes out now: a reload during practice reopens it */
  if (menuOpen()) hideMenu();
  focusPick = false; canvas.style.cursor = ''; setPlaying(false);
  const lt = $('#leftTabs .on');
  practicing = {
    state, assets, selected, selIds: selIds.slice(), T, hist: hist.slice(), histDoc: histDoc.slice(), hi, doc: platform.getDoc(),
    view, lastWorkView, layout, leftTab: lt ? lt.dataset.lt : 'add', promptEdit, shotEditId, snapHold, groundDirty, groundMigrate: [...groundMigrate],
    ed: { p: edCam.position.clone(), tg: edControls.target.clone() },
    top: { init: topInit, p: topCam.position.clone(), zoom: topCam.zoom, tg: topControls.target.clone() },
  };
  platform.hold(true);
  snapHold = true; /* the undo pool must keep the real history's take copies: the practice history refers to none of them */
  try {
    state = stage; assets = {}; selected = null; selIds = []; promptEdit = null; shotEditId = null; setTime(0);
    groundDirty = false; groundMigrate.clear();
    hist = [snapshot()]; histDoc = [practicing.doc]; hi = 0; /* undo stops here */
    resetEditorCam(); topInit = false;
    setLeftTab('add', false); setView('editor');
    showState(); requestRender();
  } catch (e) { console.error('ShotRef: could not show the practice stage', e); leavePractice(); return false; }
  return true;
}
/* Puts the real scene back exactly. Returns true when it restored something. */
function leavePractice() {
  const p = practicing;
  if (!p) return false;
  /* whatever the practice stage had under way points at its own objects */
  try { if (placing) cancelPlacing(); if (pathMode) cancelPath(); if (rec) cancelRecord(); } catch (e) { console.error('ShotRef: could not cancel the practice edit', e); }
  focusPick = false; canvas.style.cursor = ''; if (menuOpen()) hideMenu(); setPlaying(false);
  practicing = null; platform.hold(false);
  state = p.state; assets = p.assets; selected = p.selected; selIds = p.selIds; promptEdit = p.promptEdit; shotEditId = p.shotEditId; setTime(p.T);
  hist = p.hist; histDoc = p.histDoc; hi = p.hi; snapHold = p.snapHold;
  groundDirty = p.groundDirty; groundMigrate.clear(); for (const id of p.groundMigrate) groundMigrate.add(id);
  edCam.position.copy(p.ed.p); edControls.target.copy(p.ed.tg);
  topInit = p.top.init; topCam.position.copy(p.top.p); topCam.zoom = p.top.zoom; topCam.updateProjectionMatrix(); topControls.target.copy(p.top.tg);
  platform.restoreDoc(p.doc);
  try {
    if (layout !== p.layout) setLayout(p.layout, false);
    setView(p.view); lastWorkView = p.lastWorkView; setLeftTab(p.leftTab, false);
    showState();
  } catch (e) { console.error('ShotRef: could not show the real scene again', e); }
  if (snapLive > snapPruneAt) pruneSnapPool();
  autosave(); /* always: a write asked for before or during practice may not have run or may have missed files */
  requestRender();
  return true;
}
/* Runs `go` once the real scene is back. Every action that reads or replaces the scene starts with this. */
function endPracticeFirst(go) {
  if (practicing) {
    if (tourHandle) { try { tourHandle.end('external'); } catch (e) { console.error('ShotRef: the tour did not end cleanly', e); } } /* its own end calls leavePractice */
    leavePractice();
  }
  return go();
}

/* ============================== tour ============================== */
let tourHandle = null;
/* Runs a list of stops (see src/tour.js for the stop shape). Returns null, with a toast, while an export runs or a dialog is open. */
function runStops(stops, opts = {}) {
  if (exporting) { toast('Wait for the export to finish.'); return null; }
  if (openModals().length) { toast('Close the open window first.'); return null; }
  const { onEnd, canKey, ui, interactive } = opts;
  /* Esc goes to the app first when it has something to cancel */
  const appCanEsc = e => e.key === 'Escape' && (openModals().length > 0 || menuOpen() || !!rec || !!placing || !!pathMode || focusPick || (canKey ? canKey(e) : false));
  tourHandle = runTour({ stops, ui: ui || TOUR_COPY.ui, interactive: !!interactive, canKey: appCanEsc, paused: () => openModals().length > 0, onEnd: reason => { tourHandle = null; requestRender(); if (onEnd) onEnd(reason); } });
  requestRender();
  return tourHandle;
}
/* The quick tour: look, no touching. The set-up hooks only switch what is shown (the left tab); they never edit the scene. */
const BASIC_STOPS = [
  ['b-welcome', null],
  ['b-steps', '#stepSeg'],
  ['b-add', '#left', () => setLeftTab('add', false)],
  ['b-picture', '#vp'],
  ['b-view', '#viewGrp'],
  ['b-panel', '#right'],
  ['b-timeline', '#tl'],
  ['b-file', '#bFile'],
  ['b-gear', '#bMenu'],
  ['b-bye', null],
];
/* The hands-on tour is switched off for now (Ali, 2026-11-24: it needs more work). Its code and tests stay; every way a user could start it is hidden
   (first-run button, gear menu item, Quick start button; the desktop Help item is hidden in electron/main.cjs). Turn it back on with the hidden pref
   handsTour = true, or HANDS_TOUR_DEFAULT below. While it is off, the copy that talks about two tours uses its one-tour wording (textSolo / bodySolo). */
const HANDS_TOUR_DEFAULT = false;
const handsTourOn = () => !!getPref('handsTour', HANDS_TOUR_DEFAULT);
const basicStops = () => BASIC_STOPS.map(([id, target, before]) => {
  const c = TOUR_COPY.basic[id];
  return { id, target, before, title: c.title, text: !handsTourOn() && c.textSolo ? c.textSolo : c.text };
});
/* The hands-on tour: each "try" stop waits for a change made through the real UI, on the practice stage (enterPractice). snap() records what its waitFor
   compares against when the stop begins, so something already true never skips a stop. before() puts the screen where the stop needs it (these view, step
   and tab changes are not undo steps); keep() lets a key that moved the screen away (T on the camera bar) bring it back on the next tick. */
function handsStops() {
  let placed = null, framed = false; /* this run's person (the one h-place made) and whether the lens stop has framed them yet */
  const H = TOUR_COPY.hands, copy = id => ({ id, title: H[id].title, text: H[id].text, done: H[id].done });
  const personId = () => { if (placed && getObj(placed)) return placed; const q = persons()[0]; return q ? q.id : null; };
  const needPerson = () => personId() || addPerson('man', false).id; /* skipped h-place: one normal add (a practice edit) so the stops still work */
  const camView = () => { if (view !== 'camera') setView('camera'); };
  const tabNow = () => { const b = $('#leftTabs .on'); return b ? b.dataset.lt : 'add'; };
  const personPosOf = id => { const o = getObj(id); return o ? evalObj(o, T).p.map(v => v.toFixed(4)).join() : ''; };
  const personPos = () => personPosOf(personId());
  return [
    { ...copy('h-welcome'), target: null },
    { ...copy('h-build'), target: '#stepSeg', before: () => goStep('frame'), snap: currentStep, waitFor: s => currentStep() === 'build' && currentStep() !== s },
    { ...copy('h-place'), target: ['#left', '#vp'], corner: 'tr', before: () => goStep('build'), snap: () => persons().length,
      waitFor: n => !placing && persons().length > n && (placed = persons()[persons().length - 1].id) !== null },
    { ...copy('h-drag'), target: '#vp', before: () => { goStep('build'); select(needPerson()); }, snap: () => { const id = personId(); return { id, pos: personPos() }; }, waitFor: s => !!s.id && !!getObj(s.id) && !dragActive && personPosOf(s.id) !== s.pos },
    { ...copy('h-rightclick'), target: '#vp', before: () => { if (view === 'camera') setView(lastWorkView); hideMenu(); }, waitFor: () => menuOpen() },
    { ...copy('h-scenetab'), target: '#leftTabs [data-lt=scene]', before: () => setLeftTab('add', false), snap: tabNow, waitFor: s => tabNow() === 'scene' && s !== 'scene' },
    { ...copy('h-top'), target: '#viewSeg [data-v=top]', before: () => { if (view === 'top') setView('editor'); }, snap: () => view, waitFor: s => view === 'top' && s !== 'top' },
    { ...copy('h-camera'), target: '#viewSeg [data-v=camera]', before: () => { if (view === 'camera') setView('editor'); }, snap: () => view, waitFor: s => view === 'camera' && s !== 'camera' },
    { ...copy('h-cambar'), target: '#camBar', before: camView, keep: () => view === 'camera' },
    { ...copy('h-focus'), target: '#vp', keep: () => view === 'camera', snap: () => focusPicks, waitFor: n => focusPicks > n,
      before: () => { const id = needPerson(); camView(); select(id); if (!framed) { framed = true; frameShot('medium', id); } } },
    { ...copy('h-play'), target: '#bPlay', before: () => { if (playing) setPlaying(false); }, snap: () => playing, waitFor: s => playing && !s },
    { ...copy('h-key'), target: '#bKey', before: () => { if (playing) setPlaying(false); } },
    { ...copy('h-shots'), target: '#shotBar' },
    { ...copy('h-take'), target: '#bTake' },
    { ...copy('h-gear'), target: '#bMenu' },
    { ...copy('h-export'), target: '#bExport', before: () => { if (currentStep() === 'export') goStep('build'); }, snap: currentStep, waitFor: s => currentStep() === 'export' && s !== 'export' },
  ];
}
/* the toast for a hands-on tour that cannot start: the same two lines as the quick tour, else (placing, recording, a path, a save) a plain one */
const tourRefusal = () => exporting ? 'Wait for the export to finish.' : openModals().length ? 'Close the open window first.' : TOUR_COPY.ui.busy;
/* The one way to start a tour: 'basic' or 'hands'. opts.firstRun: the Start a shot picker follows the tour. */
function startTour(kind, opts = {}) {
  const firstRun = !!opts.firstRun;
  /* a tour is already running: leave it exactly as it is */
  if (tourActive() || practicing) { toast(TOUR_COPY.ui.busy); if (firstRun) openStarters(true); return null; }
  if (kind === 'hands') {
    if (!enterPractice()) { toast(tourRefusal()); if (firstRun) openStarters(true); return null; }
    const tab = getPref('leftTab', undefined); /* the tour's Add and Scene steps save the remembered tab: put it back */
    const handle = runStops(handsStops(), {
      ui: TOUR_COPY.ui, interactive: true,
      onEnd: reason => {
        leavePractice(); setPref('leftTab', tab);
        setPref('tourHandsDone', true); requestRender();
        if (reason === 'external') return; /* an Open, New, drop... took over: its own action carries on, so no picker */
        if (firstRun) openStarters(true);
      },
    });
    if (!handle) { leavePractice(); if (firstRun) openStarters(true); } /* refused after all (an export began, a dialog opened) */
    return handle;
  }
  const tab = $('#leftTabs .on') ? $('#leftTabs .on').dataset.lt : 'add';
  const handle = runStops(basicStops(), {
    ui: TOUR_COPY.ui,
    onEnd: reason => {
      setLeftTab(tab, false);
      setPref('tourBasicDone', true);
      if (reason === 'external') return; /* another tour took over, or Open / New / a file from Windows swapped the project: no picker */
      if (firstRun) openStarters(true);
    },
  });
  /* refused (a dialog is open, an export runs): a first run must still get its picker */
  if (!handle && firstRun) openStarters(true);
  return handle;
}
/* the first-run question and the buttons that start a tour from a dialog: close the dialog first, since a tour will not start over one */
/* while the first-run question is open, any way of closing it other than the two tour buttons counts as Not now (Esc, a click outside) */
let tourAsk = false;
function tourFromDialog(modalId, kind, firstRun) {
  if (modalId === 'mTour') tourAsk = false;
  closeModal($('#' + modalId));
  startTour(kind, { firstRun });
}
function wireTourDialogs() {
  const W = TOUR_COPY.welcome, H = TOUR_COPY.helpPage;
  $('#mTourT').textContent = W.title; $('#mTourP').textContent = W.body;
  $('#tourQuick').textContent = W.quick; $('#tourHands').textContent = W.hands; $('#tourNo').textContent = W.notNow;
  $('#tourQuick').onclick = () => tourFromDialog('mTour', 'basic', true);
  $('#tourHands').onclick = () => tourFromDialog('mTour', 'hands', true);
  $('#tourNo').onclick = () => closeModal($('#mTour'));
  $('#helpTourLead').textContent = H.lead; $('#helpTourQuick').textContent = H.quick; $('#helpTourHands').textContent = H.hands;
  $('#helpTourQuick').onclick = () => tourFromDialog('mHelp', 'basic', false);
  $('#helpTourHands').onclick = () => tourFromDialog('mHelp', 'hands', false);
  applyHandsTourSwitch();
}
/* show or hide every way to start the hands-on tour, and pick the matching first-run wording */
function applyHandsTourSwitch() {
  const on = handsTourOn(), W = TOUR_COPY.welcome;
  $('#tourHands').hidden = !on; $('#helpTourHands').hidden = !on;
  $('#mTourP').textContent = on ? W.body : W.bodySolo;
}
function setHandsTour(on) { setPref('handsTour', !!on); applyHandsTourSwitch(); }

/* ============================== modals ============================== */
const openModals = () => $$('.modal').filter(m => !m.classList.contains('hidden'));
/* buttons, fields and rows a keyboard user can reach inside a dialog */
const focusables = m => [...m.querySelectorAll('button, select, input, textarea, [tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
let modalReturn = null;
function openModal(id) {
  const m = $('#' + id), ae = document.activeElement;
  if (!openModals().length && ae && ae !== document.body) modalReturn = ae;
  m.classList.remove('hidden'); requestRender();
  if (id === 'mExport') { $('#exProg').hidden = !exporting; renderExportDialog(); }
  placeToast();
  if (exporting && id === 'mExport') return; /* the export lock owns focus */
  /* the main button, else the first real control: the × only when there is nothing else (K6) */
  const f = m.querySelector('button.primary:not(:disabled)') || focusables(m).find(el => !el.hasAttribute('data-close')) || focusables(m)[0];
  if (f) f.focus();
}
function closeModal(el) {
  const m = el.closest('.modal'); if (exporting && (m.id === 'mExport' || m.id === 'mCompare')) return;
  m.classList.add('hidden'); placeToast(); requestRender();
  if (m.id === 'mTour' && tourAsk) { tourAsk = false; openStarters(true); }
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
  if (practicing) return endPracticeFirst(openDialog);
  if (exporting) { toast('Wait for the export to finish.'); return; }
  const f = await platform.openProject($('#fOpen'));
  if (f && typeof f.text === 'string') loadProjectText(f.text, f);
}
/* The desktop window asked to close. Nothing unsaved: allow it. Otherwise ask, and only allow it once it is safe. */
function closeRequested() {
  if (practicing) return endPracticeFirst(closeRequested); /* so the question below is about the real scene */
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
  if (cmd === 'about') { openAbout(); return; } /* only a window: a running tour just pauses under it */
  if (practicing && !/^tour-/.test(cmd)) { endPracticeFirst(() => onDesktopMenu(cmd)); return; }
  if (exporting) { toast('Wait for the export to finish.'); return; }
  if (cmd === 'new') openStarters();
  else if (cmd === 'open') openDialog();
  else if (cmd === 'save') saveProject(false);
  else if (cmd === 'save-as') saveProject(true);
  else if (cmd === 'help') openModal('mHelp');
  else if (cmd === 'tour-basic') startTour('basic');
  else if (cmd === 'tour-hands') startTour('hands');
}

/* ============================== Settings window ============================== */
/* Settings are per browser (localStorage 'shotref.prefs'); pref(k) reads them, changePref(k, v) saves one and puts it to work. */
function changePref(k, v) {
  setPref(k, v);
  if (k === 'quality' || k === 'liveShadows' || k === 'orbitSpeed' || k === 'zoomSpeed' || k === 'snapStep' || k === 'rotSnap') applyPrefs();
  else if (k === 'pipDefault') { pipOn = v; syncTopUI(); requestRender(); }
  else if (k === 'autosave') { if (v) autosave(); }
  else requestRender();
}
function prefSelect(key, label, options, get = () => pref(key), parse = Number) {
  const s = h('select', { class: 'grow', 'data-pref': key }, options.map(([v, l]) => h('option', { value: String(v) }, l)));
  s.value = String(get()); s.addEventListener('change', () => changePref(key, parse(s.value)));
  return h('div', { class: 'row' }, h('label', null, label), s);
}
function prefCheck(key, label, get = () => pref(key), set = v => changePref(key, v)) {
  const c = h('input', { type: 'checkbox', 'data-pref': key }); c.checked = !!get();
  c.addEventListener('change', () => set(c.checked));
  return h('label', { class: 'row', style: 'gap:8px;cursor:pointer;width:auto' }, c, label);
}
function prefRange(key, label, { min, max, step, fmt }) {
  const val = h('span', { class: 'sval' }), r = h('input', { type: 'range', min, max, step, class: 'grow', 'data-pref': key });
  r.value = pref(key); val.textContent = fmt(pref(key));
  r.addEventListener('input', () => { val.textContent = fmt(+r.value); changePref(key, +r.value); });
  return h('div', { class: 'row' }, h('label', null, label), r, val);
}
function resetPrefs() {
  const wasGround = groundOn();
  for (const k of Object.keys(PREF_DEFAULTS)) delete prefs[k];
  savePrefs();
  if (!wasGround) setGround(true, true);
  pipOn = pref('pipDefault'); setLayout('single', false); applyPrefs(); syncTopUI(); uiDirty = true; propsDirty = true; requestRender();
  buildSettings(); toast('Settings reset to defaults');
}
function buildSettings() {
  const body = $('#setBody'); body.innerHTML = '';
  const ex = h('p', { class: 'note' }), showEx = () => { ex.textContent = 'Example file name: ' + nameFrom(['frame0001', 'shaded']) + '.png'; };
  const pre = h('input', { type: 'text', class: 'grow', maxlength: 40, 'data-pref': 'filePrefix', value: pref('filePrefix') });
  pre.addEventListener('keydown', e => { if (e.key !== 'Tab') e.stopPropagation(); if (e.key === 'Enter') pre.blur(); });
  pre.addEventListener('change', () => { const v = pre.value.trim().replace(/[\\/:*?"<>|]+/g, '') || PREF_DEFAULTS.filePrefix; changePref('filePrefix', v); pre.value = v; showEx(); });
  showEx();
  body.append(
    h('div', { class: 'setcol' },
      sec('New scenes',
        prefSelect('newDuration', 'Length', PREF_LISTS.newDuration.map(v => [v, v + ' s'])),
        prefSelect('newFps', 'Frame rate', PREF_LISTS.newFps.map(v => [v, v + ' fps'])),
        prefSelect('newAspect', 'Aspect', ASPECTS.map(a => [a[0], a[2]]), undefined, String),
        prefSelect('newSize', 'Size', SIZES.map(([v, l]) => [v, l])),
        h('p', { class: 'note' }, 'Used when you start a new scene or pick a starter set. Opened files keep their own.')),
      sec('Blocking',
        prefRange('walkSpeed', 'Walking speed', { min: 0.6, max: 2.5, step: 0.05, fmt: v => (+v).toFixed(2) + ' m/s' }),
        prefCheck('autoSit', 'Sit automatically when a person is dropped on a seat'),
        prefCheck('ground', 'Keep things on the ground (nothing floats or sinks)', groundOn, v => setGround(v)),
        h('p', { class: 'note' }, 'Things rest on the floor, or on the surface right under them (a cup on a table). Riders and people sitting are left alone. For a drone or a hanging lamp, tick "Can float" on that object.')),
      sec('Export',
        prefSelect('videoQuality', 'Video quality', [['standard', 'Standard (smaller files)'], ['high', 'High'], ['max', 'Maximum (large files)']], undefined, String),
        h('div', { class: 'row' }, h('label', null, 'File names'), pre),
        prefCheck('dateStamp', 'Add the date and time to file names', undefined, v => { changePref('dateStamp', v); showEx(); }),
        ex)),
    h('div', { class: 'setcol' },
      sec('Viewport',
        prefSelect('quality', 'Preview quality', [['low', 'Fast (lower resolution)'], ['balanced', 'Balanced'], ['high', 'Sharp (uses more GPU)']], undefined, String),
        prefSelect('layout', 'Layout', [['single', 'One view'], ['split', 'Split: editor + camera']], () => layout, v => { setLayout(v); }, String),
        prefCheck('liveShadows', 'Shadows in the live view'),
        prefCheck('pipDefault', 'Camera preview in the corner'),
        prefCheck('showLabels', 'Name labels over people'),
        prefCheck('showArrows', 'Facing arrows under people'),
        prefCheck('showHints', 'Hint bar at the bottom'),
        prefCheck('showSun', 'Draggable sun in the editor'),
        prefCheck('selBar', 'Toolbar over the selection'),
        prefCheck('camPoints', 'Draggable camera path points'),
        h('p', { class: 'note' }, 'Exports always render at full quality with shadows.')),
      sec('Mouse & keys',
        prefRange('orbitSpeed', 'Orbit speed', { min: 0.3, max: 2.5, step: 0.05, fmt: v => (+v).toFixed(2) + '×' }),
        prefRange('zoomSpeed', 'Zoom speed', { min: 0.3, max: 2.5, step: 0.05, fmt: v => (+v).toFixed(2) + '×' }),
        prefRange('flySpeed', 'Fly speed', { min: 0.5, max: 10, step: 0.1, fmt: v => (+v).toFixed(1) + ' m/s' }),
        prefSelect('snapStep', 'Snap step', [[0.1, '10 cm'], [0.25, '25 cm'], [0.5, '50 cm'], [1, '1 m']]),
        prefSelect('rotSnap', 'Turn snap', [[5, '5°'], [15, '15°'], [45, '45°'], [90, '90°']]),
        h('p', { class: 'note' }, 'Snapping applies while the Snap button is on. Shift while flying moves 3× faster.')),
      sec('Saving',
        prefCheck('autosave', 'Autosave (restores your last session)'),
        prefCheck('recentOn', 'Keep recent projects'),
        prefSelect('keepRecent', 'Recent projects to keep', PREF_LISTS.keepRecent.map(v => [v, String(v)])),
        h('div', { class: 'btns', style: 'margin-top:6px' },
          h('button', { onclick: () => { closeModal($('#mSettings')); confirmBox('Clear recent projects?', 'This removes the list of recent projects stored in this browser. Your current scene stays open.', async () => { const r = await clearRecents(); toast(r === null ? 'Recent projects are not available in this browser window.' : 'Recent projects cleared'); }, 'Clear'); } }, 'Clear recent projects'),
          h('button', { onclick: () => { closeModal($('#mSettings')); openModal('mHelp'); } }, 'Show quick start')))),
    h('div', { class: 'btns', style: 'margin-top:4px' }, h('button', { onclick: resetPrefs }, 'Reset all settings')));
}
function openSettings() { buildSettings(); openModal('mSettings'); $('#mSettings .dlg').scrollTop = 0; }

/* ============================== My sets ============================== */
/* localStorage 'shotref.library' = [{ id, name, items: [{ type, name, color, opts, base: { p, r, s } }] }], per browser.
   A set this version cannot read (a newer file, a damaged entry) is kept exactly as it is and simply not shown; text that is not
   JSON at all is moved to 'shotref.library.broken' before a new library is started. When the browser refuses to store (claude.ai
   window, private mode) the sets live for this visit only, and a plain note says so. */
const LIBRARY_KEY = 'shotref.library';
let libraryMem = null; /* the library for this visit when storage is blocked */
let libraryBad = null; /* unreadable library text found in storage (moved aside on the next save) */
function libraryEntries() {
  if (libraryMem) return libraryMem;
  let raw = null;
  try { raw = localStorage.getItem(LIBRARY_KEY); } catch (e) { return []; }
  if (!raw) return [];
  try { const a = JSON.parse(raw); if (Array.isArray(a)) { libraryBad = null; return a; } } catch (e) { }
  libraryBad = raw;
  return [];
}
const isNum3 = a => Array.isArray(a) && a.length === 3 && a.every(v => typeof v === 'number' && isFinite(v));
function usableSet(e) {
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string' && Array.isArray(e.items) && e.items.length > 0 &&
    e.items.every(i => !!i && typeof i === 'object' && typeof i.type === 'string' && CATALOG[i.type] && i.type !== 'image' && i.type !== 'model' && i.opts && typeof i.opts === 'object' && !Array.isArray(i.opts) && i.base && isNum3(i.base.p) && isNum3(i.base.r) && isNum3(i.base.s));
}
const librarySets = () => libraryEntries().filter(usableSet);
/* writes the whole library back; returns false when the browser would not store it */
function writeLibrary(list) {
  if (libraryBad !== null) {
    try { localStorage.setItem(LIBRARY_KEY + '.broken', libraryBad); libraryBad = null; } catch (e) { libraryMem = list; return false; }
  }
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(list)); libraryMem = null; return true; }
  catch (e) { libraryMem = list; return false; }
}
/* the part of a person or thing worth keeping in a set: its look and where it stands (not who it sits on, rides in or looks at) */
function setItemOf(o, tr, cx, cz) {
  const opts = clone(o.opts || {});
  delete opts.seated; delete opts.asset; if (opts.lookAt && opts.lookAt !== 'camera') delete opts.lookAt;
  if (opts.pose === 'sit' && o.opts.seated) opts.pose = 'stand';
  return { type: o.type, name: o.name, color: o.color, opts, base: { p: [r4(tr.p[0] - cx), r4(tr.p[1]), r4(tr.p[2] - cz)], r: tr.r.map(r4), s: tr.s.map(r4) } };
}
function saveSet(name, objs) {
  const keep = objs.filter(o => o.type !== 'image' && o.type !== 'model'), left = objs.length - keep.length;
  if (!keep.length) { toast('Nothing to save'); return false; }
  const trs = keep.map(o => evalObj(o, T)), cx = trs.reduce((a, t) => a + t.p[0], 0) / trs.length, cz = trs.reduce((a, t) => a + t.p[2], 0) / trs.length;
  const list = libraryEntries().slice();
  name = (name || '').trim().slice(0, 40) || 'Set ' + (librarySets().length + 1);
  list.push({ id: uid(), name, items: keep.map((o, i) => setItemOf(o, trs[i], cx, cz)) });
  const stored = writeLibrary(list);
  buildAddPanel(); propsDirty = true;
  const note = left ? ' (' + left + ' imported item' + (left > 1 ? 's' : '') + ' left out)' : '';
  if (stored) toast('Saved "' + name + '" to My sets' + note, 4000);
  else toast('Saved "' + name + '" for this visit only: this browser blocks storage here, so it will not be kept when the page is closed' + note, 6500);
  return true;
}
function deleteSet(set) {
  confirmBox('Delete the set "' + set.name + '"?', 'This only removes it from My sets. Scenes that use it are not changed.', () => {
    writeLibrary(libraryEntries().filter(e => e !== set && !(e && e.id === set.id)));
    buildAddPanel();
  }, 'Delete');
}
/* the new objects follow the pointer until it is clicked on the floor, then they are one undo step */
let placeRest = [], placeSetName = null;
function placeSet(set) {
  if (placing) commitPlacing();
  if (pathMode) cancelPath();
  const at = groundPointInView(), made = [], gid = set.items.length > 1 ? 'g' + uid() : null;
  if (gid) { state.groups = state.groups || {}; state.groups[gid] = { name: set.name }; }
  for (const it of set.items) {
    const o = makeObject(it.type, [at[0] + it.base.p[0], it.base.p[1], at[2] + it.base.p[2]]);
    o.color = typeof it.color === 'string' ? it.color : o.color; o.opts = clone(it.opts); o.base.r = it.base.r.slice(); o.base.s = it.base.s.slice();
    if (gid) o.grp = gid;
    if (it.type === 'mark') { o.opts.letter = nextMarkLetter(); o.name = 'Mark ' + o.opts.letter; }
    else o.name = nextName(String(it.name || catalogOf(it.type).label).replace(/\s+\d+$/, '') || catalogOf(it.type).label);
    state.objects.push(o); made.push(o);
  }
  syncScene(); selIds = made.map(o => o.id); selected = made[0].id; updateGizmo();
  changed(false, true);
  startPlacing(made[0].id);
  placeRest = made.slice(1).map(o => ({ id: o.id, dx: o.base.p[0] - made[0].base.p[0], dz: o.base.p[2] - made[0].base.p[2] })); placeSetName = set.name;
  showModeBar('Click on the floor where "' + set.name + '" goes', [['Cancel', cancelPlacing]]);
}
/* "Save as a reusable set": a name and a Save button. `getObjs` says what is saved (the selection, or the whole scene). */
function setSaveSection(getObjs, what) {
  const nm = h('input', { type: 'text', class: 'grow', placeholder: 'Name', maxlength: 40, 'aria-label': 'Name for the set' });
  const go = () => { if (saveSet(nm.value, getObjs())) nm.value = ''; };
  nm.addEventListener('keydown', e => { if (e.key !== 'Tab') e.stopPropagation(); if (e.key === 'Enter') go(); });
  const s = sec('Save as a reusable set', h('div', { class: 'row' }, nm, h('button', { onclick: go }, 'Save')),
    h('p', { class: 'note' }, 'Saves ' + what + '. Saved sets appear under "My sets" in the Add tab, ready to drop into any scene. Photos and models are left out.'));
  s.classList.add('setsave');
  return s;
}

/* ============================== Recent projects ============================== */
/* IndexedDB 'shotref', store 'projects' { id, name, updated, thumb (a small JPEG data: URL), data (the project file text) }, newest
   `keepRecent` of them. Where IndexedDB cannot be used (claude.ai window, private mode) the list is hidden with a plain note.
   Saving one never changes the scene. An entry this version cannot read stays in the list, with its own note, until you delete it. */
let recentSession = uid(); /* the id of a project that has no meta.id: renewed whenever a project is opened or started */
const recentId = () => (state.meta && state.meta.id) || recentSession;
function recentTx(mode, fn) { return idbTx(mode, fn, 'projects'); }
async function recentRows() {
  const rq = await recentTx('readonly', st => st.getAll());
  return rq && Array.isArray(rq.result) ? rq.result.filter(r => r && typeof r === 'object') : null;
}
const clearRecents = () => recentTx('readwrite', st => { st.clear(); return true; });
/* a small picture of the shot at the playhead (a data: URL: no blob: URLs on claude.ai) */
function recentThumb() {
  try {
    recentStats.thumbs++;
    const w = 240, hh = Math.max(2, Math.round(w / arOf(state.settings.aspect) / 2) * 2), r = getExportRenderer(w, hh);
    renderExportFrame(r, T, w, hh);
    const d = r.domElement.toDataURL('image/jpeg', 0.7);
    applyAll(T);
    return d;
  } catch (e) { console.error('ShotRef: could not make the picture for the recent list', e); return ''; }
}
/* The list is never written on the edit path. It is updated on Save, when a project is opened or replaced (the outgoing one),
   when the page is hidden or closed, and at most once every 3 minutes while there are unsaved edits (never while dragging,
   playing, recording or exporting). Nothing happens at all where IndexedDB is unavailable. */
let recentTimer = null, recentDirty = false;
const recentStats = { writes: 0, thumbs: 0 }; /* for the smoke test */
const RECENT_EVERY_MS = 180000, RECENT_MAX_TEXT = 40e6;
const recentOn = () => pref('recentOn') && idb.ok !== false;
const recentBusy = () => !!practicing || exporting || swapping || cmpBusy || dragActive || playing || !!rec || !!placing || !!pathMode || gizmo.dragging;
function markRecentDirty() {
  if (!recentOn() || practicing) return;
  recentDirty = true;
  if (!recentTimer) recentTimer = setTimeout(recentTick, RECENT_EVERY_MS);
}
function recentTick() { recentTimer = null; if (!recentDirty) return; if (recentBusy()) { recentTimer = setTimeout(recentTick, 5000); return; } saveRecentNow(); }
/* the outgoing / closing project: written only when it has edits the list does not have yet */
function recentFlush() { if (recentDirty && recentOn() && !recentBusy()) saveRecentNow(); }
/* writes this project into the list and keeps the newest `keepRecent`. The photo autosave is always written first. Resolves true when stored. */
async function saveRecentNow() {
  if (!recentOn() || practicing || exporting || swapping || cmpBusy) return false;
  clearTimeout(recentTimer); recentTimer = null; recentDirty = false;
  flushAutosave(); /* pending autosave first, and wait for its photo writes: recents must never crowd it out */
  const text = projectText();
  if (text.length > RECENT_MAX_TEXT) return false; /* too big for a list of copies */
  const row = { id: recentId(), name: (state.meta && state.meta.name) || 'Untitled scene', updated: Date.now(), thumb: recentThumb(), data: text };
  await idb.queue;
  recentStats.writes++;
  let ok = await recentPut(row);
  if (!ok && isQuota(idb.lastErr)) { await recentTrim(); ok = await recentPut(row); } /* out of space: drop the oldest copies, once */
  return !!ok;
}
/* put the row, then delete everything beyond the newest `keepRecent`, reading only keys (never the projects) */
const recentPut = row => recentTx('readwrite', st => {
  st.put(row);
  if (st.indexNames.contains('updated')) {
    const keep = pref('keepRecent'); let n = 0;
    const cur = st.index('updated').openKeyCursor(null, 'prev');
    cur.onsuccess = () => { const c = cur.result; if (!c) return; if (++n > keep) st.delete(c.primaryKey); c.continue(); };
  }
  return true;
});
/* quota: remove the older half of the list (at least one) */
const recentTrim = () => recentTx('readwrite', st => {
  if (!st.indexNames.contains('updated')) { st.clear(); return true; }
  const keys = []; const cur = st.index('updated').openKeyCursor(null, 'prev');
  cur.onsuccess = () => { const c = cur.result; if (c) { keys.push(c.primaryKey); c.continue(); return; } for (const k of keys.slice(Math.floor(keys.length / 2))) st.delete(k); };
  return true;
});
const agoText = t => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(t).toLocaleDateString(); };
async function openRecent() {
  if (practicing) return endPracticeFirst(openRecent);
  if (exporting) { toast('Wait for the export to finish.'); return; }
  $('#recentGrid').innerHTML = ''; $('#recNote').textContent = 'Loading…';
  openModal('mRecent');
  await renderRecent();
}
async function renderRecent() {
  const g = $('#recentGrid'), note = $('#recNote'), rows = await recentRows();
  g.innerHTML = '';
  if (rows === null) { note.textContent = 'Recent projects are not available in this browser window. Use Save, then "Open a file…", instead.'; return; }
  if (!rows.length) { note.textContent = 'No recent projects yet. Projects you work on appear here automatically.'; return; }
  note.textContent = 'Recent projects are saved automatically in this browser.';
  rows.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  for (const r of rows) {
    const cur = r.id === recentId(), readable = (() => { try { normalizeProject(JSON.parse(r.data), projectDefaults()); return true; } catch (e) { return false; } })();
    const del = h('button', { class: 'del', title: 'Remove from recent projects', 'aria-label': 'Remove ' + String(r.name || 'project') + ' from recent projects', onclick: async e => { e.stopPropagation(); await recentTx('readwrite', st => { st.delete(r.id); return true; }); renderRecent(); } }, '×');
    const card = h('div', { class: 'rcard' + (cur ? ' cur' : '') + (readable ? '' : ' bad'), role: 'button', tabindex: 0, 'data-id': String(r.id), onclick: () => openRecentRow(r, readable, cur) },
      typeof r.thumb === 'string' && /^data:image\//.test(r.thumb) ? h('img', { src: r.thumb, alt: '' }) : h('div', { class: 'noimg' }),
      h('b', null, String(r.name || 'Untitled scene')), h('small', null, !readable ? "Can't be opened here" : cur ? 'Open now' : typeof r.updated === 'number' ? agoText(r.updated) : ''), del);
    card.addEventListener('keydown', e => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); } });
    g.append(card);
  }
}
function openRecentRow(r, readable, cur) {
  if (!readable) { toast("This project can't be opened here (damaged, or made by a newer ShotRef). It stays in the list until you remove it.", 5000); return; }
  closeModal($('#mRecent'));
  if (cur) return;
  loadProjectText(r.data, undefined, false, platform.kind === 'desktop'); /* a copy kept inside the app has no file: on the desktop it counts as unsaved, so Save asks where to put it */
}
/* Open: the recent projects (web, claude.ai); the desktop app keeps its own native dialog (File > Recent projects shows the list) */
const openProjectUI = () => platform.kind === 'desktop' ? openDialog() : openRecent();

/* ============================== wiring ============================== */
function syncTopUI() {
  $('#inDur').value = state.settings.duration; $('#inFps').value = String(state.settings.fps);
  $$('#lenSet [data-len]').forEach(b => b.classList.toggle('on', +b.dataset.len === state.settings.duration));
  $$('#feelBar button').forEach(b => b.classList.toggle('on', b.dataset.feel === (state.camera.feel || 'gentle')));
  const pn = $('#projName'); if (document.activeElement !== pn) pn.value = (state.meta && state.meta.name) || '';
  $('#bTake').textContent = activeTakeName();
  $('#bLoop').classList.toggle('on', !!state.settings.loop);
  $('#bGrid').classList.toggle('on', !!state.settings.gridOn);
  $('#bPip').classList.toggle('on', pipOn);
  $('#bSnapGrid').classList.toggle('on', snapOn);
  drawGuides();
}
function wire() {
  wireTourDialogs(); wireTileDrag();
  buildAddPanel();
  setLeftTab(getPref('leftTab', 'add'), false);
  $$('#leftTabs button').forEach(b => b.onclick = () => setLeftTab(b.dataset.lt));
  $$('#stepSeg button').forEach(b => b.onclick = () => goStep(b.dataset.step));
  menuButton($('#bFile'), fileMenuItems); menuButton($('#bMenu'), gearMenuItems); wireTakes();
  $('#bTracks').onclick = () => { tracksMode = tracksOpen() ? 'closed' : 'open'; syncTracks(); uiDirty = true; requestRender(); };
  const pn = $('#projName');
  pn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') pn.blur(); else if (e.key === 'Escape') { pn.value = (state.meta && state.meta.name) || ''; pn.blur(); } });
  pn.addEventListener('change', () => {
    const v = pn.value.trim().slice(0, 80), old = (state.meta && state.meta.name) || '';
    if (v === old) { pn.value = old; return; }
    if (!state.meta) state.meta = { id: uid(), name: '' };
    state.meta.name = v; changed(true); pn.value = v;
  });
  $$('#lenSet [data-len]').forEach(b => b.onclick = () => setDuration(+b.dataset.len));
  $$('#feelBar button').forEach(b => b.onclick = () => { state.camera.feel = b.dataset.feel; changed(true, true); syncTopUI(); });
  $('#cbStart').onclick = () => setShotEnd('start'); $('#cbEnd').onclick = () => setShotEnd('end'); $('#cbRec').onclick = startRecord;
  $('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
  $$('#viewSeg button').forEach(b => b.onclick = () => setView(b.dataset.v));
  $('#stHelp').onclick = () => { closeModal($('#stHelp')); openModal('mHelp'); };
  $('#cbCopy').onclick = copyFrame; $('#exCopy').onclick = copyFrame;
  $('#copySave').onclick = () => { if (copyBlob) { const fr = Math.round(T * state.settings.fps) + 1; saveFile(outName('frame' + String(fr).padStart(4, '0'), state.settings.style) + '.png', copyBlob); } closeModal($('#copySave')); };
  $$('#vpRight [data-g]').forEach(b => b.onclick = () => setGizmoMode(b.dataset.g));
  $('#bSnapGrid').onclick = () => { snapOn = !snapOn; updateGizmo(); syncTopUI(); };
  $('#bFocus').onclick = focusSel;
  $('#bCamHere').onclick = camToEditorView;
  $('#bPip').onclick = () => { pipOn = !pipOn; syncTopUI(); };
  $('#bSplit').onclick = () => setLayout(layout === 'split' ? 'single' : 'split');
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
  $('#recFile').onclick = () => { closeModal($('#mRecent')); openDialog(); };
  $('#recNew').onclick = () => { closeModal($('#mRecent')); openStarters(); };
  $('#fOpen').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadProjectText(await readFile(f, 'text')); };
  $('#fModel').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importModel(f); };
  $('#fImage').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importImage(f); };
  $('#fPlate').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPlate(f); };
  $('#cbPlate').onclick = () => { if (plateAsset()) { select('camera'); toast('Location photo settings are in the Camera panel'); } else pickImport('#fPlate', importPlate, PLATE_FILTER); };
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
    if (practicing && hasFiles(e)) endPracticeFirst(() => {}); /* the file goes into the real scene, as it would with no tour */
    for (const f of e.dataTransfer.files) {
      if (/\.(glb|gltf)$/i.test(f.name)) await importModel(f);
      else if (/^image\//.test(f.type)) { if (view === 'camera' || (splitOn() && paneOf(e) === 'cam')) await importPlate(f); else await importImage(f); }
      else if (/\.(json|shotref)$/i.test(f.name)) loadProjectText(await readFile(f, 'text'), { name: f.name });
    }
  });
  // modals
  $$('[data-close]').forEach(b => b.onclick = () => closeModal(b));
  $$('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m && !exporting) { e.preventDefault(); closeModal(m); } })); /* preventDefault: the click must not move focus to the page (K3) */
  $('#cfOk').onclick = () => { closeModal($('#cfOk')); cfCb && cfCb(); };
  $('#cfAlt').onclick = () => { closeModal($('#cfAlt')); cfAltCb && cfAltCb(); };
  $('#exAspect').append(...ASPECTS.map(a => h('option', { value: a[0] }, a[2])));
  $('#exSize').append(...SIZES.map(s => h('option', { value: s[0] }, s[1])));
  $('#exAspect').onchange = e => { state.settings.aspect = e.target.value; changed(true, true); renderExportDialog(); };
  $('#exSize').onchange = e => { state.settings.size = +e.target.value; changed(true, true); renderExportDialog(); };
  $('#exGrid').onchange = e => { state.settings.exportGrid = e.target.checked; changed(true); };
  $('#exVideo').onclick = exportVideo;
  $('#exFrame').onclick = () => exportPNG(T);
  $('#exEnds').onclick = exportFramePack;
  $('#sheetSave').onclick = () => { if (sheetBlob) saveFile(nameFrom(['contact-sheet']) + '.png', sheetBlob); };
  $('#exCancel').onclick = () => { exCancel = true; };

  wireMenu();
  /* the Scene list has the same right-click menu as the 3D view */
  $('#outliner').addEventListener('contextmenu', e => {
    const r = e.target.closest('.ol'); if (!r || !r.dataset.id) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, ctxItems({ id: r.dataset.id }, null));
  });
  // viewport pointer handling: click to place, drag on the floor, turn ring, paths, picking
  let pdown = null, drag = null, hoverT = 0, rdown = null, box = null;
  /* what a drag moves or turns: every selected item that is not locked, with where it started */
  /* an item that rides on another selected item is carried along by it, so it is not moved a second time */
  const dragItems = () => { const sel = selObjs().filter(o => !o.locked), ids = new Set(sel.map(o => o.id)); return sel.filter(o => { for (let q = parentOf(o), n = 0; q && n < 30; q = parentOf(q), n++) if (ids.has(q.id)) return false; return true; }).map(o => ({ id: o.id, tr: clone(evalObj(o, T)) })); };
  canvas.addEventListener('pointerdown', e => {
    canvas.focus(); gizmoUsed = false;
    if (!drag && !box) setPane(paneOf(e)); /* the half that was pressed steers */
    pdown = { x: e.clientX, y: e.clientY, b: e.button };
    if (e.button === 2) rdown = { x: e.clientX, y: e.clientY };
    if (placing) { e.stopImmediatePropagation(); rdown = null; if (e.button === 0) { movePlacing(e); commitPlacing(); } else cancelPlacing(); pdown = null; return; }
    if (pathMode) {
      e.stopImmediatePropagation();
      const rc = rayFromEvent(e);
      if (e.button === 0 && rc) { const g = planeHit(rc, pathMode.y); if (g) addPathPoint(g); } else if (e.button === 2) removePathPoint();
      rdown = null;
      pdown = null; return;
    }
    if (focusPick && camPane()) { rdown = null; e.stopImmediatePropagation(); const rc = rayFromEvent(e); if (e.button === 0 && rc) finishFocusPick(rc); pdown = null; return; }
    if (rec || e.button !== 0 || camPane() || gizmo.axis) return;
    const rc = rayFromEvent(e); if (!rc) return;
    const hit = pickAt(rc);
    if (!hit) {
      /* Shift-drag on empty space draws a selection box (a plain drag still orbits the view) */
      if (e.shiftKey) { e.stopImmediatePropagation(); box = { x0: e.clientX, y0: e.clientY, x1: null, y1: null }; dragActive = true; pdown = null; try { canvas.setPointerCapture(e.pointerId); } catch (_) { } }
      return;
    }
    if (hit.id === 'cpath') return; /* the path line: a click selects the camera (on release); a press-drag still orbits */
    const ho = getObj(hit.id);
    /* Shift/Ctrl-click adds or removes one item; it never starts a drag */
    if (ho && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.stopImmediatePropagation(); select(hit.id, 'toggle'); pdown = null; return; }
    if (ho && e.altKey) select(hit.id, 'single'); /* Alt-click picks one item inside a group */
    /* a locked item can be selected but not dragged: the press goes on to orbit the view */
    if (ho && ho.locked) { if (selected !== hit.id && !selIds.includes(hit.id)) select(hit.id); return; }
    e.stopImmediatePropagation();
    if (playing) setPlaying(false);
    if (hit.id.startsWith('ck:')) {
      /* a camera path point: drag along the floor (Alt: up and down) */
      const k = state.camera.keys[+hit.id.slice(3)]; if (!k) return;
      select('camera'); setTime(k.t);
      const cur = camToWorld(k.p, k.t), g = planeHit(rc, cur[1]);
      drag = { kind: 'ck', id: 'camera', i: +hit.id.slice(3), cur, ox: g ? g.x - cur[0] : 0, oz: g ? g.z - cur[2] : 0, items: [] }; ckHot = drag.i;
    } else if (hit.id === 'sun') {
      select('sun'); sunDragging = true;
      drag = { kind: 'sun', id: 'sun', items: [] };
    } else if (hit.id === 'ring') {
      const o = getObj(selected), v = views.get(selected); if (!o || !v) return;
      const y = ringGrp.position.y, g = planeHit(rc, y) || hit.point;
      drag = { kind: 'rot', id: selected, multi: isMulti(), items: dragItems(), py: y, cx: ringGrp.position.x, cz: ringGrp.position.z, a0: Math.atan2(g.x - ringGrp.position.x, g.z - ringGrp.position.z), yaw0: v.group.rotation.y * R2D };
      let off = 0;
      for (const it of drag.items) { const q = getObj(it.id); if (q.opts.faceTravel && q.keys.length > 1) { q.opts.faceTravel = false; off++; } }
      if (off) toast('Turning by hand, so "face the way they travel" is now off');
    } else if (hit.id === 'lift') {
      /* the green arrow raises what floats: a vertical plane facing the camera through the item turns mouse height into metres */
      const o = getObj(selected); if (!o) return;
      const tr = evalObj(o, T), n = new THREE.Vector3(edCam.position.x - tr.p[0], 0, edCam.position.z - tr.p[2]).normalize(), pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3().fromArray(tr.p)), gp = new THREE.Vector3();
      rc.ray.intersectPlane(pl, gp);
      drag = { kind: 'lift', id: selected, plane: pl, y0: tr.p[1], gy: gp.y, items: dragItems() };
    } else {
      if (selected !== hit.id && !selIds.includes(hit.id)) select(hit.id);
      else if (ho && selected !== hit.id) { selected = hit.id; uiDirty = true; propsDirty = true; }
      const pos = hit.id === 'camera' ? camState.p : hit.id === 'target' ? camState.tg : evalObj(getObj(hit.id), T).p;
      const py = hit.point.y, g = planeHit(rc, py) || hit.point;
      drag = { kind: 'move', id: hit.id, py, ox: g.x - pos[0], oz: g.z - pos[2], items: ho ? dragItems() : [], alt: e.altKey };
      /* one grounded item dragged over the scene: it rests on whatever is under it (a cup on a table) */
      if (ho && drag.items.length === 1 && isGrounded(ho)) { const tr = evalObj(ho, T); drag.skip = rideIds(ho); drag.ground = true; drag.off = restOffset(views.get(ho.id), tr.r, tr.s); }
    }
    dragActive = true;
    drag.sx = e.clientX; drag.sy = e.clientY; drag.moved = false;
    gizmo.enabled = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { }
  }, { capture: true });
  canvas.addEventListener('pointermove', e => {
    if (!e.buttons && !drag && !box) setPane(paneOf(e)); /* hovering: the half under the pointer takes the wheel and the keys */
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
      drag.moved = true; canvas.style.cursor = 'grabbing';
      const rc = rayFromEvent(e); if (!rc) return;
      if (drag.kind === 'lift') {
        const u = new THREE.Vector3(); if (!rc.ray.intersectPlane(drag.plane, u)) return;
        let d = u.y - drag.gy; if (snapOn) d = Math.round(d / 0.05) * 0.05;
        for (const it of drag.items) { const q = getObj(it.id), cur = clone(it.tr); cur.p[1] = r4(Math.max(-20, it.tr.p[1] + d)); writeObj(q, cur, false); }
        const f = getObj(drag.id);
        showModeBar(drag.items.length > 1 ? 'Raised ' + (d >= 0 ? '+' : '') + d.toFixed(2) + ' m' : f.name + ': ' + (drag.y0 + d).toFixed(2) + ' m above the floor', []);
        return;
      }
      if (drag.kind === 'ck') {
        const k = state.camera.keys[drag.i]; if (!k) return;
        let d;
        if (e.altKey && view !== 'top') {
          /* Alt: up and down, on a vertical plane facing the viewer through the point */
          const n = new THREE.Vector3(edCam.position.x - drag.cur[0], 0, edCam.position.z - drag.cur[2]).normalize(), u = new THREE.Vector3();
          if (!rc.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3().fromArray(drag.cur)), u)) return;
          d = [drag.cur[0], r4(Math.max(0.1, u.y)), drag.cur[2]];
        } else {
          const g = planeHit(rc, drag.cur[1]); if (!g) return;
          d = [snapV(g.x - drag.ox), drag.cur[1], snapV(g.z - drag.oz)];
        }
        drag.cur = d; k.p = camToLocal(d, k.t).map(r4); quietChange(false);
        showModeBar('Camera point at ' + k.t.toFixed(2) + ' s · ' + d[1].toFixed(2) + ' m high' + (view !== 'top' ? ' · hold Alt to raise or lower' : ''), []);
        return;
      }
      if (drag.kind === 'sun') {
        const s = state.settings, c = sun.target.position, u = new THREE.Vector3();
        if (view !== 'top' && rc.ray.intersectSphere(new THREE.Sphere(c, sunDist), u)) { u.sub(c).normalize(); s.sunAz = (Math.atan2(u.x, u.z) * R2D % 360 + 360) % 360; s.sunEl = clamp(Math.asin(clamp(u.y, -1, 1)) * R2D, 2, 89); }
        else { const g = planeHit(rc, 0); if (g) s.sunAz = (Math.atan2(g.x - c.x, g.z - c.z) * R2D % 360 + 360) % 360; }
        s.sunAz = Math.round(s.sunAz) % 360; s.sunEl = Math.round(s.sunEl);
        quietChange(false);
        showModeBar('Sun: ' + s.sunAz + '° around, ' + s.sunEl + '° high · ' + sunWording(), []);
        return;
      }
      const g = planeHit(rc, drag.py); if (!g) return;
      if (drag.kind === 'rot') {
        /* released over another thing (or the camera), the whole set turns to face it; otherwise it follows the pointer */
        const skip = new Set(selIds), th = (() => { const q = pickAt(rc, true); return q && !skip.has(q.id) && (q.id === 'camera' || getObj(q.id)) ? q : null; })();
        const prim = clone(evalObj(getObj(drag.id), T));
        let yaw, face = null;
        if (th) { const tp = th.id === 'camera' ? camState.p : evalObj(getObj(th.id), T).p; face = { id: th.id, name: th.id === 'camera' ? 'the camera' : getObj(th.id).name }; yaw = Math.atan2(tp[0] - prim.p[0], tp[2] - prim.p[2]) * R2D; showModeBar('Release to face ' + face.name, []); }
        else {
          yaw = drag.yaw0 + (Math.atan2(g.x - drag.cx, g.z - drag.cz) - drag.a0) * R2D;
          if (snapOn) yaw = Math.round(yaw / pref('rotSnap')) * pref('rotSnap');
          if ($('#modeBar').textContent.startsWith('Release')) hideModeBar();
        }
        drag.face = face;
        const dy = yaw - drag.yaw0, ca = Math.cos(dy * D2R), sa = Math.sin(dy * D2R);
        for (const it of drag.items) {
          const o = getObj(it.id), cur = clone(it.tr);
          if (drag.multi) { const x = it.tr.p[0] - drag.cx, z = it.tr.p[2] - drag.cz; cur.p = [r4(drag.cx + x * ca + z * sa), it.tr.p[1], r4(drag.cz - x * sa + z * ca)]; cur.r[1] = it.tr.r[1] + dy; }
          else cur.r[1] = yaw;
          writeObj(o, cur, false);
        }
      } else {
        const nx = snapV(g.x - drag.ox), nz = snapV(g.z - drag.oz);
        if (drag.id === 'camera') writeCam({ p: [nx, camState.p[1], nz] }, false);
        else if (drag.id === 'target') writeCam({ tg: [nx, camState.tg[1], nz] }, false);
        else if (drag.items.length > 1) {
          const f = drag.items.find(it => it.id === drag.id) || drag.items[0], dx = nx - f.tr.p[0], dz = nz - f.tr.p[2];
          for (const it of drag.items) { const cur = clone(it.tr); cur.p = [r4(it.tr.p[0] + dx), it.tr.p[1], r4(it.tr.p[2] + dz)]; writeObj(getObj(it.id), cur, false); }
        } else {
          const o = getObj(drag.id), cur = clone(evalObj(o, T));
          /* a person dragged onto a seat snaps to it; letting go there sits them down */
          drag.seat = o.type === 'person' && getPref('autoSit', true) ? nearestSeat(nx, nz, o.id) : null;
          if (drag.seat) { showModeBar('Release to sit on ' + drag.seat.o.name, []); cur.p = [r4(drag.seat.w.x), cur.p[1], r4(drag.seat.w.z)]; }
          else {
            cur.p = [nx, cur.p[1], nz];
            const bar = $('#modeBar').textContent;
            if (drag.ground) {
              let yy;
              if (o.type === 'person') yy = surfaceUnder(nx, nz, 50, drag.skip, true);
              else {
                const hp = firstUpFace(rc.intersectObjects(restTargets(drag.skip), true)); /* the surface under the pointer: follow it */
                if (hp && hp.y < 2.6 && hp.y > 0.02) { yy = hp.y; cur.p = [snapV(hp.x - drag.ox), cur.p[1], snapV(hp.z - drag.oz)]; } else yy = surfaceUnder(nx, nz, 0.3, drag.skip, false);
              }
              cur.p[1] = r4(yy - drag.off);
              if (yy > 0.02) showModeBar('On top of something: ' + yy.toFixed(2) + ' m up', []); else if (bar.startsWith('On top')) hideModeBar();
            } else if (bar.startsWith('Release to sit')) hideModeBar();
          }
          writeObj(o, cur, false);
        }
      }
      return;
    }
    if (box) {
      const c = canvas.getBoundingClientRect(), b = $('#boxSel');
      Object.assign(b.style, { display: 'block', left: Math.min(box.x0, e.clientX) - c.left + 'px', top: Math.min(box.y0, e.clientY) - c.top + 'px', width: Math.abs(e.clientX - box.x0) + 'px', height: Math.abs(e.clientY - box.y0) + 'px' });
      box.x1 = e.clientX; box.y1 = e.clientY; return;
    }
    if (placing) { movePlacing(e); return; }
    if (pathMode) { const rc = rayFromEvent(e), g = rc && planeHit(rc, pathMode.y); pathMode.cursor = g ? [g.x, g.z] : null; return; }
    if (!e.buttons && !focusPick && !camPane() && performance.now() - hoverT > 50) {
      hoverT = performance.now();
      const rc = rayFromEvent(e), hit = rc && !gizmo.axis && pickAt(rc);
      canvas.style.cursor = hit ? (hit.id === 'ring' ? 'ew-resize' : hit.id === 'lift' ? 'ns-resize' : hit.id === 'sun' || hit.id.startsWith('ck:') ? 'move' : hit.id === 'cpath' ? 'pointer' : (getObj(hit.id) || {}).locked ? '' : 'grab') : '';
    }
  });
  /* a drag ends on mouse-up, or when the browser cuts it off (pointercancel, lost capture): either way it is saved (K2) */
  const endDrag = e => {
    const d = drag; drag = null; dragActive = false; syncControls(); canvas.style.cursor = ''; sunDragging = false; ckHot = -1;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { }
    if (/^(Release|On top|Raised|Camera point at|Sun:)|above the floor$/.test($('#modeBar').textContent)) hideModeBar();
    /* a click that did not drag narrows the selection to what was clicked (its group, or just it with Alt) */
    if (!d.moved && d.kind === 'move' && getObj(d.id)) select(d.id, d.alt ? 'single' : undefined);
    if (d.moved && d.kind === 'move' && getObj(d.id) && getObj(d.id).type === 'person' && d.items.length <= 1) {
      const o = getObj(d.id);
      if (d.seat) { sitPerson(o, d.seat); pdown = null; return; } /* dropped on a seat */
      if (isSeated(o)) { standPerson(o); pdown = null; return; } /* dragged away from the seat */
    }
    if (d.moved) {
      changed(true, true);
      if (d.face) toast((d.items.length > 1 ? d.items.length + ' items now face ' : (getObj(d.id) || {}).name + ' now faces ') + d.face.name);
    }
    pdown = null;
  };
  /* Shift-drag box: select everything whose middle falls inside (added to what is already selected) */
  const endBox = e => {
    const b = box; box = null; dragActive = false; $('#boxSel').style.display = 'none';
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { }
    if (!b || b.x1 == null || Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < 5) return;
    const c = canvas.getBoundingClientRect(), cam = view === 'top' ? topCam : edCam, bb = new THREE.Box3(), pt = new THREE.Vector3();
    cam.updateMatrixWorld();
    const xa = Math.min(b.x0, b.x1), xb = Math.max(b.x0, b.x1), ya = Math.min(b.y0, b.y1), yb = Math.max(b.y0, b.y1), found = [];
    for (const o of state.objects) {
      const v = views.get(o.id); if (!v || !v.group.visible) continue;
      bb.setFromObject(v.group); if (bb.isEmpty()) continue;
      bb.getCenter(pt).project(cam);
      const sx = c.left + (pt.x * 0.5 + 0.5) * c.width, sy = c.top + (-pt.y * 0.5 + 0.5) * c.height;
      if (pt.z < 1 && sx >= xa && sx <= xb && sy >= ya && sy <= yb) found.push(o.id);
    }
    if (!found.length) return;
    const set = new Set(selIds); for (const id of found) for (const m of groupMembers(id)) set.add(m);
    selIds = [...set]; selected = found[found.length - 1];
    updateGizmo(); uiDirty = true; propsDirty = true; pathRev = -1; toast(selIds.length + (selIds.length === 1 ? ' item selected' : ' items selected'));
  };
  const cutOff = e => {
    if (drag) endDrag(e);
    if (box) endBox(e);
    pdown = null;
    /* the move/rotate/scale arrows only listen for pointerup */
    if (gizmo.dragging) { canvas.removeEventListener('pointermove', gizmo._onPointerMove); gizmo.pointerUp(null); }
  };
  canvas.addEventListener('pointercancel', cutOff);
  canvas.addEventListener('lostpointercapture', e => { if (drag) endDrag(e); else if (box) endBox(e); });
  canvas.addEventListener('pointerup', e => {
    if (drag) { endDrag(e); return; }
    if (box) { endBox(e); return; }
    if (!pdown || pdown.b !== 0) { pdown = null; return; }
    const moved = Math.hypot(e.clientX - pdown.x, e.clientY - pdown.y) > 4; pdown = null;
    if (moved || gizmoUsed || gizmo.dragging || rec) return;
    const rc = rayFromEvent(e); if (!rc) return;
    const hit = pickAt(rc);
    if (!hit) { if (!e.shiftKey) select(null); }
    else if (hit.id === 'cpath') { if (selected !== 'camera') select('camera'); }
    else if (hit.id !== 'ring' && hit.id !== 'lift' && (getObj(hit.id) || selected !== hit.id)) select(hit.id, e.altKey && getObj(hit.id) ? 'single' : undefined);
  });
  canvas.addEventListener('dblclick', e => {
    setPane(paneOf(e));
    if (pathMode) { finishPath(); return; }
    if (placing || rec || focusPick) return;
    const rc = rayFromEvent(e); if (!rc) return;
    const hit = pickAt(rc), o = hit && getObj(hit.id);
    if (o && o.type !== 'mark') focusLensAt(hit.point.clone(), o.name); /* F still zooms the view to the selection */
  });
  /* right-click opens the page's own menu (never the native one); a right-drag is a pan and opens nothing */
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault(); if (!dragActive) setPane(paneOf(e));
    const d = rdown; rdown = null;
    if (!d || placing || pathMode || focusPick || rec) return; /* no press of ours (or it cancelled placing, a path, a pick): no menu */
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const rc = rayFromEvent(e); if (!rc) return;
    let hit = pickAt(rc);
    if (hit && (hit.id === 'ring' || hit.id === 'lift')) hit = selected ? { id: selected, point: hit.point } : null;
    let g = hit ? null : planeHit(rc, 0);
    if (g && Math.hypot(g.x, g.z) > 200) g = null;
    showMenu(e.clientX, e.clientY, ctxItems(hit, g));
  });
  canvas.addEventListener('wheel', e => {
    if (!dragActive) setPane(paneOf(e)); /* the wheel goes to the half the pointer is over */
    if (camPane() && (e.altKey || e.ctrlKey)) {
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
      else if (k === 'o') { e.preventDefault(); openProjectUI(); }
      else if (k === 'd') { e.preventDefault(); duplicateSel(); }
      else if (k === 'a') { e.preventDefault(); selectAll(); }
      else if (k === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSel(); else groupSel(); }
      else if (k === 'l') { e.preventDefault(); const l = targetObjs(); if (l.length) lockObjs(l, !l.every(o => o.locked)); }
      else if (k === 'c' && !e.shiftKey && !(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyFrame(); }
      return;
    }
    if (camPane() && 'wasdqe'.includes(k) && k.length === 1) { flyKeys.add(k); if (e.shiftKey) flyKeys.add('shift'); e.preventDefault(); return; }
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
    else if ((k === '1' || k === '2' || k === '3') && !e.altKey && !e.shiftKey) goStep(['build', 'frame', 'export'][+k - 1]);
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
  let restored = false, broken = false, raw = null, wasDirty = false;
  probeStorage();
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (e) { }
  if (raw) {
    try { const d = normalizeProject(JSON.parse(raw), projectDefaults()); state = d.state; assets = { ...d.assets }; restored = true;
      const rec = JSON.parse(raw); /* an autosave without the field (older build) counts as unsaved if it holds anything */
      wasDirty = typeof rec.dirty === 'boolean' ? rec.dirty : !!(state.objects.length || state.plate); }
    catch (e) { broken = true; console.error('ShotRef: could not read the autosave', e); }
  }
  let embedded = false;
  if (!restored && EMBED && EMBED.project) {
    try { const d = normalizeProject(typeof EMBED.project === 'string' ? JSON.parse(EMBED.project) : EMBED.project, projectDefaults()); state = d.state; assets = { ...d.assets }; embedded = true; }
    catch (e) { console.error('ShotRef: could not read the embedded project', e); state = defaultState(); assets = {}; }
  }
  if (!restored && !embedded) seedScene();
  wire();
  try { syncScene(); applyEnv(); }
  catch (e) {
    if (!restored) throw e;
    console.error('ShotRef: could not rebuild the autosaved scene', e);
    restored = false; embedded = false; broken = true; wasDirty = false;
    state = defaultState(); assets = {}; for (const id of [...modelCache.keys()]) dropModel(id); seedScene();
    syncScene(); applyEnv();
  }
  /* move (not copy) the broken autosave aside: a big one would not fit twice */
  if (broken) {
    try { localStorage.removeItem(AUTOSAVE_KEY); localStorage.setItem(AUTOSAVE_KEY + '.broken', raw); }
    catch (e) { console.error('ShotRef: could not keep a copy of the broken autosave', e); }
  }
  cleanTakes(); migrateAll(); pushHistory(); platform.setDirty(wasDirty); setSimple(simple);
  /* only now: queued menu / file events from the desktop shell must see the restored scene and its unsaved mark */
  wireAbout();
  platform.onMenu(onDesktopMenu);
  platform.onOpenFile(f => { if (f && typeof f.text === 'string') { launchFile = true; tourAsk = false; closeModal($('#mTour')); closeModal($('#mStart')); loadProjectText(f.text, f, true); } });
 applyPrefs(); setView('editor'); setGizmoMode('translate');
  requestAnimationFrame(frame);
  let seen = false; try { seen = localStorage.getItem('shotref.seenHelp'); localStorage.setItem('shotref.seenHelp', '1'); } catch (e) { }
  if (autosaveOff) toast(NO_AUTOSAVE, 6000); /* starter sets still open below on a first visit */
  if (broken) toast("Your last session couldn't be restored, so ShotRef started a fresh scene.", 5000);
  else if (embedded) { if (EMBED.message) toast(EMBED.message, 7000); }
  else if (!restored && !seen) setTimeout(() => { if (!openModals().length && !launchFile) { tourAsk = true; openModal('mTour'); } }, 400);
  /* photos and models come from IndexedDB (async); legacy autosaves carry them inline */
  if (broken) idb.noPrune = true; /* the broken autosave's files may live only in IndexedDB */
  /* while a broken autosave is kept aside, never prune the files it lists (C4) */
  try { for (const id of brokenAssetIds(localStorage.getItem(AUTOSAVE_KEY + '.broken'))) idb.keep.add(id); } catch (e) { }
  const want = restored ? [...usedAssetIds(state)].filter(id => !assets[id]) : [];
  if (restored && !want.length) toast('Restored your last session');
  idbLoad(want).then(got => {
    const n = Object.keys(got).length;
    if (n) {
      /* a hands-on tour may be running: the files belong to the real scene it set aside, not to the practice stage */
      if (practicing) practicing.assets = { ...practicing.assets, ...got };
      else {
        assets = { ...assets, ...got };
        try { syncScene(); } catch (e) { console.error('ShotRef: could not rebuild the restored photos and models', e); }
        editRev++; uiDirty = true; propsDirty = true; requestRender();
      }
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
  window.addEventListener('pagehide', () => { flushAutosave(); recentFlush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') recentFlush(); });
  window.__shotref = { practice: { enter: () => enterPractice(), enterEarly: () => enterPractice(true), leave: leavePractice, active: () => !!practicing }, practicing: () => !!practicing, stateForSave, docInfo: () => ({ dirty: platform.isDirty(), name: platform.currentName(), path: platform.currentPath(), doc: platform.getDoc() }), tour: { run: runStops, active: tourActive, end: r => tourHandle && tourHandle.end(r), current: () => tourHandle }, startTour, setHandsTour, handsTourOn, setSimple, promptText, ensureDof, get selection() { return selIds; }, layout: () => layout, gizmoNdc: (x, y) => { const q = gizmo._getPointer({ clientX: x, clientY: y, button: 0 }); return { x: q.x, y: q.y }; }, arrowsVisible: () => [...arrows.values()].some(a => a.visible), videoBitrate, snapValue: snapWith, rotSnapDeg: () => pref('rotSnap'), controlSpeeds: () => ({ orbit: edControls.rotateSpeed, zoom: edControls.zoomSpeed, cam: camControls.rotateSpeed }), flySpeedNow, walkSpeedNow: () => pathSpeedOf({ type: 'person', opts: { pose: 'stand' } }), buildAddPanel: () => buildAddPanel(), saveRecentNow, recentFlush, recentStats, recentBusy, selectMany: ids => { selIds = ids.slice(); selected = selIds[selIds.length - 1] || null; updateGizmo(); uiDirty = true; propsDirty = true; requestRender(); }, pickAtScreen: (x, y) => { const rc = rayFromEvent({ clientX: x, clientY: y }); const h = rc && pickAt(rc); return h ? h.id : null; }, settleTime: () => { const t0 = performance.now(); solveGround(); return performance.now() - t0; }, groundMigrate: () => groundMigrate.size, liftKnob: () => { if (!liftGrp.visible) return null; const q = liftPick.getWorldPosition(new THREE.Vector3()); return window.__shotref.project(q.x, q.y, q.z); }, attachTo, setMount, writeCam, shownObj: (id, t) => shownObj(getObj(id), t), viewOf: id => { const v = views.get(id); if (!v) return null; v.group.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(v.group), sz = bb.getSize(new THREE.Vector3()); return { p: v.group.position.toArray(), yaw: v.group.rotation.y * R2D, s: v.group.scale.toArray(), size: sz.toArray(), wheels: v.wheels ? v.wheels.list.map(w => ({ spin: w.spin.rotation.x, steer: w.piv.rotation.y, front: w.front })) : null }; }, ringKnob: () => ringGrp.visible ? ringKnob.getWorldPosition(new THREE.Vector3()).toArray() : null, getPref, setPref, showMenu, menuButton, hideMenu, project: (x, y, z) => { const r = canvas.getBoundingClientRect(), R = viewRects(r.width, r.height); let cam = view === 'top' ? topCam : edCam, rr = R.work || { x: 0, y: 0, w: r.width, h: r.height }; if (camPane() && R.frame) { cam = renderCam; rr = R.frame; } const v = new THREE.Vector3(x, y, z).project(cam); return [r.left + rr.x + (v.x * 0.5 + 0.5) * rr.w, r.top + rr.y + (-v.y * 0.5 + 0.5) * rr.h]; }, get view() { return view; }, get placing() { return placing; }, get playing() { return playing; }, get step() { return currentStep(); }, get selected() { return selected; }, get state() { return state; }, get assets() { return assets; }, setT: t => setTime(t, false), applyMove, addObject, select, setView, evalCam, exportVideo, exportPNG, pickCodec, _exportCanvas: () => exRenderer ? exRenderer.domElement : null, changed, writeObj, evalObj, setKey, get T() { return T; },
    get rebuilds() { return rebuilds; }, urlCacheIds: () => [...urlCache.keys()],
    /* batch H (takes) hooks for the smoke test */
    switchTake, newTake, snapPoolSize: () => snapLive, snapPruned: () => snapPruned,
    normalize: raw => normalizeProject(raw, projectDefaults()), describeChange, lights: () => ({ sun: sun.intensity, amb: hemi.intensity, radius: sun.shadow.radius }), pickEnv, setClouds: patch => { state.settings.clouds = cleanClouds({ ...state.settings.clouds, ...patch }); applyEnv(); changed(true, true); },
    sky: () => ({ visible: skyDome.mesh.visible, cover: skyDome.uniforms.uCover.value, time: skyDome.time }),
    get history() { return { at: hi, length: hist.length, bytes: hist[hi].length }; },
    /* batch F (camera UX and light) hooks for the smoke test */
    editCamPos: () => edCam.position.toArray(), detectMove, describeShot, camToWorld, pointsVisible: () => ckPts.some(m => m.visible),
    sunInfo: () => ({ castShadow: sun.castShadow, radius: sun.shadow.radius, intensity: sun.intensity, color: '#' + sun.color.getHexString(), gizmo: { visible: sunGrp.visible, pos: sunGrp.position.toArray() } }),
    shotPixels: (t, w = 240) => { const hh = Math.max(2, Math.round(w / arOf(state.settings.aspect))), r = getExportRenderer(w, hh); renderExportFrame(r, t, w, hh); const c = document.createElement('canvas'); c.width = w; c.height = hh; const g = c.getContext('2d'); g.drawImage(r.domElement, 0, 0); const d = g.getImageData(0, 0, w, hh).data; applyAll(T); return d; },
    /* batch D (people) hooks for the smoke test */
    addPerson, sitPerson, standPerson, setLookAt, setPoseAt, nearestSeat, freeSeat, actLayer, poseAt, applyAll: t => applyAll(t),
    rig: id => { const v = views.get(id), P = v && v.person; if (!P) return null; const r = j => [j.rotation.x, j.rotation.y, j.rotation.z]; return { H: P.H, neck: r(P.neck), spine: r(P.spine), head: r(P.head), lSh: r(P.lSh), rSh: r(P.rSh), lEl: r(P.lEl), rEl: r(P.rEl), lHip: r(P.lHip), rHip: r(P.rHip), lKnee: r(P.lKnee), rKnee: r(P.rKnee), shoulderX: P.lSh.position.x, hipX: P.lHip.position.x, headScale: P.head.scale.x, headParts: P.head.children.length, pelvisY: P.pelvis.position.y, group: { p: v.group.position.toArray(), yaw: v.group.rotation.y } }; },
    soles: id => { const v = views.get(id); if (!v || !v.person) return null; v.group.updateMatrixWorld(true); return v.person.soles.map(s => s.getWorldPosition(new THREE.Vector3()).toArray()); },
    renderStats: () => ({ shadows: renderer.shadowMap.enabled, pixelRatio: renderer.getPixelRatio(), split: splitOn(), frame: renderer.info.render.frame, calls: renderer.info.render.calls, draws: drawCount, lastDraw, lastAsync, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }) };
}
boot();
