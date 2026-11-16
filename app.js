// Listas — súper y tareas compartidas, en vivo. JS vanilla, sin build.
// v2 "convivencia": gastos, aportes, mimos y cierre de mes (cálculos puros en calc.js).
// Secciones: constantes · estado · utilidades · datos · realtime · hojas · componentes · pantallas · arranque.

/* ============================== Constantes ============================== */

const CFG = window.LISTAS_CONFIG || {};
import {
  TIPOS_APORTE, parseEuros, fmtEUR, centsToInput, saldoHalf, saldoCents, localISODate, monthKey, addMonthKey, monthLabel, monthName,
  cap, lastDayOfMonth, QUEHACERES, filasCasa, fechaCorta, period, contarAportes, porcentajes, mesCierrePorDefecto, mesFindeDeCierre, resumenGastosMes,
} from './calc.js';

const SB = window.supabase;
const ITEM_COLS_V1 = 'id,list,text,done,done_at,bucket,assignee,created_by,created_at';
let ITEM_COLS = 'id,list,text,done,done_at,done_by,bucket,assignee,created_by,created_at'; // cae a v1 si v2.sql aún no está aplicada
const GASTO_COLS = 'id,tipo,descripcion,monto_cent,pagado_por,reparto,fecha,created_by,created_at';
const MIMO_COLS = 'id,de,para,tipo,texto,visto,canjeado,canjeado_at,created_at';
let ACT_COLS = 'id,actor,tipo,item_id,detalle,at'; // cae a v2 si v3.sql aún no está aplicada
const ACT_COLS_V2 = 'id,actor,tipo,item_id,at';
const CIERRE_COLS = 'mes,aprendimos,mejoramos,trabajando,updated_by,updated_at';
const CIERRE_FIELDS = ['aprendimos', 'mejoramos', 'trabajando'];
const CIERRE_Q = [
  ['aprendimos', '¿Qué aprendimos este mes?'],
  ['mejoramos', '¿Qué mejoramos?'],
  ['trabajando', '¿En qué seguimos trabajando?'],
];
const MIMOS = {
  corazon: { emoji: '❤️', name: 'Corazón' },
  beso: { emoji: '💋', name: 'Beso' },
  gracias: { emoji: '🙏', name: 'Gracias' },
  vale: { emoji: '🎁', name: 'Vale' },
};
const VALES = ['Vale por un masaje', 'Vale por unos mimos', 'Vale por unos besitos', 'Vale por un desayuno en la cama', 'Vale por elegir la peli', 'Vale por un chocolate'];
const ROUTES = ['super', 'tareas', 'gastos', 'aportes', 'mimos', 'cierre', 'avisos'];
const ACT_DAYS = 400;
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
  route: 'home',        // home | super | tareas | gastos | aportes | mimos | cierre
  routeArg: null,       // mes (AAAA-MM) de #/cierre/AAAA-MM
  gastos: [],
  mimos: [],
  actividad: [],
  cierres: [],
  apKind: 'semana',     // selector de #/aportes
  apOffset: 0,
  mimosInit: false,     // ya se vio la primera carga de mimos (para no avisar los viejos)
  seenMimos: new Set(), // mimos ya vistos en esta sesión
  freshMimos: new Set(),// los que estaban sin ver al entrar a #/mimos (se resaltan)
  cierreDraft: {},      // mes -> { campo: texto } escrito y todavía no guardado
  cierreSeen: null,     // mes -> updated_at, para avisar cambios del otro
  markBlockUntil: 0,
  sendingMimo: false,
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

function toast(msg, emoji) {
  const box = document.getElementById('toasts');
  const t = emoji
    ? h('div', { class: 'toast big' }, h('span', { class: 'toast-emoji', 'aria-hidden': 'true' }, emoji), h('span', null, msg))
    : h('div', { class: 'toast' }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), emoji ? 6000 : 3500);
}

