# Listas

Lista de súper y de tareas compartida entre dos personas, en vivo desde el móvil. App web estática (HTML + CSS + JS vanilla, sin build) con Supabase como backend (Postgres, Auth y Realtime). Se publica en GitHub Pages, en un subpath, por eso todas las rutas son relativas. Se puede agregar a la pantalla de inicio (PWA, sin service worker).

## Estructura

- `index.html`, `style.css`, `app.js`: la app. Sin scripts ni estilos inline (la CSP los bloquea).
- `config.js`: URL y clave publicable de Supabase.
- `vendor/supabase.js`: supabase-js 2.118.0 (UMD).
- `manifest.webmanifest`, `icons/`: PWA.
- `supabase/schema.sql`: tablas, RLS, privilegios por columna, triggers y realtime.
- `supabase/test_rls.sql`: pruebas de las políticas.
- `calc.js`: cálculos puros de v2 (plata, semanas, meses, aportes). Módulo ES importado por `app.js`.
- `supabase/v2.sql` y `supabase/test_v2.sql`: migración y pruebas de v2.

## Configurar Supabase

1. Creá un proyecto en Supabase.
2. En el SQL editor, corré `supabase/schema.sql` entero (y después `supabase/test_rls.sql` para comprobar las políticas).
3. En `config.js` reemplazá los dos placeholders:
   - `__SUPABASE_HOST__` por el host del proyecto, por ejemplo `abcd.supabase.co` (sin `https://`).
   - `__SUPABASE_KEY__` por la clave publicable (anon / publishable). Es pública por diseño: la seguridad la da RLS.
4. En `index.html`, la CSP (`connect-src`) también lleva `__SUPABASE_HOST__`: reemplazalo por el mismo host. Con `sed -i 's/__SUPABASE_HOST__/abcd.supabase.co/g' index.html config.js` alcanza para los dos archivos.
5. Mientras queden placeholders, la app muestra "Falta configurar la app".
6. Authentication → URL Configuration: poné **Site URL** = `https://<usuario>.github.io/listas/` y agregá la misma URL en **Redirect URLs**. Si no, con la confirmación de email activa el link del mail apunta a localhost y el alta queda rota.
7. Authentication → Sign In / Providers → Email: subí la **longitud mínima de contraseña a 8** (el cliente la exige solo al crear cuenta; el servidor acepta 6 por defecto).

`supabase/test_rls.sql` se puede correr incluso con datos reales: todo queda en una transacción con ROLLBACK y los chequeos miran solo sus filas de prueba. Si no aparece ningún error, pasó todo (el último resultado muestra `TODO OK`).

## Habilitar a un miembro

Crear una cuenta no da acceso a nada: quien se registra pero no está en `members` ve cero filas y la app le muestra "Falta que te habiliten". El dueño habilita desde el SQL editor, una vez por persona:

```sql
insert into public.members (user_id, name, color)
select id, 'Nombre', '#ffd9c7' from auth.users where email = 'persona@ejemplo.com';
```

`name` va de 1 a 20 caracteres y `color` es un hex `#rrggbb`. Los nombres que muestra la app salen de esta tabla. Después la persona toca "Ya me habilitaron".

## Dar de baja a un miembro

`items.created_by` apunta a `members` sin `on delete`, así que no se puede borrar a un miembro (ni su usuario en Auth) mientras tenga ítems creados. Antes hay que reasignarlos o borrarlos, por ejemplo: `update public.items set created_by = '<otro user_id>' where created_by = '<user_id>';` corrido como `postgres` en el SQL editor. Se evita un `cascade` a propósito: borraría contenido compartido.

## Cerrar los registros

Cuando ya estén las dos cuentas: Authentication → Sign In / Providers → desactivá "Allow new users to sign up". Así nadie más puede crear cuentas (y aunque lo hiciera, RLS no le deja ver nada). Si desactivás también la confirmación de email, las cuentas entran sin confirmar; mantenela si preferís más control.

## Publicar en GitHub Pages

Settings → Pages → desplegar desde la rama principal, carpeta raíz. `.nojekyll` evita que Jekyll toque los archivos. La URL queda `https://<usuario>.github.io/listas/`.

## Notas de seguridad

