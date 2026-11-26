import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid";

describe("uuidv7", () => {
  it("tiene versión 7, variante RFC y el instante en los primeros 48 bits", () => {
    const id = uuidv7(0x0190_1234_5678, new Uint8Array(10).fill(0xff));
    expect(id).toBe("01901234-5678-7fff-bfff-ffffffffffff");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("se ordena por tiempo", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