function cleanText(s, max = MAX_TEXT) {
  const t = String(s ?? '').trim();
  return t.length >= 1 && t.length <= max ? t : null;
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

/** Pide a la Edge Function 'notificar' que avise al otro. Fire-and-forget: nunca bloquea ni muestra errores. */
function notificar(body) {
  try {
    Promise.resolve(state.client.functions.invoke('notificar', { body }))
      .then((r) => { if (r?.error) console.warn('notificar', r.error.message); })
      .catch((e) => console.warn('notificar', e?.message));
  } catch (e) { console.warn('notificar', e?.message); }
}

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
    const since = new Date(Date.now() - ACT_DAYS * DAY).toISOString();
    const fetchItems = () => state.client.from('items').select(ITEM_COLS).order('created_at', { ascending: true }).limit(1000);
    // PostgREST recorta a max-rows (1000 por defecto): se pagina con range() hasta traer todo.
    const pages = async (mk, max) => {
      const all = [];
      for (let from = 0; from < max; from += 1000) {
        const r = await mk().range(from, from + 999);
        if (r.error) return r;
        all.push(...r.data);
        if (r.data.length < 1000) break;
      }
      return { data: all, error: null };
    };
    const [ir0, mr, gr, mir, ar0, cr] = await withTimeout(Promise.all([
      fetchItems(),
      state.client.from('members').select(MEMBER_COLS),
      pages(() => state.client.from('gastos').select(GASTO_COLS).order('fecha', { ascending: false }).order('created_at', { ascending: false }).order('id'), 5000),
      pages(() => state.client.from('mimos').select(MIMO_COLS).order('created_at', { ascending: false }).order('id'), 5000),
      pages(() => state.client.from('actividad').select(ACT_COLS).gte('at', since).order('at', { ascending: false }).order('id', { ascending: false }), 10000),
      state.client.from('cierres').select(CIERRE_COLS),
    ]));
    let ir = ir0, ar = ar0;
    if (ir.error && ITEM_COLS.includes('done_by')) { // v2.sql todavía no aplicada: seguir con las columnas de v1
      ITEM_COLS = ITEM_COLS_V1;
      ir = await withTimeout(fetchItems());
    }
    if (ar.error && ACT_COLS.includes('detalle')) { // v3.sql todavía no aplicada: seguir con las columnas de v2
      ACT_COLS = ACT_COLS_V2;
      ar = await withTimeout(pages(() => state.client.from('actividad').select(ACT_COLS).gte('at', since).order('at', { ascending: false }).order('id', { ascending: false }), 10000));
    }
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
      // Las tablas de v2 son opcionales: si una falla, se conserva lo anterior.
      for (const [key, res] of [['gastos', gr], ['mimos', mir], ['actividad', ar], ['cierres', cr]]) {
        if (res.error || !res.data) { console.warn('load ' + key, res.error?.message); continue; }
        if (JSON.stringify(res.data) !== JSON.stringify(state[key])) { state[key] = res.data; changed = true; }
      }
      state.loaded = true; state.loadFailed = false;
      notifyMimos(!mir.error);
      watchCierres();
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
  if (data.list === 'tareas' && data.assignee && data.assignee !== state.session?.user.id) notificar({ kind: 'tarea', id: data.id });
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

/* ------------------------------ Datos de v2 ------------------------------ */

const todayISO = () => localISODate(new Date());

async function insertGasto(row) {
  // Solo columnas permitidas: tipo, descripcion, monto_cent, pagado_por, reparto, fecha.
  const r = { tipo: row.tipo, descripcion: row.descripcion, monto_cent: row.monto_cent, pagado_por: row.pagado_por, reparto: row.reparto, fecha: row.fecha };
  const { data, error } = await write(() => state.client.from('gastos').insert(r).select(GASTO_COLS).single());
  if (error) throw error;
  if (!state.gastos.some((g) => g.id === data.id)) state.gastos.push(data);
  render();
  notificar({ kind: 'gasto', id: data.id });
  return data;
}

async function updateGasto(g, changes) {
  // Solo columnas permitidas: descripcion, monto_cent, pagado_por, reparto, fecha.
  const r = {};
  for (const k of ['descripcion', 'monto_cent', 'pagado_por', 'reparto', 'fecha']) if (k in changes) r[k] = changes[k];
  const { data, error } = await write(() => state.client.from('gastos').update(r).eq('id', g.id).select(GASTO_COLS));
  if (error) throw error;
  if (!data || !data.length) throw new Error('missing');
  const cur = state.gastos.find((x) => x.id === g.id);
  if (cur) Object.assign(cur, data[0]);
  render();
}

async function deleteGasto(g) {
  const { error } = await write(() => state.client.from('gastos').delete().eq('id', g.id));
  if (error) throw error;
  state.gastos = state.gastos.filter((x) => x.id !== g.id);
  render();
}

async function sendMimo(tipo, texto) {
  // Solo columnas permitidas: para, tipo, texto.
  const o = other();
  if (!o) throw new Error('solo');
  const r = { para: o.user_id, tipo };
  if (texto) r.texto = texto;
  const { data, error } = await write(() => state.client.from('mimos').insert(r).select(MIMO_COLS).single());
  if (error) throw error;
  if (!state.mimos.some((m) => m.id === data.id)) state.mimos.unshift(data);
  state.seenMimos.add(data.id);
  render();
  notificar({ kind: 'mimo', id: data.id });
  return data;
}

/** Un quehacer, un toque. Solo viaja la columna 'que'; quién y cuándo los pone la base. */
async function insertQuehacer(que) {
  const { data, error } = await write(() => state.client.from('quehaceres').insert({ que }).select('id').single());
  if (error) throw error;
  return data;
}

async function deleteQuehacer(id) {
  const { data, error } = await write(() => state.client.from('quehaceres').delete().eq('id', id).select('id'));
  if (error) throw error;
  if (!data || !data.length) throw new Error('ya no estaba');
}

async function deleteMimo(m) {
  const { error } = await write(() => state.client.from('mimos').delete().eq('id', m.id));
  if (error) throw error;
  state.mimos = state.mimos.filter((x) => x.id !== m.id);
  render();
}

async function canjearMimo(m) {
  if (inflight.has(m.id)) return;
  inflight.add(m.id);
  const prev = { canjeado: m.canjeado, canjeado_at: m.canjeado_at };
  m.canjeado = true; m.canjeado_at = new Date().toISOString();
  render();
  let failed = false;
  try {
    // Solo columna permitida: canjeado (y visto al entrar a #/mimos).
    const { data, error } = await write(() => state.client.from('mimos').update({ canjeado: true }).eq('id', m.id).select('id'));
    failed = !!error || !data || data.length === 0;
  } catch (e) { failed = true; }
  inflight.delete(m.id);
  if (failed) {
    const now = state.mimos.find((x) => x.id === m.id);
    if (now) Object.assign(now, prev);
    render();
    toast('No se pudo canjear, probá de nuevo');
  } else {
    const from = memberById(m.de)?.name || 'Alguien';
    toast(`Canjeado. ${from} ya sabe que lo vas a cobrar 😏`, '🎁');
  }
}

const unseenForMe = () => {
  const id = me()?.user_id;
  return state.mimos.filter((m) => m.para === id && !m.visto).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
};

/** Al estar en #/mimos, los recibidos sin ver pasan a vistos (solo los dirigidos a mí). */
function ensureSeen() {
  if (state.route !== 'mimos' || state.phase !== 'ready' || !state.loaded) return;
  const un = unseenForMe();
  if (!un.length || Date.now() < state.markBlockUntil) return;
  un.forEach((m) => { state.freshMimos.add(m.id); state.seenMimos.add(m.id); m.visto = true; });
  const myId = me().user_id;
  write(() => state.client.from('mimos').update({ visto: true }).eq('para', myId).eq('visto', false).select('id'))
    .then(({ error }) => { if (error) { state.markBlockUntil = Date.now() + 30000; console.warn('visto', error.message); } })
    .catch((e) => { state.markBlockUntil = Date.now() + 30000; console.warn('visto', e?.message); });
}

/** "💋 Mati te mandó un beso", "🎁 Mati te regaló: Vale por un masaje", "🙏 Mati te dio las gracias: …" */
function mimoPhrase(m) {
  const name = memberById(m.de)?.name || 'Alguien';
  if (m.tipo === 'corazon') return `${name} te mandó un corazón`;
  if (m.tipo === 'beso') return `${name} te mandó un beso`;
  if (m.tipo === 'gracias') return m.texto ? `${name} te dio las gracias: ${m.texto}` : `${name} te dio las gracias`;
  return `${name} te regaló: ${m.texto}`;
}

/** Aviso especial de mimos nuevos para mí. En la primera carga no avisa (para eso está el banner del inicio). */
function notifyMimos(mimosOk) {
  const myId = me()?.user_id;
  if (!myId || !mimosOk) return;
  if (!state.mimosInit) {
    state.mimos.forEach((m) => state.seenMimos.add(m.id));
    state.mimosInit = true;
    return;
  }
  const fresh = state.mimos.filter((m) => !state.seenMimos.has(m.id));
  fresh.forEach((m) => state.seenMimos.add(m.id));
  fresh.filter((m) => m.para === myId && !m.visto)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .forEach((m) => toast(mimoPhrase(m), MIMOS[m.tipo]?.emoji || '💌'));
}

/** Si el otro guarda el cierre del mes que estoy mirando, avisar (sin repintar lo que estoy escribiendo). */
function watchCierres() {
  const myId = me()?.user_id;
  const first = state.cierreSeen === null;
  if (first) state.cierreSeen = {};
  for (const c of state.cierres) {
    const key = c.mes.slice(0, 7);
    const prev = state.cierreSeen[key];
    state.cierreSeen[key] = c.updated_at;
    if (first || prev === c.updated_at) continue;
    if (c.updated_by && c.updated_by !== myId && state.route === 'cierre' && key === cierreMes()) {
      toast(`${memberById(c.updated_by)?.name || 'El otro'} actualizó el cierre`);
    }
  }
}

const cierreMes = () => state.routeArg || mesCierrePorDefecto(new Date());
const cierreRow = (key) => state.cierres.find((c) => c.mes.slice(0, 7) === key) || null;
const cierreVacio = (c) => !c || CIERRE_FIELDS.every((f) => !(c[f] || '').trim());

let cierreSaving = null;

/** Guarda lo escrito del mes: select ya hecho (state), insert si no existe, update si el insert da 23505. Nunca upsert. */
async function saveCierre(key, manual) {
  while (cierreSaving) { try { await cierreSaving; } catch (e) { /* ya avisó */ } }
  const draft = state.cierreDraft[key];
  const row = cierreRow(key);
  const changes = {};
  if (draft) for (const f of CIERRE_FIELDS) if (f in draft && draft[f] !== (row?.[f] ?? '')) changes[f] = draft[f];
  if (!Object.keys(changes).length) {
    if (draft) delete state.cierreDraft[key];
    if (manual) toast('Guardado ✓');
    return;
  }
  const run = async () => {
    const mes = key + '-01';
    let res;
    if (!row) {
      const full = {};
      CIERRE_FIELDS.forEach((f) => { full[f] = changes[f] ?? ''; });
      res = await write(() => state.client.from('cierres').insert({ mes, ...full }).select(CIERRE_COLS).single());
      if (res.error?.code === '23505') res = null; // el otro lo creó justo antes: actualizar
    }
    if (!res) {
      res = await write(() => state.client.from('cierres').update(changes).eq('mes', mes).select(CIERRE_COLS));
      if (!res.error && res.data) res = { data: res.data[0], error: null };
    }
    if (res.error) throw res.error;
    const saved = res.data;
    if (saved) {
      const i = state.cierres.findIndex((c) => c.mes === saved.mes);
      if (i >= 0) state.cierres[i] = saved; else state.cierres.push(saved);
      if (state.cierreSeen) state.cierreSeen[key] = saved.updated_at;
    }
    const d = state.cierreDraft[key];
    if (d) {
      for (const f of Object.keys(changes)) if (d[f] === changes[f]) delete d[f];
      if (!Object.keys(d).length) delete state.cierreDraft[key];
    }
  };
  cierreSaving = run();
  try {
    await cierreSaving;
    if (manual) toast('Guardado ✓');
  } catch (e) {
    console.warn('cierre', e?.message);
    toast('No se pudo guardar, probá de nuevo');
  } finally {
    cierreSaving = null;
  }
}

const cierreAreaFocused = () => document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('cierre-area');

/* ============================ Avisos push (v4) ============================ */

// status: checking | unsupported | sw-error | ios-install | denied | off | on
const push = { status: 'checking', busy: false, msg: '' };

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 5000))]);

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function setPush(patch) {
  const before = JSON.stringify(push);
  Object.assign(push, patch);
  if (JSON.stringify(push) !== before && state.phase === 'ready' && state.loaded) render();
}

