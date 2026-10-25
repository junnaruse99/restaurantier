const ORIGEN_DE_REFERENCIA = "https://warike.invalid";

/**
 * Solo se permiten rutas internas como destino tras iniciar sesión (evita redirecciones abiertas).
 * La ruta se resuelve con el mismo parser de URL que usará el navegador, así que trucos como
 * `//sitio`, `/\sitio` o tabuladores y saltos de línea intercalados no escapan del origen.
 */
export function destinoSeguro(
  siguiente: string | null | undefined,
  porDefecto = "/inicio",
): string {
  if (!siguiente || !siguiente.startsWith("/")) return porDefecto;
  let url: URL;
  try {
    url = new URL(siguiente, ORIGEN_DE_REFERENCIA);
  } catch {
    return porDefecto;
  }
  if (url.origin !== ORIGEN_DE_REFERENCIA) return porDefecto;
  return `${url.pathname}${url.search}${url.hash}`;
}
