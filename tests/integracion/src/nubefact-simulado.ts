import http from "node:http";

// Nubefact simulado para las pruebas de emitir-cpe: acepta "generar_comprobante" y
// "consultar_comprobante" con el token esperado, y puede fallar a propósito.

export interface DocumentoSimulado {
  cuerpo: Record<string, unknown>;
  respuesta: Record<string, unknown>;
}

export class NubefactSimulado {
  readonly documentos = new Map<string, DocumentoSimulado>();
  readonly solicitudes: Array<{
    operacion: string;
    cuerpo: Record<string, unknown>;
    autorizacion?: string;
  }> = [];
  /** Las próximas N solicitudes responden 503 (caída del proveedor). */
  fallarProximas = 0;
  private servidor?: http.Server;

  constructor(
    readonly puerto: number,
    readonly token: string,
  ) {}

  iniciar(): Promise<void> {
    this.servidor = http.createServer((req, res) => {
      let datos = "";
      req.on("data", (c) => (datos += c));
      req.on("end", () => {
        const responder = (estado: number, cuerpo: unknown) => {
          res.writeHead(estado, { "Content-Type": "application/json" });
          res.end(JSON.stringify(cuerpo));
        };
        let cuerpo: Record<string, unknown>;
        try {
          cuerpo = JSON.parse(datos) as Record<string, unknown>;
        } catch {
          return responder(400, { errors: "JSON inválido", codigo: 10 });
        }
        const operacion = String(cuerpo.operacion);
        this.solicitudes.push({ operacion, cuerpo, autorizacion: req.headers.authorization });
        if (req.headers.authorization !== `Token token="${this.token}"`) {
          return responder(401, { errors: "Token inválido", codigo: 11 });
        }
        if (this.fallarProximas > 0) {
          this.fallarProximas--;
          return responder(503, { errors: "Servicio no disponible" });
        }
        const clave = `${cuerpo.tipo_de_comprobante}-${cuerpo.serie}-${cuerpo.numero}`;
        if (operacion === "consultar_comprobante") {
          const doc = this.documentos.get(clave);
          return doc
            ? responder(200, doc.respuesta)
            : responder(400, { errors: "No existe", codigo: 24 });
        }
        if (operacion !== "generar_comprobante") {
          return responder(400, { errors: "Operación no soportada", codigo: 12 });
        }
        if (this.documentos.has(clave)) {
          return responder(400, { errors: "Este documento ya existe en NubeFacT", codigo: 23 });
        }
        const respuesta = {
          tipo_de_comprobante: cuerpo.tipo_de_comprobante,
          serie: cuerpo.serie,
          numero: cuerpo.numero,
          enlace_del_pdf: `https://nubefact.simulado/${clave}.pdf`,
          enlace_del_xml: `https://nubefact.simulado/${clave}.xml`,
          enlace_del_cdr: `https://nubefact.simulado/${clave}.cdr`,
          aceptada_por_sunat: true,
          sunat_description: "La Boleta numero " + clave + ", ha sido aceptada",
          sunat_responsecode: "0",
          cadena_para_codigo_qr: `20480723563|${cuerpo.tipo_de_comprobante}|${cuerpo.serie}|${cuerpo.numero}|${cuerpo.total_igv}|${cuerpo.total}`,
          codigo_hash: Buffer.from(clave).toString("base64"),
        };
        this.documentos.set(clave, { cuerpo, respuesta });
        responder(200, respuesta);
      });
    });
    return new Promise((resolve) => this.servidor!.listen(this.puerto, "0.0.0.0", resolve));
  }

  detener(): Promise<void> {
    return new Promise((resolve) =>
      this.servidor ? this.servidor.close(() => resolve()) : resolve(),
    );
  }
}
