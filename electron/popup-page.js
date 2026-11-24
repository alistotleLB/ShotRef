/* Fills popup.html from the options popup.cjs sent, then reports its height and the chosen button. Text only, never HTML. */
(function () {
  const api = window.shotrefPopup;
  const o = api && api.opts;
  if (!o) { if (api) api.answer(-1); return; }
  const $ = id => document.getElementById(id);
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };

  document.title = o.title;
  $('box').className = o.type;
  if (o.type === 'error' || o.type === 'warning') $('msg').appendChild(el('i'));
  $('msg').appendChild(document.createTextNode(o.message));
  $('detail').textContent = o.detail;
  for (const n of o.notes) {
    const s = el('section'); s.appendChild(el('h2', 'ShotRef ' + n.version));
    const ul = el('ul'); for (const t of n.items) ul.appendChild(el('li', t));
    s.appendChild(ul); $('notes').appendChild(s);
  }

  let answered = false;
  const answer = n => { if (answered) return; answered = true; api.answer(n); };
  /* the main button sits on the right, like the page's own dialogs; the others keep their order to its left */
  const order = o.buttons.map((b, i) => i).filter(i => i !== o.defaultId).concat(o.defaultId);
  let main = null;
  for (const i of order) {
    const b = el('button', o.buttons[i]); b.type = 'button'; b.dataset.i = i;
    if (i === o.defaultId) { b.className = 'primary'; main = b; }
    b.addEventListener('click', () => answer(i));
    $('btns').appendChild(b);
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); answer(o.cancelId); }
    if (e.key === 'Tab' || e.key.startsWith('Arrow')) document.body.classList.add('kb');
    /* Enter presses the focused button (the main one unless the user tabbed away) */
  });
  if (main) main.focus();
  requestAnimationFrame(() => api.ready(Math.ceil(document.getElementById('box').getBoundingClientRect().height)));
})();
