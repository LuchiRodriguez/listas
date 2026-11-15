// Listas — súper y tareas compartidas, en vivo. JS vanilla, sin build.
// Secciones: constantes · estado · utilidades · datos · realtime · hojas · componentes · pantallas · arranque.

/* ============================== Constantes ============================== */

const CFG = window.LISTAS_CONFIG || {};
const SB = window.supabase;
const ITEM_COLS = 'id,list,text,done,done_at,bucket,assignee,created_by,created_at';
const MEMBER_COLS = 'user_id,name,color';
const BUCKETS = [['hoy', 'Hoy'], ['semana', 'Semana'], ['algun_dia', 'Algún día']];
const BUCKET_TITLES = { hoy: 'Hoy', semana: 'Esta semana', algun_dia: 'Algún día' };
const MAX_TEXT = 120;
const DAY = 24 * 60 * 60 * 1000;

/* ================================ Estado ================================ */

const state = {
  client: null,
  session: null,
  members: [],
  items: [],
  phase: 'boot',        // boot | config | auth | waiting | ready
  route: 'home',        // home | super | tareas
  rt: 'CLOSED',         // estado del canal realtime
  channel: null,
  filter: 'all',        // all | mine | other
  doneOpen: false,
  pendingWrites: 0,
  writeSeq: 0,          // sube al empezar y al terminar cada escritura
  loading: false,
  dirty: false,         // llegó un pedido de refetch mientras había uno en vuelo
  loaded: false,        // ya hubo una primera carga correcta de items
  loadFailed: false,
  subscribing: false,
};
const FETCH_TIMEOUT = 15000;
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), FETCH_TIMEOUT))]);
const inflight = new Set(); // ids con un tilde en vuelo

const me = () => state.members.find((m) => m.user_id === state.session?.user.id) || null;
const other = () => state.members.find((m) => m.user_id !== state.session?.user.id) || null;
const memberById = (id) => state.members.find((m) => m.user_id === id) || null;
const itemsOf = (list) => state.items.filter((i) => i.list === list);

/* ============================== Utilidades ============================== */

/** Crea un elemento. Los textos siempre como nodos de texto, nunca HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'disabled' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

function toast(msg) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: 'toast' }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function cleanText(s) {
  const t = String(s ?? '').trim();
  return t.length >= 1 && t.length <= MAX_TEXT ? t : null;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

const byCreated = (a, b) => new Date(a.created_at) - new Date(b.created_at);
const byDoneAt = (a, b) => new Date(a.done_at || a.created_at) - new Date(b.done_at || b.created_at);

function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

function friendlyAuthError(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Email o contraseña incorrectos.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'Ese email ya tiene cuenta. Probá con "Entrar".';
  if (m.includes('at least') || m.includes('weak')) return 'La contraseña tiene que tener al menos 8 caracteres.';
  if (m.includes('email not confirmed')) return 'Falta confirmar el email. Revisá tu bandeja de entrada.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Demasiados intentos. Esperá un rato y probá de nuevo.';
  if (m.includes('valid email') || m.includes('invalid email')) return 'Ese email no parece válido.';
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) return 'Los registros están cerrados.';
  if (m.includes('fetch') || m.includes('network')) return 'Sin conexión. Probá de nuevo en un rato.';
  if (m.includes('different from the old')) return 'Tiene que ser distinta de la anterior.';
  if (m.includes('session') && m.includes('missing')) return 'El link venció. Pedí otro desde "Olvidé mi contraseña".';
  return 'No se pudo completar. Probá de nuevo.';
}

/* ============================ Datos (Supabase) ========================== */

async function loadMembers() {
  const { data, error } = await withTimeout(state.client.from('members').select(MEMBER_COLS));
  if (error) throw error;
  state.members = data || [];
}

async function loadItems() {
  if (state.phase !== 'ready') return;
  if (state.loading) { state.dirty = true; return; }
  state.loading = true;
  const uid = state.session?.user.id;
  const seq = state.writeSeq;
  try {
    const [ir, mr] = await withTimeout(Promise.all([
      state.client.from('items').select(ITEM_COLS).order('created_at', { ascending: true }).limit(1000),
      state.client.from('members').select(MEMBER_COLS),
    ]));
    if (ir.error) throw ir.error;
    if (state.phase !== 'ready' || state.session?.user.id !== uid) return; // cambió la sesión mientras tanto
    const wasLoaded = state.loaded, hadFailed = state.loadFailed;
    let changed = false;
    if (!mr.error && mr.data && mr.data.length && JSON.stringify(mr.data) !== JSON.stringify(state.members)) {
      state.members = mr.data; changed = true; // el otro pudo haber sido habilitado después
    }
    if (state.pendingWrites > 0 || seq !== state.writeSeq) {
      state.dirty = true; // hubo escrituras durante el fetch: la respuesta puede ser vieja; repetir
    } else {
      const next = ir.data || [];
      if (JSON.stringify(next) !== JSON.stringify(state.items)) { state.items = next; changed = true; }
      state.loaded = true; state.loadFailed = false;
    }
    if (changed || wasLoaded !== state.loaded || hadFailed !== state.loadFailed) render();
  } catch (e) {
    console.warn('loadItems', e?.message);
    if (!state.loaded && !state.loadFailed) { state.loadFailed = true; render(); }
  } finally {
    state.loading = false;
    if (state.dirty) { state.dirty = false; refetch(); }
  }
}
const refetch = debounce(loadItems, 150);

