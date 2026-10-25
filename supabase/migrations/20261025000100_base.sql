-- =============================================================================
-- Warike POS — 0100 Base: extensiones, esquema privado y funciones utilitarias
-- =============================================================================
-- Convenciones (§5):
--   * PK uuid con gen_random_uuid().
--   * Tablas operativas con local_id, created_at, created_by y updated_at.
--   * Montos numeric(12,2); precios unitarios internos numeric(14,6).
--   * Estados con CHECK constraints.
--   * Sin borrado físico en tablas transaccionales (trigger app.prohibir_borrado).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- Esquema privado: funciones auxiliares de RLS y datos internos que nunca se exponen por la API.
create schema if not exists app;
comment on schema app is 'Funciones y datos internos de Warike POS. No se expone por la API REST.';
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- Las tablas y funciones nuevas no se exponen automáticamente a anon/authenticated:
-- cada migración concede permisos de forma explícita. PostgreSQL además concede EXECUTE
-- a PUBLIC en toda función nueva, así que cada RPC lo revoca explícitamente.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- -----------------------------------------------------------------------------
-- updated_at automático
-- -----------------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Prohibición de borrado físico (§5: usar estado o anulado_at)
-- -----------------------------------------------------------------------------
create or replace function app.prohibir_borrado()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Borrado físico prohibido en %: usa estado o anulado_at', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- -----------------------------------------------------------------------------
-- IP del cliente a partir de las cabeceras que PostgREST deja en la sesión
-- -----------------------------------------------------------------------------
create or replace function app.ip_cliente()
returns inet
language plpgsql
stable
set search_path = ''
as $$
declare
  v_xff text;
begin
  v_xff := nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for';
  if v_xff is null then
    return null;
  end if;
  return trim(split_part(v_xff, ',', 1))::inet;
exception
  when others then
    return null;
end;
$$;
