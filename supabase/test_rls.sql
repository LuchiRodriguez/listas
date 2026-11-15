-- Prueba de RLS y privilegios. Pegalo en el SQL Editor de Supabase (corre como postgres).
-- Todo ocurre en una transacción que termina en ROLLBACK: no deja rastro. Se puede correr con datos reales:
-- los chequeos miran solo las filas de prueba. Si no aparece ningún error, pasó todo.
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@test.invalid', now(), now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@test.invalid', now(), now()),
  ('cccccccc-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@test.invalid', now(), now());

insert into public.members (user_id, name, color) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'A', '#ffd9c7'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'B', '#c7e0ff');

-- ===== A (miembro) =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare n int; r record;
begin
  insert into public.items (list, text) values ('super', 'leche');
  insert into public.items (list, text, bucket, assignee) values ('tareas', 'llamar', 'hoy', null);
  select count(*) into n from public.items where text in ('leche', 'llamar');
  if n <> 2 then raise exception 'A deberia ver 2 items de prueba, ve %', n; end if;
  select * into r from public.items where text = 'leche' and created_by = 'aaaaaaaa-0000-0000-0000-000000000001';
  if r.created_by <> 'aaaaaaaa-0000-0000-0000-000000000001' then raise exception 'created_by mal'; end if;
  if r.done_at is not null then raise exception 'done_at deberia ser null'; end if;
end $$;

-- A no puede insertar a nombre de B
do $$
begin
  begin
    insert into public.items (list, text, created_by) values ('super', 'x', 'bbbbbbbb-0000-0000-0000-000000000002');
    raise exception 'A pudo insertar created_by = B';
  exception when insufficient_privilege then null; end;
end $$;

-- Nadie puede escribir columnas protegidas
do $$
begin
  begin
    update public.items set created_by = 'bbbbbbbb-0000-0000-0000-000000000002';
    raise exception 'update created_by permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.items set done_at = now();
    raise exception 'update done_at permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.items set created_at = now();
    raise exception 'update created_at permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.items set updated_at = now();
    raise exception 'update updated_at permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.items (list, text, done_at) values ('super', 'x', now());
    raise exception 'insert done_at permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.items (list, text, done) values ('super', 'x', true);
    raise exception 'insert done permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.members (user_id, name) values ('cccccccc-0000-0000-0000-000000000003', 'C');
    raise exception 'insert members permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.members set name = 'Z';
    raise exception 'update members permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- Checks (cada uno en su subtransacción)
do $$
begin
  begin insert into public.items (list, text) values ('super', '');
    raise exception 'texto vacio aceptado';
  exception when check_violation then null; end;
  begin insert into public.items (list, text) values ('super', '   ');
    raise exception 'texto en blanco aceptado';
  exception when check_violation then null; end;
  begin insert into public.items (list, text) values ('super', repeat('a', 121));
    raise exception '121 chars aceptado';
  exception when check_violation then null; end;
  insert into public.items (list, text) values ('super', repeat('a', 120));
  begin insert into public.items (list, text, bucket, assignee) values ('tareas', 'x', 'nunca', null);
    raise exception 'bucket invalido aceptado';
  exception when check_violation then null; end;
  begin insert into public.items (list, text, bucket) values ('super', 'x', 'hoy');
    raise exception 'super con bucket aceptado';
  exception when check_violation then null; end;
  begin insert into public.items (list, text) values ('tareas', 'x');
    raise exception 'tarea sin bucket aceptada';
  exception when check_violation then null; end;
  begin insert into public.items (list, text) values ('otra', 'x');
    raise exception 'list invalida aceptada';
  exception when check_violation then null; end;
end $$;

-- done_at al tildar / destildar
do $$
declare r record;
begin
  update public.items set done = true where text = 'leche';
  select * into r from public.items where text = 'leche';
  if r.done_at is null then raise exception 'done_at no se puso'; end if;
  update public.items set text = 'leche' where text = 'leche';
  update public.items set done = false where text = 'leche';
  select * into r from public.items where text = 'leche';
  if r.done_at is not null then raise exception 'done_at no volvio a null'; end if;
end $$;

-- ===== B (miembro) =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.items where text in ('leche', 'llamar');
  if n <> 2 then raise exception 'B deberia ver lo de A, ve %', n; end if;
  select count(*) into n from public.members
    where user_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
  if n <> 2 then raise exception 'B deberia ver los 2 members de prueba, ve %', n; end if;
  update public.items set done = true where text = 'llamar';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B no pudo tildar'; end if;
end $$;

-- ===== C (no miembro) =====
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.items;
  if n <> 0 then raise exception 'no-miembro ve % items', n; end if;
  if public.is_member() then raise exception 'is_member true para un no-miembro'; end if;
  select count(*) into n from public.members;
  if n <> 0 then raise exception 'no-miembro ve % members', n; end if;
  begin
    insert into public.items (list, text) values ('super', 'intruso');
    raise exception 'no-miembro pudo insertar';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  update public.items set done = true;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro pudo actualizar'; end if;
  delete from public.items;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro pudo borrar'; end if;
end $$;

-- ===== anon =====
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare n int;
begin
  begin
    select count(*) into n from public.items;
    raise exception 'anon pudo leer items';
  exception when insufficient_privilege then null; end;
  begin
    select count(*) into n from public.members;
    raise exception 'anon pudo leer members';
  exception when insufficient_privilege then null; end;
  begin
    perform public.is_member();
    raise exception 'anon pudo ejecutar is_member';
  exception when insufficient_privilege then null; end;
end $$;

-- ===== borrado por miembro =====
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
declare n int;
begin
  -- tildar 'leche' (super) y 'llamar' (tareas ya tildada por B) y borrar solo las tildadas del super
  update public.items set done = true where text = 'leche';
  delete from public.items where list = 'super' and done = true and text = 'leche';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'el borrado por miembro no borro la fila esperada (%)', n; end if;
  select count(*) into n from public.items where text = 'llamar';
  if n <> 1 then raise exception 'borrado afecto tareas'; end if;
end $$;

-- ===== tope de 1000 filas =====
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into public.items (list, text)
  select 'super', 'relleno ' || g from generate_series(1, greatest(0, 1000 - (select count(*) from public.items))) g;
set local role authenticated;
do $$
begin
  begin
    insert into public.items (list, text) values ('super', 'una de mas');
    raise exception 'el tope de 1000 filas no frena';
  exception when check_violation then null; end;
end $$;

reset role;
select 'TODO OK' as resultado;
rollback;
