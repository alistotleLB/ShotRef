/* Tour engine: a dimmed screen with viewfinder corners around one target and a small bubble beside it.
 * Pure DOM, no app state. main.js owns the stop lists and the guards (export, open dialogs).
 *
 * stop: { id, target: string | () => Element | null | null, title, text, before?: () => void,
 *         waitFor?: (snap) => boolean, snap?: () => any, done?: string, interactive?: boolean }
 *   target   a CSS selector, a function returning an element, or null for a centred bubble.
 *   before   set-up run when the stop begins (also after Back).
 *   snap     taken when the stop begins; waitFor(snap) must report a change since then (hands-on stops).
 *   done     the confirmation word shown with the tick once waitFor passes; the tour moves on 700 ms later.
 *   interactive: false  makes a stop of an interactive tour block clicks like a basic one.
 * ui: { next, back, end, finish, skip, progress(n, total) }, the labels (src/tour-copy.js).
 * onEnd(reason): 'finish' | 'end' | 'esc' | 'external'.
 * canKey(e): true when an app key must reach the app (Esc while there is something to cancel).
 * tourTick() runs from main.js frame() while a tour is active: it re-measures and evaluates waitFor. */

const PAD = 6;       /* gap between the target and the corners */
const GAP = 12;      /* gap between the corners and the bubble */
const MARGIN = 12;   /* clearance from the window edge */
const NARROW = 900;  /* below this width the bubble pins to the bottom */
const DONE_MS = 700; /* how long the tick shows before a hands-on stop moves on */
const MISSING_MS = 400; /* a target that is still missing after this shows as a centred bubble, with a warning */

let cur = null;

