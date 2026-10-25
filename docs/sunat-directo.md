# Envío directo a SUNAT (`SunatDirectoEmisor`)

**No se implementa en el MVP** (§2, §10.3). En producción se usa Nubefact (plan de S/ 70/mes hasta 500 documentos).
Esta alternativa se reevalúa si el volumen supera **500 documentos al mes de forma sostenida**. El reporte R4 y `uso_cpe_mensual` muestran ese volumen.

El stub está en `packages/billing-adapter/src/sunat-directo.ts` y rechaza todas las operaciones con `NoImplementadoError`.

## Qué requeriría

| Componente       | Detalle                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alta como emisor | SEE-Del Contribuyente (Sistema de Emisión Electrónica desde los sistemas del contribuyente) ante SUNAT                                                          |
| Formato          | XML UBL 2.1 para facturas (01), boletas (03) y notas de crédito y débito (07, 08), según las guías de SUNAT                                                     |
| Firma            | XAdES con el Certificado Digital Tributario (CDT), guardado en Supabase Vault                                                                                   |
| Transporte       | Servicio SOAP `billService`: `sendBill` (facturas y notas), `sendSummary` (resumen diario de boletas y comunicación de baja), `getStatus` (consulta de tickets) |
| Constancias      | Guardar el XML firmado y el CDR en Supabase Storage, más un backup inmutable (§14.4)                                                                            |
| Boletas          | Resumen diario dentro del plazo de `config_plazos_cpe.plazo_resumen_dias`                                                                                       |
| Bajas            | Comunicación de baja (facturas) y anulación en el resumen (boletas), dentro de `plazo_baja_dias`                                                                |
| Contingencia     | Procedimiento para las caídas de SUNAT, validado por el contador                                                                                                |
| Pruebas          | Ambiente de homologación (beta) de SUNAT antes de producción                                                                                                    |

## Estimación

Entre 60 y 120 h de desarrollo, más el mantenimiento ante cambios normativos de SUNAT. El ahorro estimado frente a Nubefact es de ~S/ 840 al año con ~470 documentos al mes (§2).

## Cómo migrar cuando se apruebe

1. Implementar `SunatDirectoEmisor` detrás de la misma interfaz `EmisorCPE`.
2. Probarlo en homologación con los mismos casos de §16: boleta, factura, NC `01`, baja y un rechazo.
3. Cambiar `locales.proveedor_cpe` a `sunat_directo` en el local. Es solo configuración (§10.3).
4. Seguir el runbook de migración (por escribir en la fase 5).
