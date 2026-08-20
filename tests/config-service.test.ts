import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigService,
  type ServerResolver,
  type VpnOperations,
} from "../src/config-service.js";
import { AppDatabase } from "../src/database.js";
import type { VpnServerTarget } from "../src/openvpn.js";
import { createCleanDatabase } from "./database-fixture.js";

function serverTarget(key: string, clients: string[]): VpnServerTarget {
  return {
    key,
    name: key === "new" ? "Новый сервер" : key === "old" ? "Старый сервер" : key,
    host: `${key}.test`,
    port: 22,
    username: "vpn-bot",
    privateKey: Buffer.from("key"),
    hostFingerprint: "SHA256:test",
    helperCommand: "sudo /usr/local/sbin/openvpn-bot-helper",
  };
}

class FakeVpn implements VpnOperations {
  readonly calls: string[] = [];
  readonly clients = new Map<string, string[]>([
    ["new", []],
    ["old", []],
  ]);
  readonly enabled = new Map<string, boolean>([
    ["new", true],
    ["old", true],
  ]);
  readonly listFailures = new Set<string>();
  failRevokeOn = "";

  async listClients(server: VpnServerTarget): Promise<string[]> {
    this.calls.push(`list:${server.key}`);
    if (this.listFailures.has(server.key))
      throw new Error(`${server.key} unavailable`);
    return [...(this.clients.get(server.key) ?? [])];
  }

  async createClient(server: VpnServerTarget, client: string): Promise<Buffer> {
    this.calls.push(`create:${server.key}:${client}`);
    this.clients.get(server.key)!.push(client);
    return Buffer.from("client\ndev tun\n");
  }

  async downloadClient(server: VpnServerTarget, client: string): Promise<Buffer> {
    this.calls.push(`download:${server.key}:${client}`);
    return Buffer.from("client\ndev tun\n");
  }

  async revokeClient(server: VpnServerTarget, client: string): Promise<void> {
    this.calls.push(`revoke:${server.key}:${client}`);
    if (server.key === this.failRevokeOn)
      throw new Error(`${server.key} unavailable`);
  }
}

class FakeResolver implements ServerResolver {
  constructor(private readonly vpn: FakeVpn) {}

  async resolveTarget(serverKey: string): Promise<VpnServerTarget | null> {
    if (!this.vpn.clients.has(serverKey)) return null;
    return serverTarget(serverKey, []);
  }

  async usableTargets(): Promise<VpnServerTarget[]> {
    return [...this.vpn.enabled.entries()]
      .filter(([, enabled]) => enabled)
      .map(([key]) => serverTarget(key, []));
  }
}

let db: AppDatabase;
let vpn: FakeVpn;
let service: ConfigService;

beforeEach(async () => {
  db = await createCleanDatabase();
  vpn = new FakeVpn();
  service = new ConfigService(db, vpn, new FakeResolver(vpn));
});

afterEach(async () => {
  await db.close();
});

