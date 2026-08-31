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

describe("SSH routing config", () => {
  it("разбирает список серверов с прямым SSH", () => {
    const config = loadConfig({
      ...baseEnv,
      SSH_PROXY_URL: "socks5h://127.0.0.1:1081",
      VPN_DIRECT_SSH_SERVER_KEYS: "srv_1, old",
    });

    expect([...config.directSshServerKeys]).toEqual(["srv_1", "old"]);
    expect(config.sshProxyUrl).toBe("socks5h://127.0.0.1:1081");
  });

  it("отклоняет некорректный ключ сервера", () => {
    expect(() => loadConfig({
      ...baseEnv,
      VPN_DIRECT_SSH_SERVER_KEYS: "srv_1, bad key",
    })).toThrow("Некорректный ключ VPN-сервера");
  });
});
