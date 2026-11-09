# Manual de usuario de Warike POS

Un manual por rol, con capturas de la fase 1 (salón, cocina y administración):

- [Mozo](mozo.md): ingresar con código y PIN, abrir mesas, pedir, enviar a cocina, servir, anular y mover mesas.
- [Cocina](cocina.md): pantalla de comandas (KDS), marcar platos listos y agotados.
- [Administrador](admin.md): carta y precios (con carga desde Excel), menú del día, usuarios, dispositivos, impresoras, plano, aprobaciones y reportes.

Caja y comprobantes llegan en la fase 2; este manual se ampliará entonces.

## Cómo se generan las capturas

Las imágenes de `img/` salen de recorrer la aplicación con Playwright contra el stack local con la semilla de desarrollo (por eso aparecen productos "(EJEMPLO)" y usuarios "Demo"). Para regenerarlas después de cambiar pantallas:

```bash
pnpm db:reset                      # datos limpios
pnpm --filter @warike/web build
pnpm --filter @warike/web manual   # escribe docs/manual/img/<rol>/*.png
```
