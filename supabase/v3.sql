-- Listas v3 "quehaceres": los quehaceres de la casa suman 1 aporte cada uno.
-- Migración idempotente sobre v2: corré schema.sql y v2.sql primero, después este archivo entero en el SQL Editor.

-- ---------- actividad: detalle y tipo 'quehacer' ----------
alter table public.actividad
  add column if not exists detalle text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.actividad'::regclass and conname = 'actividad_detalle_check'
  ) then
    alter table public.actividad
      add constraint actividad_detalle_check check (detalle is null or char_length(detalle) between 1 and 40);
  end if;

  -- El check de tipo de v2 (nombre por defecto de Postgres) se reemplaza por uno que acepta 'quehacer'.
  alter table public.actividad drop constraint if exists actividad_tipo_check;
  alter table public.actividad
    add constraint actividad_tipo_check
    check (tipo in ('agrego_super', 'creo_tarea', 'completo_tarea', 'compro', 'gasto', 'mimo', 'quehacer'));
end $$;

-- ---------- quehaceres ----------
create table if not exists public.quehaceres (
  id       uuid primary key default gen_random_uuid(),
  quien    uuid not null default auth.uid() references public.members (user_id) on delete cascade,
  que      text not null check (char_length(btrim(que)) between 1 and 40),
  hecho_el timestamptz not null default now()
);
create index if not exists quehaceres_hecho_idx on public.quehaceres (hecho_el);

-- ---------- Funciones de trigger ----------
create or replace function public.quehaceres_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.quehaceres) >= 20000 then
    raise exception 'Límite de quehaceres alcanzado' using errcode = 'check_violation';
  end if;
  new.quien := auth.uid();
  new.hecho_el := now();
  new.que := btrim(new.que);
  return new;
end;
$$;

create or replace function public.actividad_quehaceres_ins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.quien is not null then
    insert into public.actividad (actor, tipo, item_id, detalle)
    values (new.quien, 'quehacer', new.id, new.que);
  end if;
  return new;
end;
$$;

create or replace function public.actividad_quehaceres_del()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.actividad where item_id = old.id and tipo = 'quehacer';
  return old;
end;
$$;

revoke execute on function public.quehaceres_before_insert() from public, anon, authenticated;
revoke execute on function public.actividad_quehaceres_ins() from public, anon, authenticated;
revoke execute on function public.actividad_quehaceres_del() from public, anon, authenticated;

-- ---------- Triggers ----------
drop trigger if exists quehaceres_before_insert_trg on public.quehaceres;
create trigger quehaceres_before_insert_trg before insert on public.quehaceres
  for each row execute function public.quehaceres_before_insert();

drop trigger if exists actividad_quehaceres_ins_trg on public.quehaceres;
create trigger actividad_quehaceres_ins_trg after insert on public.quehaceres
  for each row execute function public.actividad_quehaceres_ins();

drop trigger if exists actividad_quehaceres_del_trg on public.quehaceres;
create trigger actividad_quehaceres_del_trg after delete on public.quehaceres
  for each row execute function public.actividad_quehaceres_del();

-- ---------- RLS ----------
alter table public.quehaceres enable row level security;

drop policy if exists quehaceres_select on public.quehaceres;
create policy quehaceres_select on public.quehaceres
  for select to authenticated using (public.is_member());
drop policy if exists quehaceres_insert on public.quehaceres;
create policy quehaceres_insert on public.quehaceres
  for insert to authenticated
  with check (public.is_member() and quien = auth.uid());
drop policy if exists quehaceres_delete on public.quehaceres;
create policy quehaceres_delete on public.quehaceres
  for delete to authenticated
  using (public.is_member() and quien = auth.uid());

-- ---------- Privilegios por columna ----------
revoke all on public.quehaceres from anon, authenticated;
grant select, delete on public.quehaceres to authenticated;
grant insert (que) on public.quehaceres to authenticated;

-- actividad sigue siendo solo lectura para el cliente (detalle incluido)
revoke all on public.actividad from anon, authenticated;
grant select on public.actividad to authenticated;

-- ---------- Realtime ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'quehaceres'
  ) then
    alter publication supabase_realtime add table public.quehaceres;
  end if;
end $$;