/** Ejecuta una escritura contando las que están en vuelo; al terminar, siempre refresca. */
async function write(fn) {
  state.pendingWrites++; state.writeSeq++;
  try { return await fn(); } finally { state.pendingWrites--; state.writeSeq++; refetch(); }
}

async function insertItem(payload) {
  // Solo columnas permitidas: list, text, bucket, assignee.
  const row = { list: payload.list, text: payload.text };
  if (payload.list === 'tareas') {
    row.bucket = payload.bucket;
    row.assignee = payload.assignee ?? null;
  }
  const { data, error } = await write(() => state.client.from('items').insert(row).select(ITEM_COLS).single());
  if (error) throw error;
  if (!state.items.some((i) => i.id === data.id)) state.items.push(data);
  render();
  return data;
}

async function toggleItem(item) {
  const id = item.id;
  if (inflight.has(id)) return; // un toque a la vez por ítem
  const cur = state.items.find((i) => i.id === id);
  if (!cur) return;
  inflight.add(id);
  const prev = { done: cur.done, done_at: cur.done_at };
  const next = !cur.done;
  cur.done = next;
  cur.done_at = next ? new Date().toISOString() : null;
  render();
  let failed = false;
  try {
    // Solo columna permitida: done. select('id') para detectar que la fila ya no existe.
    const { data, error } = await write(() => state.client.from('items').update({ done: next }).eq('id', id).select('id'));
    failed = !!error || !data || data.length === 0;
  } catch (e) { failed = true; }
  inflight.delete(id);
  if (failed) {
    const now = state.items.find((i) => i.id === id);
    if (now) { now.done = prev.done; now.done_at = prev.done_at; }
    render();
    toast('No se pudo guardar, probá de nuevo');
  }
}

async function updateItem(item, changes) {
  // Solo columnas permitidas: text, bucket, assignee (y done en toggleItem).
  const row = {};
  if ('text' in changes) row.text = changes.text;
  if ('bucket' in changes) row.bucket = changes.bucket;
  if ('assignee' in changes) row.assignee = changes.assignee;
  const { data, error } = await write(() => state.client.from('items').update(row).eq('id', item.id).select(ITEM_COLS));
  if (error) throw error;
  if (!data || !data.length) throw new Error('missing');
  const cur = state.items.find((i) => i.id === item.id);
  if (cur) Object.assign(cur, data[0]);
  render();
}

async function deleteItem(item) {
  const { error } = await write(() => state.client.from('items').delete().eq('id', item.id));
  if (error) throw error;
  state.items = state.items.filter((i) => i.id !== item.id);
  render();
}

async function deleteDone(list) {
  const { error } = await write(() => state.client.from('items').delete().eq('list', list).eq('done', true));
  if (error) throw error;
  state.items = state.items.filter((i) => !(i.list === list && i.done));
  render();
}

/* ============================== Tiempo real ============================= */

let chSeq = 0;

async function dropChannel() {
  const old = state.channel;
  state.channel = null;
  if (old) { try { await state.client.removeChannel(old); } catch (e) { console.warn('removeChannel', e?.message); } }
}

async function subscribe() {
  if (state.subscribing) return;
  state.subscribing = true;
  try {
    await dropChannel();
    if (state.phase !== 'ready') return;
    state.rt = 'CONNECTING';
    // Topic único por intento: channel() devuelve el canal viejo si el topic ya existe.
    const ch = state.client
      .channel('items-' + (++chSeq))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => refetch())
      .subscribe((status) => {
        if (ch !== state.channel) return; // estado de un canal ya descartado
        state.rt = status;
        if (status === 'SUBSCRIBED') refetch();
        render();
      });
    state.channel = ch;
  } catch (e) {
    console.warn('subscribe', e?.message);
    state.rt = 'CLOSED';
  } finally {
    state.subscribing = false;
  }
}

function unsubscribe() {
  state.rt = 'CLOSED';
  dropChannel();
}

