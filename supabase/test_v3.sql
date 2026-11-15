-- Prueba de v3 (quehaceres). Pegalo en el SQL Editor DESPUÉS de v1, v2 y v3 (corre como postgres).
-- Transacción que termina en ROLLBACK: no deja rastro. Los chequeos miran solo filas de prueba.
-- Si no aparece ningún error, pasó todo.
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@test.invalid', now(), now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@test.invalid', now(), now()),
  ('cccccccc-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@test.invalid', now(), now());

insert into public.members (user_id, name, color) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'A', '#ffd9c7'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'B', '#c7e0ff');

-- ===== A inserta =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare n int; r record;
begin
  insert into public.quehaceres (que) values ('  v3 Lavar los platos ');
  select * into r from public.quehaceres where que like 'v3 Lavar%';
  if r.id is null then raise exception 'no se inserto el quehacer'; end if;
  if r.quien <> 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then raise exception 'quien no es A'; end if;
  if r.que <> 'v3 Lavar los platos' then raise exception 'que no quedo recortado: [%]', r.que; end if;
  if r.hecho_el < now() - interval '1 minute' then raise exception 'hecho_el raro'; end if;
  perform set_config('v3.platos', r.id::text, true);

  select count(*) into n from public.actividad
    where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'quehacer'
      and item_id = r.id and detalle = 'v3 Lavar los platos';
  if n <> 1 then raise exception 'falta actividad quehacer con detalle (%)', n; end if;
end $$;

-- quien no se falsifica
do $$
begin
  begin
    insert into public.quehaceres (que, quien) values ('v3 falso', 'bbbbbbbb-0000-0000-0000-000000000002');
    raise exception 'insert quien permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.quehaceres (que, hecho_el) values ('v3 falso2', '2000-01-01');
    raise exception 'insert hecho_el permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.quehaceres (que, id) values ('v3 falso3', gen_random_uuid());
    raise exception 'insert id permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- que: vacío, solo espacios, 41 chars rechazados; 40 aceptado
do $$
declare n int;
begin
  begin
    insert into public.quehaceres (que) values ('');
    raise exception 'que vacio aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.quehaceres (que) values ('   ');
    raise exception 'que de espacios aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.quehaceres (que) values (repeat('x', 41));
    raise exception 'que de 41 aceptado';
  exception when check_violation then null; end;
  insert into public.quehaceres (que) values (repeat('y', 40));
  select count(*) into n from public.quehaceres where que = repeat('y', 40);
  if n <> 1 then raise exception 'que de 40 no se inserto'; end if;
end $$;

-- no hay update
do $$
begin
  begin
    update public.quehaceres set que = 'v3 cambiado';
    raise exception 'update permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- el cliente sigue sin escribir actividad (ni con detalle)
do $$
begin
  begin
    insert into public.actividad (actor, tipo, detalle) values ('aaaaaaaa-0000-0000-0000-000000000001', 'quehacer', 'trampa');
    raise exception 'cliente inserto actividad';
  exception when insufficient_privilege then null; end;
  begin
    update public.actividad set detalle = 'trampa';
    raise exception 'cliente actualizo actividad';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.actividad;
    raise exception 'cliente borro actividad';
  exception when insufficient_privilege then null; end;
end $$;

-- ===== B: ve lo de A, no puede borrarlo, deshace lo suyo =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n int; id_b uuid;
begin
  select count(*) into n from public.quehaceres where id = current_setting('v3.platos')::uuid;
  if n <> 1 then raise exception 'B no ve el quehacer de A'; end if;

  delete from public.quehaceres where id = current_setting('v3.platos')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B borro el quehacer de A'; end if;
  select count(*) into n from public.actividad where item_id = current_setting('v3.platos')::uuid;
  if n <> 1 then raise exception 'la actividad de A se alteró (%)', n; end if;

  insert into public.quehaceres (que) values ('v3 Cocinar') returning id into id_b;
  select count(*) into n from public.actividad
    where actor = 'bbbbbbbb-0000-0000-0000-000000000002' and tipo = 'quehacer' and item_id = id_b and detalle = 'v3 Cocinar';
  if n <> 1 then raise exception 'falta actividad de B (%)', n; end if;

  delete from public.quehaceres where id = id_b;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B no pudo deshacer lo suyo'; end if;
  select count(*) into n from public.actividad where item_id = id_b;
  if n <> 0 then raise exception 'deshacer no borro la actividad (%)', n; end if;
end $$;

-- ===== C (no miembro) =====
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.quehaceres;
  if n <> 0 then raise exception 'no-miembro ve % quehaceres', n; end if;
  begin
    insert into public.quehaceres (que) values ('v3 intruso');
    raise exception 'no-miembro inserto quehacer';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  delete from public.quehaceres;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro borro %', n; end if;
end $$;

-- ===== anon: nada =====
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.quehaceres;
    raise exception 'anon leyo quehaceres';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.quehaceres (que) values ('v3 anon');
    raise exception 'anon inserto quehaceres';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== el check de tipo acepta 'quehacer' y rechaza inventados (como postgres) =====
do $$
begin
  insert into public.actividad (actor, tipo, detalle) values ('aaaaaaaa-0000-0000-0000-000000000001', 'quehacer', 'v3 directo');
  begin
    insert into public.actividad (actor, tipo) values ('aaaaaaaa-0000-0000-0000-000000000001', 'inventado');
    raise exception 'tipo inventado aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.actividad (actor, tipo, detalle) values ('aaaaaaaa-0000-0000-0000-000000000001', 'quehacer', repeat('z', 41));
    raise exception 'detalle de 41 aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.actividad (actor, tipo, detalle) values ('aaaaaaaa-0000-0000-0000-000000000001', 'quehacer', '');
    raise exception 'detalle vacio aceptado';
  exception when check_violation then null; end;
end $$;

-- ===== tope de 20000 =====
-- Se llena hasta el tope con filas sintéticas (como postgres, con los triggers apagados) y se prueba que el 20001 se rechaza.
do $$
declare n int; falta int;
begin
  select count(*) into n from public.quehaceres;
  falta := 20000 - n;
  if falta > 0 then
    alter table public.quehaceres disable trigger user;
    insert into public.quehaceres (quien, que)
      select 'aaaaaaaa-0000-0000-0000-000000000001', 'v3 relleno' from generate_series(1, falta);
    alter table public.quehaceres enable trigger user;
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
begin
  begin
    insert into public.quehaceres (que) values ('v3 uno de mas');
    raise exception 'tope de 20000 no se aplica';
  exception when check_violation then null; end;
end $$;
reset role;

select 'TODO OK' as resultado;
rollback;
