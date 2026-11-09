// Carga masiva de la carta (DECISIONS D-042): lectura de la plantilla en CSV o Excel. La validación
// definitiva y la escritura las hace la RPC importar_carta; aquí solo se separan las filas y se
// avisan los errores evidentes antes de enviarlas.

export const COLUMNAS_PLANTILLA = [
  "codigo",
  "nombre",
  "categoria",
  "precio",
  "descripcion",
  "estacion",
  "disponible",
] as const;

type Columna = (typeof COLUMNAS_PLANTILLA)[number];

export const PLANTILLA: ReadonlyArray<ReadonlyArray<string | number>> = [
  COLUMNAS_PLANTILLA,
  ["LOMO", "Lomo saltado", "Fondos", 32, "Con papas fritas y arroz", "Cocina", "si"],
  ["CHICHA-1L", "Chicha morada 1 L", "Bebidas", 12, "", "Bar", "si"],
];

export interface FilaCarta {
  fila: number;
  codigo: string | null;
  nombre: string;
  categoria: string;
  precio: number | null;
  descripcion: string | null;
  estacion: string | null;
  disponible: boolean | null;
}

export interface LecturaCarta {
  filas: FilaCarta[];
  errores: Array<{ fila: number; error: string }>;
}

/** Valor de una celda tal como lo entregan el lector de Excel o el de CSV. */
type Celda = unknown;

const ALIAS: Record<string, Columna> = {
  codigo: "codigo",
  cod: "codigo",
  nombre: "nombre",
  producto: "nombre",
  categoria: "categoria",
  precio: "precio",
  "precio (s/)": "precio",
  "precio s/": "precio",
  descripcion: "descripcion",
  estacion: "estacion",
  disponible: "disponible",
};

function normalizarEncabezado(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/** Separa un CSV de Excel o Google Sheets: detecta `,`, `;` o tabulador y respeta las comillas. */
export function parsearCsv(texto: string): string[][] {
  const limpio = texto.replace(/^\uFEFF/, "");
  const primera = limpio.split(/\r?\n/, 1)[0] ?? "";
  const separador = [";", "\t", ","]
    .map((s) => ({ s, n: primera.split(s).length }))
    .sort((a, b) => b.n - a.n)[0]!.s;

  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let entreComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i]!;
    if (entreComillas) {
      if (c === '"' && limpio[i + 1] === '"') {
        celda += '"';
        i++;
      } else if (c === '"') {
        entreComillas = false;
      } else {
        celda += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === separador) {
      fila.push(celda);
      celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && limpio[i + 1] === "\n") i++;
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = "";
    } else {
      celda += c;
    }
  }
  if (celda !== "" || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}

/** Precio escrito como 12, 12.5, "12,50", "S/ 1,234.50" o "1.234,50". */
export function leerPrecio(valor: Celda): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor !== "string") return null;
  let t = valor.replace(/s\/\.?/i, "").replace(/\s/g, "");
  if (!t) return null;
  const coma = t.lastIndexOf(",");
  const punto = t.lastIndexOf(".");
  if (coma > -1 && punto > -1) {
    t = coma > punto ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (coma > -1) {
    t = t.replace(",", ".");
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** "si", "sí", "no", "agotado", 1/0, verdadero/falso. Vacío: sin cambio (null). */
export function leerDisponible(valor: Celda): boolean | null | undefined {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "boolean") return valor;
  if (typeof valor === "number") return valor !== 0;
  const t = normalizarEncabezado(String(valor));
  if (["si", "s", "x", "1", "true", "verdadero", "disponible"].includes(t)) return true;
  if (["no", "n", "0", "false", "falso", "agotado"].includes(t)) return false;
  return undefined;
}

function texto(valor: Celda): string {
  if (valor === null || valor === undefined) return "";
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).trim();
}

/** Convierte la hoja (primera fila = encabezados) en filas para importar_carta. */
export function leerTabla(tabla: ReadonlyArray<ReadonlyArray<Celda>>): LecturaCarta {
  const errores: LecturaCarta["errores"] = [];
  const encabezados = (tabla[0] ?? []).map((c) => ALIAS[normalizarEncabezado(texto(c))]);
  for (const requerida of ["nombre", "categoria", "precio"] as const) {
    if (!encabezados.includes(requerida)) {
      errores.push({ fila: 1, error: `Falta la columna "${requerida}" (use la plantilla)` });
    }
  }
  if (errores.length) return { filas: [], errores };

  const filas: FilaCarta[] = [];
  tabla.slice(1).forEach((celdas, i) => {
    const fila = i + 2;
    const valor = (columna: Columna) => {
      const indice = encabezados.indexOf(columna);
      return indice === -1 ? undefined : celdas[indice];
    };
    if (celdas.every((c) => texto(c) === "")) return;
    const nombre = texto(valor("nombre"));
    const categoria = texto(valor("categoria"));
    const precio = leerPrecio(valor("precio") ?? null);
    const disponible = leerDisponible(valor("disponible"));
    if (!nombre) errores.push({ fila, error: "Falta el nombre" });
    if (!categoria) errores.push({ fila, error: "Falta la categoría" });
    if (precio === null || precio < 0) errores.push({ fila, error: "El precio no es un número" });
    if (disponible === undefined) errores.push({ fila, error: 'En "disponible" escriba si o no' });
    filas.push({
      fila,
      codigo: texto(valor("codigo")) || null,
      nombre,
      categoria,
      precio,
      descripcion: texto(valor("descripcion")) || null,
      estacion: texto(valor("estacion")) || null,
      disponible: disponible ?? null,
    });
  });
  if (!filas.length && !errores.length)
    errores.push({ fila: 2, error: "El archivo no tiene productos" });
  return { filas, errores };
}