function resync() {
  if (state.phase === 'error') { enterSession(); return; }
  if (state.phase !== 'ready') return;
  if (state.rt !== 'SUBSCRIBED' && state.rt !== 'CONNECTING') subscribe();
  loadItems();
}

/* ================================ Hojas ================================= */

let sheetEl = null;
let sheetReturnFocus = null;
let sheetCleanup = null;

function closeSheet() {
  if (!sheetEl) return;
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
  sheetEl.remove();
  sheetEl = null;
  document.getElementById('app').inert = false;
  document.body.style.overflow = '';
  if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

/** Abre una hoja inferior. build({close, focus}) devuelve el cuerpo; focus(el) marca qué enfocar. */
function openSheet(title, build) {
  closeSheet();
  sheetReturnFocus = document.activeElement;
  let focusEl = null;
  const body = build({ close: closeSheet, focus: (el) => { focusEl = el; } });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('h2', null, title),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Cerrar', onclick: closeSheet }, '✕')),
    body);
  sheetEl = h('div', { class: 'overlay', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } }, sheet);
  document.body.appendChild(sheetEl);
  document.body.style.overflow = 'hidden';
  document.getElementById('app').inert = true; // el foco queda dentro de la hoja
  // El teclado móvil no cambia 100dvh: ajustar la hoja al viewport visual.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => { sheetEl.style.top = `${vv.offsetTop}px`; sheetEl.style.height = `${vv.height}px`; };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    sheetCleanup = () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
  }
  (focusEl || sheet.querySelector('input,button.btn')).focus();
}

function segmented(options, value, onPick, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const paint = () => wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value())));
  options.forEach(([v, text]) => wrap.appendChild(h('button', { type: 'button', 'data-v': v, onclick: () => { onPick(v); paint(); } }, text)));
  paint();
  return wrap;
}

function whoOptions() {
  const o = other();
  const opts = [['me', 'Yo']];
  if (o) opts.push(['other', o.name]);
  opts.push(['both', 'Los dos']);
  return opts;
}
const whoToAssignee = (w) => (w === 'me' ? me().user_id : w === 'other' && other() ? other().user_id : null);
function assigneeToWho(id) {
  if (!id) return 'both';
  return id === me()?.user_id ? 'me' : 'other';
}

function openAddSheet(defaultList) {
  const f = { list: defaultList, bucket: 'hoy', who: 'both', busy: false };
  openSheet('Agregar', ({ focus }) => {
    const input = h('input', { class: 'input', type: 'text', maxlength: MAX_TEXT, placeholder: 'Qué falta o qué hay que hacer', 'aria-label': 'Texto', enterkeyhint: 'done', autocomplete: 'off' });
    const added = h('div', { class: 'added', 'aria-live': 'polite' });
    const taskOpts = h('div', { class: 'stack' },
      h('div', null, h('div', { class: 'label' }, '¿Cuándo?'), segmented(BUCKETS, () => f.bucket, (v) => { f.bucket = v; }, 'Cuándo')),
      h('div', null, h('div', { class: 'label' }, '¿Quién?'), segmented(whoOptions(), () => f.who, (v) => { f.who = v; }, 'Quién')));
    taskOpts.hidden = f.list !== 'tareas';
    const btn = h('button', { class: 'btn primary block', type: 'button' }, 'Agregar');
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // que el input no pierda el foco (teclado abierto)
    let hideTimer = null;
    const submit = async () => {
      if (f.busy) return;
      const text = cleanText(input.value);
      if (!text) { input.focus(); return; }
      f.busy = true;
      try {
        await insertItem({ list: f.list, text, bucket: f.bucket, assignee: whoToAssignee(f.who) });
        input.value = '';
        added.textContent = 'Agregado ✓';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { added.textContent = ''; }, 1800);
      } catch (e) {
        console.warn('insert', e?.message);
        toast('No se pudo guardar, probá de nuevo');
      } finally {
        f.busy = false; input.focus();
      }
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    focus(input);
    return h('div', { class: 'stack' },
      input,
      segmented([['super', '🛒 Súper'], ['tareas', '✓ Tarea']], () => f.list, (v) => { f.list = v; taskOpts.hidden = v !== 'tareas'; }, 'Lista'),
      taskOpts, added, btn);
  });
}

