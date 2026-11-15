-- Listas: esquema de Supabase (Postgres 15+). Idempotente: se puede correr de nuevo.
-- Pegalo entero en el SQL Editor de Supabase.

-- ---------- Tablas ----------
create table if not exists public.members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 20),
  color      text not null default '#ffd9c7' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id         uuid primary key default gen_random_uuid(),
  list       text not null check (list in ('super', 'tareas')),
  text       text not null check (char_length(btrim(text)) between 1 and 120),
  done       boolean not null default false,
  done_at    timestamptz,                       -- lo mantiene el trigger
  bucket     text check (bucket in ('hoy', 'semana', 'algun_dia')),
  assignee   uuid references public.members (user_id) on delete set null,  -- null = los dos
  created_by uuid not null default auth.uid() references public.members (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- coherencia: el súper no lleva bucket ni responsable; las tareas siempre llevan bucket
  constraint items_coherencia check (
    (list = 'super' and bucket is null and assignee is null)
    or (list = 'tareas' and bucket is not null)
  )
);

create index if not exists items_list_done_idx on public.items (list, done);
create index if not exists items_created_at_idx on public.items (created_at);

-- ---------- Funciones ----------
create or replace function public.is_member()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;

revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- Mantiene updated_at, done_at y (al insertar) created_by.
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
  else
    if new.done and not old.done then
      new.done_at := now();
    elsif not new.done then
      new.done_at := null;
    else
      new.done_at := old.done_at;
    end if;
  end if;
  return new;
end;
$$;

-- Tope anti-abuso: máximo 1000 filas en items.
create or replace function public.items_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.items) >= 1000 then
    raise exception 'Límite de items alcanzado' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.items_before_write() from public, anon, authenticated;
revoke execute on function public.items_cap() from public, anon, authenticated;

drop trigger if exists items_cap_trg on public.items;
create trigger items_cap_trg before insert on public.items
  for each row execute function public.items_cap();

drop trigger if exists items_write_trg on public.items;
create trigger items_write_trg before insert or update on public.items
  for each row execute function public.items_before_write();

-- ---------- RLS ----------
alter table public.members enable row level security;
alter table public.items enable row level security;

drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (public.is_member());

drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select to authenticated using (public.is_member());

drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());

drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete to authenticated using (public.is_member());

-- ---------- Privilegios por columna ----------
revoke all on public.members from anon, authenticated;
revoke all on public.items from anon, authenticated;
grant select on public.members to authenticated;
grant select, delete on public.items to authenticated;
grant insert (list, text, bucket, assignee) on public.items to authenticated;
grant update (text, done, bucket, assignee) on public.items to authenticated;

-- ---------- Realtime ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;
