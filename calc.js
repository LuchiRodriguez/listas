// Listas v2 — cálculos puros (plata, semanas, meses, aportes). Sin DOM ni red: se puede probar con node.

export const TIPOS_APORTE = [
  ['agrego_super', 'Agregar al súper'],
  ['creo_tarea', 'Crear tareas'],
  ['completo_tarea', 'Completar tareas'],
  ['compro', 'Hacer la compra'],
  ['gasto', 'Cargar gastos'],
  ['mimo', 'Mimos'],
];

export const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/* ------------------------------- Plata -------------------------------- */

/** "23,40" o "23.40" → céntimos enteros. null si no vale (> 0, ≤ 100000, hasta 2 decimales). */
export function parseEuros(s) {
  let t = String(s ?? '').trim().replace(/\s/g, '').replace(/€$/, '');
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, ''); // 1.234,50
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(t)) return null;
  const [ent, dec = ''] = t.replace(',', '.').split('.');
  const cents = Number(ent) * 100 + Number((dec + '00').slice(0, 2));
  return cents >= 1 && cents <= 10000000 ? cents : null;
}

export const fmtEUR = (cents) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);

/** Céntimos → texto para un input ("23,40"). */
export function centsToInput(cents) {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

/** Lo que el que NO pagó le debe al que pagó, en medios céntimos (así 'mitad' con monto impar es exacto). */
export function halfDebt(g) {
  return g.reparto === 'todo_otro' ? g.monto_cent * 2 : g.monto_cent;
}

/** Saldo de `myId` en medios céntimos: >0 el otro me debe; <0 yo le debo. `hasta` = fecha 'AAAA-MM-DD' inclusive. */
export function saldoHalf(gastos, myId, hasta = null) {
  let s = 0;
  for (const g of gastos) {
    if (hasta && g.fecha > hasta) continue;
    s += (g.pagado_por === myId ? 1 : -1) * halfDebt(g);
  }
  return s;
}

/** Medios céntimos → céntimos con signo, redondeado solo para mostrar. Medio céntimo suelto = a mano. */
export function saldoCents(half) {
  if (Math.abs(half) <= 1) return 0;
  return Math.sign(half) * Math.round(Math.abs(half) / 2);
}

/* ------------------------------- Fechas ------------------------------- */

const p2 = (n) => String(n).padStart(2, '0');
export const localISODate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const monthKey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
export const parseMonthKey = (k) => ({ y: Number(k.slice(0, 4)), m: Number(k.slice(5, 7)) });
export const addMonthKey = (k, n) => {
  const { y, m } = parseMonthKey(k);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${p2((t % 12) + 1)}`;
};
export const monthLabel = (k) => `${MESES[parseMonthKey(k).m - 1]} ${parseMonthKey(k).y}`;
export const monthName = (k) => MESES[parseMonthKey(k).m - 1];
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const lastDayOfMonth = (k) => {
  const { y, m } = parseMonthKey(k);
  return `${k}-${p2(new Date(y, m, 0).getDate())}`;
};
export function fechaCorta(fecha) {
  const [, m, d] = fecha.split('-').map(Number);
  return `${d} ${MESES_CORTOS[m - 1]}`;
}

export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Lunes 00:00 local de la semana de `d`. */
export function weekStart(d) {
  const dow = (d.getDay() + 6) % 7; // lunes = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
}

/** Período de aportes: semana (lunes a domingo) o mes, `offset` períodos hacia atrás (0 = actual). */
export function period(kind, offset, now = new Date()) {
  if (kind === 'mes') {
    const k = addMonthKey(monthKey(now), -offset);
    const { y, m } = parseMonthKey(k);
    return { kind, start: new Date(y, m - 1, 1), end: new Date(y, m, 1), label: offset === 0 ? 'Este mes' : cap(monthLabel(k)) };
  }
  const start = addDays(weekStart(now), -7 * offset);
  const end = addDays(start, 7);
  const last = addDays(end, -1);
  const label = offset === 0 ? 'Esta semana'
    : start.getMonth() === last.getMonth()
      ? `${start.getDate()} – ${last.getDate()} de ${MESES[last.getMonth()]}`
      : `${start.getDate()} ${MESES_CORTOS[start.getMonth()]} – ${last.getDate()} ${MESES_CORTOS[last.getMonth()]}`;
  return { kind, start, end, label };
}

/* ------------------------------ Aportes ------------------------------- */

/** { total, porActor: {id: n}, porTipo: {tipo: {id: n}} } de las filas de actividad dentro de [start, end). */
export function contarAportes(actividad, start, end, actores) {
  const out = { total: 0, porActor: {}, porTipo: {} };
  actores.forEach((a) => { out.porActor[a] = 0; });
  const t0 = start.getTime(), t1 = end.getTime();
  for (const r of actividad) {
    const t = new Date(r.at).getTime();
    if (t < t0 || t >= t1 || !(r.actor in out.porActor)) continue;
    out.total++;
    out.porActor[r.actor]++;
    const pt = (out.porTipo[r.tipo] = out.porTipo[r.tipo] || {});
    pt[r.actor] = (pt[r.actor] || 0) + 1;
  }
  return out;
}

/** Porcentajes enteros que suman 100 (con dos personas; con una sola, 100). */
export function porcentajes(porActor, ids) {
  const total = ids.reduce((s, id) => s + (porActor[id] || 0), 0);
  if (!total) return ids.map(() => 0);
  const out = ids.map((id) => Math.round((100 * (porActor[id] || 0)) / total));
  if (ids.length === 2) out[1] = 100 - out[0];
  return out;
}

/* -------------------------------- Cierre ------------------------------ */

/** Mes por defecto de #/cierre: el anterior los días 1–7, si no el actual. */
export function mesCierrePorDefecto(now = new Date()) {
  const k = monthKey(now);
  return now.getDate() <= 7 ? addMonthKey(k, -1) : k;
}

/** Mes al que apunta la tarjeta del inicio, o null si hoy no es finde de cierre. */
export function mesFindeDeCierre(now = new Date()) {
  const dow = now.getDay();
  if (dow !== 0 && dow !== 6) return null;
  if (now.getDate() <= 7) return addMonthKey(monthKey(now), -1);
  const next = addDays(now, 7);
  return next.getMonth() !== now.getMonth() ? monthKey(now) : null;
}

/** Gastado en el mes por tipo 'gasto' (por fecha): { total, porPagador: {id: cents} }. */
export function resumenGastosMes(gastos, key) {
  const out = { total: 0, n: 0, porPagador: {} };
  for (const g of gastos) {
    if (g.tipo !== 'gasto' || !g.fecha.startsWith(key)) continue;
    out.total += g.monto_cent; out.n++;
    out.porPagador[g.pagado_por] = (out.porPagador[g.pagado_por] || 0) + g.monto_cent;
  }
  return out;
}
