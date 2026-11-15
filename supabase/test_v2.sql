-- Prueba de v2 (gastos, aportes, mimos, cierres). Pegalo en el SQL Editor DESPUÉS de v1 y v2 (corre como postgres).
-- Transacción que termina en ROLLBACK: no deja rastro. Se puede correr con datos reales:
-- los chequeos miran solo filas de prueba. Si no aparece ningún error, pasó todo.
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@test.invalid', now(), now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@test.invalid', now(), now()),
  ('cccccccc-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@test.invalid', now(), now());

insert into public.members (user_id, name, color) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'A', '#ffd9c7'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'B', '#c7e0ff');

-- ===== A: items, done_by y actividad =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

do $$
declare n int; r record;
begin
  insert into public.items (list, text) values ('super', 'v2 leche');
  insert into public.items (list, text, bucket) values ('tareas', 'v2 llamar', 'hoy');
  select * into r from public.items where text = 'v2 leche';
  perform set_config('v2.leche', r.id::text, true);
  if r.done_by is not null then raise exception 'done_by deberia ser null al crear'; end if;
  select id into r from public.items where text = 'v2 llamar';
  perform set_config('v2.llamar', r.id::text, true);

  select count(*) into n from public.actividad
    where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'agrego_super' and item_id = current_setting('v2.leche')::uuid;
  if n <> 1 then raise exception 'falta actividad agrego_super (%)', n; end if;
  select count(*) into n from public.actividad
    where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'creo_tarea' and item_id = current_setting('v2.llamar')::uuid;
  if n <> 1 then raise exception 'falta actividad creo_tarea (%)', n; end if;
end $$;

-- el cliente no escribe done_by
do $$
begin
  begin
    update public.items set done_by = 'bbbbbbbb-0000-0000-0000-000000000002' where text = 'v2 leche';
    raise exception 'update done_by permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.items (list, text, done_by) values ('super', 'v2 x', 'bbbbbbbb-0000-0000-0000-000000000002');
    raise exception 'insert done_by permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- tildar / destildar / tildar de nuevo
do $$
declare n int; r record;
begin
  update public.items set done = true where text = 'v2 leche';
  select * into r from public.items where text = 'v2 leche';
  if r.done_by is distinct from 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then raise exception 'done_by no es A'; end if;
  select count(*) into n from public.actividad
    where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'compro' and item_id = r.id;
  if n <> 1 then raise exception 'falta actividad compro (%)', n; end if;

  update public.items set done = false where text = 'v2 leche';
  select * into r from public.items where text = 'v2 leche';
  if r.done_by is not null then raise exception 'done_by no volvio a null'; end if;
  select count(*) into n from public.actividad where item_id = r.id and tipo = 'compro';
  if n <> 0 then raise exception 'destildar no descuenta compro (%)', n; end if;
  select count(*) into n from public.actividad where item_id = r.id and tipo = 'agrego_super';
  if n <> 1 then raise exception 'destildar borro agrego_super (%)', n; end if;

  update public.items set done = true where text = 'v2 leche';
  select count(*) into n from public.actividad where item_id = r.id and tipo = 'compro';
  if n <> 1 then raise exception 'volver a tildar no suma compro (%)', n; end if;
end $$;

-- ===== B tilda la tarea de A =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n int; r record;
begin
  update public.items set done = true where text = 'v2 llamar';
  select * into r from public.items where text = 'v2 llamar';
  if r.done_by is distinct from 'bbbbbbbb-0000-0000-0000-000000000002'::uuid then raise exception 'done_by no es B'; end if;
  select count(*) into n from public.actividad
    where actor = 'bbbbbbbb-0000-0000-0000-000000000002' and tipo = 'completo_tarea' and item_id = r.id;
  if n <> 1 then raise exception 'falta completo_tarea de B (%)', n; end if;
  -- editar texto o re-marcar done=true no cambia done_by ni duplica actividad
  update public.items set text = 'v2 llamar' where text = 'v2 llamar';
  update public.items set done = true where text = 'v2 llamar';
  select * into r from public.items where text = 'v2 llamar';
  if r.done_by is distinct from 'bbbbbbbb-0000-0000-0000-000000000002'::uuid then raise exception 'done_by se pisó'; end if;
  select count(*) into n from public.actividad where item_id = r.id and tipo = 'completo_tarea';
  if n <> 1 then raise exception 'actividad duplicada (%)', n; end if;
end $$;

