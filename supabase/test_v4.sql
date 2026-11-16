-- Prueba de v4 (push). Pegalo en el SQL Editor DESPUÉS de v1, v2, v3 y v4 (corre como postgres).
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

-- Una fila de log de prueba (como postgres) para comprobar que el cliente no la ve.
insert into public.push_log (kind, ref) values ('v4test', 'x');

-- ===== A inserta =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare n int; r record;
begin
  insert into public.push_subs (endpoint, p256dh, auth)
    values ('https://push.example.test/v4-a', 'p256dh-de-prueba-A', 'auth-de-A-1');
  select * into r from public.push_subs where endpoint = 'https://push.example.test/v4-a';
  if r.id is null then raise exception 'no se inserto la suscripcion'; end if;
  if r.user_id <> 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then raise exception 'user_id no es A'; end if;
  perform set_config('v4.sub_a', r.id::text, true);
end $$;

-- user_id no se falsifica: ni por columna (sin grant) ni por el trigger
do $$
begin
  begin
    insert into public.push_subs (endpoint, p256dh, auth, user_id)
      values ('https://push.example.test/v4-falso', 'p256dh-de-prueba-X', 'auth-de-X-1', 'bbbbbbbb-0000-0000-0000-000000000002');
    raise exception 'insert user_id permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth, id)
      values ('https://push.example.test/v4-falso2', 'p256dh-de-prueba-X', 'auth-de-X-1', gen_random_uuid());
    raise exception 'insert id permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth, created_at)
      values ('https://push.example.test/v4-falso3', 'p256dh-de-prueba-X', 'auth-de-X-1', '2000-01-01');
    raise exception 'insert created_at permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- validaciones de columnas
do $$
declare n int;
begin
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('http://push.example.test/inseguro', 'p256dh-de-prueba-X', 'auth-de-X-1');
    raise exception 'endpoint http aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://x', 'p256dh-de-prueba-X', 'auth-de-X-1');
    raise exception 'endpoint corto aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://' || repeat('e', 993), 'p256dh-de-prueba-X', 'auth-de-X-1');
    raise exception 'endpoint de 1001 aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-k1', 'corto', 'auth-de-X-1');
    raise exception 'p256dh corto aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-k2', repeat('p', 201), 'auth-de-X-1');
    raise exception 'p256dh de 201 aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-k3', 'p256dh-de-prueba-X', 'corta');
    raise exception 'auth corto aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-k4', 'p256dh-de-prueba-X', repeat('a', 101));
    raise exception 'auth de 101 aceptado';
  exception when check_violation then null; end;
  -- límites válidos
  insert into public.push_subs (endpoint, p256dh, auth) values ('https://' || repeat('e', 992), repeat('p', 200), repeat('a', 100));
  select count(*) into n from public.push_subs where endpoint like 'https://eeee%';
  if n <> 1 then raise exception 'limites validos no se insertaron'; end if;
  delete from public.push_subs where endpoint like 'https://eeee%';
end $$;

-- endpoint único
do $$
begin
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-a', 'p256dh-de-prueba-A', 'auth-de-A-1');
    raise exception 'endpoint duplicado aceptado';
  exception when unique_violation then null; end;
end $$;

-- no hay update
do $$
begin
  begin
    update public.push_subs set p256dh = 'cambiado-cambiado';
    raise exception 'update permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- push_log inaccesible para el cliente
do $$
begin
  begin
    perform count(*) from public.push_log;
    raise exception 'authenticated leyo push_log';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.push_log (kind, ref) values ('v4test', 'y');
    raise exception 'authenticated inserto push_log';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.push_log;
    raise exception 'authenticated borro push_log';
  exception when insufficient_privilege then null; end;
end $$;

-- ===== B: no ve ni borra la de A; tiene la suya =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.push_subs where endpoint = 'https://push.example.test/v4-a';
  if n <> 0 then raise exception 'B ve la suscripcion de A'; end if;
  select count(*) into n from public.push_subs;
  if n <> 0 then raise exception 'B ve % suscripciones ajenas', n; end if;

  delete from public.push_subs where id = current_setting('v4.sub_a')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B borro la suscripcion de A'; end if;

  insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-b', 'p256dh-de-prueba-B', 'auth-de-B-1');
  select count(*) into n from public.push_subs;
  if n <> 1 then raise exception 'B deberia ver solo la suya (%)', n; end if;
  if (select user_id from public.push_subs) <> 'bbbbbbbb-0000-0000-0000-000000000002'::uuid then raise exception 'user_id de B mal'; end if;

  -- B no puede reutilizar el endpoint de A (la fila de A no se ve, pero la unique salta)
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-a', 'p256dh-de-prueba-B', 'auth-de-B-1');
    raise exception 'B reutilizo el endpoint de A';
  exception when unique_violation then null; end;

  delete from public.push_subs where endpoint = 'https://push.example.test/v4-b';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B no pudo borrar la suya'; end if;
end $$;

-- A sigue teniendo la suya
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.push_subs where endpoint = 'https://push.example.test/v4-a';
  if n <> 1 then raise exception 'A perdio su suscripcion (%)', n; end if;
end $$;

-- ===== C (no miembro) =====
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.push_subs;
  if n <> 0 then raise exception 'no-miembro ve % suscripciones', n; end if;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-c', 'p256dh-de-prueba-C', 'auth-de-C-1');
    raise exception 'no-miembro inserto suscripcion';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  delete from public.push_subs;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro borro %', n; end if;
end $$;

-- ===== anon: nada =====
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.push_subs;
    raise exception 'anon leyo push_subs';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-anon', 'p256dh-de-prueba-N', 'auth-de-N-1');
    raise exception 'anon inserto push_subs';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.push_subs;
    raise exception 'anon borro push_subs';
  exception when insufficient_privilege then null; end;
  begin
    perform count(*) from public.push_log;
    raise exception 'anon leyo push_log';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.push_log (kind, ref) values ('v4test', 'z');
    raise exception 'anon inserto push_log';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== el log existe y es del servicio (postgres lo ve) =====
do $$
declare n int;
begin
  select count(*) into n from public.push_log where kind = 'v4test';
  if n <> 1 then raise exception 'push_log de prueba no esta (%)', n; end if;
  begin
    insert into public.push_log (kind, ref) values ('v4test', 'x');
    raise exception 'push_log acepto clave duplicada';
  exception when unique_violation then null; end;
  insert into public.push_log (kind, ref) values ('v4test', 'x') on conflict do nothing;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'on conflict do nothing inserto'; end if;
end $$;

-- ===== tope de 200 =====
-- Se llena hasta el tope con filas sintéticas (como postgres, con los triggers apagados) y se prueba que la 201 se rechaza.
do $$
declare n int; falta int;
begin
  select count(*) into n from public.push_subs;
  falta := 200 - n;
  if falta > 0 then
    alter table public.push_subs disable trigger user;
    insert into public.push_subs (user_id, endpoint, p256dh, auth)
      select 'aaaaaaaa-0000-0000-0000-000000000001', 'https://push.example.test/relleno-' || g, 'p256dh-de-relleno', 'auth-de-relleno'
      from generate_series(1, falta) g;
    alter table public.push_subs enable trigger user;
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
begin
  begin
    insert into public.push_subs (endpoint, p256dh, auth) values ('https://push.example.test/v4-de-mas', 'p256dh-de-prueba-B', 'auth-de-B-1');
    raise exception 'tope de 200 no se aplica';
  exception when check_violation then null; end;
end $$;
reset role;

select 'TODO OK' as resultado;
rollback;