function openEditSheet(item) {
  const isTask = item.list === 'tareas';
  const f = { bucket: item.bucket || 'hoy', who: assigneeToWho(item.assignee), busy: false, confirming: false };
  openSheet('Editar', ({ close, focus }) => {
    const input = h('input', { class: 'input', type: 'text', maxlength: MAX_TEXT, value: item.text, 'aria-label': 'Texto', autocomplete: 'off' });
    const save = h('button', { class: 'btn primary block', type: 'button' }, 'Guardar');
    const delArea = h('div', { class: 'confirm' });
    const paintDel = () => {
      delArea.replaceChildren();
      if (!f.confirming) {
        delArea.appendChild(h('button', { class: 'btn danger block', type: 'button', onclick: () => { f.confirming = true; paintDel(); } }, 'Borrar'));
      } else {
        delArea.appendChild(h('p', null, '¿Seguro?'));
        delArea.appendChild(h('div', { class: 'row' },
          h('button', { class: 'btn danger', type: 'button', onclick: doDelete }, 'Sí, borrar'),
          h('button', { class: 'btn', type: 'button', onclick: () => { f.confirming = false; paintDel(); } }, 'No')));
      }
    };
    async function doDelete() {
      if (f.busy) return;
      f.busy = true;
      try { await deleteItem(item); close(); } catch (e) { console.warn('del', e?.message); toast('No se pudo borrar, probá de nuevo'); f.busy = false; }
    }
    save.addEventListener('click', async () => {
      if (f.busy) return;
      const text = cleanText(input.value);
      if (!text) { input.focus(); return; }
      f.busy = true; save.disabled = true;
      try {
        const changes = { text };
        if (isTask) { changes.bucket = f.bucket; changes.assignee = whoToAssignee(f.who); }
        await updateItem(item, changes);
        close();
      } catch (e) {
        console.warn('upd', e?.message);
        const gone = e?.message === 'missing';
        toast(gone ? 'Esto ya no existe' : 'No se pudo guardar, probá de nuevo');
        if (gone) { close(); refetch(); }
        f.busy = false; save.disabled = false;
      }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
    paintDel();
    focus(input);
    return h('div', { class: 'stack' },
      input,
      isTask && h('div', null, h('div', { class: 'label' }, '¿Cuándo?'), segmented(BUCKETS, () => f.bucket, (v) => { f.bucket = v; }, 'Cuándo')),
      isTask && h('div', null, h('div', { class: 'label' }, '¿Quién?'), segmented(whoOptions(), () => f.who, (v) => { f.who = v; }, 'Quién')),
      save, delArea);
  });
}

/** Confirmación propia (sin window.confirm). */
function openConfirm(title, message, okLabel, onOk) {
  openSheet(title, ({ close, focus }) => {
    const ok = h('button', { class: 'btn danger', type: 'button' }, okLabel);
    const no = h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancelar');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try { await onOk(); close(); } catch (e) { console.warn('confirm', e?.message); toast('No se pudo borrar, probá de nuevo'); ok.disabled = false; }
    });
    focus(no);
    return h('div', { class: 'confirm' }, h('p', null, message), h('div', { class: 'row' }, ok, no));
  });
}

/* ============================== Componentes ============================= */

const HEX = /^#[0-9a-fA-F]{6}$/;
const colorOf = (m) => (m && HEX.test(m.color) ? m.color : '#e6e0d2');
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum < 140 ? '#ffffff' : '#2b2b2b';
}

function avatarOf(memberId) {
  const m = memberById(memberId);
  const name = m ? m.name : 'Alguien';
  const el = h('span', { class: 'avatar', role: 'img', 'aria-label': name }, (name[0] || '?').toUpperCase());
  el.style.background = colorOf(m);
  el.style.color = inkFor(colorOf(m));
  return el;
}

function avatarPair() {
  const a = me(), b = other();
  if (!b) return avatarOf(a?.user_id); // un solo miembro: "los dos" es uno
  const label = `${a?.name || 'Yo'} y ${b.name}`;
  const mk = (m) => {
    const s = h('span', null, (m?.name?.[0] || '?').toUpperCase());
    s.style.background = colorOf(m);
    s.style.color = inkFor(colorOf(m));
    return s;
  };
  return h('span', { class: 'avatar pair', role: 'img', 'aria-label': label }, mk(a), mk(b));
}

const assigneeAvatar = (item) => (item.assignee ? avatarOf(item.assignee) : avatarPair());

function checkBox(item) {
  return h('button', {
    class: 'check hit', type: 'button', role: 'checkbox', 'aria-checked': String(item.done), 'aria-label': item.text,
    onclick: (e) => { e.stopPropagation(); toggleItem(item); },
  });
}

/** Input rápido del súper: un único nodo que sobrevive a los repintados (no cierra el teclado). */
const quickUI = (() => {
  const input = h('input', { class: 'input', type: 'text', maxlength: MAX_TEXT, placeholder: '+ agregar…', 'aria-label': 'Agregar al súper', enterkeyhint: 'done', autocomplete: 'off' });
  const btn = h('button', { class: 'btn primary', type: 'button', 'aria-label': 'Agregar' }, '+');
  let busy = false;
  const add = async () => {
    if (busy) return;
    const text = cleanText(input.value);
    if (!text) { input.focus(); return; }
    busy = true;
    try {
      await insertItem({ list: 'super', text });
      input.value = '';
    } catch (e) {
      console.warn('quick', e?.message);
      toast('No se pudo guardar, probá de nuevo');
    } finally { busy = false; }
  };
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return { row: h('div', { class: 'quick' }, input, btn), input };
})();
let keepQuick = false; // durante un repintado parcial, viewSuper deja un hueco en vez del input

