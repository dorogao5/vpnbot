import { describe, expect, it } from "vitest";
import { hashAccountLinkCode, isVkAccountLinkCode } from "../src/account-link.js";

describe("account link codes", () => {
  it("нормализует регистр и пробелы перед хешированием", () => {
    expect(hashAccountLinkCode(" vk-a1b2c3d4e5f6 ")).toBe(
      hashAccountLinkCode("VK-A1B2C3D4E5F6")
    );
  });

  it("принимает только короткий одноразовый VK-код", () => {
    expect(isVkAccountLinkCode("VK-A1B2C3D4E5F6")).toBe(true);
    expect(isVkAccountLinkCode("vk-a1b2c3d4e5f6")).toBe(true);
    expect(isVkAccountLinkCode("VK-A1B2")).toBe(false);
    expect(isVkAccountLinkCode("TG-A1B2C3D4E5F6")).toBe(false);
  });
});
