import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  BOT_TOKEN: "telegram-token-for-test",
  ADMIN_TELEGRAM_ID: "100",
  DATABASE_URL: "postgresql://vpnbot:test@localhost:5432/vpnbot",
};

describe("VK config", () => {
  it("оставляет VK выключенным, если параметры не заданы", () => {
    expect(loadConfig(baseEnv).vk).toBeUndefined();
  });

  it("принимает ID сообщества и токен только вместе", () => {
    expect(loadConfig({
      ...baseEnv,
      VK_GROUP_ID: "241194754",
      VK_GROUP_TOKEN: "vk-secret",
    }).vk).toEqual({ groupId: 241194754, token: "vk-secret" });

    expect(() => loadConfig({ ...baseEnv, VK_GROUP_ID: "241194754" }))
      .toThrow("VK_GROUP_ID и VK_GROUP_TOKEN");
  });
});
