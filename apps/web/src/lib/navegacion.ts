/** Solo se permiten rutas internas como destino tras iniciar sesión (evita redirecciones abiertas). */
export function destinoSeguro(
  siguiente: string | null | undefined,
  porDefecto = "/inicio",
): string {
  if (
    !siguiente ||
    !siguiente.startsWith("/") ||
    siguiente.startsWith("//") ||
    siguiente.includes("\\")
  ) {
    return porDefecto;
  }
  return siguiente;
}