/* ============================== Pantallas =============================== */

function viewAuth() {
  const err = h('div', { class: 'form-error', role: 'alert' });
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'tu@email.com', 'aria-label': 'Email', inputmode: 'email', autocapitalize: 'none' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Contraseña (mín. 8)', 'aria-label': 'Contraseña' });
  const enter = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  const create = h('button', { class: 'btn', type: 'button' }, 'Crear cuenta');
  const busy = (b) => { enter.disabled = b; create.disabled = b; };
  const check = () => {
    const e = email.value.trim(), p = pass.value;
    if (!e) { err.textContent = 'Poné tu email.'; email.focus(); return null; }
    if (!p) { err.textContent = 'Poné tu contraseña.'; pass.focus(); return null; }
    err.textContent = '';
    return { e, p };
  };
  const forgot = h('button', { class: 'btn ghost block', type: 'button' }, 'Olvidé mi contraseña');
  const form = h('form', { class: 'card', novalidate: true },
    h('div', { class: 'field' }, h('label', null, 'Email', email)),
    h('div', { class: 'field' }, h('label', null, 'Contraseña', pass)),
    err,
    h('div', { class: 'row' }, enter, create),
    forgot);
  forgot.addEventListener('click', async () => {
    const e = email.value.trim();
    if (!e) { err.textContent = 'Poné tu email y tocá de nuevo "Olvidé mi contraseña".'; email.focus(); return; }
    forgot.disabled = true;
    err.style.color = '';
    const { error } = await state.client.auth.resetPasswordForEmail(e, { redirectTo: location.origin + location.pathname });
    if (error) {
      err.textContent = friendlyAuthError(error);
      forgot.disabled = false;
      return;
    }
    err.style.color = 'inherit';
    err.textContent = 'Si ese email tiene cuenta, te llegó un mail con un link. Abrilo desde este teléfono para elegir una contraseña nueva. Puede tardar un minuto; mirá también en spam.';
    setTimeout(() => { forgot.disabled = false; }, 60000); // un pedido por minuto
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = check(); if (!v) return;
    pass.autocomplete = 'current-password';
    busy(true);
    const { error } = await state.client.auth.signInWithPassword({ email: v.e, password: v.p });
    if (error) { err.textContent = friendlyAuthError(error); busy(false); }
  });
  create.addEventListener('click', async () => {
    const v = check(); if (!v) return;
    if (v.p.length < 8) { err.textContent = 'La contraseña tiene que tener al menos 8 caracteres.'; pass.focus(); return; }
    pass.autocomplete = 'new-password';
    busy(true);
    const { data, error } = await state.client.auth.signUp({ email: v.e, password: v.p });
    if (error) { err.textContent = friendlyAuthError(error); busy(false); return; }
    if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      err.textContent = friendlyAuthError({ message: 'User already registered' }); busy(false); return;
    }
    if (!data?.session) { err.textContent = 'Listo. Revisá tu email para confirmar la cuenta y después entrá.'; busy(false); }
  });
  return h('div', { class: 'center-screen' }, h('h1', null, 'Listas'), form);
}

function viewRecovery() {
  const err = h('div', { class: 'form-error', role: 'alert' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Mínimo 8 caracteres', 'aria-label': 'Contraseña nueva' });
  const pass2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repetila', 'aria-label': 'Repetir contraseña' });
  const save = h('button', { class: 'btn primary block', type: 'submit' }, 'Guardar contraseña');
  const form = h('form', { class: 'card', novalidate: true },
    h('p', null, 'Elegí tu contraseña nueva.'),
    h('div', { class: 'field' }, h('label', null, 'Contraseña nueva', pass)),
    h('div', { class: 'field' }, h('label', null, 'Repetila', pass2)),
    err,
    save);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pass.value.length < 8) { err.textContent = 'La contraseña tiene que tener al menos 8 caracteres.'; pass.focus(); return; }
    if (pass.value !== pass2.value) { err.textContent = 'Las dos no coinciden.'; pass2.focus(); return; }
    save.disabled = true;
    const { error } = await state.client.auth.updateUser({ password: pass.value });
    if (error) { err.textContent = friendlyAuthError(error); save.disabled = false; return; }
    state.recovering = false;
    if (/access_token|type=recovery/.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search); // sacar el token de la barra
      parseRoute();
    }
    toast('Listo, contraseña cambiada');
    enterSession();
  });
  setTimeout(() => pass.focus(), 0);
  return h('div', { class: 'center-screen' }, h('h1', null, 'Listas'), form);
}