/** Mira el estado real de este móvil (permiso + suscripción del navegador). */
async function refreshPush() {
  let next;
  try {
    if (isIOS() && !isStandalone()) next = 'ios-install';
    else if (!pushSupported()) next = 'unsupported';
    else if (Notification.permission === 'denied') next = 'denied';
    else {
      const reg = await swReady();
      if (!reg) next = 'sw-error';
      else {
        const sub = Notification.permission === 'granted' ? await reg.pushManager.getSubscription() : null;
        next = 'off';
        if (sub) {
          // "Activado" solo si la fila es de este usuario (RLS filtra): si otro usó este móvil, no lo está.
          const { data } = await state.client.from('push_subs').select('id').eq('endpoint', sub.endpoint).limit(1);
          if (data && data.length) next = 'on';
        }
      }
    }
  } catch (e) {
    console.warn('refreshPush', e?.message);
    next = 'sw-error';
  }
  setPush({ status: next });
}

async function pushEnable() {
  if (push.busy) return;
  // requestPermission tiene que ser lo primero dentro del click (iOS exige el gesto): no poner nada antes.
  const permP = Notification.requestPermission();
  setPush({ busy: true, msg: '' });
  let sub = null;
  try {
    const perm = await permP;
    if (perm !== 'granted') { setPush({ busy: false, status: perm === 'denied' ? 'denied' : 'off', msg: perm === 'denied' ? '' : 'No diste el permiso. Si querés los avisos, tocá de nuevo y aceptá.' }); return; }
    const reg = await swReady();
    if (!reg) throw new Error('sin service worker');
    sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(CFG.vapidPublicKey) });
    const j = sub.toJSON();
    const row = { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth };
    let { error } = await state.client.from('push_subs').insert(row);
    if (error?.code === '23505') { // ese endpoint ya estaba: borrar la fila propia y reintentar una vez
      await state.client.from('push_subs').delete().eq('endpoint', row.endpoint);
      ({ error } = await state.client.from('push_subs').insert(row));
      if (error?.code === '23505') { // el endpoint es de otra cuenta (mismo móvil, otra persona): sacar uno nuevo
        await sub.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(CFG.vapidPublicKey) });
        const j2 = sub.toJSON();
        ({ error } = await state.client.from('push_subs').insert({ endpoint: j2.endpoint, p256dh: j2.keys?.p256dh, auth: j2.keys?.auth }));
      }
    }
    if (error) throw error;
    setPush({ busy: false, status: 'on', msg: '' });
  } catch (e) {
    console.warn('pushEnable', e?.message);
    try { if (sub) await sub.unsubscribe(); } catch (e2) { /* ya está */ }
    const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
    setPush({ busy: false, status: denied ? 'denied' : 'off', msg: denied ? '' : 'No se pudieron activar los avisos. Probá de nuevo en un rato; si sigue, avisale a quien mantiene la app.' });
  }
}

async function pushDisable() {
  if (push.busy) return;
  setPush({ busy: true, msg: '' });
  try {
    const reg = await swReady();
    if (!reg) throw new Error('sin service worker');
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const { error } = await state.client.from('push_subs').delete().eq('endpoint', sub.endpoint);
      if (error) throw error;
      await sub.unsubscribe();
    }
    setPush({ busy: false, status: 'off', msg: 'Avisos desactivados en este móvil.' });
  } catch (e) {
    console.warn('pushDisable', e?.message);
    setPush({ busy: false, msg: 'No se pudo desactivar. Probá de nuevo.' });
  }
}

async function pushTest() {
  if (push.busy) return;
  setPush({ busy: true, msg: '' });
  try {
    const { data, error } = await state.client.functions.invoke('notificar', { body: { kind: 'prueba' } });
    if (error) throw error;
    let msg;
    if (data?.sent > 0) msg = 'Listo, te mandamos un aviso. Tiene que llegar en unos segundos.';
    else if (data?.motivo === 'ya enviado') msg = 'Ya te mandamos uno hace un momento. Esperá un minuto y probá de nuevo.';
    else if (data?.failed > 0) msg = 'El envío falló. Probá de nuevo en un rato.';
    else msg = 'No encontramos este móvil entre los suscriptos. Desactivá y volvé a activar los avisos.';
    setPush({ busy: false, msg });
  } catch (e) {
    console.warn('pushTest', e?.message);
    setPush({ busy: false, msg: 'No se pudo mandar la prueba. Esperá un minuto y probá de nuevo.' });
  }
}

/** Línea para el inicio y mimos: solo si en este móvil los avisos se pueden activar y no lo están. */
const pushInvite = () => push.status === 'off' || push.status === 'denied' || push.status === 'ios-install';

