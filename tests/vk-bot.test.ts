import { describe, expect, it } from "vitest";
import {
  configListKeyboard,
  vkRequiresTelegramLink,
} from "../src/vk-bot.js";

describe("VK access gate", () => {
  it("требует привязку для неизвестного и отдельного VK-пользователя", () => {
    expect(vkRequiresTelegramLink(null)).toBe(true);
    expect(vkRequiresTelegramLink({ telegramId: null })).toBe(true);
  });

  it("открывает функции после привязки Telegram", () => {
    expect(vkRequiresTelegramLink({ telegramId: "123456" })).toBe(false);
  });
});

describe("VK config list keyboard", () => {
  it("укладывает пять конфигов, пагинацию и главное меню в шесть рядов", () => {
    const configs = Array.from({ length: 5 }, (_, index) => ({
      id: `config-${index}`,
      displayName: `Конфиг ${index}`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      status: "active",
    }));

    const value = JSON.parse(configListKeyboard(configs, 0, 2));

    expect(value.buttons).toHaveLength(6);
    expect(value.buttons[5].map((item: { action: { label: string } }) =>
      item.action.label)).toEqual(["→", "Главное меню"]);
  });
});
