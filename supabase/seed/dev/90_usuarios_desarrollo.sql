-- =============================================================================
-- SOLO DESARROLLO LOCAL — usuarios, PIN y dispositivos de prueba
-- =============================================================================
-- Lo carga `supabase db reset` en local. NUNCA se aplica a staging ni a producción.
--
--   Rol      Acceso                                          Credenciales
--   admin    email + contraseña + TOTP (se enrola al entrar)  admin@warike.test / Warike-Admin-2026
--   auditor  email + contraseña + TOTP                        auditor@warike.test / Warike-Auditor-2026
--   mozo     PIN en dispositivo                               código 1001 / PIN 2580
--   cajero   PIN en dispositivo                               código 2001 / PIN 1470
--   cocina   PIN en dispositivo                               código 3001 / PIN 3690
--   (admin también tiene código 9001 / PIN 7531 para autorizar acciones de supervisor)
--
--   Dispositivos (token completo, para pegar en /dispositivo en local):
--   Tablet Salón 1  wkd_ + "a1" × 32
--   Caja 1          wkd_ + "c2" × 32
--   KDS Cocina      wkd_ + "d3" × 32

begin;

do $$
declare
  v_local constant uuid := 'b0000000-0000-4000-8000-000000000001';
  u record;
begin
  for u in
    select * from (values
      ('d0000000-0000-4000-8000-000000000001'::uuid, 'admin@warike.test', 'Warike-Admin-2026', 'Admin Warike', '9001', '7531', 'admin'),
      ('d0000000-0000-4000-8000-000000000002'::uuid, 'auditor@warike.test', 'Warike-Auditor-2026', 'Auditor Warike', null, null, 'auditor'),
      ('d0000000-0000-4000-8000-000000000003'::uuid, 'u-1001@pin.warike.test', null, 'Mozo Demo', '1001', '2580', 'mozo'),
      ('d0000000-0000-4000-8000-000000000004'::uuid, 'u-2001@pin.warike.test', null, 'Cajera Demo', '2001', '1470', 'cajero'),
      ('d0000000-0000-4000-8000-000000000005'::uuid, 'u-3001@pin.warike.test', null, 'Cocina Demo', '3001', '3690', 'cocina')
    ) as t (id, email, password, nombre, codigo, pin, rol)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
      -- Los usuarios de PIN no tienen contraseña utilizable.
      extensions.crypt(coalesce(u.password, encode(extensions.gen_random_bytes(24), 'hex')), extensions.gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('nombre', u.nombre), now(), now(),
      '', '', '', ''
    ) on conflict (id) do nothing;

    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
            'email', now(), now(), now())
    on conflict do nothing;

    insert into public.usuarios_perfil (user_id, codigo_empleado, nombre_visible)
    values (u.id, u.codigo, u.nombre)
    on conflict (user_id) do nothing;

    if u.pin is not null then
      insert into app.pin_credenciales (user_id, pin_hash)
      values (u.id, extensions.crypt(u.pin, extensions.gen_salt('bf', 10)))
      on conflict (user_id) do nothing;
    end if;

    insert into public.user_local_roles (user_id, local_id, role_id)
    select u.id, v_local, r.id from public.roles r where r.empresa_id is null and r.codigo = u.rol
    on conflict do nothing;
  end loop;
end;
$$;

insert into public.dispositivos (local_id, nombre, tipo, token_hash) values
  ('b0000000-0000-4000-8000-000000000001', 'Tablet Salón 1', 'tablet_mozo', app.hash_token('wkd_' || repeat('a1', 32))),
  ('b0000000-0000-4000-8000-000000000001', 'Caja 1', 'caja', app.hash_token('wkd_' || repeat('c2', 32))),
  ('b0000000-0000-4000-8000-000000000001', 'KDS Cocina', 'kds', app.hash_token('wkd_' || repeat('d3', 32)))
on conflict (token_hash) do nothing;

update public.cajas c
set dispositivo_id = d.id
from public.dispositivos d
where c.local_id = 'b0000000-0000-4000-8000-000000000001' and c.nombre = 'Caja 1'
  and d.local_id = c.local_id and d.nombre = 'Caja 1' and c.dispositivo_id is null;

commit;