function viewConfig() {
  return h('div', { class: 'center-screen' }, h('h1', null, 'Listas'),
    h('div', { class: 'card' }, h('p', null, 'Falta configurar la app. Completá config.js con la URL y la clave de Supabase.')));
}

function viewWaiting() {
  const check = h('button', { class: 'btn primary block', type: 'button' }, 'Ya me habilitaron');
  check.addEventListener('click', async () => {
    check.disabled = true;
    await enterSession();
    if (state.phase === 'waiting') { toast('Todavía no te habilitaron'); }
  });
  return h('div', { class: 'center-screen' }, h('h1', null, 'Listas'),
    h('div', { class: 'card' },
      h('p', null, 'Ya tenés cuenta. Falta que te habiliten.'),
      check,
      h('button', { class: 'btn ghost block', type: 'button', onclick: signOut }, 'Salir')));
}

function viewError() {
  const retry = h('button', { class: 'btn primary block', type: 'button' }, 'Reintentar');
  retry.addEventListener('click', () => { retry.disabled = true; enterSession(); });
  return h('div', { class: 'center-screen' }, h('h1', null, 'Listas'),
    h('div', { class: 'card' },
      h('p', null, 'No se pudo cargar. Revisá tu conexión.'),
      retry,
      h('button', { class: 'btn ghost block', type: 'button', onclick: signOut }, 'Salir')));
}

function viewLoading() {
  if (!state.loadFailed) return h('p', { class: 'boot' }, 'Cargando…');
  const retry = h('button', { class: 'btn primary block', type: 'button', onclick: () => { state.loadFailed = false; render(); loadItems(); } }, 'Reintentar');
  return h('div', { class: 'center-screen' }, h('div', { class: 'card' }, h('p', null, 'No se pudo cargar. Revisá tu conexión.'), retry));
}

function liveLine() {
  const o = other();
  const on = state.rt === 'SUBSCRIBED';
  let text;
  if (!on) text = 'reconectando…';
  else {
    const last = o && state.items
      .filter((i) => i.created_by === o.user_id && Date.now() - new Date(i.created_at) < DAY)
      .sort(byCreated).pop();
    text = last ? `en vivo · ${o.name} agregó "${last.text}" ${timeAgo(last.created_at)}` : `en vivo con ${o?.name || 'el otro'}`;
  }
  return h('div', { class: `live${on ? '' : ' off'}` },
    h('span', { class: 'dot', 'aria-hidden': 'true' }, on ? '●' : '○'),
    h('span', { class: 'live-text' }, text));
}

function viewHome() {
  const sup = itemsOf('super').filter((i) => !i.done).sort(byCreated);
  const tareas = itemsOf('tareas').filter((i) => !i.done).sort(byCreated);
  const hoy = tareas.filter((i) => i.bucket === 'hoy');
  const nSem = tareas.filter((i) => i.bucket === 'semana').length;
  const nAlg = tareas.filter((i) => i.bucket === 'algun_dia').length;
  const preview = sup.slice(0, 4).map((i) => i.text).join(', ') + (sup.length > 4 ? '…' : '');

  const superCard = h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '🛒 Súper'),
    sup.length
      ? [h('div', { class: 'big' }, String(sup.length)), h('div', { class: 'preview' }, preview)]
      : h('div', { class: 'empty' }, 'No falta nada 🎉'),
    h('button', { class: 'btn primary block', type: 'button', onclick: () => { location.hash = '#/super'; } }, 'Estoy en el súper →'));

  const tasksCard = h('section', { class: 'card tap', onclick: () => { location.hash = '#/tareas'; } },
    h('div', { class: 'card-title' }, '✓ Tareas'),
    h('div', { class: 'big' }, String(hoy.length)),
    h('div', { class: 'muted' }, 'para hoy'),
    hoy.length > 0 && h('ul', { class: 'today-list' }, hoy.map((i) =>
      h('li', { class: 'row-item' }, checkBox(i), h('span', { class: 'txt' }, i.text), assigneeAvatar(i)))),
    h('div', { class: 'foot' }, `+${nSem} esta semana · +${nAlg} algún día`),
    h('a', { class: 'more-link', href: '#/tareas' }, 'Ver tareas →'));

  return h('div', { class: 'stack' },
    h('header', null,
      h('div', { class: 'topbar' },
        h('h1', { class: 'hello' }, `Hola, ${me()?.name || ''} 👋`),
        h('button', { class: 'btn ghost', type: 'button', onclick: signOut }, 'Salir')),
      liveLine()),
    superCard, tasksCard);
}

