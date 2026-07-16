import { describe, expect, test } from "bun:test";
import { EVENT_SCHEMA_VERSION, isCompatible, PROTOCOL_VERSION } from "./index.js";

describe("protocol version", () => {
  test("constants have the expected v1 / event-schema-4 values", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(4);
  });

  test("isCompatible reflects additive-within-a-major", () => {
    expect(isCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatible(1)).toBe(true);
    expect(isCompatible(2)).toBe(false);
    expect(isCompatible(0)).toBe(false);
    expect(isCompatible(1.5)).toBe(false);
  });
});
