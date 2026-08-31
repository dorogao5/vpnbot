import { describe, expect, it } from "vitest";
import { vkRequiresTelegramLink } from "../src/vk-bot.js";

describe("VK access gate", () => {
  it("требует привязку для неизвестного и отдельного VK-пользователя", () => {
    expect(vkRequiresTelegramLink(null)).toBe(true);
    expect(vkRequiresTelegramLink({ telegramId: null })).toBe(true);
  });

  it("открывает функции после привязки Telegram", () => {
    expect(vkRequiresTelegramLink({ telegramId: "123456" })).toBe(false);
  });
});
