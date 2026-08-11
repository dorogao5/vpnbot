import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, type VpnOperations } from "../src/config-service.js";
import { AppDatabase } from "../src/database.js";
import { createCleanDatabase } from "./database-fixture.js";

class FakeVpn implements VpnOperations {
  readonly calls: string[] = [];
  readonly clients = { new: [] as string[], old: [] as string[] };
  readonly configured = { new: true, old: true };
  readonly listFailures = new Set<"new" | "old">();
  failOldRevoke = false;

  isConfigured(server: "new" | "old"): boolean {
    return this.configured[server];
  }

  async listClients(server: "new" | "old"): Promise<string[]> {
    this.calls.push(`list:${server}`);
    if (this.listFailures.has(server)) throw new Error(`${server} unavailable`);
    return [...this.clients[server]];
  }

  async createClient(server: "new" | "old", client: string): Promise<Buffer> {
    this.calls.push(`create:${server}:${client}`);
    this.clients[server].push(client);
    return Buffer.from("client\ndev tun\n");
  }

  async downloadClient(server: "new" | "old", client: string): Promise<Buffer> {
    this.calls.push(`download:${server}:${client}`);
    return Buffer.from("client\ndev tun\n");
  }

  async revokeClient(server: "new" | "old", client: string): Promise<void> {
    this.calls.push(`revoke:${server}:${client}`);
    if (server === "old" && this.failOldRevoke) throw new Error("old unavailable");
  }
}

let db: AppDatabase;
let vpn: FakeVpn;
let service: ConfigService;

beforeEach(async () => {
  db = await createCleanDatabase();
  vpn = new FakeVpn();
  service = new ConfigService(db, vpn);
});

afterEach(async () => {
  await db.close();
});

describe("ConfigService", () => {
  it("при равной нагрузке создаёт новый клиент на новом сервере", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");
    expect(config.serverKey).toBe("new");
    expect(config.clientName).toMatch(/^[a-z]{12}$/);
    expect(vpn.calls).toContain(`create:new:${config.clientName}`);
    expect(await db.listVisibleConfigs(user.id)).toHaveLength(1);
  });

  it("выбирает сервер с меньшим количеством действующих клиентов", async () => {
    vpn.clients.new.push("new_one", "new_two");
    const user = await db.upsertUser({ telegramId: "102", firstName: "Пётр" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("old");
    expect(vpn.calls).toContain(`create:old:${config.clientName}`);
  });

  it("использует доступный сервер, если второй не отвечает", async () => {
    vpn.listFailures.add("old");
    const user = await db.upsertUser({ telegramId: "103", firstName: "Ольга" });
    const config = await service.issue(user, "2027-01-01T20:59:59.999Z");

    expect(config.serverKey).toBe("new");
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
    expect(vpn.calls.at(-1)).toBe(`download:new:${first.clientName}`);
  });

  it("откатывает миграцию, если старый клиент не удалось отозвать", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    await db.syncLegacyClients("old", ["legacy_one"]);
    const legacy = (await db.listUnassignedLegacyClients("old"))[0]!;
    const config = await service.bindLegacy(user, legacy, "2027-01-01T20:59:59.999Z");
    vpn.failOldRevoke = true;

    await expect(service.migrateLegacy(config)).rejects.toThrow("old unavailable");
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
    expect(vpn.calls.at(-1)).toBe(`download:new:${config.clientName}`);
    expect(vpn.calls.filter((call) => call.startsWith("create:"))).toHaveLength(
      createCallsBeforeDownload
    );
  });

  it("перевыпускает конфиг на другом сервере и планирует отложенный отзыв", async () => {
    const user = await db.upsertUser({ telegramId: "105", firstName: "Сергей" });
    const original = await service.issue(user, "2027-03-01T20:59:59.999Z");
    await db.updateDisplayName(original.id, "Рабочий компьютер");
    const renamed = (await db.getConfig(original.id))!;

    const recreated = await service.recreate(renamed);

    expect(recreated.config.id).toBe(original.id);
    expect(recreated.config.displayName).toBe("Рабочий компьютер");
    expect(recreated.config.expiresAt).toBe(original.expiresAt);
    expect(recreated.config.serverKey).toBe("old");
    expect(recreated.config.clientName).not.toBe(original.clientName);
    expect(vpn.calls).not.toContain(`revoke:new:${original.clientName}`);
    expect(recreated.file).toBeInstanceOf(Buffer);
    const pending = await db.prisma.pendingRevocation.findMany();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      configId: original.id,
      serverKey: "new",
      clientName: original.clientName,
      attempts: 0,
    });
    expect(pending[0]!.scheduledAt.getTime()).toBeGreaterThan(
      Date.now() + 4 * 60 * 1000
    );
  });

  it("оставляет старый конфиг при ошибке немедленного админского переноса", async () => {
    const user = await db.upsertUser({ telegramId: "106", firstName: "Елена" });
    await db.syncLegacyClients("old", ["legacy_recreate"]);
    const legacy = (await db.listUnassignedLegacyClients("old"))[0]!;
    const original = await service.bindLegacy(
      user,
      legacy,
      "2027-04-01T20:59:59.999Z"
    );
    vpn.failOldRevoke = true;

    await expect(service.moveToServer(original, "new")).rejects.toThrow(
      "old unavailable"
    );

    const restored = (await db.getConfig(original.id))!;
    expect(restored.clientName).toBe(original.clientName);
    expect(restored.serverKey).toBe("old");
    expect(restored.isLegacy).toBe(true);
    expect(vpn.calls.filter((call) => call.startsWith("revoke:new:"))).toHaveLength(1);
  });

  it("принудительно переносит конфиг на выбранный сервер", async () => {
    const user = await db.upsertUser({ telegramId: "107", firstName: "Максим" });
    const original = await service.issue(user, "2027-05-01T20:59:59.999Z");

    const moved = await service.moveToServer(original, "old");

    expect(moved.config.serverKey).toBe("old");
    expect(moved.config.clientName).not.toBe(original.clientName);
    expect(vpn.calls).toContain(`create:old:${moved.config.clientName}`);
    expect(vpn.calls).toContain(`revoke:new:${original.clientName}`);
    await expect(service.moveToServer(moved.config, "old")).rejects.toThrow(
      "уже находится"
    );
  });
});