function viewAvisos() {
  const st = push.status;
  const intro = h('p', { class: 'muted' }, 'Te avisamos con una vibración, aunque la app esté cerrada, cuando te llega un mimo o un vale, cuando el otro te asigna una tarea, cuando carga un gasto, y el sábado del último finde del mes para el cierre.');
  let body;
  if (st === 'checking') body = h('p', { class: 'muted' }, 'Mirando cómo está este móvil…');
  else if (st === 'ios-install') {
    body = h('div', { class: 'stack' },
      h('p', null, 'En iPhone y iPad los avisos solo andan si abrís Listas desde el ícono de la pantalla de inicio (hace falta iOS 16.4 o más).'),
      h('p', null, '1. Tocá Compartir → Agregar a pantalla de inicio.'),
      h('p', null, '2. Abrí Listas desde ese ícono y volvé acá.'));
  } else if (st === 'sw-error') {
    body = h('div', { class: 'stack' },
      h('p', null, 'No pudimos preparar los avisos en este móvil. Cerrá y abrí la app, y probá de nuevo.'),
      h('button', { class: 'btn block', type: 'button', onclick: () => { setPush({ status: 'checking' }); registerSW(); refreshPush(); } }, 'Reintentar'));
  } else if (st === 'unsupported') body = h('p', null, 'Este navegador no permite avisos. Probá desde Chrome o Safari (en iPhone, con la app en la pantalla de inicio).');
  else if (st === 'denied') {
    body = h('div', { class: 'stack' },
      h('p', null, 'Los avisos están bloqueados para Listas en este móvil.'),
      h('p', null, 'Habilitalos en Ajustes: en iPhone, Ajustes → Notificaciones → Listas; en Android, el candado de la barra del navegador → Permisos → Notificaciones. Después volvé acá.'));
  } else if (st === 'on') {
    body = h('div', { class: 'stack' },
      h('div', { class: 'card-title' }, '✓ Avisos activados en este móvil'),
      h('div', { class: 'row card-actions' },
        h('button', { class: 'btn primary', type: 'button', disabled: push.busy, onclick: pushTest }, 'Probar aviso'),
        h('button', { class: 'btn', type: 'button', disabled: push.busy, onclick: pushDisable }, 'Desactivar')));
  } else {
    body = h('button', { class: 'btn primary block', type: 'button', disabled: push.busy, onclick: pushEnable }, 'Activar avisos en este móvil');
  }
  return h('div', { class: 'stack' },
    topbar('🔔 Avisos en este móvil'),
    h('section', { class: 'card stack' }, intro, body, h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' }, push.msg)));
}

function registerSW() {
  if (!('serviceWorker' in navigator) || window.top !== window.self) return;
  try {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch((e) => console.warn('sw', e?.message));
  } catch (e) { console.warn('sw', e?.message); }
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
    const ch = state.client.channel('items-' + (++chSeq));
    for (const table of ['items', 'gastos', 'mimos', 'cierres', 'actividad', 'quehaceres']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => refetch());
    }
    ch.subscribe((status) => {
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
function openConfirm(title, message, okLabel, onOk, opts = {}) {
  openSheet(title, ({ close, focus }) => {
    const ok = h('button', { class: opts.primary ? 'btn primary' : 'btn danger', type: 'button' }, okLabel);
    const no = h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancelar');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try { await onOk(); close(); } catch (e) { console.warn('confirm', e?.message); toast(opts.errMsg || 'No se pudo borrar, probá de nuevo'); ok.disabled = false; }
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
    mimoBanner(), mimosCard(), superCard, tasksCard, gastosCard(), weekCard(), cierreCard(),
    h('div', { class: 'foot-links' },
      h('a', { class: 'more-link soft', href: '#/cierre' }, 'Cierre del mes →'),
      h('a', { class: 'more-link soft', href: '#/avisos' }, '🔔 Avisos')));
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
    onclick: () => openConfirm('Terminé la compra', `¿Sacar de la lista las ${done.length} cosas tildadas?`, 'Sí, sacarlas', async () => {
      await deleteDone('super');
      // Con el borrado ya hecho, preguntar (opcional) cuánto salió. Después de que se cierre esta hoja.
      if (other()) setTimeout(() => openGastoSheet({ compra: true }), 0);
    }),
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

/* ============================ Pantallas de v2 ============================ */

const memberName = (id) => memberById(id)?.name || 'Alguien';
const bothIds = () => { const a = me(), b = other(); return b ? [a.user_id, b.user_id] : [a.user_id]; };

function topbar(title) {
  return h('div', { class: 'topbar' }, h('button', { class: 'back', type: 'button', 'aria-label': 'Volver', onclick: goHome }, '←'), h('h1', null, title));
}

/** Torta de aportes (dona) con conic-gradient. Sin ganador: solo cómo se repartió. */
function pieEl(porActor, size) {
  const ids = bothIds();
  const pct = porcentajes(porActor, ids);
  const total = ids.reduce((s, id) => s + (porActor[id] || 0), 0);
  const label = total ? ids.map((id, i) => `${memberName(id)} ${pct[i]} %`).join(', ') : 'Todavía sin aportes';
  const el = h('div', { class: `pie ${size}`, role: 'img', 'aria-label': label });
  if (!total) el.style.background = 'var(--soft)';
  else if (ids.length === 1) el.style.background = colorOf(me());
  else el.style.background = `conic-gradient(${colorOf(me())} 0 ${pct[0]}%, ${colorOf(other())} ${pct[0]}% 100%)`;
  return el;
}

function pieLegend(porActor) {
  const ids = bothIds();
  const pct = porcentajes(porActor, ids);
  const total = ids.reduce((s, id) => s + (porActor[id] || 0), 0);
  return h('ul', { class: 'legend' }, ids.map((id, i) => {
    const sw = h('span', { class: 'swatch', 'aria-hidden': 'true' });
    sw.style.background = colorOf(memberById(id));
    return h('li', null, sw, `${memberName(id)} ${total ? pct[i] : 0} %`);
  }));
}

function aportesTabla(c) {
  const ids = bothIds();
  const casa = filasCasa(c);
  const head = h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Aporte'), ids.map((id) => h('th', { scope: 'col' }, memberName(id)))));
  const rows = TIPOS_APORTE.map(([tipo, nombre]) =>
    h('tr', null, h('th', { scope: 'row' }, nombre), ids.map((id) => h('td', null, String(c.porTipo[tipo]?.[id] || 0)))));
  const tabla = h('table', { class: 'tabla' }, head, h('tbody', null, rows));
  if (!casa.length) return [tabla, h('p', { class: 'muted small casa-vacia' }, 'Todavía no registraron cosas de la casa')];
  const totalCasa = (id) => casa.reduce((s, r) => s + (r.porActor[id] || 0), 0);
  const casaTabla = h('table', { class: 'tabla casa' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Casa 🏠'), ids.map((id) => h('th', { scope: 'col' }, memberName(id))))),
    h('tbody', null,
      casa.map((r) => h('tr', null, h('th', { scope: 'row' }, `${r.emoji} ${r.nombre}`), ids.map((id) => h('td', null, String(r.porActor[id] || 0))))),
      h('tr', { class: 'total' }, h('th', { scope: 'row' }, 'Total casa'), ids.map((id) => h('td', null, String(totalCasa(id)))))));
  return [tabla, casaTabla];
}

function aportesDe(per) { return contarAportes(state.actividad, per.start, per.end, bothIds()); }

/* ---------- Inicio ---------- */

function mimoBanner() {
  const un = unseenForMe();
  if (!un.length) return null;
  const m = un[0], more = un.length - 1;
  return h('button', { class: 'banner', type: 'button', onclick: () => { location.hash = '#/mimos'; } },
    h('span', { class: 'banner-emoji', 'aria-hidden': 'true' }, MIMOS[m.tipo]?.emoji || '💌'),
    h('span', { class: 'banner-text' }, `${mimoPhrase(m)} · ${timeAgo(m.created_at)}`, more > 0 && h('span', { class: 'banner-more' }, `y ${more} más`)));
}

function saldoLine(half) {
  const c = saldoCents(half), on = other()?.name || 'el otro';
  if (c === 0) return 'Están a mano ✓';
  return c > 0 ? `${on} te debe ${fmtEUR(c)}` : `Le debés ${fmtEUR(-c)} a ${on}`;
}
const miSaldo = () => saldoHalf(state.gastos, me().user_id);

function gastosCard() {
  const o = other();
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '💸 Gastos'),
    o ? h('div', { class: 'saldo' }, saldoLine(miSaldo())) : h('div', { class: 'muted saldo-sub' }, 'Cuando entre la otra persona, van a poder repartir gastos.'),
    h('div', { class: 'row card-actions' },
      h('button', { class: 'btn primary', type: 'button', disabled: !o, onclick: () => openGastoSheet() }, 'Cargar gasto'),
      h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/gastos'; } }, 'Ver gastos →')));
}

function weekCard() {
  const c = aportesDe(period('semana', 0));
  return h('section', { class: 'card tap', onclick: () => { location.hash = '#/aportes'; } },
    h('div', { class: 'card-title' }, '🥧 Esta semana'),
    c.total
      ? h('div', { class: 'pie-row' }, pieEl(c.porActor, 'sm'),
        h('div', { class: 'pie-side' }, pieLegend(c.porActor), h('div', { class: 'muted' }, `${c.total} ${c.total === 1 ? 'aporte' : 'aportes'}`)))
      : h('div', { class: 'preview' }, 'Todavía no hay aportes esta semana'),
    c.total > 0 && h('div', { class: 'foot' }, 'Así se repartió la carga esta semana'),
    h('div', { class: 'row card-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.stopPropagation(); openQuehaceresSheet(); } }, '🧹 Hice algo de la casa'),
      h('a', { class: 'more-link', href: '#/aportes', onclick: (e) => e.stopPropagation() }, 'Ver aportes →')));
}

function mimosCard() {
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '💌 Mimos'),
    mimoButtons(),
    !other() && h('p', { class: 'muted small' }, 'Cuando entre la otra persona, van a poder mandarse mimos.'),
    h('a', { class: 'more-link', href: '#/mimos' }, 'Ver mimos →'));
}

function cierreCard() {
  const key = mesFindeDeCierre(new Date());
  if (!key || !cierreVacio(cierreRow(key))) return null;
  return h('section', { class: 'card tap cierre-card', onclick: () => { location.hash = `#/cierre/${key}`; } },
    h('p', null, `🗓️ Es finde de cierre de ${monthName(key)}. ¿Se hacen un rato para charlarlo?`),
    h('a', { class: 'more-link', href: `#/cierre/${key}` }, 'Ir al cierre →'));
}

/* ---------- Quehaceres (v3) ---------- */

const busyChips = new Set(); // guardia contra doble toque mientras se guarda (a nivel módulo: sobrevive a cerrar y reabrir la hoja)

function openQuehaceresSheet() {
  openSheet('¿Qué hiciste? 🧹', ({ focus }) => {
    const feedback = h('div', { class: 'added', role: 'status', 'aria-live': 'polite' });
    let undoBusy = false;
    const sumar = async (que, emoji, key) => {
      if (busyChips.has(key)) return false;
      busyChips.add(key);
      try {
        const row = await insertQuehacer(que);
        const undo = h('button', { class: 'link-btn', type: 'button' }, 'Deshacer');
        undo.addEventListener('click', async () => {
          if (undoBusy) return;
          undoBusy = true; undo.disabled = true;
          try { await deleteQuehacer(row.id); feedback.replaceChildren(`Deshecho: ${que}`); toast(`Se deshizo: ${que}`); }
          catch (e) { console.warn('deshacer quehacer', e?.message); toast('No se pudo deshacer, probá de nuevo'); undo.disabled = false; }
          finally { undoBusy = false; }
        });
        feedback.replaceChildren(`Sumaste: ${que} ${emoji} · `, undo);
        toast(`Sumaste: ${que} ${emoji}`);
        return true;
      } catch (e) { console.warn('quehacer', e?.message); toast('No se pudo sumar, probá de nuevo'); return false; }
      finally { busyChips.delete(key); }
    };
    const grid = h('div', { class: 'quehacer-grid' }, QUEHACERES.map(([emoji, nombre]) => {
      const b = h('button', { class: 'quehacer-chip', type: 'button' }, h('span', { class: 'qh-emoji', 'aria-hidden': 'true' }, emoji), h('span', null, nombre));
      b.addEventListener('click', () => { sumar(nombre, emoji, nombre).finally(() => { b.disabled = false; }); b.disabled = busyChips.has(nombre); });
      return b;
    }));
    const otra = h('button', { class: 'quehacer-chip', type: 'button' }, h('span', { class: 'qh-emoji', 'aria-hidden': 'true' }, '✏️'), h('span', null, 'Otra…'));
    grid.appendChild(otra);
    const input = h('input', { class: 'input', type: 'text', maxlength: 40, placeholder: '¿Qué hiciste?', 'aria-label': 'Otra cosa de la casa', enterkeyhint: 'send', autocomplete: 'off' });
    const add = h('button', { class: 'btn primary block', type: 'button' }, 'Sumar');
    const custom = h('div', { class: 'stack' }, input, add);
    custom.hidden = true;
    otra.addEventListener('click', () => { custom.hidden = false; input.focus(); });
    const go = async () => {
      const t = cleanText(input.value, 40);
      if (!t) { input.focus(); return; }
      add.disabled = true;
      if (await sumar(t, '✏️', '__otra')) input.value = '';
      add.disabled = false;
    };
    add.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    focus(grid.firstChild);
    return h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Un toque y suma. Podés registrar varias seguidas.'), grid, custom, feedback);
  });
}

/* ---------- Mimos ---------- */

async function quickMimo(tipo) {
  if (state.sendingMimo) return;
  state.sendingMimo = true;
  try {
    await sendMimo(tipo);
    const o = other();
    toast(tipo === 'beso' ? `Le mandaste un beso a ${o.name} 💋` : `Le mandaste un corazón a ${o.name} ❤️`);
  } catch (e) {
    console.warn('mimo', e?.message);
    toast('No se pudo mandar, probá de nuevo');
  } finally { state.sendingMimo = false; }
}

function mimoButtons() {
  const o = other();
  const mk = (tipo, onclick) => h('button', { class: 'mimo-btn', type: 'button', disabled: !o, 'aria-label': MIMOS[tipo].name, onclick },
    h('span', { class: 'mimo-emoji', 'aria-hidden': 'true' }, MIMOS[tipo].emoji), h('span', { class: 'mimo-name' }, MIMOS[tipo].name));
  return h('div', { class: 'mimo-grid' },
    mk('corazon', () => quickMimo('corazon')), mk('beso', () => quickMimo('beso')),
    mk('gracias', openGraciasSheet), mk('vale', openValeSheet));
}

function openGraciasSheet() {
  const o = other();
  if (!o) return;
  let busy = false;
  openSheet('Gracias 🙏', ({ close, focus }) => {
    const input = h('input', { class: 'input', type: 'text', maxlength: 80, placeholder: `Un mensaje para ${o.name} (opcional)`, 'aria-label': 'Mensaje', enterkeyhint: 'send', autocomplete: 'off' });
    const send = h('button', { class: 'btn primary block', type: 'button' }, 'Mandar 🙏');
    send.addEventListener('click', async () => {
      if (busy) return;
      const raw = input.value.trim();
      if (raw.length > 80) { input.focus(); return; }
      busy = true; send.disabled = true;
      try {
        await sendMimo('gracias', raw || null);
        close();
        toast(`Le diste las gracias a ${o.name} 🙏`);
      } catch (e) { console.warn('gracias', e?.message); toast('No se pudo mandar, probá de nuevo'); busy = false; send.disabled = false; }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send.click(); } });
    focus(input);
    return h('div', { class: 'stack' }, h('p', { class: 'muted' }, `¿Qué le agradecés a ${o.name}?`), input, send);
  });
}

function openValeSheet() {
  const o = other();
  if (!o) return;
  let busy = false;
  const give = async (texto, close, btns) => {
    if (busy) return;
    busy = true; btns.forEach((b) => { b.disabled = true; });
    try {
      await sendMimo('vale', texto);
      close();
      toast(`Le regalaste "${texto}" a ${o.name} 🎁`);
    } catch (e) { console.warn('vale', e?.message); toast('No se pudo mandar, probá de nuevo'); busy = false; btns.forEach((b) => { b.disabled = false; }); }
  };
  openSheet('Un vale 🎁', ({ close, focus }) => {
    const btns = [];
    const presets = VALES.map((t) => { const b = h('button', { class: 'btn block vale-opt', type: 'button', onclick: () => give(t, close, btns) }, t); btns.push(b); return b; });
    const input = h('input', { class: 'input', type: 'text', maxlength: 80, placeholder: 'Vale por…', 'aria-label': 'Vale por', enterkeyhint: 'send', autocomplete: 'off' });
    const send = h('button', { class: 'btn primary block', type: 'button' }, 'Regalar');
    btns.push(send);
    const custom = h('div', { class: 'stack' }, input, send);
    custom.hidden = true;
    const other_ = h('button', { class: 'btn ghost block', type: 'button' }, 'Escribir otro…');
    other_.addEventListener('click', () => { custom.hidden = false; other_.hidden = true; input.focus(); });
    const go = () => { const t = cleanText(input.value, 80); if (!t) { input.focus(); return; } give(t, close, btns); };
    send.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    focus(presets[0]);
    return h('div', { class: 'stack' }, h('p', { class: 'muted' }, `Un vale para ${o.name}. Lo puede canjear cuando quiera.`), ...presets, other_, custom);
  });
}

function viewMimos() {
  const o = other(), myId = me().user_id;
  const byNew = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const recibidos = state.mimos.filter((m) => m.para === myId).sort(byNew);
  const valesPend = recibidos.filter((m) => m.tipo === 'vale' && !m.canjeado);
  const resto = recibidos.filter((m) => !(m.tipo === 'vale' && !m.canjeado));
  const enviados = state.mimos.filter((m) => m.de === myId).sort(byNew);

  const recRow = (m) => {
    const sub = m.canjeado ? `canjeado ${timeAgo(m.canjeado_at || m.created_at)} · ${timeAgo(m.created_at)}` : timeAgo(m.created_at);
    return h('li', { class: `mimo-row${m.tipo === 'vale' && !m.canjeado ? ' vale' : ''}${m.canjeado ? ' used' : ''}${state.freshMimos.has(m.id) ? ' fresh' : ''}` },
      h('span', { class: 'mimo-big', 'aria-hidden': 'true' }, MIMOS[m.tipo]?.emoji || '💌'),
      h('div', { class: 'mimo-body' },
        h('div', { class: 'mimo-title' }, mimoPhrase(m), state.freshMimos.has(m.id) && h('span', { class: 'tag' }, 'nuevo')),
        h('div', { class: 'muted small' }, sub)),
      m.tipo === 'vale' && !m.canjeado && h('button', { class: 'btn primary', type: 'button', onclick: () => canjearMimo(m) }, 'Canjear'));
  };

  const estado = (m) => (m.canjeado ? 'canjeado' : m.visto ? 'visto' : 'sin ver');
  const sentText = (m) => {
    if (m.tipo === 'corazon') return 'Un corazón';
    if (m.tipo === 'beso') return 'Un beso';
    if (m.tipo === 'gracias') return m.texto ? `Gracias: ${m.texto}` : 'Gracias';
    return m.texto;
  };
  const sentRow = (m) => h('li', { class: 'mimo-row sent' },
    h('span', { class: 'mimo-big', 'aria-hidden': 'true' }, MIMOS[m.tipo]?.emoji || '💌'),
    h('div', { class: 'mimo-body' },
      h('div', { class: 'mimo-title' }, sentText(m)),
      h('div', { class: 'muted small' }, `${estado(m)} · ${timeAgo(m.created_at)}`)),
    h('button', {
      class: 'btn ghost', type: 'button', 'aria-label': `Deshacer: ${sentText(m)}`,
      onclick: () => openConfirm('Deshacer mimo', '¿Querés sacar este mimo? Si ya lo vio, igual desaparece.', 'Sí, sacarlo', () => deleteMimo(m), { errMsg: 'No se pudo deshacer, probá de nuevo' }),
    }, 'Deshacer'));

  return h('div', { class: 'stack' },
    topbar('Mimos 💌'),
    pushInvite() && h('a', { class: 'more-link', href: '#/avisos' }, 'Activá los avisos para enterarte aunque la app esté cerrada →'),
    h('section', { class: 'card' },
      h('div', { class: 'card-title' }, o ? `Mandale algo a ${o.name}` : 'Mandar un mimo'),
      mimoButtons(),
      !o && h('p', { class: 'muted small' }, 'Cuando entre la otra persona, van a poder mandarse mimos.')),
    h('section', { class: 'group' },
      h('h2', null, 'Para vos'),
      recibidos.length
        ? h('ul', { class: 'list' }, valesPend.map(recRow), resto.map(recRow))
        : h('p', { class: 'muted pad' }, 'Todavía no llegó ninguno. Mandá el primero 😉')),
    enviados.length > 0 && h('section', { class: 'group' },
      h('h2', null, 'Los que mandaste'),
      h('ul', { class: 'list' }, enviados.map(sentRow))));
}

/* ---------- Gastos ---------- */

function openGastoSheet(opts = {}) {
  const g = opts.gasto || null;
  const compra = !!opts.compra;
  const isPago = g?.tipo === 'pago';
  const mi = me(), ot = other();
  if (!ot) { toast('Falta que entre la otra persona'); return; }
  const f = { payer: g ? g.pagado_por : mi.user_id, reparto: g ? g.reparto : 'mitad', busy: false, confirming: false };
  const title = compra ? '¿Cuánto salió la compra?' : g ? (isPago ? 'Editar pago' : 'Editar gasto') : 'Cargar gasto';
  openSheet(title, ({ close, focus }) => {
    const desc = h('input', { class: 'input', type: 'text', maxlength: 80, value: g ? g.descripcion : '', placeholder: 'Qué compraste o pagaste', 'aria-label': 'Descripción', autocomplete: 'off' });
    const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: g ? centsToInput(g.monto_cent) : '', placeholder: '0,00', 'aria-label': 'Importe en euros', autocomplete: 'off' });
    const date = h('input', { class: 'input', type: 'date', value: g ? g.fecha : todayISO(), 'aria-label': 'Fecha' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const repBox = h('div');
    const paintRep = () => {
      const noPaga = f.payer === mi.user_id ? ot.name : mi.name;
      repBox.replaceChildren(h('div', { class: 'label' }, '¿Para quién?'),
        segmented([['mitad', 'Para los dos (mitad)'], ['todo_otro', `Todo para ${noPaga}`]], () => f.reparto, (v) => { f.reparto = v; }, 'Para quién'));
    };
    paintRep();
    const payerSeg = segmented([[mi.user_id, 'Yo'], [ot.user_id, ot.name]], () => f.payer, (v) => { f.payer = v; paintRep(); }, 'Quién pagó');
    const save = h('button', { class: 'btn primary block', type: 'button' }, compra ? 'Guardar gasto' : 'Guardar');
    const delArea = h('div', { class: 'confirm' });

    const submit = async () => {
      if (f.busy) return;
      const cents = parseEuros(amount.value);
      const d = compra ? 'Compra del súper' : cleanText(desc.value, 80);
      const fecha = compra ? todayISO() : date.value;
      if (!d) { err.textContent = 'Poné una descripción (hasta 80 letras).'; desc.focus(); return; }
      if (cents === null) { err.textContent = 'Poné un importe válido, por ejemplo 23,40 (hasta 100000).'; amount.focus(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { err.textContent = 'Poné una fecha válida.'; date.focus(); return; }
      err.textContent = '';
      f.busy = true; save.disabled = true;
      try {
        if (g) {
          const ch = { descripcion: d, monto_cent: cents, pagado_por: f.payer, fecha };
          if (!isPago) ch.reparto = f.reparto;
          await updateGasto(g, ch);
        } else {
          await insertGasto({ tipo: 'gasto', descripcion: d, monto_cent: cents, pagado_por: f.payer, reparto: compra ? 'mitad' : f.reparto, fecha });
        }
        close();
        toast(g ? 'Cambios guardados ✓' : 'Gasto guardado ✓');
      } catch (e) {
        console.warn('gasto', e?.message);
        const gone = e?.message === 'missing';
        toast(gone ? 'Esto ya no existe' : 'No se pudo guardar, probá de nuevo');
        if (gone) { close(); refetch(); }
        f.busy = false; save.disabled = false;
      }
    };
    save.addEventListener('click', submit);
    [desc, amount].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }));

    const paintDel = () => {
      delArea.replaceChildren();
      if (!g) return;
      if (!f.confirming) {
        delArea.appendChild(h('button', { class: 'btn danger block', type: 'button', onclick: () => { f.confirming = true; paintDel(); } }, 'Borrar'));
      } else {
        delArea.appendChild(h('p', null, '¿Seguro?'));
        delArea.appendChild(h('div', { class: 'row' },
          h('button', { class: 'btn danger', type: 'button', onclick: async () => {
            if (f.busy) return;
            f.busy = true;
            try { await deleteGasto(g); close(); } catch (e) { console.warn('del', e?.message); toast('No se pudo borrar, probá de nuevo'); f.busy = false; }
          } }, 'Sí, borrar'),
          h('button', { class: 'btn', type: 'button', onclick: () => { f.confirming = false; paintDel(); } }, 'No')));
      }
    };
    paintDel();
    focus(compra || g ? amount : desc);
    return h('div', { class: 'stack' },
      !compra && h('div', null, h('div', { class: 'label' }, 'Descripción'), desc),
      h('div', null, h('div', { class: 'label' }, 'Importe (€)'), amount),
      h('div', null, h('div', { class: 'label' }, '¿Quién pagó?'), payerSeg),
      !compra && !isPago && repBox,
      !compra && h('div', null, h('div', { class: 'label' }, 'Fecha'), date),
      err, save,
      compra && h('button', { class: 'btn ghost block', type: 'button', onclick: close }, 'Ahora no'),
      delArea);
  });
}

function openSaldar() {
  const half = miSaldo(), c = saldoCents(half);
  if (c === 0) return;
  const deudor = c > 0 ? other() : me(), acreedor = c > 0 ? me() : other();
  const monto = Math.abs(c);
  openConfirm('Saldar cuentas', `¿${deudor.name} le pagó ${fmtEUR(monto)} a ${acreedor.name}?`, 'Sí, saldar', async () => {
    await insertGasto({ tipo: 'pago', descripcion: 'Saldaron cuentas', monto_cent: monto, pagado_por: deudor.user_id, reparto: 'todo_otro', fecha: todayISO() });
    toast('Cuentas saldadas ✓');
  }, { primary: true, errMsg: 'No se pudo guardar, probá de nuevo' });
}

function viewGastos() {
  const o = other();
  const c = saldoCents(miSaldo());
  const sorted = [...state.gastos].sort((a, b) => (a.fecha === b.fecha ? new Date(b.created_at) - new Date(a.created_at) : a.fecha < b.fecha ? 1 : -1));
  const months = [];
  sorted.forEach((g) => {
    const k = g.fecha.slice(0, 7);
    let grp = months[months.length - 1];
    if (!grp || grp.key !== k) { grp = { key: k, rows: [] }; months.push(grp); }
    grp.rows.push(g);
  });

  const row = (g) => {
    const pagador = memberName(g.pagado_por);
    const otroN = memberName(bothIds().find((id) => id !== g.pagado_por) || g.pagado_por);
    const isPago = g.tipo === 'pago';
    const title = isPago ? `${pagador} le pagó a ${otroN}` : g.descripcion;
    const sub = isPago ? `${fechaCorta(g.fecha)} · ${g.descripcion}`
      : `${fechaCorta(g.fecha)} · pagó ${pagador} · ${g.reparto === 'mitad' ? 'mitad' : `todo para ${otroN}`}`;
    return h('li', { class: `gasto-row${isPago ? ' pago' : ''}` },
      h('div', { class: 'g-main' }, h('div', { class: 'g-title' }, title), h('div', { class: 'muted small' }, sub)),
      h('div', { class: 'g-amount' }, fmtEUR(g.monto_cent)),
      h('button', { class: 'more', type: 'button', 'aria-label': `Editar ${title}`, onclick: () => openGastoSheet({ gasto: g }) }, '⋯'));
  };

  const groups = months.map((grp) => {
    const rs = resumenGastosMes(state.gastos, grp.key);
    const parts = bothIds().map((id) => `pagó ${memberName(id)} ${fmtEUR(rs.porPagador[id] || 0)}`);
    return h('section', { class: 'group' },
      h('h2', null, cap(monthLabel(grp.key))),
      h('p', { class: 'muted small month-sum' }, rs.n
        ? `${cap(monthName(grp.key))}: gastaron ${fmtEUR(rs.total)} entre los dos · ${parts.join(' · ')}`
        : `${cap(monthName(grp.key))}: sin gastos, solo pagos`),
      h('div', { class: 'card' }, h('ul', { class: 'list tight' }, grp.rows.map(row))));
  });

  return h('div', { class: 'stack' },
    topbar('Gastos 💸'),
    h('section', { class: 'card' },
      o ? h('div', { class: 'saldo big-saldo' }, saldoLine(miSaldo())) : h('p', { class: 'muted' }, 'Cuando entre la otra persona, van a poder repartir gastos.'),
      h('div', { class: 'row card-actions' },
        c !== 0 && h('button', { class: 'btn', type: 'button', onclick: openSaldar }, 'Saldar'),
        h('button', { class: 'btn primary', type: 'button', disabled: !o, onclick: () => openGastoSheet() }, 'Cargar gasto'))),
    months.length ? groups : h('p', { class: 'nothing' }, 'Todavía no hay gastos'));
}

/* ---------- Aportes ---------- */

function periodNav(label, canPrev, canNext, onPrev, onNext) {
  return h('div', { class: 'period-nav' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Anterior', disabled: !canPrev, onclick: onPrev }, '‹'),
    h('div', { class: 'period-label' }, label),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Siguiente', disabled: !canNext, onclick: onNext }, '›'));
}

function earliestAt() {
  let min = Infinity;
  for (const a of state.actividad) { const t = new Date(a.at).getTime(); if (t < min) min = t; }
  return min;
}

function viewAportes() {
  const per = period(state.apKind, state.apOffset);
  const c = aportesDe(per);
  const canPrev = earliestAt() < per.start.getTime();
  const seg = segmented([['semana', 'Semana'], ['mes', 'Mes']], () => state.apKind, (v) => { state.apKind = v; state.apOffset = 0; render(); }, 'Período');
  return h('div', { class: 'stack' },
    topbar('Aportes 🥧'),
    h('button', { class: 'btn primary block', type: 'button', onclick: openQuehaceresSheet }, '🧹 Hice algo de la casa'),
    seg,
    periodNav(per.label, canPrev, state.apOffset > 0, () => { state.apOffset++; render(); }, () => { state.apOffset--; render(); }),
    h('section', { class: 'card pie-card' },
      pieEl(c.porActor, 'lg'),
      pieLegend(c.porActor),
      h('p', { class: 'muted' }, c.total ? `${c.total} ${c.total === 1 ? 'aporte' : 'aportes'} · así se repartió la carga` : 'Sin aportes en este período'),
      aportesTabla(c)),
    h('p', { class: 'muted small center' }, 'Cuenta desde que existe el historial. Agregar, tildar, cargar gastos, mandar mimos y las cosas de la casa suman por igual.'));
}

/* ---------- Cierre del mes ---------- */

function earliestMonthKey() {
  let min = null;
  const eat = (k) => { if (k && (min === null || k < min)) min = k; };
  state.gastos.forEach((g) => eat(g.fecha.slice(0, 7)));
  state.mimos.forEach((m) => eat(monthKey(new Date(m.created_at))));
  state.actividad.forEach((a) => eat(monthKey(new Date(a.at))));
  state.cierres.forEach((c) => eat(c.mes.slice(0, 7)));
  return min;
}

function viewCierre() {
  const key = cierreMes(), nowKey = monthKey(new Date());
  const row = cierreRow(key);
  const draft = state.cierreDraft[key] || {};
  const ids = bothIds();
  const earliest = earliestMonthKey();
  const go = (k) => { location.hash = `#/cierre/${k}`; };

  // Aportes del mes
  const offset = (() => { const a = nowKey.split('-').map(Number), b = key.split('-').map(Number); return (a[0] - b[0]) * 12 + (a[1] - b[1]); })();
  const per = period('mes', offset);
  const c = aportesDe(per);
  const aportes = h('section', { class: 'card pie-card' },
    h('div', { class: 'card-title' }, '🥧 Cómo se repartió la carga'),
    pieEl(c.porActor, 'lg'), pieLegend(c.porActor),
    h('p', { class: 'muted' }, c.total ? `${c.total} ${c.total === 1 ? 'aporte' : 'aportes'}` : 'Sin aportes registrados este mes'),
    aportesTabla(c));

  // Gastos del mes
  const rs = resumenGastosMes(state.gastos, key);
  const saldoCierre = saldoHalf(state.gastos, me().user_id, lastDayOfMonth(key));
  const gastos = h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '💸 Gastos'),
    rs.n
      ? h('div', { class: 'stack tight-stack' },
        h('p', null, `Gastaron ${fmtEUR(rs.total)} entre los dos.`),
        h('p', { class: 'muted' }, ids.map((id) => `Pagó ${memberName(id)} ${fmtEUR(rs.porPagador[id] || 0)}`).join(' · ')))
      : h('p', { class: 'muted' }, 'No hubo gastos este mes.'),
    other() && h('p', { class: 'saldo-sub' }, `Saldo al cierre del mes: ${saldoLine(saldoCierre)}`));

  // Mimos del mes
  const myId = me().user_id;
  const delMes = state.mimos.filter((m) => monthKey(new Date(m.created_at)) === key);
  const canjMes = state.mimos.filter((m) => m.canjeado && m.canjeado_at && monthKey(new Date(m.canjeado_at)) === key).length;
  const mimos = h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '💌 Mimos'),
    delMes.length || canjMes
      ? h('ul', { class: 'mimo-count' },
        Object.keys(MIMOS).map((t) => {
          const mand = delMes.filter((m) => m.tipo === t && m.de === myId).length;
          const rec = delMes.filter((m) => m.tipo === t && m.para === myId).length;
          return h('li', null, h('span', { 'aria-hidden': 'true' }, MIMOS[t].emoji), ` ${MIMOS[t].name}: mandaste ${mand} · recibiste ${rec}`);
        }),
        h('li', null, `🎟️ Vales canjeados: ${canjMes}`))
      : h('p', { class: 'muted' }, 'No hubo mimos este mes. Todavía están a tiempo 😉'));

  // Preguntas compartidas
  const areas = CIERRE_Q.map(([f, q]) => {
    const ta = h('textarea', { class: 'input cierre-area', rows: 4, maxlength: 2000, 'data-campo': f, 'aria-label': q, placeholder: 'Lo que se les ocurra, sin apuro', value: draft[f] ?? row?.[f] ?? '' });
    ta.addEventListener('input', () => { (state.cierreDraft[key] = state.cierreDraft[key] || {})[f] = ta.value; });
    ta.addEventListener('blur', async () => {
      await saveCierre(key);
      setTimeout(() => { if (!cierreAreaFocused()) render(); }, 0);
    });
    return h('div', { class: 'field' }, h('label', { class: 'q' }, q, ta));
  });
  const pendiente = Object.keys(draft).length > 0;
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' },
    pendiente ? 'Sin guardar todavía' : row ? `Guardado · lo editó ${memberName(row.updated_by)} ${timeAgo(row.updated_at)}` : 'Todavía no escribieron nada');
  const saveBtn = h('button', { class: 'btn primary block', type: 'button' }, 'Guardar');
  saveBtn.addEventListener('click', async () => { saveBtn.disabled = true; await saveCierre(key, true); render(); });
  const preguntas = h('section', { class: 'card stack' },
    h('div', { class: 'card-title' }, '🗣️ Para charlar juntos'), ...areas, status, saveBtn);

  return h('div', { class: 'stack' },
    topbar(`Cierre de ${monthLabel(key)}`),
    periodNav(cap(monthLabel(key)), !!earliest && key > earliest, key < nowKey, () => go(addMonthKey(key, -1)), () => go(addMonthKey(key, 1))),
    h('p', { class: 'muted' }, 'Un ratito para mirar el mes y charlarlo, sin examen ni culpas: qué aprendimos, qué mejoramos y en qué seguimos trabajando. Escriban acá lo que se llevan de la charla.'),
    aportes, gastos, mimos, preguntas);
}

/* ============================== Render y ruteo ========================== */

function goHome() { location.replace('#/'); } // sin apilar otra entrada en el historial

function parseRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  const [a, b] = r.split('/');
  state.route = ROUTES.includes(a) ? a : 'home';
  state.routeArg = state.route === 'cierre' && /^\d{4}-(0[1-9]|1[0-2])$/.test(b || '') ? b : null;
}

