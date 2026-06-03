import { describe, expect, it } from "vitest";

import { inferCascadeDirectionFromTrigger } from "./cascadeAtPrice";

describe("inferCascadeDirectionFromTrigger", () => {
  it("below bid → buy", () => {
    expect(inferCascadeDirectionFromTrigger(4440, 4500)).toBe("buy");
  });
  it("above bid → sell", () => {
    expect(inferCascadeDirectionFromTrigger(4520, 4500)).toBe("sell");
  });
  it("equal → null", () => {
    expect(inferCascadeDirectionFromTrigger(4500, 4500)).toBe(null);
  });
});