-- ===== A: borrar el item no borra la actividad; actividad de solo lectura =====
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
declare n int;
begin
  delete from public.items where text = 'v2 leche';
  select count(*) into n from public.actividad where item_id = current_setting('v2.leche')::uuid;
  if n <> 2 then raise exception 'borrar el item deberia dejar 2 actividades (agrego_super, compro), hay %', n; end if;

  begin
    insert into public.actividad (actor, tipo) values ('aaaaaaaa-0000-0000-0000-000000000001', 'mimo');
    raise exception 'cliente inserto actividad';
  exception when insufficient_privilege then null; end;
  begin
    update public.actividad set tipo = 'mimo';
    raise exception 'cliente actualizo actividad';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.actividad;
    raise exception 'cliente borro actividad';
  exception when insufficient_privilege then null; end;
end $$;

-- ===== gastos =====
do $$
declare n int; r record;
begin
  insert into public.gastos (descripcion, monto_cent, pagado_por)
    values ('v2 cena', 2340, 'aaaaaaaa-0000-0000-0000-000000000001');
  select * into r from public.gastos where descripcion = 'v2 cena';
  if r.created_by <> 'aaaaaaaa-0000-0000-0000-000000000001' then raise exception 'created_by gasto mal'; end if;
  if r.tipo <> 'gasto' or r.reparto <> 'mitad' then raise exception 'defaults de gasto mal'; end if;
  select count(*) into n from public.actividad
    where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'gasto';
  if n <> 1 then raise exception 'falta actividad gasto (%)', n; end if;

  -- pago: no cuenta como aporte
  insert into public.gastos (tipo, descripcion, monto_cent, pagado_por, reparto)
    values ('pago', 'v2 saldar', 1000, 'bbbbbbbb-0000-0000-0000-000000000002', 'todo_otro');
  select count(*) into n from public.actividad
    where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'gasto';
  if n <> 1 then raise exception 'un pago conto como aporte (%)', n; end if;
  -- el created_by del pago es el que lo cargó (A), aunque pagó B
  select * into r from public.gastos where descripcion = 'v2 saldar';
  if r.created_by <> 'aaaaaaaa-0000-0000-0000-000000000001' then raise exception 'created_by pago mal'; end if;

  begin
    insert into public.gastos (tipo, descripcion, monto_cent, pagado_por, reparto)
      values ('pago', 'v2 x', 1000, 'aaaaaaaa-0000-0000-0000-000000000001', 'mitad');
    raise exception 'pago con reparto mitad aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (tipo, descripcion, monto_cent, pagado_por) values ('otro', 'v2 x', 100, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'tipo invalido aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por, reparto) values ('v2 x', 100, 'aaaaaaaa-0000-0000-0000-000000000001', 'tercio');
    raise exception 'reparto invalido aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 x', 0, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'monto 0 aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 x', -5, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'monto negativo aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 x', 10000001, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'monto excesivo aceptado';
  exception when check_violation then null; end;
  insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 max', 10000000, 'aaaaaaaa-0000-0000-0000-000000000001');
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('   ', 100, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'descripcion en blanco aceptada';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values (repeat('a', 81), 100, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'descripcion de 81 aceptada';
  exception when check_violation then null; end;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 x', 100, 'cccccccc-0000-0000-0000-000000000003');
    raise exception 'pagado_por no miembro aceptado';
  exception when foreign_key_violation then null; end;

  -- columnas protegidas
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por, created_by)
      values ('v2 x', 100, 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
    raise exception 'insert created_by permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.gastos set created_by = 'bbbbbbbb-0000-0000-0000-000000000002' where descripcion = 'v2 cena';
    raise exception 'update created_by permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.gastos set tipo = 'pago' where descripcion = 'v2 cena';
    raise exception 'update tipo permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.gastos set created_at = now() where descripcion = 'v2 cena';
    raise exception 'update created_at permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.gastos set id = gen_random_uuid() where descripcion = 'v2 cena';
    raise exception 'update id permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- B edita y borra gastos de A; B carga el suyo
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n int; r record;
begin
  select count(*) into n from public.gastos where descripcion like 'v2 %';
  if n <> 3 then raise exception 'B deberia ver 3 gastos de prueba, ve %', n; end if;
  update public.gastos set monto_cent = 2500, reparto = 'todo_otro', pagado_por = 'bbbbbbbb-0000-0000-0000-000000000002', fecha = '2026-01-02'
    where descripcion = 'v2 cena';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B no pudo editar'; end if;
  insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 b', 500, 'bbbbbbbb-0000-0000-0000-000000000002');
  select * into r from public.gastos where descripcion = 'v2 b';
  if r.created_by <> 'bbbbbbbb-0000-0000-0000-000000000002' then raise exception 'created_by de B mal'; end if;
  delete from public.gastos where descripcion = 'v2 max';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B no pudo borrar'; end if;
end $$;

-- ===== mimos =====
-- A manda a B
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
declare n int; r record;
begin
  insert into public.mimos (para, tipo) values ('bbbbbbbb-0000-0000-0000-000000000002', 'beso');
  insert into public.mimos (para, tipo, texto) values ('bbbbbbbb-0000-0000-0000-000000000002', 'vale', 'v2 vale masaje');
  select * into r from public.mimos where tipo = 'beso' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
  if r.visto or r.canjeado or r.canjeado_at is not null then raise exception 'defaults de mimo mal'; end if;
  select count(*) into n from public.actividad where actor = 'aaaaaaaa-0000-0000-0000-000000000001' and tipo = 'mimo';
  if n <> 2 then raise exception 'falta actividad mimo (%)', n; end if;

  begin
    insert into public.mimos (para, tipo) values ('aaaaaaaa-0000-0000-0000-000000000001', 'corazon');
    raise exception 'mimo a uno mismo aceptado';
  exception when check_violation or insufficient_privilege then null; end;
  begin
    insert into public.mimos (para, tipo) values ('bbbbbbbb-0000-0000-0000-000000000002', 'vale');
    raise exception 'vale sin texto aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.mimos (para, tipo, texto) values ('bbbbbbbb-0000-0000-0000-000000000002', 'gracias', repeat('a', 81));
    raise exception 'texto de 81 aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.mimos (para, tipo) values ('bbbbbbbb-0000-0000-0000-000000000002', 'abrazo');
    raise exception 'tipo invalido aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.mimos (para, tipo) values ('cccccccc-0000-0000-0000-000000000003', 'corazon');
    raise exception 'mimo a no miembro aceptado';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.mimos (de, para, tipo) values ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'corazon');
    raise exception 'insert de permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.mimos (para, tipo, visto) values ('bbbbbbbb-0000-0000-0000-000000000002', 'corazon', true);
    raise exception 'insert visto permitido';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.mimos (para, tipo, canjeado) values ('bbbbbbbb-0000-0000-0000-000000000002', 'vale', true);
    raise exception 'insert canjeado permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.mimos set texto = 'otro' where de = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'update texto permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.mimos set para = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'update para permitido';
  exception when insufficient_privilege then null; end;

  -- quien manda NO puede marcar visto / canjeado (la RLS filtra: 0 filas)
  update public.mimos set visto = true where de = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'el que manda pudo marcar visto'; end if;
  update public.mimos set canjeado = true where tipo = 'vale' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'el que manda pudo canjear'; end if;
end $$;

-- B recibe
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare n int; r record;
begin
  update public.mimos set visto = true where para = 'bbbbbbbb-0000-0000-0000-000000000002' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'B no pudo marcar visto (%)', n; end if;

  -- canje solo de vales
  begin
    update public.mimos set canjeado = true where tipo = 'beso' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'canje de un beso aceptado';
  exception when check_violation then null; end;

  update public.mimos set canjeado = true where tipo = 'vale' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
  select * into r from public.mimos where tipo = 'vale' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
  if not r.canjeado or r.canjeado_at is null then raise exception 'canjeado_at no lo puso el trigger'; end if;
  -- una edicion posterior conserva canjeado_at
  update public.mimos set visto = true where id = r.id;
  if (select canjeado_at from public.mimos where id = r.id) is distinct from r.canjeado_at then
    raise exception 'canjeado_at no se conservo';
  end if;
  update public.mimos set canjeado = false where id = r.id;
  if (select canjeado_at from public.mimos where id = r.id) is not null then raise exception 'canjeado_at no volvio a null'; end if;
  update public.mimos set canjeado = true where id = r.id;

  -- B no puede borrar lo de A
  delete from public.mimos where de = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B borro mimos de A'; end if;
  -- B manda uno y A (quien recibe) no podra borrarlo
  insert into public.mimos (para, tipo) values ('aaaaaaaa-0000-0000-0000-000000000001', 'corazon');
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
do $$
declare n int;
begin
  delete from public.mimos where de = 'bbbbbbbb-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'A borro un mimo de B'; end if;
  -- A deshace el suyo
  delete from public.mimos where tipo = 'beso' and de = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'A no pudo deshacer su mimo'; end if;
end $$;

-- ===== cierres (mes de prueba 1999, para no chocar con datos reales) =====
do $$
declare r record;
begin
  insert into public.cierres (mes, aprendimos) values ('1999-01-01', 'a');
  select * into r from public.cierres where mes = '1999-01-01';
  if r.updated_by <> 'aaaaaaaa-0000-0000-0000-000000000001' then raise exception 'updated_by del insert mal'; end if;
  begin
    insert into public.cierres (mes) values ('1999-02-15');
    raise exception 'mes con dia <> 1 aceptado';
  exception when check_violation then null; end;
  begin
    insert into public.cierres (mes) values ('1999-01-01');
    raise exception 'mes duplicado aceptado';
  exception when unique_violation then null; end;
  begin
    insert into public.cierres (mes, aprendimos) values ('1999-03-01', repeat('a', 2001));
    raise exception '2001 chars aceptado';
  exception when check_violation then null; end;
  insert into public.cierres (mes, mejoramos) values ('1999-03-01', repeat('a', 2000));
  begin
    insert into public.cierres (mes, updated_by) values ('1999-04-01', 'bbbbbbbb-0000-0000-0000-000000000002');
    raise exception 'insert updated_by permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.cierres set mes = '1999-05-01' where mes = '1999-01-01';
    raise exception 'update mes permitido';
  exception when insufficient_privilege then null; end;
  begin
    update public.cierres set updated_by = 'bbbbbbbb-0000-0000-0000-000000000002' where mes = '1999-01-01';
    raise exception 'update updated_by permitido';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.cierres where mes = '1999-01-01';
    raise exception 'delete cierres permitido';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
do $$
declare r record; n int;
begin
  update public.cierres set trabajando = 'b escribio' where mes = '1999-01-01';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'B no pudo actualizar el cierre'; end if;
  select * into r from public.cierres where mes = '1999-01-01';
  if r.updated_by <> 'bbbbbbbb-0000-0000-0000-000000000002' then raise exception 'updated_by no es B'; end if;
  if r.aprendimos <> 'a' then raise exception 'se perdio lo de A'; end if;
end $$;

-- ===== C (no miembro): todo en 0 =====
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.actividad;
  if n <> 0 then raise exception 'no-miembro ve % actividad', n; end if;
  select count(*) into n from public.gastos;
  if n <> 0 then raise exception 'no-miembro ve % gastos', n; end if;
  select count(*) into n from public.mimos;
  if n <> 0 then raise exception 'no-miembro ve % mimos', n; end if;
  select count(*) into n from public.cierres;
  if n <> 0 then raise exception 'no-miembro ve % cierres', n; end if;
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('intruso', 100, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'no-miembro inserto gasto';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  begin
    insert into public.mimos (para, tipo) values ('aaaaaaaa-0000-0000-0000-000000000001', 'corazon');
    raise exception 'no-miembro inserto mimo';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  begin
    insert into public.cierres (mes) values ('1999-06-01');
    raise exception 'no-miembro inserto cierre';
  exception when insufficient_privilege then null; end;
  update public.gastos set monto_cent = 1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro actualizo gastos'; end if;
  update public.mimos set visto = true;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro actualizo mimos'; end if;
  update public.cierres set aprendimos = 'x';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro actualizo cierres'; end if;
  delete from public.gastos;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro borro gastos'; end if;
  delete from public.mimos;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'no-miembro borro mimos'; end if;
end $$;

-- ===== anon =====
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare n int;
begin
  begin select count(*) into n from public.actividad; raise exception 'anon leyo actividad';
  exception when insufficient_privilege then null; end;
  begin select count(*) into n from public.gastos; raise exception 'anon leyo gastos';
  exception when insufficient_privilege then null; end;
  begin select count(*) into n from public.mimos; raise exception 'anon leyo mimos';
  exception when insufficient_privilege then null; end;
  begin select count(*) into n from public.cierres; raise exception 'anon leyo cierres';
  exception when insufficient_privilege then null; end;
  begin insert into public.gastos (descripcion, monto_cent, pagado_por) values ('x', 1, 'aaaaaaaa-0000-0000-0000-000000000001'); raise exception 'anon inserto gastos';
  exception when insufficient_privilege then null; end;
  begin insert into public.mimos (para, tipo) values ('aaaaaaaa-0000-0000-0000-000000000001', 'corazon'); raise exception 'anon inserto mimos';
  exception when insufficient_privilege then null; end;
  begin insert into public.cierres (mes) values ('1999-07-01'); raise exception 'anon inserto cierres';
  exception when insufficient_privilege then null; end;
end $$;

-- ===== topes de 5000 filas (como postgres, con A de actor) =====
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
insert into public.gastos (descripcion, monto_cent, pagado_por)
  select 'relleno ' || g, 100, 'aaaaaaaa-0000-0000-0000-000000000001'
  from generate_series(1, greatest(0, 5000 - (select count(*) from public.gastos))) g;
insert into public.mimos (para, tipo)
  select 'bbbbbbbb-0000-0000-0000-000000000002', 'corazon'
  from generate_series(1, greatest(0, 5000 - (select count(*) from public.mimos))) g;
set local role authenticated;
do $$
begin
  begin
    insert into public.gastos (descripcion, monto_cent, pagado_por) values ('v2 de mas', 100, 'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'el tope de 5000 gastos no frena';
  exception when check_violation then null; end;
  begin
    insert into public.mimos (para, tipo) values ('bbbbbbbb-0000-0000-0000-000000000002', 'corazon');
    raise exception 'el tope de 5000 mimos no frena';
  exception when check_violation then null; end;
end $$;

reset role;
select 'TODO OK' as resultado;
rollback;
