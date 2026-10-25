-- =============================================================================
-- Warike POS — 0800 Impresión, sincronización offline y auditoría (§5.8)
-- =============================================================================

create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locales (id),
  impresora_id uuid,
  tipo text not null check (
    tipo in ('comanda', 'precuenta', 'comprobante', 'ticket_provisional', 'corte_x', 'corte_z', 'anulacion',
             'traslado', 'movimiento')
  ),
  payload jsonb not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'tomado', 'impreso', 'error')),
  intentos integer not null default 0 check (intentos >= 0),
  agente_id uuid,
  error text,
  impreso_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  foreign key (impresora_id, local_id) references public.impresoras (id, local_id),
  foreign key (agente_id, local_id) references public.dispositivos (id, local_id)
);
create index print_jobs_pendientes_idx on public.print_jobs (local_id, estado, created_at)
  where estado in ('pendiente', 'tomado', 'error');

-- Deduplicación del outbox de los clientes offline (§12.2).
create table public.outbox_recibidos (
  id uuid primary key default gen_random_uuid(),
  client_mutation_id uuid not null unique,
  local_id uuid not null references public.locales (id),
  dispositivo_id uuid,
  tipo text not null,
  payload jsonb not null,
  aplicado_at timestamptz not null default now(),
  resultado jsonb,
  foreign key (dispositivo_id, local_id) references public.dispositivos (id, local_id)
);

create trigger print_jobs_updated_at before update on public.print_jobs
  for each row execute function app.set_updated_at();

-- Cola de impresión y registro de deduplicación: sin borrado físico. Borrar outbox_recibidos
-- permitiría reaplicar mutaciones offline. No llevan trigger de auditoría: ya son un registro y
-- print_jobs cambia de estado en cada impresión (DECISIONS D-020).
create trigger print_jobs_sin_borrado before delete on public.print_jobs
  for each row execute function app.prohibir_borrado();
create trigger outbox_recibidos_sin_borrado before delete on public.outbox_recibidos
  for each row execute function app.prohibir_borrado();

-- -----------------------------------------------------------------------------
-- Bitácora de auditoría append-only (§5.8, §14.7). Retención de 5 años.
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id bigserial primary key,
  local_id uuid references public.locales (id),
  user_id uuid,
  dispositivo_id uuid,
  accion text not null,
  entidad text not null,
  entidad_id text,
  antes jsonb,
  despues jsonb,
  ip inet,
  created_at timestamptz not null default now()
);
create index audit_log_local_fecha_idx on public.audit_log (local_id, created_at);
create index audit_log_entidad_idx on public.audit_log (entidad, entidad_id);
create index audit_log_accion_idx on public.audit_log (accion, created_at);

create or replace function app.audit_log_inmutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log es append-only: % no está permitido', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- El trigger bloquea UPDATE, DELETE y TRUNCATE incluso para service_role y postgres.
create trigger audit_log_sin_update_delete before update or delete on public.audit_log
  for each row execute function app.audit_log_inmutable();
create trigger audit_log_sin_truncate before truncate on public.audit_log
  for each statement execute function app.audit_log_inmutable();

revoke update, delete, truncate on public.audit_log from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Dispositivo de la sesión actual (si es una sesión PIN).
-- -----------------------------------------------------------------------------
create or replace function app.dispositivo_sesion()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.dispositivo_id
  from app.sesiones_dispositivo s
  where s.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
$$;

-- -----------------------------------------------------------------------------
-- Registro explícito de eventos (inicios de sesión, autorizaciones, etc.).
-- -----------------------------------------------------------------------------
create or replace function app.registrar_evento(
  p_accion text,
  p_entidad text,
  p_entidad_id text default null,
  p_local_id uuid default null,
  p_despues jsonb default null,
  p_user_id uuid default null,
  p_dispositivo_id uuid default null,
  p_ip inet default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (local_id, user_id, dispositivo_id, accion, entidad, entidad_id, despues, ip)
  values (
    p_local_id,
    coalesce(p_user_id, auth.uid()),
    coalesce(p_dispositivo_id, app.dispositivo_sesion()),
    p_accion,
    p_entidad,
    p_entidad_id,
    p_despues,
    coalesce(p_ip, app.ip_cliente())
  );
$$;

-- -----------------------------------------------------------------------------
-- Trigger genérico de auditoría. Los argumentos del trigger son columnas que no
-- deben copiarse a la bitácora (p. ej. hashes).
-- -----------------------------------------------------------------------------
create or replace function app.auditar_cambio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_excluir text[] := coalesce(tg_argv::text[], '{}');
  v_antes jsonb;
  v_despues jsonb;
  v_fila jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_antes := to_jsonb(old) - v_excluir;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_despues := to_jsonb(new) - v_excluir;
  end if;
  if tg_op = 'UPDATE' and (v_antes - 'updated_at') = (v_despues - 'updated_at') then
    return null;
  end if;

  v_fila := coalesce(v_despues, v_antes);

  insert into public.audit_log (local_id, user_id, dispositivo_id, accion, entidad, entidad_id, antes, despues, ip)
  values (
    (v_fila ->> 'local_id')::uuid,
    auth.uid(),
    app.dispositivo_sesion(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_fila ->> 'id', v_fila ->> 'user_id', v_fila ->> 'role_id', v_fila ->> 'local_id'),
    v_antes,
    v_despues,
    app.ip_cliente()
  );
  return null;
end;
$$;

revoke all on function app.registrar_evento(text, text, text, uuid, jsonb, uuid, uuid, inet) from public;
revoke all on function app.auditar_cambio() from public;
revoke all on function app.dispositivo_sesion() from public;
revoke all on function app.ip_cliente() from public;
