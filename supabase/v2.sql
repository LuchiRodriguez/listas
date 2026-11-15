-- Listas v2 "convivencia": gastos, aportes, mimos y cierre de mes.
-- Migración idempotente sobre v1: corré schema.sql primero, después este archivo entero en el SQL Editor.

-- ---------- items.done_by ----------
alter table public.items
  add column if not exists done_by uuid references public.members (user_id) on delete set null;

-- Reescribe el trigger de v1 conservando todo y sumando done_by.
create or replace function public.items_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.done_at := case when new.done then now() else null end;
    new.done_by := case when new.done then auth.uid() else null end;
  else
    if new.done and not old.done then
      new.done_at := now();
      new.done_by := auth.uid();
    elsif not new.done then
      new.done_at := null;
      new.done_by := null;
    else
      new.done_at := old.done_at;
      new.done_by := old.done_by;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.items_before_write() from public, anon, authenticated;

-- ---------- actividad ----------
create table if not exists public.actividad (
  id      bigint generated always as identity primary key,
  actor   uuid not null references public.members (user_id) on delete cascade,
  tipo    text not null check (tipo in ('agrego_super', 'creo_tarea', 'completo_tarea', 'compro', 'gasto', 'mimo')),
  item_id uuid null,
  at      timestamptz not null default now()
);
create index if not exists actividad_at_idx on public.actividad (at);
create index if not exists actividad_item_idx on public.actividad (item_id);

-- ---------- gastos ----------
create table if not exists public.gastos (
  id          uuid primary key default gen_random_uuid(),
  tipo        text not null default 'gasto' check (tipo in ('gasto', 'pago')),
  descripcion text not null check (char_length(btrim(descripcion)) between 1 and 80),
  monto_cent  integer not null check (monto_cent between 1 and 10000000),
  pagado_por  uuid not null references public.members (user_id),
  reparto     text not null default 'mitad' check (reparto in ('mitad', 'todo_otro')),
  fecha       date not null default current_date,
  created_by  uuid not null default auth.uid() references public.members (user_id),
  created_at  timestamptz not null default now(),
  constraint gastos_pago_reparto check (tipo = 'gasto' or reparto = 'todo_otro')
);
create index if not exists gastos_fecha_idx on public.gastos (fecha);

-- ---------- mimos ----------
create table if not exists public.mimos (
  id          uuid primary key default gen_random_uuid(),
  de          uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  para        uuid not null references public.members (user_id) on delete cascade,
  tipo        text not null check (tipo in ('corazon', 'beso', 'gracias', 'vale')),
  texto       text null check (texto is null or char_length(btrim(texto)) between 1 and 80),
  visto       boolean not null default false,
  canjeado    boolean not null default false,
  canjeado_at timestamptz null,
  created_at  timestamptz not null default now(),
  constraint mimos_no_a_uno check (de <> para),
  constraint mimos_vale_texto check (tipo <> 'vale' or texto is not null),
  constraint mimos_canje_solo_vale check (tipo = 'vale' or canjeado = false)
);
create index if not exists mimos_para_idx on public.mimos (para, visto);

-- ---------- cierres ----------
create table if not exists public.cierres (
  mes         date primary key check (extract(day from mes) = 1),
  aprendimos  text not null default '' check (char_length(aprendimos) <= 2000),
  mejoramos   text not null default '' check (char_length(mejoramos) <= 2000),
  trabajando  text not null default '' check (char_length(trabajando) <= 2000),
  updated_by  uuid null references public.members (user_id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ---------- Funciones de trigger ----------
create or replace function public.gastos_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.gastos) >= 5000 then
    raise exception 'Límite de gastos alcanzado' using errcode = 'check_violation';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

create or replace function public.mimos_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.mimos) >= 5000 then
    raise exception 'Límite de mimos alcanzado' using errcode = 'check_violation';
  end if;
  new.de := auth.uid();
  new.visto := false;
  new.canjeado := false;
  new.canjeado_at := null;
  return new;
end;
$$;

create or replace function public.mimos_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.canjeado and not old.canjeado then
    new.canjeado_at := now();
  elsif not new.canjeado then
    new.canjeado_at := null;
  else
    new.canjeado_at := old.canjeado_at;
  end if;
  return new;
end;
$$;

create or replace function public.cierres_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

-- Escriben en actividad: security definer; si el actor es null (SQL editor) no insertan.
create or replace function public.actividad_items_ins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.actividad (actor, tipo, item_id)
    values (new.created_by, case when new.list = 'super' then 'agrego_super' else 'creo_tarea' end, new.id);
  end if;
  return new;
end;
$$;

create or replace function public.actividad_items_upd()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.done and not old.done then
    if new.done_by is not null then
      insert into public.actividad (actor, tipo, item_id)
      values (new.done_by, case when new.list = 'super' then 'compro' else 'completo_tarea' end, new.id);
    end if;
  elsif old.done and not new.done then
    delete from public.actividad where item_id = new.id and tipo in ('compro', 'completo_tarea');
  end if;
  return new;
end;
$$;

create or replace function public.actividad_gastos_ins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tipo = 'gasto' and new.created_by is not null then
    insert into public.actividad (actor, tipo) values (new.created_by, 'gasto');
  end if;
  return new;
end;
$$;

