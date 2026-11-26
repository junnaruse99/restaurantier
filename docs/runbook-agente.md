# Runbook: agente de impresión

Instalación, operación y reinstalación del agente local de impresión (`apps/print-agent`, §3, §13, §14.1).
El agente no guarda datos críticos: si el equipo se daña, se reinstala con estos pasos en unos 30 minutos.

## 1. Qué hace

- Entra a Supabase con el **token de su dispositivo** (tipo `agente_impresion`) por la Edge Function
  `agente-login`. Nunca usa la `service_role`: recibe un usuario técnico cuyo único permiso es `imprimir`, y
  la sesión queda ligada al dispositivo por 24 h (se renueva sola).
- Se entera de los trabajos nuevos por **Realtime** y, de respaldo, consulta la cola cada 5 s.
- Imprime en orden por impresora, por **TCP 9100 (RAW)** o **USB**, con plantillas ESC/POS de 80 y 58 mm en
  CP858 (ñ y tildes): comanda, anulación y traslado. Pre-cuenta, comprobantes y cortes llegan en la fase 2.
- Si la impresora está apagada o sin papel, el trabajo vuelve a la cola y se reintenta con espera creciente
  (5 s, 10 s, 20 s… hasta 60 s). Tras 20 intentos queda en **error** y el admin lo redirige a otra impresora.
- Informa el estado de cada impresora (`ok`, `sin_papel`, `offline`) y envía un latido cada 30 s.
- El relevo por LAN para trabajar sin internet (§12.3) se agrega en la fase 3.

## 2. Requisitos

- Mini-PC con Windows 10/11 o Linux (Debian/Ubuntu), en la misma red que las impresoras, con IP fija o
  reserva DHCP. Node.js 22.12 o superior (se recomienda 24 LTS) y pnpm 10.
- Impresoras térmicas ESC/POS (Epson TM-T20 o genéricas tipo Xprinter) con IP fija en el puerto 9100, o
  conectadas por USB al mini-PC.

## 3. Registrar el dispositivo y las impresoras

1. En el panel de admin → **Dispositivos**, registre un dispositivo de tipo **Agente de impresión**. Copie el
   token que se muestra: solo se ve una vez.
2. En **Impresoras**, cree cada impresora:
   - **TCP**: dirección IP y puerto (9100).
   - **USB**: en `host` ponga la ruta del dispositivo (`/dev/usb/lp0` en Linux) o el nombre compartido en
     Windows (`\\localhost\COCINA`). Si queda vacío, se usa `WARIKE_USB_RUTA`.
   - Ancho del papel (80 o 58 mm) y el agente que la atiende.
3. En **Estaciones de producción**, asigne la impresora de cada estación (Cocina, Parrilla, Bar). Una
   estación sin impresora trabaja solo con el KDS.

## 4. Instalar en Linux (systemd)

```bash
sudo useradd --system --groups lp warike
sudo git clone https://github.com/<org>/restaurantier /opt/warike
cd /opt/warike && sudo corepack enable && sudo pnpm install --frozen-lockfile --filter @warike/print-agent...
sudo mkdir -p /etc/warike
sudo cp apps/print-agent/deploy/print-agent.env.ejemplo /etc/warike/print-agent.env
sudo chmod 600 /etc/warike/print-agent.env   # complete SUPABASE_URL, la clave publicable y el token
sudo cp apps/print-agent/deploy/warike-print-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now warike-print-agent
journalctl -u warike-print-agent -f          # debe decir "agente en línea"
```

El grupo `lp` da acceso a `/dev/usb/lp*`.

## 5. Instalar en Windows (servicio con NSSM)

1. Instale Node.js 24 LTS, Git y [NSSM](https://nssm.cc/). Habilite pnpm: `corepack enable`.
2. Clone el repositorio en `C:\warike` e instale: `pnpm install --frozen-lockfile --filter @warike/print-agent...`
3. Cree el servicio (PowerShell como administrador):

   ```powershell
   nssm install WarikePrintAgent "C:\Program Files\nodejs\node.exe"
   nssm set WarikePrintAgent AppDirectory C:\warike\apps\print-agent
   nssm set WarikePrintAgent AppParameters "node_modules\tsx\dist\cli.mjs src\index.ts"
   nssm set WarikePrintAgent AppEnvironmentExtra "SUPABASE_URL=https://<ref>.supabase.co" "SUPABASE_PUBLISHABLE_KEY=<clave>" "WARIKE_DEVICE_TOKEN=wkd_..."
   nssm set WarikePrintAgent AppStdout C:\warike\logs\print-agent.log
   nssm set WarikePrintAgent AppStderr C:\warike\logs\print-agent.log
   nssm set WarikePrintAgent AppRotateFiles 1
   nssm set WarikePrintAgent Start SERVICE_AUTO_START
   nssm start WarikePrintAgent
   ```

4. Para USB en Windows, comparta la impresora (p. ej. `COCINA`) con el driver "Generic / Text Only" y use
   `\\localhost\COCINA` como ruta.

La autoactualización desde GitHub Releases firmados (§17) se agrega en la fase 4; mientras tanto se
actualiza con `git pull && pnpm install` y reiniciando el servicio.

## 6. Página de códigos

El agente selecciona CP858 con `ESC t 19`, que es el valor de Epson y de la mayoría de las genéricas. Si
la ñ o las tildes salen mal, consulte la hoja de autoprueba de la impresora y ajuste
`WARIKE_PAGINA_CODIGOS` (algunas Xprinter usan 16 para WPC1252, que también tiene ñ y tildes, pero no
el mismo orden: en ese caso hay que reportarlo para agregar la tabla).

## 7. Probar sin impresoras (desarrollo)

La semilla de desarrollo trae el dispositivo **Agente Caja** (`wkd_` + `e4` × 32) y tres impresoras en
`127.0.0.1:9101-9103`. Con el stack local levantado:

```bash
pnpm --filter @warike/print-agent simulador          # impresoras simuladas que muestran el ticket en texto
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_PUBLISHABLE_KEY=<anon key de supabase status> \
WARIKE_DEVICE_TOKEN=wkd_e4e4…e4 \
pnpm --filter @warike/print-agent start
```

Envíe una comanda desde la tablet y el simulador la imprime en la consola.

## 8. Problemas frecuentes

| Síntoma                             | Qué revisar                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `agente-login respondió 401`        | El dispositivo está desactivado o el token no es de tipo agente. Registre uno nuevo.                 |
| La caja muestra "impresora offline" | IP y puerto de la impresora (`nc -vz <ip> 9100`), cable de red, que esté encendida.                  |
| "sin papel"                         | Cambie el rollo; el siguiente trabajo vuelve a "ok" solo.                                            |
| Trabajos en **error**               | Pasaron 20 intentos. En **Impresoras → Trabajos**, redirija el trabajo a otra impresora o reintente. |
| No llegan trabajos                  | `journalctl`/log del servicio; el health check alerta si el agente lleva más de 2 min sin latido.    |
