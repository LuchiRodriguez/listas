-- Listas v4 "push": avisos al móvil con la app cerrada.
-- Migración idempotente sobre v3: corré schema.sql, v2.sql y v3.sql primero, después este archivo entero en el SQL Editor.
-- El recordatorio programado del cierre va aparte, en v4_cron.sql.

-- ---------- push_subs: suscripciones push de cada móvil ----------
-- Cada uno ve y borra SOLO las suyas: los endpoints no se comparten con el otro.
-- La Edge Function las lee con la clave de servicio, que se salta RLS.
create table if not exists public.push_subs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  endpoint   text not null unique check (char_length(endpoint) between 10 and 1000 and endpoint like 'https://%'),
  p256dh     text not null check (char_length(p256dh) between 10 and 200),
  auth       text not null check (char_length(auth) between 8 and 100),
  created_at timestamptz not null default now()
);

-- ---------- push_log: deduplicación de avisos (solo la Edge Function) ----------
create table if not exists public.push_log (
  kind    text not null,
  ref     text not null,
  sent_at timestamptz not null default now(),
  primary key (kind, ref)
);

-- ---------- Funciones de trigger ----------
create or replace function public.push_subs_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.push_subs) >= 200 then
    raise exception 'Límite de suscripciones alcanzado' using errcode = 'check_violation';
  end if;
  new.user_id := auth.uid();
  return new;
end;
$$;

revoke execute on function public.push_subs_before_insert() from public, anon, authenticated;

drop trigger if exists push_subs_before_insert_trg on public.push_subs;
create trigger push_subs_before_insert_trg before insert on public.push_subs
  for each row execute function public.push_subs_before_insert();

-- ---------- RLS ----------
alter table public.push_subs enable row level security;
alter table public.push_log enable row level security;   -- sin políticas: solo la clave de servicio

drop policy if exists push_subs_select on public.push_subs;
create policy push_subs_select on public.push_subs
  for select to authenticated using (public.is_member() and user_id = auth.uid());
drop policy if exists push_subs_insert on public.push_subs;
create policy push_subs_insert on public.push_subs
  for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
drop policy if exists push_subs_delete on public.push_subs;
create policy push_subs_delete on public.push_subs
  for delete to authenticated
  using (public.is_member() and user_id = auth.uid());

-- ---------- Privilegios por columna ----------
revoke all on public.push_subs from anon, authenticated;
grant select, delete on public.push_subs to authenticated;
grant insert (endpoint, p256dh, auth) on public.push_subs to authenticated;

revoke all on public.push_log from anon, authenticated;

-- La Edge Function 'notificar' usa service_role. El proyecto se creó sin "exponer tablas
-- automáticamente", así que service_role no tiene privilegios por defecto: se dan solo los que usa.
grant select on public.members, public.items, public.gastos, public.mimos, public.cierres to service_role;
grant select, delete on public.push_subs to service_role;
grant select, insert, delete on public.push_log to service_role;