function el(tag, cls, attrs, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

const tourActive = () => !!cur;

function runTour({ stops, ui, interactive = false, onEnd = null, canKey = null }) {
  if (cur) cur.end('external');
  const prevFocus = document.activeElement;
  const root = el('div', null, { id: 'tour' });
  const dim = el('div', 'tour-dim');
  const corners = el('div', 'tour-corners');
  for (const c of ['tl', 'tr', 'bl', 'br']) corners.appendChild(el('i', 'tc ' + c));
  const hits = ['t', 'b', 'l', 'r', 'c'].map(k => el('div', 'tour-hit ' + k));
  const bubble = el('div', 'tour-bubble', { role: 'dialog', 'aria-labelledby': 'tourTitle', 'aria-live': 'polite', tabindex: '-1' });
  const title = el('div', 'tour-title', { id: 'tourTitle' });
  const body = el('div', 'tour-text');
  const prog = el('div', 'tour-prog');
  const path = el('div', 'tour-path');
  const dot = el('i', 'tour-dot');
  const ptS = el('i', 'tour-pt s'), ptE = el('i', 'tour-pt e');
  path.append(ptS, ptE, dot);
  const count = el('span', 'tour-count');
  prog.append(path, count);
  const tick = el('div', 'tour-done'); tick.hidden = true;
  const back = el('button', 'tour-btn quiet', { id: 'tourBack', type: 'button' }, ui.back);
  const end = el('button', 'tour-btn quiet', { id: 'tourEnd', type: 'button' }, ui.end);
  const next = el('button', 'tour-btn main', { id: 'tourNext', type: 'button' });
  const acts = el('div', 'tour-acts');
  acts.append(back, end, el('span', 'tour-sp'), next);
  bubble.append(title, body, prog, tick, acts);
  root.append(dim, corners, ...hits, bubble);
  document.body.appendChild(root);

  let i = -1, snap = null, done = false, doneTimer = 0, stopAt = 0, warned = false, lastKey = '', hadRect = false, ended = false;
  const stopOf = () => stops[i];
  const stopInteractive = () => !!interactive && stopOf().interactive !== false;

  function resolve(s) {
    let t = null;
    try { t = typeof s.target === 'function' ? s.target() : s.target ? document.querySelector(s.target) : null; } catch (e) { t = null; }
    if (!t || !t.getClientRects || !t.getClientRects().length) return null;
    const r = t.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  /* where the corners go: the target plus a margin, kept inside the window */
  function cutRect(r) {
    const vw = window.innerWidth, vh = window.innerHeight;
    return { left: Math.max(0, r.left - PAD), top: Math.max(0, r.top - PAD), right: Math.min(vw, r.right + PAD), bottom: Math.min(vh, r.bottom + PAD) };
  }

  function place(c) {
    const vw = window.innerWidth, vh = window.innerHeight, narrow = vw < NARROW;
    bubble.style.width = narrow ? (vw - 16) + 'px' : '';
    bubble.style.maxWidth = narrow ? 'none' : '';
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    let x, y;
    const pinned = () => { x = narrow ? 8 : (vw - w) / 2; y = vh - (narrow ? 8 : MARGIN) - h; };
    if (!c) { x = (vw - w) / 2; y = (vh - h) / 2; }
    else if (narrow) pinned();
    else {
      const cx = (c.left + c.right) / 2, cy = (c.top + c.bottom) / 2;
      const clampX = v => Math.min(Math.max(v, MARGIN), vw - MARGIN - w);
      const clampY = v => Math.min(Math.max(v, MARGIN), vh - MARGIN - h);
      const tries = [
        () => c.right + GAP + w <= vw - MARGIN && [c.right + GAP, clampY(cy - h / 2)],
        () => c.bottom + GAP + h <= vh - MARGIN && [clampX(cx - w / 2), c.bottom + GAP],
        () => c.left - GAP - w >= MARGIN && [c.left - GAP - w, clampY(cy - h / 2)],
        () => c.top - GAP - h >= MARGIN && [clampX(cx - w / 2), c.top - GAP - h],
      ];
      let hit = null;
      for (const f of tries) { hit = f(); if (hit) break; }
      if (hit) [x, y] = hit; else pinned();
    }
    bubble.style.left = Math.round(x) + 'px'; bubble.style.top = Math.round(y) + 'px';
  }

  function measure(force) {
    if (ended || i < 0) return;
    const s = stopOf(), r = resolve(s);
    let missing = false;
    if (!r && s.target) {
      missing = true;
      if (!warned && performance.now() - stopAt > MISSING_MS) { warned = true; console.warn('tour: target not visible for stop "' + (s.id || i) + '", showing a centred bubble'); }
    }
    const c = r ? cutRect(r) : null;
    const key = (c ? [c.left, c.top, c.right, c.bottom].join() : 'none') + '|' + window.innerWidth + 'x' + window.innerHeight + '|' + stopInteractive() + '|' + (missing ? 'm' : '');
    if (!force && key === lastKey) return;
    lastKey = key;
    const vw = window.innerWidth, vh = window.innerHeight;
    const b = c || { left: vw / 2, top: vh / 2, right: vw / 2, bottom: vh / 2 };
    /* the first rectangle after a centred bubble appears in place instead of flying in from the middle */
    const snapTo = !!c && !hadRect;
    if (snapTo) root.classList.add('nt');
    for (const e of [dim, corners]) {
      e.style.left = b.left + 'px'; e.style.top = b.top + 'px'; e.style.width = (b.right - b.left) + 'px'; e.style.height = (b.bottom - b.top) + 'px';
    }
    corners.classList.toggle('off', !c);
    if (snapTo) { void corners.offsetWidth; root.classList.remove('nt'); }
    hadRect = !!c;
    const [ht, hb, hl, hr, hc] = hits;
    const set = (e, l, t, w, h2) => { e.style.left = l + 'px'; e.style.top = t + 'px'; e.style.width = Math.max(0, w) + 'px'; e.style.height = Math.max(0, h2) + 'px'; };
    set(ht, 0, 0, vw, b.top); set(hb, 0, b.bottom, vw, vh - b.bottom);
    set(hl, 0, b.top, b.left, b.bottom - b.top); set(hr, b.right, b.top, vw - b.right, b.bottom - b.top);
    set(hc, b.left, b.top, b.right - b.left, b.bottom - b.top);
    hc.style.display = stopInteractive() ? 'none' : '';
    place(c);
  }

  function show(n) {
    clearTimeout(doneTimer); doneTimer = 0;
    i = n; done = false; warned = false; stopAt = performance.now(); lastKey = '';
    const s = stopOf();
    try { if (s.before) s.before(); } catch (e) { console.error('tour: before() failed for stop "' + (s.id || i) + '"', e); }
    try { snap = s.snap ? s.snap() : null; } catch (e) { snap = null; }
    title.textContent = s.title || ''; body.textContent = s.text || '';
    count.textContent = ui.progress(i + 1, stops.length);
    dot.style.left = 'calc(3px + (100% - 6px) * ' + (stops.length > 1 ? i / (stops.length - 1) : 0) + ')';
    tick.hidden = true;
    back.disabled = i === 0;
    labels();
    measure(true);
    bubble.focus({ preventScroll: true });
  }

  function labels() {
    const last = i === stops.length - 1, wait = stopInteractive() && !!stopOf().waitFor && !done;
    next.textContent = wait ? ui.skip : last ? ui.finish : ui.next;
  }

  function go(n) { if (n >= 0 && n < stops.length) show(n); }
  function nextStop() { if (i >= stops.length - 1) finish('finish'); else go(i + 1); }
  function backStop() { go(i - 1); }

  function finish(reason) {
    if (ended) return;
    ended = true; clearTimeout(doneTimer);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    root.remove();
    if (cur === handle) cur = null;
    if (prevFocus && prevFocus !== document.body && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { } }
    if (onEnd) onEnd(reason);
  }

  function tickOnce() {
    if (ended) return;
    measure(false);
    const s = stopOf();
    if (!done && stopInteractive() && s.waitFor) {
      let yes = false;
      try { yes = !!s.waitFor(snap); } catch (e) { yes = false; }
      if (yes) {
        done = true; labels();
        tick.hidden = false; tick.textContent = '';
        tick.append(el('i', 'tour-tick'), el('span', null, null, s.done || ''));
        doneTimer = setTimeout(nextStop, DONE_MS);
      }
    }
  }

  function onResize() { measure(true); }

  /* capture phase: this runs before the app's own shortcut handler */
  function onKey(e) {
    const inBubble = bubble.contains(e.target), k = e.key;
    if (k === 'Escape') {
      if (canKey && canKey(e)) return;
      e.preventDefault(); e.stopPropagation(); finish('esc'); return;
    }
    if (k === 'Tab') {
      /* keep Tab inside the bubble */
      const f = [...bubble.querySelectorAll('button:not(:disabled)')]; if (!f.length) return;
      e.preventDefault(); e.stopPropagation();
      const j = f.indexOf(document.activeElement);
      f[(j + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      return;
    }
    const onButton = inBubble && e.target.tagName === 'BUTTON';
    if (interactive && !inBubble && (e.target.closest && e.target.closest('input, textarea, select'))) return; /* typing in the app */
    const free = interactive && !inBubble; /* hands-on: the app keeps its shortcuts; arrows and Enter are only ours inside the bubble */
    if (onButton && (k === 'Enter' || k === ' ')) { e.stopPropagation(); return; } /* the button's own click runs */
    if (!free || inBubble) {
      if (k === 'Enter' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); nextStop(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); backStop(); return; }
    } else if (k === 'Enter' && (document.activeElement === document.body || document.activeElement === bubble)) {
      e.preventDefault(); e.stopPropagation(); nextStop(); return;
    }
    if (!interactive) e.stopPropagation(); /* basic tour: no app shortcuts at all */
  }

  next.onclick = nextStop; back.onclick = backStop; end.onclick = () => finish('end');
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);

  const handle = {
    end: (reason = 'end') => finish(reason), next: nextStop, back: backStop,
    get index() { return i; }, get stop() { return stops[i]; },
    tick: tickOnce,
  };
  cur = handle;
  show(0);
  return handle;
}

function tourTick() { if (cur) cur.tick(); }

export { runTour, tourActive, tourTick };
