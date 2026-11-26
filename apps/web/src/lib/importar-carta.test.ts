import { describe, expect, it } from "vitest";
import { leerDisponible, leerPrecio, leerTabla, parsearCsv, PLANTILLA } from "./importar-carta";

describe("parsearCsv", () => {
  it("detecta punto y coma, respeta comillas y quita el BOM", () => {
    const csv = '﻿nombre;precio\r\n"Lomo; con ""papas""";32,50\r\nChicha;12\r\n';
    expect(parsearCsv(csv)).toEqual([
      ["nombre", "precio"],
      ['Lomo; con "papas"', "32,50"],
      ["Chicha", "12"],
    ]);
  });

  it("acepta comas y tabuladores, y una última fila sin salto de línea", () => {
    expect(parsearCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parsearCsv("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("permite saltos de línea dentro de una celda entre comillas", () => {
    expect(parsearCsv('a,b\n"uno\ndos",2')).toEqual([
      ["a", "b"],
      ["uno\ndos", "2"],
    ]);
  });
});

describe("leerPrecio", () => {
  it.each([
    [32, 32],
    ["32", 32],
    ["32,50", 32.5],
    ["S/ 12.90", 12.9],
    ["S/. 1,234.50", 1234.5],
    ["1.234,50", 1234.5],
  ])("%s → %s", (entrada, esperado) => {
    expect(leerPrecio(entrada)).toBe(esperado);
  });

  it("rechaza lo que no es un número", () => {
    expect(leerPrecio("doce")).toBeNull();
    expect(leerPrecio("")).toBeNull();
    expect(leerPrecio(null)).toBeNull();
    expect(leerPrecio(Number.NaN)).toBeNull();
  });
});

describe("leerDisponible", () => {
  it("entiende sí y no en varias formas", () => {
    expect(leerDisponible("Sí")).toBe(true);
    expect(leerDisponible("agotado")).toBe(false);
    expect(leerDisponible(1)).toBe(true);
    expect(leerDisponible(false)).toBe(false);
    expect(leerDisponible("")).toBeNull();
    expect(leerDisponible("tal vez")).toBeUndefined();
  });
});

describe("leerTabla", () => {
  it("lee la plantilla", () => {
    const { filas, errores } = leerTabla(PLANTILLA);
    expect(errores).toEqual([]);
    expect(filas[0]).toEqual({
      fila: 2,
      codigo: "LOMO",
      nombre: "Lomo saltado",
      categoria: "Fondos",
      precio: 32,
      descripcion: "Con papas fritas y arroz",
      estacion: "Cocina",
      disponible: true,
    });
    expect(filas[1]!.descripcion).toBeNull();
  });

  it("acepta encabezados con tildes, en otro orden y sin las columnas opcionales", () => {
    const { filas, errores } = leerTabla([
      ["Precio (S/)", "Categoría", "Nombre"],
      ["15,5", "Entradas", "Tequeños"],
      ["", "", ""],
    ]);
    expect(errores).toEqual([]);
    expect(filas).toEqual([
      {
        fila: 2,
        codigo: null,
        nombre: "Tequeños",
        categoria: "Entradas",
        precio: 15.5,
        descripcion: null,
        estacion: null,
        disponible: null,
      },
    ]);
  });

  it("avisa columnas faltantes y errores por fila", () => {
    expect(leerTabla([["nombre", "precio"]]).errores).toEqual([
      { fila: 1, error: 'Falta la columna "categoria" (use la plantilla)' },
    ]);
    const { errores } = leerTabla([
      ["nombre", "categoria", "precio", "disponible"],
      ["", "Fondos", "abc", "tal vez"],
    ]);
    expect(errores.map((e) => e.error)).toEqual([
      "Falta el nombre",
      "El precio no es un número",
      'En "disponible" escriba si o no',
    ]);
    expect(leerTabla([["nombre", "categoria", "precio"]]).errores).toEqual([
      { fila: 2, error: "El archivo no tiene productos" },
    ]);
  });
});
