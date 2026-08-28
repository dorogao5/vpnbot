import { describe, expect, it } from "vitest";
import {
  CONFIG_REQUEST_NOTE_MAX_LENGTH,
  normalizeConfigRequestNote,
} from "../src/config-request.js";

describe("пометка к заявке", () => {
  it("убирает лишние пробелы и переносы", () => {
    expect(normalizeConfigRequestNote("  отец\n  Саши  ")).toBe("отец Саши");
  });

  it("принимает ровно 100 символов, включая Unicode", () => {
    const note = "🙂".repeat(CONFIG_REQUEST_NOTE_MAX_LENGTH);
    expect(normalizeConfigRequestNote(note)).toBe(note);
  });

  it("отклоняет пустую и слишком длинную пометку", () => {
    expect(normalizeConfigRequestNote(" \n ")).toBeNull();
    expect(
      normalizeConfigRequestNote(
        "я".repeat(CONFIG_REQUEST_NOTE_MAX_LENGTH + 1)
      )
    ).toBeNull();
  });
});
