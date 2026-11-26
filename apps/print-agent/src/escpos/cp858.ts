/**
 * Codificación CP858 (CP850 con €) para impresoras térmicas (§13): ñ, tildes, ¿, ¡ y símbolos
 * comunes. Lo que no existe en la página se aproxima (sin tilde) o se reemplaza por "?".
 */
const TABLA: Record<string, number> = {
  Ç: 0x80,
  ü: 0x81,
  é: 0x82,
  â: 0x83,
  ä: 0x84,
  à: 0x85,
  å: 0x86,
  ç: 0x87,
  ê: 0x88,
  ë: 0x89,
  è: 0x8a,
  ï: 0x8b,
  î: 0x8c,
  ì: 0x8d,
  Ä: 0x8e,
  Å: 0x8f,
  É: 0x90,
  æ: 0x91,
  Æ: 0x92,
  ô: 0x93,
  ö: 0x94,
  ò: 0x95,
  û: 0x96,
  ù: 0x97,
  ÿ: 0x98,
  Ö: 0x99,
  Ü: 0x9a,
  ø: 0x9b,
  "£": 0x9c,
  Ø: 0x9d,
  "×": 0x9e,
  á: 0xa0,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  ñ: 0xa4,
  Ñ: 0xa5,
  ª: 0xa6,
  º: 0xa7,
  "¿": 0xa8,
  "®": 0xa9,
  "½": 0xab,
  "¼": 0xac,
  "¡": 0xad,
  "«": 0xae,
  "»": 0xaf,
  Á: 0xb5,
  Â: 0xb6,
  À: 0xb7,
  "©": 0xb8,
  ã: 0xc6,
  Ã: 0xc7,
  Ê: 0xd2,
  Ë: 0xd3,
  È: 0xd4,
  "€": 0xd5,
  Í: 0xd6,
  Î: 0xd7,
  Ï: 0xd8,
  Ì: 0xde,
  Ó: 0xe0,
  ß: 0xe1,
  Ô: 0xe2,
  Ò: 0xe3,
  õ: 0xe4,
  Õ: 0xe5,
  µ: 0xe6,
  Ú: 0xe9,
  Û: 0xea,
  Ù: 0xeb,
  "±": 0xf1,
  "°": 0xf8,
  "·": 0xfa,
  "²": 0xfd,
};

/** Sustituciones para caracteres frecuentes que CP858 no tiene. */
const SUSTITUTOS: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  " ": " ",
};

export function codificarCp858(texto: string): Buffer {
  const bytes: number[] = [];
  for (const caracter of texto.normalize("NFC")) {
    const codigo = caracter.codePointAt(0)!;
    if (codigo === 0x0a || (codigo >= 0x20 && codigo < 0x7f)) {
      bytes.push(codigo);
      continue;
    }
    const directo = TABLA[caracter];
    if (directo !== undefined) {
      bytes.push(directo);
      continue;
    }
    const sustituto = SUSTITUTOS[caracter] ?? caracter.normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (const c of sustituto) {
      const cc = c.codePointAt(0)!;
      bytes.push(cc >= 0x20 && cc < 0x7f ? cc : 0x3f);
    }
  }
  return Buffer.from(bytes);
}

const INVERSA = new Map<number, string>(Object.entries(TABLA).map(([c, b]) => [b, c]));

/** Inverso de codificarCp858 para bytes de texto (lo usa el simulador de impresora). */
export function decodificarCp858(bytes: Uint8Array): string {
  let texto = "";
  for (const b of bytes) texto += b < 0x80 ? String.fromCharCode(b) : (INVERSA.get(b) ?? "?");
  return texto;
}