function viewSuper() {
  const all = itemsOf('super');
  const pending = all.filter((i) => !i.done).sort(byCreated);
  const done = all.filter((i) => i.done).sort(byDoneAt);
  const total = all.length;

  const row = (i) => h('li', { class: `big-row${i.done ? ' done' : ''}`, onclick: () => toggleItem(i) },
    checkBox(i), h('span', { class: 'txt' }, i.text), avatarOf(i.created_by),
    h('button', { class: 'more', type: 'button', 'aria-label': `Editar ${i.text}`, onclick: (e) => { e.stopPropagation(); openEditSheet(i); } }, '⋯'));

  const finish = h('button', {
    class: 'btn primary', type: 'button', disabled: done.length === 0,
    onclick: () => openConfirm('Terminé la compra', `¿Sacar de la lista las ${done.length} cosas tildadas?`, 'Sí, sacarlas', () => deleteDone('super')),
  }, 'Terminé la compra ✓');

  const bar = h('i');
  bar.style.width = total ? `${(done.length / total) * 100}%` : '0';

  return h('div', { 'data-view': 'super' },
    h('div', { class: 'topbar' }, h('button', { class: 'back', type: 'button', 'aria-label': 'Volver', onclick: goHome }, '←'), h('h1', null, 'En el súper 🛒')),
    h('div', { class: 'count' }, `${done.length} de ${total}`),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progreso de la compra', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done.length }, bar),
    keepQuick ? h('div', { class: 'quick-slot' }) : quickUI.row,
    total ? h('ul', { class: 'list' }, pending.map(row), done.map(row)) : h('p', { class: 'nothing' }, 'No falta nada 🎉'),
    h('div', { class: 'finish' }, finish));
}

function viewTareas() {
  const o = other(), mine = me();
  const all = itemsOf('tareas');
  const pass = (i) => state.filter === 'all'
    || (state.filter === 'mine' && (!i.assignee || i.assignee === mine?.user_id))
    || (state.filter === 'other' && (!i.assignee || i.assignee === o?.user_id));
  const pending = all.filter((i) => !i.done && pass(i)).sort(byCreated);
  const done = all.filter((i) => i.done).sort((a, b) => byDoneAt(b, a));

  const chip = (v, text) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.filter === v), onclick: () => { state.filter = v; render(); } }, text);
  const row = (i) => h('li', { class: `row-item${i.done ? ' done' : ''}` },
    checkBox(i), h('span', { class: 'txt' }, i.text), assigneeAvatar(i),
    h('button', { class: 'more', type: 'button', 'aria-label': `Editar ${i.text}`, onclick: () => openEditSheet(i) }, '⋯'));

  const groups = BUCKETS.map(([k]) => {
    const rows = pending.filter((i) => i.bucket === k);
    return rows.length > 0 && h('section', { class: 'group' },
      h('h2', null, BUCKET_TITLES[k]),
      h('div', { class: 'card' }, h('ul', { class: 'list' }, rows.map(row))));
  });

  const doneSec = done.length > 0 && h('section', { class: 'group' },
    h('div', { class: 'row' },
      h('button', { class: 'fold', type: 'button', 'aria-expanded': String(state.doneOpen), onclick: () => { state.doneOpen = !state.doneOpen; render(); } },
        `${state.doneOpen ? '▾' : '▸'} ✓ Hechas (${done.length})`),
      state.doneOpen && h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => openConfirm('Borrar hechas', `¿Borrar las ${done.length} tareas hechas?`, 'Sí, borrar', () => deleteDone('tareas')),
      }, 'Borrar hechas')),
    state.doneOpen && h('div', { class: 'card' }, h('ul', { class: 'list' }, done.map(row))));

  return h('div', null,
    h('div', { class: 'topbar' }, h('button', { class: 'back', type: 'button', 'aria-label': 'Volver', onclick: goHome }, '←'), h('h1', null, 'Tareas ✓')),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtro' }, chip('all', 'Todas'), chip('mine', 'Mías'), o && chip('other', `De ${o.name}`)),
    pending.length ? groups : h('p', { class: 'nothing' }, 'Nada pendiente 🎉'),
    doneSec);
}

/* ============================== Render y ruteo ========================== */

function goHome() { location.replace('#/'); } // sin apilar otra entrada en el historial

function parseRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  state.route = r === 'super' ? 'super' : r === 'tareas' ? 'tareas' : 'home';
}

