import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/database.js";
import type { VpnConfigRecord } from "../src/domain.js";
import { createCleanDatabase } from "./database-fixture.js";

let db: AppDatabase;

beforeEach(async () => {
  db = await createCleanDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("AppDatabase с Prisma", () => {
  it("обновляет username зарегистрированного пользователя", async () => {
    const first = await db.upsertUser({ telegramId: "100", username: "old", firstName: "Иван" });
    const updated = await db.upsertUser({ telegramId: "100", username: "new", firstName: "Иван" });
    expect(updated.id).toBe(first.id);
    expect(updated.username).toBe("new");
    expect(await db.searchUsers("@NEW")).toHaveLength(1);
  });

  it("возвращает получателей рассылки без администратора", async () => {
    await db.upsertUser({ telegramId: "100", firstName: "Администратор" });
    await db.upsertUser({ telegramId: "200", firstName: "Иван" });
    await db.upsertUser({ telegramId: "300", firstName: "Ольга" });

    expect(await db.listBroadcastRecipients("100")).toEqual(["200", "300"]);
  });

  it("не создаёт повторную открытую заявку и разрешает новую после отказа", async () => {
    const user = await db.upsertUser({
      telegramId: "request-user",
      firstName: "Анна",
    });

    const first = await db.createConfigRequest(user.id, "отец Саши");
    const duplicate = await db.createConfigRequest(user.id, "другая пометка");

    expect(first.created).toBe(true);
    expect(first.request.note).toBe("отец Саши");
    expect(duplicate).toEqual({ request: first.request, created: false });
    expect(await db.countPendingConfigRequests()).toBe(1);
    expect(await db.rejectConfigRequest(first.request.id)).toBe(true);

    const next = await db.createConfigRequest(user.id, null);
    expect(next.created).toBe(true);
    expect(next.request.id).not.toBe(first.request.id);
    expect(await db.claimConfigRequest(next.request.id)).toBe(true);
    expect(await db.releaseProcessingConfigRequests()).toBe(1);
    expect(await db.getConfigRequest(next.request.id)).toMatchObject({
      status: "pending",
    });
  });

  it("создаёт отдельного VK-пользователя без фиктивного Telegram ID", async () => {
    const user = await db.upsertVkUser({
      vkId: "700",
      peerId: "700",
      username: "vk-user",
      firstName: "Виктор",
    });

    expect(user.telegramId).toBeNull();
    expect((await db.getUserByVkId("700"))?.id).toBe(user.id);
    expect(await db.listBroadcastRecipients("100")).toEqual([]);
  });

  it("объединяет VK и Telegram через одноразовый код, сохраняя конфиги", async () => {
    const telegram = await db.upsertUser({
      telegramId: "100",
      firstName: "Иван",
    });
    const vk = await db.upsertVkUser({
      vkId: "700",
      peerId: "700",
      firstName: "Иван",
    });
    const config = testConfig(vk.id, "vk-client", "2026-12-31T20:59:59.999Z");
    await db.insertConfig(config);
    await db.createAccountLinkToken({
      userId: telegram.id,
      provider: "vk",
      tokenHash: "a".repeat(64),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const linked = await db.consumeVkAccountLink({
      tokenHash: "a".repeat(64),
      vkId: "700",
      peerId: "700",
      firstName: "Иван",
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(linked?.id).toBe(telegram.id);
    expect((await db.getUserByVkId("700"))?.id).toBe(telegram.id);
    expect((await db.getConfig(config.id))?.userId).toBe(telegram.id);
  });

  it("скрывает конфиг после окончания десятидневного окна", async () => {
    const user = await db.upsertUser({ telegramId: "100", firstName: "Иван" });
    const now = new Date().toISOString();
    const config: VpnConfigRecord = {
      id: randomUUID(), userId: user.id, displayName: "Телефон", clientName: "client1",
      serverKey: "new", expiresAt: "2026-01-01T20:59:59.999Z", status: "expired",
      isLegacy: false, revokedAt: now, hiddenAt: "2026-01-11T20:59:59.999Z",
      createdAt: now, updatedAt: now,
    };
    await db.insertConfig(config);
    expect(await db.listVisibleConfigs(user.id, new Date("2026-01-10T00:00:00.000Z"))).toHaveLength(1);
    expect(await db.listVisibleConfigs(user.id, new Date("2026-01-12T00:00:00.000Z"))).toHaveLength(0);
  });

  it("убирает из импорта клиентов, которых больше нет на сервере", async () => {
    await db.syncLegacyClients("old", ["first", "second"]);
    expect((await db.listUnassignedLegacyClients("old")).map((item) => item.clientName)).toEqual(["first", "second"]);
    await db.syncLegacyClients("old", ["second", "third"]);
    expect((await db.listUnassignedLegacyClients("old")).map((item) => item.clientName)).toEqual(["second", "third"]);
  });

  it("массово прибавляет срок только действующим конфигам", async () => {
    const user = await db.upsertUser({ telegramId: "400", firstName: "Иван" });
    const active = testConfig(user.id, "active-client", "2026-01-31T20:59:59.999Z");
    const expired = {
      ...testConfig(user.id, "expired-client", "2026-01-01T20:59:59.999Z"),
      id: randomUUID(),
      status: "expired" as const,
      revokedAt: "2026-01-02T20:59:59.999Z",
    };
    await db.insertConfig(active);
    await db.insertConfig(expired);

    expect(await db.countExtendableConfigs()).toBe(1);
    expect(await db.extendAllActiveConfigs({ months: 1 })).toBe(1);

    const updated = await db.getConfig(active.id);
    expect(updated?.expiresAt).toBe("2026-02-28T20:59:59.999Z");
    expect(updated?.hiddenAt).toBe("2026-03-10T20:59:59.999Z");
    expect((await db.getConfig(expired.id))?.expiresAt).toBe(expired.expiresAt);
  });

  it("удаляет сервер из пула, сохраняя конфиги и занятый srv_N", async () => {
    const user = await db.upsertUser({ telegramId: "500", firstName: "Ольга" });
    await db.createServerPlaceholder({
      key: "srv_7",
      name: "Удаляемый",
      host: "192.0.2.7",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "key",
      hostFingerprint: "SHA256:test",
    });
    const config = testConfig(user.id, "kept-client", "2026-12-31T20:59:59.999Z");
    config.serverKey = "srv_7";
    await db.insertConfig(config);
    await db.syncLegacyClients("srv_7", ["orphan-client"]);

    const result = await db.deleteServer("srv_7");

    expect(result).toMatchObject({ configs: 1, legacyClients: 1 });
    expect(await db.getServerByKey("srv_7")).toBeNull();
    expect(await db.getConfig(config.id)).not.toBeNull();
    expect(await db.listUnassignedLegacyClients("srv_7")).toEqual([]);
    expect(await db.maxDynamicServerId()).toBe(7);
  });
});

function testConfig(
  userId: number,
  clientName: string,
  expiresAt: string
): VpnConfigRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: randomUUID(),
    userId,
    displayName: clientName,
    clientName,
    serverKey: "new",
    expiresAt,
    status: "active",
    isLegacy: false,
    revokedAt: null,
    hiddenAt: "2027-01-10T20:59:59.999Z",
    createdAt: now,
    updatedAt: now,
  };
}