const VIEWS = { home: viewHome, super: viewSuper, tareas: viewTareas, gastos: viewGastos, aportes: viewAportes, mimos: viewMimos, cierre: viewCierre, avisos: viewAvisos };

function render() {
  const app = document.getElementById('app');
  const ready = state.phase === 'ready';
  // Escribiendo en el cierre: no repintar (se repinta al salir del campo).
  if (ready && state.loaded && state.route === 'cierre' && cierreAreaFocused()) return;
  if (ready && state.loaded) ensureSeen(); // antes de pintar, para resaltar los nuevos
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
  else if (ready) view = VIEWS[state.route]();
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

  if (ready && state.loaded && ['home', 'super', 'tareas'].includes(state.route)) {
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
    refreshPush();
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
  // Que este móvil no siga recibiendo los avisos de quien sale (sin bloquear la salida).
  try {
    if (pushSupported() && state.session) {
      const reg = await Promise.race([navigator.serviceWorker.getRegistration(), new Promise((res) => setTimeout(() => res(null), 2000))]);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await state.client.from('push_subs').delete().eq('endpoint', sub.endpoint);
        await sub.unsubscribe();
      }
    }
  } catch (e) { console.warn('signOut push', e?.message); }
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
    state.gastos = []; state.mimos = []; state.actividad = []; state.cierres = [];
    state.mimosInit = false; state.seenMimos = new Set(); state.freshMimos = new Set();
    state.cierreDraft = {}; state.cierreSeen = null;
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

  window.addEventListener('hashchange', () => {
    const prev = state.route === 'cierre' ? cierreMes() : null;
    if (prev && state.cierreDraft[prev]) saveCierre(prev); // no perder lo escrito al irse de la pantalla
    closeSheet(); parseRoute();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // si no, render() ignora el cambio con un textarea del cierre enfocado
    state.freshMimos = new Set();
    if (state.route === 'avisos') push.msg = '';
    render(); window.scrollTo(0, 0);
    if (state.route === 'avisos') refreshPush();
  });
  window.addEventListener('online', resync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { resync(); if (state.route === 'avisos' && !push.busy) refreshPush(); }
    else if (state.route === 'cierre' && state.cierreDraft[cierreMes()]) saveCierre(cierreMes());
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  setInterval(() => { if (document.visibilityState === 'visible') resync(); }, 60000);
}

parseRoute();
render();
boot();
registerSW();
