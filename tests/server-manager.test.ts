import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ssh-run.js", () => ({
  runSshShell: vi.fn(
    () =>
      new Promise<never>(() => {
        // bootstrap никогда не завершается в юнит-тестах: сервер остаётся pending
      })
  ),
  keyFingerprint: () => "SHA256:test",
}));
import { AppDatabase } from "../src/database.js";
import type { OpenVpnGateway } from "../src/openvpn.js";
import { ServerManager } from "../src/server-manager.js";
import type { AppConfig } from "../src/config.js";
import { createCleanDatabase } from "./database-fixture.js";

const appConfig: AppConfig = {
  botToken: "test",
  adminTelegramId: "1",
  contactUrl: "https://t.me/ralfy",
  databaseUrl: "test",
  timezone: "Europe/Moscow",
  reminderHour: 10,
  helperCommand: "sudo /usr/local/sbin/openvpn-bot-helper",
  bootstrapPublicKey:
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtest vpnbot-bootstrap",
  telegramProxyUrl: undefined,
  sshProxyUrl: undefined,
  vpnProfile: { relay: undefined, blockIpv6: false },
  relayProvisioning: {
    host: "relay.example.com",
    publicHost: "relay.example.com",
    port: 22,
    username: "vpn-relay",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
    hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtest relay",
    portStart: 4443,
    portEnd: 4499,
  },
  envServers: {},
};

let db: AppDatabase;
let manager: ServerManager;

beforeEach(async () => {
  db = await createCleanDatabase();
  manager = new ServerManager(db, {} as OpenVpnGateway, appConfig);
});

afterEach(async () => {
  await db.close();
});

describe("ServerManager", () => {
  it("выделяет свободный ключ srv_N и создаёт сервер в статусе pending", async () => {
    await db.createServerPlaceholder({
      key: "srv_3",
      name: "Франкфурт",
      host: "1.2.3.4",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "",
      hostFingerprint: "pending",
    });

    const created = await manager.addServer({
      host: "5.6.7.8",
      port: 22,
      rootPassword: "secret",
      name: "Амстердам",
    });

    expect(created.key).toBe("srv_4");
    expect(created.status).toBe("pending");
    expect(created.enabled).toBe(false);
    expect(created.relayPort).toBe(4443);

    // завершаем зависший bootstrap, чтобы тест не держал соединение
    manager.onBootstrapFinished = undefined;
  });

  it("отклоняет дубликат по адресу", async () => {
    await db.createServerPlaceholder({
      key: "srv_1",
      name: "Франкфурт",
      host: "1.2.3.4",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "",
      hostFingerprint: "pending",
    });

    await expect(
      manager.addServer({
        host: "1.2.3.4",
        port: 22,
        rootPassword: "secret",
        name: "Дубликат",
      })
    ).rejects.toThrow("уже добавлен");
  });

  it("валидирует входные данные", async () => {
    await expect(
      manager.addServer({ host: "bad host!", port: 22, rootPassword: "x", name: "A" })
    ).rejects.toThrow("адрес");
    await expect(
      manager.addServer({ host: "1.2.3.4", port: 0, rootPassword: "x", name: "A" })
    ).rejects.toThrow("порт");
    await expect(
      manager.addServer({ host: "1.2.3.4", port: 22, rootPassword: "x", name: "" })
    ).rejects.toThrow("Название");
    await expect(
      manager.addServer({ host: "1.2.3.4", port: 22, rootPassword: "", name: "A" })
    ).rejects.toThrow("Пароль");
  });

  it("вычисляет usableTargets только по готовым и включённым серверам", async () => {
    await db.upsertBuiltinServer({
      key: "new",
      name: "Новый",
      host: "10.0.0.1",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
      hostFingerprint: "SHA256:abc",
    });
    await db.createServerPlaceholder({
      key: "srv_1",
      name: "В работе",
      host: "10.0.0.2",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----",
      hostFingerprint: "SHA256:def",
    });
    await db.createServerPlaceholder({
      key: "srv_2",
      name: "Настраивается",
      host: "10.0.0.3",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "",
      hostFingerprint: "pending",
    });
    await db.updateServer("srv_1", { status: "ready", enabled: false });

    const targets = await manager.usableTargets();
    expect(targets.map((target) => target.key)).toEqual(["new"]);
    await expect(manager.resolveTarget("srv_1")).resolves.toBeNull();

    await db.updateServer("srv_1", { enabled: true });
    const after = await manager.usableTargets();
    expect(after.map((target) => target.key).sort()).toEqual(["new", "srv_1"]);
    await expect(manager.resolveTarget("srv_1")).resolves.toMatchObject({
      key: "srv_1",
    });
  });

  it("возвращает displayName сервера с приоритетом БД", async () => {
    await db.upsertBuiltinServer({
      key: "old",
      name: "Старый из БД",
      host: "10.0.0.9",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "k",
      hostFingerprint: "SHA256:zzz",
    });

    await expect(manager.serverName("old")).resolves.toBe("Старый из БД");
    await db.updateServer("old", { name: "Переименованный" });
    await expect(manager.serverName("old")).resolves.toBe("Переименованный");
  });
});
