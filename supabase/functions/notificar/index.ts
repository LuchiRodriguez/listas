// Listas v4: Edge Function 'notificar'. Manda avisos push a los móviles suscriptos.
// Un solo archivo, pensado para pegarse en el editor del dashboard de Supabase.
// Despliegue con la verificación de JWT APAGADA (el cron llama sin token): la función verifica sola.
// Secret requerido: VAPID_PRIVATE_KEY. SUPABASE_URL y SUPABASE_SECRET_KEYS (o SUPABASE_SERVICE_ROLE_KEY) los pone Supabase.

// ===================== LÓGICA PURA (sin imports ni red; se prueba aparte) =====================

export const VAPID_PUBLIC =
  'BHBRC0mjMoNOl-X_wibMUak2byccPaQqr-0yVcr2oRHKIAy--I3g94omqS55y_2NrOZ7ZRc2NDVLHf461i3I5to';
export const VAPID_SUBJECT = 'https://luchirodriguez.github.io/listas/';
export const ALLOWED_ORIGINS = ['https://luchirodriguez.github.io', 'http://localhost:5200'];
export const MAX_BODY_BYTES = 2048;
export const VENTANA_MS = 10 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS_USUARIO = ['mimo', 'tarea', 'gasto', 'prueba'];
const KINDS = ['mimo', 'tarea', 'gasto', 'prueba', 'cierre'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export type Pedido = { kind: string; id: string | null };

// Valida el texto del body: tamaño, JSON, kind conocido y uuid (si el kind lo pide).
export function validarBody(texto: string): { ok: true; pedido: Pedido } | { ok: false } {
  if (typeof texto !== 'string' || texto.length === 0) return { ok: false };
  if (new TextEncoder().encode(texto).length >= MAX_BODY_BYTES) return { ok: false };
  let b: unknown;
  try { b = JSON.parse(texto); } catch { return { ok: false }; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false };
  const { kind, id } = b as { kind?: unknown; id?: unknown };
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return { ok: false };
  if (kind === 'mimo' || kind === 'tarea' || kind === 'gasto') {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return { ok: false };
    return { ok: true, pedido: { kind, id: id.toLowerCase() } };
  }
  return { ok: true, pedido: { kind, id: null } };
}

export function requiereUsuario(kind: string): boolean {
  return KINDS_USUARIO.includes(kind);
}

export function reciente(createdAt: string, ahora: number = Date.now()): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  const edad = ahora - t;
  return edad >= -60_000 && edad < VENTANA_MS;
}

export function formatEUR(cent: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cent / 100);
}

export function textoMimo(m: { tipo: string; texto: string | null }, de: string): string {
  const t = m.texto ? m.texto.trim() : '';
  switch (m.tipo) {
    case 'corazon': return `❤️ ${de} te mandó un corazón`;
    case 'beso': return `💋 ${de} te mandó un beso`;
    case 'gracias': return `🙏 ${de} te dio las gracias` + (t ? `: ${t}` : '');
    case 'vale': return `🎁 ${de} te regaló: ${t}`;
    default: return `💌 ${de} te mandó un mimo`;
  }
}

export function textoTarea(t: { text: string; bucket: string | null }, de: string): string {
  const cuando = t.bucket === 'hoy' ? 'hoy' : t.bucket === 'semana' ? 'esta semana' : 'algún día';
  return `📋 ${de} te asignó: ${t.text.trim()} (${cuando})`;
}

// quien = quien cargó el gasto; otro = el destinatario.
export function textoGasto(
  g: { tipo: string; descripcion: string; monto_cent: number; pagado_por: string; reparto: string },
  quien: { id: string; name: string },
  otro: { id: string; name: string },
): string {
  const importe = formatEUR(g.monto_cent);
  if (g.tipo === 'pago') {
    const pago = g.pagado_por === quien.id ? quien : otro;
    const recibe = pago === quien ? otro : quien;
    return `🤝 ${pago.name} le pagó ${importe} a ${recibe.name}`;
  }
  let reparto = ' · mitad';
  if (g.reparto === 'todo_otro') {
    // 'todo_otro': el gasto es todo de quien NO pagó.
    reparto = g.pagado_por === quien.id ? ' · todo para vos' : ` · todo para ${quien.name}`;
  }
  return `💸 ${quien.name} cargó ${g.descripcion.trim()}: ${importe}${reparto}`;
}