function render() {
  const app = document.getElementById('app');
  const ready = state.phase === 'ready';
  const old = app.firstElementChild;
  // Si se está tipeando en el input rápido del súper, repintar todo menos ese input.
  const partial = ready && state.loaded && state.route === 'super' && !!old && old.dataset.view === 'super'
    && quickUI.row.contains(document.activeElement);

  keepQuick = partial;
  let view;
  if (state.phase === 'config') view = viewConfig();
  else if (state.phase === 'auth') view = viewAuth();
  else if (state.phase === 'recovery') view = viewRecovery();
  else if (state.phase === 'waiting') view = viewWaiting();
  else if (state.phase === 'error') view = viewError();
  else if (ready && !state.loaded) view = viewLoading();
  else if (ready) view = state.route === 'super' ? viewSuper() : state.route === 'tareas' ? viewTareas() : viewHome();
  else view = h('p', { class: 'boot' }, 'Cargando…');
  keepQuick = false;

  if (partial) {
    const nk = [...view.children], ok = [...old.children];
    if (nk.length === ok.length) {
      nk.forEach((k, i) => { if (!k.classList.contains('quick-slot')) ok[i].replaceWith(k); });
      return;
    }
    // Estructura distinta (no debería pasar): repintado completo.
    keepQuick = false;
    view = viewSuper();
  }

  app.replaceChildren(view);
  document.body.classList.toggle('has-finish', ready && state.loaded && state.route === 'super');

  if (ready && state.loaded) {
    app.appendChild(h('button', {
      class: 'fab', type: 'button', 'aria-label': 'Agregar',
      onclick: () => openAddSheet(state.route === 'tareas' ? 'tareas' : 'super'),
    }, '+'));
  }
}

/* ============================ Sesión y arranque ========================= */

let enterGen = 0;

async function enterSession() {
  const gen = ++enterGen;
  try {
    await loadMembers();
    if (gen !== enterGen) return;
    if (!me()) { unsubscribe(); state.phase = 'waiting'; render(); return; }
    state.phase = 'ready';
    state.loaded = false; state.loadFailed = false;
    parseRoute();
    render();
    await loadItems();
    if (gen !== enterGen) return;
    subscribe();
  } catch (e) {
    if (gen !== enterGen) return;
    console.warn('enterSession', e?.message);
    // Error de red o de servidor: no es lo mismo que "no estás habilitado".
    state.phase = 'error';
    render();
  }
}

async function signOut() {
  await state.client.auth.signOut();
}

function onAuth(session) {
  // Vino del link de "Olvidé mi contraseña": primero la clave nueva.
  if (session && state.recovering) {
    enterGen++;
    unsubscribe();
    state.session = session;
    closeSheet();
    state.phase = 'recovery';
    render();
    return;
  }
  // supabase-js re-emite SIGNED_IN al volver a la pestaña: si es la misma persona, no reiniciar.
  if (session && state.session && state.session.user.id === session.user.id && state.phase === 'ready') {
    state.session = session;
    return;
  }
  state.session = session;
  closeSheet();
  if (!session) {
    enterGen++; // cancela cualquier carga en curso
    unsubscribe();
    state.members = []; state.items = [];
    state.loaded = false; state.loadFailed = false; state.dirty = false;
    quickUI.input.value = '';
    state.phase = 'auth';
    render();
  } else {
    enterSession();
  }
}

function boot() {
  // GitHub Pages no permite frame-ancestors: si nos embeben en otra página, no arrancar.
  if (window.top !== window.self) { document.documentElement.hidden = true; return; }
  const configured = CFG.url && CFG.key && SB && !/__SUPABASE_/.test(CFG.url + CFG.key);
  if (!configured) { state.phase = 'config'; render(); return; }

  // Link del mail de recuperación: trae #...type=recovery (o un error si venció).
  const urlHash = location.hash;
  if (/[#&]type=recovery(&|$)/.test(urlHash)) state.recovering = true;
  const linkErr = /[#&]error_code=([^&]*)/.exec(urlHash);
  if (linkErr) {
    history.replaceState(null, '', location.pathname + location.search);
    parseRoute();
    setTimeout(() => toast(linkErr[1] === 'otp_expired'
      ? 'El link venció o ya se usó. Pedí otro desde "Olvidé mi contraseña".'
      : 'El link no sirvió. Pedí otro desde "Olvidé mi contraseña".'), 0);
  }

  state.client = SB.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });

  state.client.auth.onAuthStateChange((event, session) => {
    // Diferido: no hacer llamadas a Supabase dentro del callback.
    if (event === 'PASSWORD_RECOVERY') state.recovering = true;
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') { state.session = session; return; }
    setTimeout(() => onAuth(session), 0);
  });

  window.addEventListener('hashchange', () => { closeSheet(); parseRoute(); render(); window.scrollTo(0, 0); });
  window.addEventListener('online', resync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  setInterval(() => { if (document.visibilityState === 'visible') resync(); }, 60000);
}

parseRoute();
render();
boot();