create or replace function public.actividad_mimos_ins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.de is not null then
    insert into public.actividad (actor, tipo) values (new.de, 'mimo');
  end if;
  return new;
end;
$$;

revoke execute on function public.gastos_before_insert() from public, anon, authenticated;
revoke execute on function public.mimos_before_insert() from public, anon, authenticated;
revoke execute on function public.mimos_before_update() from public, anon, authenticated;
revoke execute on function public.cierres_before_write() from public, anon, authenticated;
revoke execute on function public.actividad_items_ins() from public, anon, authenticated;
revoke execute on function public.actividad_items_upd() from public, anon, authenticated;
revoke execute on function public.actividad_gastos_ins() from public, anon, authenticated;
revoke execute on function public.actividad_mimos_ins() from public, anon, authenticated;

-- ---------- Triggers ----------
drop trigger if exists gastos_before_insert_trg on public.gastos;
create trigger gastos_before_insert_trg before insert on public.gastos
  for each row execute function public.gastos_before_insert();

drop trigger if exists mimos_before_insert_trg on public.mimos;
create trigger mimos_before_insert_trg before insert on public.mimos
  for each row execute function public.mimos_before_insert();

drop trigger if exists mimos_before_update_trg on public.mimos;
create trigger mimos_before_update_trg before update on public.mimos
  for each row execute function public.mimos_before_update();

drop trigger if exists cierres_write_trg on public.cierres;
create trigger cierres_write_trg before insert or update on public.cierres
  for each row execute function public.cierres_before_write();

drop trigger if exists actividad_items_ins_trg on public.items;
create trigger actividad_items_ins_trg after insert on public.items
  for each row execute function public.actividad_items_ins();

drop trigger if exists actividad_items_upd_trg on public.items;
create trigger actividad_items_upd_trg after update of done on public.items
  for each row execute function public.actividad_items_upd();

drop trigger if exists actividad_gastos_ins_trg on public.gastos;
create trigger actividad_gastos_ins_trg after insert on public.gastos
  for each row execute function public.actividad_gastos_ins();

drop trigger if exists actividad_mimos_ins_trg on public.mimos;
create trigger actividad_mimos_ins_trg after insert on public.mimos
  for each row execute function public.actividad_mimos_ins();

-- ---------- RLS ----------
alter table public.actividad enable row level security;
alter table public.gastos enable row level security;
alter table public.mimos enable row level security;
alter table public.cierres enable row level security;

drop policy if exists actividad_select on public.actividad;
create policy actividad_select on public.actividad
  for select to authenticated using (public.is_member());

drop policy if exists gastos_select on public.gastos;
create policy gastos_select on public.gastos
  for select to authenticated using (public.is_member());
drop policy if exists gastos_insert on public.gastos;
create policy gastos_insert on public.gastos
  for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists gastos_update on public.gastos;
create policy gastos_update on public.gastos
  for update to authenticated
  using (public.is_member()) with check (public.is_member());
drop policy if exists gastos_delete on public.gastos;
create policy gastos_delete on public.gastos
  for delete to authenticated using (public.is_member());

drop policy if exists mimos_select on public.mimos;
create policy mimos_select on public.mimos
  for select to authenticated using (public.is_member());
drop policy if exists mimos_insert on public.mimos;
create policy mimos_insert on public.mimos
  for insert to authenticated
  with check (public.is_member() and de = auth.uid() and para <> auth.uid());
drop policy if exists mimos_update on public.mimos;
create policy mimos_update on public.mimos
  for update to authenticated
  using (public.is_member() and para = auth.uid())
  with check (public.is_member() and para = auth.uid());
drop policy if exists mimos_delete on public.mimos;
create policy mimos_delete on public.mimos
  for delete to authenticated
  using (public.is_member() and de = auth.uid());

drop policy if exists cierres_select on public.cierres;
create policy cierres_select on public.cierres
  for select to authenticated using (public.is_member());
drop policy if exists cierres_insert on public.cierres;
create policy cierres_insert on public.cierres
  for insert to authenticated with check (public.is_member());
drop policy if exists cierres_update on public.cierres;
create policy cierres_update on public.cierres
  for update to authenticated
  using (public.is_member()) with check (public.is_member());

-- ---------- Privilegios por columna ----------
revoke all on public.actividad from anon, authenticated;
revoke all on public.gastos from anon, authenticated;
revoke all on public.mimos from anon, authenticated;
revoke all on public.cierres from anon, authenticated;

grant select on public.actividad to authenticated;

grant select, delete on public.gastos to authenticated;
grant insert (tipo, descripcion, monto_cent, pagado_por, reparto, fecha) on public.gastos to authenticated;
grant update (descripcion, monto_cent, pagado_por, reparto, fecha) on public.gastos to authenticated;

grant select, delete on public.mimos to authenticated;
grant insert (para, tipo, texto) on public.mimos to authenticated;
grant update (visto, canjeado) on public.mimos to authenticated;

grant select on public.cierres to authenticated;
grant insert (mes, aprendimos, mejoramos, trabajando) on public.cierres to authenticated;
grant update (aprendimos, mejoramos, trabajando) on public.cierres to authenticated;

-- ---------- Realtime ----------
do $$
declare t text;
begin
  foreach t in array array['gastos', 'mimos', 'cierres', 'actividad'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