// Fecha de hoy en Europe/Madrid.
export function fechaMadrid(ahora: Date): { y: number; m: number; d: number; dow: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(ahora);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), dow: get('weekday') };
}

// Si hoy (Madrid) es el sábado del último fin de semana del mes, devuelve el mes; si no, null.
// "Último fin de semana" = el sábado cuyo sábado siguiente ya cae en el mes que viene.
export function mesDelCierre(ahora: Date): { mes: string; mesDate: string; nombre: string } | null {
  const { y, m, d, dow } = fechaMadrid(ahora);
  if (dow !== 'Sat') return null;
  const mas7 = new Date(Date.UTC(y, m - 1, d + 7));
  if (mas7.getUTCMonth() === m - 1) return null;
  const mm = String(m).padStart(2, '0');
  return { mes: `${y}-${mm}`, mesDate: `${y}-${mm}-01`, nombre: MESES[m - 1] };
}

export function textoCierre(nombreMes: string): string {
  return `🗓️ Es finde de cierre de ${nombreMes}. ¿Se hacen un rato para charlarlo?`;
}

export function cierreVacio(c: { aprendimos?: string; mejoramos?: string; trabajando?: string } | null): boolean {
  if (!c) return true;
  return [c.aprendimos, c.mejoramos, c.trabajando].every((x) => !x || x.trim() === '');
}

// ===================== FIN LÓGICA PURA =====================

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const ERR_GENERICO = 'No se pudo enviar el aviso';