describe("ConfigService", () => {
  it("при равной нагрузке создаёт новый клиент на сервере с лексикографически первым ключом", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");
    expect(["new", "old"]).toContain(config.serverKey);
    expect(config.clientName).toMatch(/^[a-z]{12}$/);
    expect(vpn.calls).toContain(`create:${config.serverKey}:${config.clientName}`);
    expect(await db.listVisibleConfigs(user.id)).toHaveLength(1);
  });

  it("выбирает сервер с меньшим количеством действующих клиентов", async () => {
    vpn.clients.get("new")!.push("new_one", "new_two");
    const user = await db.upsertUser({ telegramId: "102", firstName: "Пётр" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("old");
    expect(vpn.calls).toContain(`create:old:${config.clientName}`);
  });

  it("использует доступный сервер, если второй не отвечает", async () => {
    vpn.listFailures.add("old");
    vpn.clients.get("new")!.push("a", "b", "c");
    const user = await db.upsertUser({ telegramId: "103", firstName: "Ольга" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("new");
  });

  it("не выдаёт конфиги на выключенном сервере", async () => {
    vpn.enabled.set("new", false);
    const user = await db.upsertUser({ telegramId: "109", firstName: "Тест" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("old");
  });

  it("выдаёт разные технические имена и не меняет их при переименовании", async () => {
    const user = await db.upsertUser({ telegramId: "101", firstName: "Анна" });
    const first = await service.issue(user, "2027-01-01T20:59:59.999Z");
    const second = await service.issue(user, "2027-02-01T20:59:59.999Z");

    expect(first.clientName).not.toBe(second.clientName);
    await db.updateDisplayName(first.id, "Рабочий ноутбук 💻");
    const renamed = (await db.getConfig(first.id))!;
    await service.download(renamed);

    expect(renamed.displayName).toBe("Рабочий ноутбук 💻");
    expect(renamed.clientName).toBe(first.clientName);
    expect(vpn.calls.at(-1)).toBe(`download:${first.serverKey}:${first.clientName}`);
  });

  it("откатывает перенос, если старый клиент не удалось отозвать", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    await db.syncLegacyClients("old", ["legacy_one"]);
    const legacy = (await db.listUnassignedLegacyClients("old"))[0]!;
    const config = await service.bindLegacy(user, legacy, "2027-01-01T20:59:59.999Z");
    vpn.failRevokeOn = "old";

    await expect(service.moveToServer(config, "new")).rejects.toThrow(
      "old unavailable"
    );
    const restored = (await db.getConfig(config.id))!;
    expect(restored.serverKey).toBe("old");
    expect(restored.clientName).toBe("legacy_one");
    expect(vpn.calls.some((call) => call.startsWith("revoke:new:"))).toBe(true);
  });

  it("повторно выдаёт старый конфиг без переноса", async () => {
    const user = await db.upsertUser({ telegramId: "104", firstName: "Мария" });
    await db.syncLegacyClients("old", ["legacy_download"]);
    const legacy = (await db.listUnassignedLegacyClients("old"))[0]!;
    const config = await service.bindLegacy(user, legacy, "2027-01-01T20:59:59.999Z");

    expect(config.displayName).toBe("legacy_download.ovpn");
    expect(config.clientName).toBe("legacy_download");
    await expect(service.download(config)).resolves.toBeInstanceOf(Buffer);
    expect(vpn.calls.at(-1)).toBe("download:old:legacy_download");
  });

  it("позволяет администратору скачать существующий просроченный конфиг без перевыпуска", async () => {
    const user = await db.upsertUser({ telegramId: "108", firstName: "Игорь" });
    const config = await service.issue(user, "2020-01-01T20:59:59.999Z");
    const createCallsBeforeDownload = vpn.calls.filter((call) =>
      call.startsWith("create:")
    ).length;

    await expect(service.downloadExisting(config)).resolves.toBeInstanceOf(Buffer);
    expect(vpn.calls.at(-1)).toBe(`download:${config.serverKey}:${config.clientName}`);
    expect(vpn.calls.filter((call) => call.startsWith("create:"))).toHaveLength(
      createCallsBeforeDownload
    );
  });

  it("перевыпускает конфиг на выбранном сервере и планирует отложенный отзыв", async () => {
    const user = await db.upsertUser({ telegramId: "105", firstName: "Сергей" });
    const original = await service.issue(user, "2027-03-01T20:59:59.999Z");
    await db.updateDisplayName(original.id, "Рабочий компьютер");
    const renamed = (await db.getConfig(original.id))!;
    const targetKey = original.serverKey === "new" ? "old" : "new";

    const recreated = await service.recreate(renamed, targetKey);

    expect(recreated.config.id).toBe(original.id);
    expect(recreated.config.displayName).toBe("Рабочий компьютер");
    expect(recreated.config.expiresAt).toBe(original.expiresAt);
    expect(recreated.config.serverKey).toBe(targetKey);
    expect(recreated.config.clientName).not.toBe(original.clientName);
    expect(vpn.calls).not.toContain(
      `revoke:${original.serverKey}:${original.clientName}`
    );
    expect(recreated.file).toBeInstanceOf(Buffer);
    const pending = await db.prisma.pendingRevocation.findMany();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      configId: original.id,
      serverKey: original.serverKey,
      clientName: original.clientName,
      attempts: 0,
    });
    expect(pending[0]!.scheduledAt.getTime()).toBeGreaterThan(
      Date.now() + 4 * 60 * 1000
    );
  });

  it("принудительно переносит конфиг на выбранный сервер", async () => {
    const user = await db.upsertUser({ telegramId: "107", firstName: "Максим" });
    const original = await service.issue(user, "2027-05-01T20:59:59.999Z");
    const targetKey = original.serverKey === "new" ? "old" : "new";

    const moved = await service.moveToServer(original, targetKey);

    expect(moved.config.serverKey).toBe(targetKey);
    expect(moved.config.clientName).not.toBe(original.clientName);
    expect(vpn.calls).toContain(`create:${targetKey}:${moved.config.clientName}`);
    expect(vpn.calls).toContain(`revoke:${original.serverKey}:${original.clientName}`);
    await expect(service.moveToServer(moved.config, targetKey)).rejects.toThrow(
      "уже находится"
    );
  });
});