- Toda la autorización está en Postgres (RLS + privilegios por columna), no en el cliente. La clave del frontend es publicable.
- Solo el rol `authenticated` y solo si `is_member()` puede leer o escribir. El cliente envía únicamente `list`, `text`, `bucket`, `assignee` al insertar y `text`, `done`, `bucket`, `assignee` al actualizar; `id`, `created_by`, `created_at`, `done_at` y `updated_at` los fija la base. No se usa `upsert`.
- `members` es solo lectura desde el cliente.
- Hay un tope de 1000 filas en `items`.
- Realtime con `postgres_changes`: INSERT y UPDATE se filtran por RLS, pero los DELETE no (limitación de Realtime): un usuario autenticado que no sea miembro podría recibir el `id` de una fila borrada, sin texto ni datos. Cerrar los registros lo elimina en la práctica.
- GitHub Pages no permite cabeceras, así que no hay `frame-ancestors`; la app no arranca si la embeben en un iframe ajeno.
- CSP estricta: `script-src 'self'`, sin inline, `connect-src` limitado a tu proyecto de Supabase, `form-action 'none'`, `base-uri 'none'`. Referrer desactivado.
- Todo texto de usuario se pinta con `textContent`/nodos de texto; no se usa `innerHTML`.
- No pongas nunca la clave `service_role` en este repo.

## v2: convivencia

Además de las listas, la app ahora tiene:

- **Gastos** (#/gastos): estilo Splitwise, en euros. Cada gasto es mitad y mitad o "todo para el otro". Arriba se ve el saldo ("Mati te debe 23,40 €") y el botón Saldar registra un pago. Al tocar "Terminé la compra" en el súper pregunta, opcionalmente, cuánto salió y quién pagó, y lo carga como "Compra del súper".
- **Aportes** (#/aportes): torta semanal o mensual de cuánto aportó cada uno (agregar al súper, crear y completar tareas, hacer la compra, cargar gastos, mimos). Sin ganador: solo cómo se reparte la carga. La semana va de lunes a domingo en hora local del móvil.
- **Mimos** (#/mimos): corazón, beso, gracias (con mensaje) y vales canjeables. Avisan dentro de la app (aviso especial si está abierta, banner en el inicio si hay sin ver). No hay push ni service worker.
- **Cierre de mes** (#/cierre, #/cierre/AAAA-MM): resumen del mes y tres preguntas compartidas para charlar juntos (qué aprendimos, qué mejoramos, en qué seguimos trabajando).

### Aplicar v2

1. v1 tiene que estar aplicada (`supabase/schema.sql`).
2. En el SQL Editor pegá `supabase/v2.sql` entero. Es idempotente.
3. Corré `supabase/test_v2.sql` para comprobar las políticas (todo en una transacción con ROLLBACK; el último resultado dice `TODO OK`).

**Orden:** corré `v2.sql` ANTES de publicar el front nuevo. Si se publica antes, las listas siguen andando (la app cae a las columnas de v1) pero las pantallas nuevas quedan vacías y no se cuentan los aportes. Los datos se traen paginados (1000 por pedido), así que el límite de filas de Supabase no recorta el historial.

## v3: quehaceres de la casa

- **Quehaceres**: en el inicio, la tarjeta "Esta semana" y la pantalla #/aportes tienen "🧹 Hice algo de la casa". Abre una hoja con un chip por quehacer (lavar la ropa, colgar la ropa, vaciar el tender, cocinar, lavar los platos, hacer la cama, cambiar sábanas, cambiar toallas, limpiar y ordenar la habitación, regar las plantas) y "Otra…" con texto libre. Un toque suma 1 aporte a la torta; la hoja queda abierta para registrar varios y cada uno se puede deshacer al instante (cada uno deshace solo lo suyo).
- **Tabla de aportes**: además de las filas de siempre aparece una sección "Casa" con los quehaceres del período y un "Total casa".
- **Vales**: se suma "Vale por un chocolate" a los preajustes.
- **Inicio**: la tarjeta de Mimos pasa arriba de todo, debajo del saludo y del aviso de mimos sin ver.

### Aplicar v3

1. v1 y v2 tienen que estar aplicadas.
2. En el SQL Editor pegá `supabase/v3.sql` entero. Es idempotente.
3. Corré `supabase/test_v3.sql` (todo en una transacción con ROLLBACK; el último resultado dice `TODO OK`).

**Orden:** corré `v3.sql` ANTES de publicar el front nuevo. Si se publica antes, la app cae a las columnas de v2 (sin `detalle`) y los botones de quehaceres fallan con "No se pudo sumar" hasta aplicar el SQL; lo demás sigue andando. Además, el canal de tiempo real incluye `quehaceres`: si la tabla todavía no está en la publicación, Supabase puede rechazar el canal y cortar el tiempo real de todo, así que no publiques antes de aplicar `v3.sql`.
