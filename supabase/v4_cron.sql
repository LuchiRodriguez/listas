-- Listas v4: recordatorio del cierre de mes (cron). Corrélo aparte, DESPUÉS de v4.sql y de desplegar la función 'notificar'.
-- No se puede probar fuera de Supabase (pg_cron y pg_net). Sin secretos: la función 'cierre' no necesita token.
-- Corre los sábados a las 09:00 y 17:00 UTC (10:00/11:00 y 18:00/19:00 en Madrid); el segundo es un reintento si el primero falló (el dedupe evita duplicados). La función decide si ese sábado corresponde.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotente: si el job ya existe, se reemplaza.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'listas-cierre') then
    perform cron.unschedule('listas-cierre');
  end if;
end $$;

select cron.schedule(
  'listas-cierre',
  '0 9,17 * * 6',
  $job$
    select net.http_post(
      url := 'https://unopdwprmpouycmysmce.supabase.co/functions/v1/notificar',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"kind":"cierre"}'::jsonb
    )
  $job$
);