function claveAdmin(): string | null {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        const k = o['default'] ?? Object.values(o)[0];
        if (typeof k === 'string' && k) return k;
      }
    } catch { /* se prueba la clave vieja */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function responder(status: number, cuerpo: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/** Lee el body cortando a MAX_BODY_BYTES (el Content-Length no sirve con chunked). Devuelve '' si se pasa. */
async function leerLimitado(req: Request): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total >= MAX_BODY_BYTES) { await reader.cancel(); return ''; }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let off = 0;
  for (const p of partes) { todo.set(p, off); off += p.length; }
  return new TextDecoder().decode(todo);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return responder(405, { error: 'Método no permitido' }, origin);

  try {
    const largo = Number(req.headers.get('content-length') ?? '0');
    if (largo >= MAX_BODY_BYTES) return responder(400, { error: 'Pedido inválido' }, origin);
    const v = validarBody(await leerLimitado(req));
    if (!v.ok) return responder(400, { error: 'Pedido inválido' }, origin);
    const { kind, id } = v.pedido;

    const url = Deno.env.get('SUPABASE_URL');
    const clave = claveAdmin();
    const vapidPriv = Deno.env.get('VAPID_PRIVATE_KEY');
    if (!url || !clave || !vapidPriv) {
      console.error('notificar: falta configuración (SUPABASE_URL, clave secreta o VAPID_PRIVATE_KEY)');
      return responder(500, { error: ERR_GENERICO }, origin);
    }
    const admin = createClient(url, clave, { auth: { persistSession: false, autoRefreshToken: false } });

    // 'cierre' sin token: si hoy no corresponde, responder sin tocar la base.
    const cierreHoy = kind === 'cierre' ? mesDelCierre(new Date()) : null;
    if (kind === 'cierre' && !cierreHoy) return responder(200, { sent: 0, removed: 0, motivo: 'hoy no es el sábado del cierre' }, origin);

    // ---- quién llama (antes de tocar la base) ----
    let caller: string | null = null;
    if (requiereUsuario(kind)) {
      const auth = req.headers.get('authorization') ?? '';
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      if (!token) return responder(401, { error: 'No autorizado' }, origin);
      const { data: u, error: eAuth } = await admin.auth.getUser(token);
      if (eAuth || !u?.user) return responder(401, { error: 'No autorizado' }, origin);
      caller = u.user.id;
    }

    const { data: miembros, error: eMiembros } = await admin.from('members').select('user_id, name');
    if (eMiembros || !miembros) throw eMiembros ?? new Error('members vacío');
    const nombre = (uid: string) => miembros.find((m: { user_id: string }) => m.user_id === uid)?.name ?? 'Alguien';
    if (caller && !miembros.some((m: { user_id: string }) => m.user_id === caller)) {
      return responder(403, { error: 'No autorizado' }, origin);
    }

    // ---- armar destino y texto ----
    let destinos: string[] = [];
    let cuerpo = '';
    let urlApp = './';
    let ref = '';

    if (kind === 'mimo') {
      const { data: m } = await admin.from('mimos').select('id, de, para, tipo, texto, created_at').eq('id', id).maybeSingle();
      if (!m || m.de !== caller || !reciente(m.created_at)) return responder(404, { error: 'No encontrado' }, origin);
      destinos = [m.para];
      cuerpo = textoMimo(m, nombre(m.de));
      urlApp = './#/mimos';
      ref = m.id;
    } else if (kind === 'tarea') {
      const { data: t } = await admin.from('items')
        .select('id, list, text, bucket, assignee, created_by, created_at').eq('id', id).maybeSingle();
      if (!t || t.list !== 'tareas' || t.created_by !== caller || !t.assignee || t.assignee === caller || !reciente(t.created_at)) {
        return responder(404, { error: 'No encontrado' }, origin);
      }
      destinos = [t.assignee];
      cuerpo = textoTarea(t, nombre(caller!));
      urlApp = './#/tareas';
      ref = t.id;
    } else if (kind === 'gasto') {
      const { data: g } = await admin.from('gastos')
        .select('id, tipo, descripcion, monto_cent, pagado_por, reparto, created_by, created_at').eq('id', id).maybeSingle();
      if (!g || g.created_by !== caller || !reciente(g.created_at)) return responder(404, { error: 'No encontrado' }, origin);
      const otro = miembros.find((m: { user_id: string }) => m.user_id !== caller);
      if (!otro) return responder(200, { sent: 0, removed: 0, motivo: 'sin destinatario' }, origin);
      destinos = [otro.user_id];
      cuerpo = textoGasto(g, { id: caller!, name: nombre(caller!) }, { id: otro.user_id, name: otro.name });
      urlApp = './#/gastos';
      ref = g.id;
    } else if (kind === 'prueba') {
      destinos = [caller!];
      cuerpo = '🔔 Listo, así te van a llegar los avisos';
      urlApp = './#/avisos';
      ref = `${caller}:${Math.floor(Date.now() / 60000)}`;
      // Limpieza barata del log (todo lo de más de 30 días).
      await admin.from('push_log').delete().lt('sent_at', new Date(Date.now() - 30 * 86_400_000).toISOString());
    } else {
      // cierre
      const c = cierreHoy!;
      const { data: cierre } = await admin.from('cierres').select('aprendimos, mejoramos, trabajando').eq('mes', c.mesDate).maybeSingle();
      if (!cierreVacio(cierre)) return responder(200, { sent: 0, removed: 0, motivo: 'el cierre ya tiene respuestas' }, origin);
      destinos = miembros.map((m: { user_id: string }) => m.user_id);
      cuerpo = textoCierre(c.nombre);
      urlApp = `./#/cierre/${c.mes}`;
      ref = c.mes;
    }

    // ---- deduplicación: siempre antes de enviar ----
    const { error: eLog } = await admin.from('push_log').insert({ kind, ref });
    if (eLog) {
      if (eLog.code === '23505') return responder(200, { sent: 0, removed: 0, motivo: 'ya enviado' }, origin);
      throw eLog;
    }

    // ---- envío ----
    // Si falla por algo transitorio, se libera la reserva del log para que se pueda reintentar.
    const liberar = async () => {
      try { await admin.from('push_log').delete().eq('kind', kind).eq('ref', ref); } catch (e2) { console.error('notificar: no se pudo liberar el log'); }
    };
    let sent = 0;
    let removed = 0;
    let failed = 0;
    try {
      const { data: subs, error: eSubs } = await admin.from('push_subs').select('id, endpoint, p256dh, auth').in('user_id', destinos);
      if (eSubs) throw eSubs;

      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, vapidPriv);
      const payload = JSON.stringify({ title: 'Listas', body: cuerpo, url: urlApp, tag: `${kind}-${ref}` });
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            const { error: eDel } = await admin.from('push_subs').delete().eq('id', s.id);
            if (!eDel) removed++;
          } else {
            failed++;
            console.error('notificar: fallo de envío, status', status);
          }
        }
      }
    } catch (e) {
      await liberar();
      throw e;
    }
    if (sent === 0) await liberar(); // nadie recibió nada: que se pueda reintentar (p. ej. aún sin suscriptos)
    return responder(200, { sent, removed, failed }, origin);
  } catch (e) {
    console.error('notificar: error', e instanceof Error ? e.message : e);
    return responder(500, { error: ERR_GENERICO }, origin);
  }
});
