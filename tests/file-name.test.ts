import { describe, expect, it } from "vitest";
import { labeledVpnFileName, vpnFileName } from "../src/file-name.js";

describe("vpnFileName", () => {
  it("использует только неизменяемое техническое имя", () => {
    expect(vpnFileName("abcdefghjkmn")).toBe("abcdefghjkmn.ovpn");
    expect(vpnFileName("tg100_ab12")).toBe("tg100_ab12.ovpn");
  });

  it("не допускает кириллицу и небезопасные символы", () => {
    expect(() => vpnFileName("Мой телефон")).toThrow();
    expect(() => vpnFileName("../../config")).toThrow();
  });

  it("добавляет понятное название и убирает опасные символы", () => {
    expect(labeledVpnFileName("Телефон / Android", "abcdefghjkmn")).toBe(
      "Телефон _ Android — abcdefghjkmn.ovpn"
    );
    expect(labeledVpnFileName("...", "tg100_ab12")).toBe("tg100_ab12.ovpn");
  });
});
