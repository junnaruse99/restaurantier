/**
 * UUID v7 (RFC 9562) para los client_mutation_id (§12.2): ordenados por tiempo, así el outbox y
 * outbox_recibidos se leen en el orden en que se generaron.
 */
export function uuidv7(
  ahora = Date.now(),
  aleatorio: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  const b = new Uint8Array(16);
  let ms = BigInt(ahora);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b.set(aleatorio.subarray(0, 10), 6);
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
