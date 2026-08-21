import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import type { VpnConfigRecord } from "../src/domain.js";
import { BackgroundJobs } from "../src/jobs.js";
import type { ServerResolver } from "../src/config-service.js";
import type { OpenVpnGateway, VpnServerTarget } from "../src/openvpn.js";
import { expiryFromDate, hiddenAtFromExpiry } from "../src/time.js";
import type { TrafficService } from "../src/traffic-service.js";
import { createCleanDatabase } from "./database-fixture.js";

const appConfig: AppConfig = {
  botToken: "test",
  adminTelegramId: "1",
  contactUrl: "https://t.me/ralfy",
  databaseUrl: "test",
  timezone: "Europe/Moscow",
  reminderHour: 10,
  helperCommand: "sudo /usr/local/sbin/openvpn-bot-helper",
  bootstrapPublicKey: undefined,
  telegramProxyUrl: undefined,
  sshProxyUrl: undefined,
  vpnProfile: { relay: undefined, bypassRoutes: [], bypassDomains: [], blockIpv6: false },
  relayProvisioning: undefined,
  envServers: {},
};

const TEST_TARGET: VpnServerTarget = {
  key: "old",
  name: "Старый сервер",
  host: "old.test",
  port: 22,
  username: "vpn-bot",
  privateKey: Buffer.from("key"),
  hostFingerprint: "SHA256:test",
  helperCommand: "sudo /usr/local/sbin/openvpn-bot-helper",
  proxyUrl: undefined,
};

const testResolver: ServerResolver = {
  async resolveTarget() {
    return TEST_TARGET;
  },
  async usableTargets() {
    return [TEST_TARGET];
  },
};

let db: AppDatabase;

beforeEach(async () => {
  db = await createCleanDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("напоминания об окончании", () => {
  it("объединяет несколько конфигов пользователя в одно сообщение", async () => {
    const user = await db.upsertUser({ telegramId: "200", firstName: "Иван" });
    const first = reminderConfig(user.id, "Телефон", "reminder_phone", "2026-08-01");
    const second = reminderConfig(user.id, "Ноутбук", "reminder_laptop", "2026-07-31");
    await db.insertConfig(first);
    await db.insertConfig(second);

    const sendMessage = vi.fn(
      async (
        _chatId: string,
        _text: string,
        _options: {
          reply_markup: {
            inline_keyboard: Array<Array<{ url?: string }>>;
          };
        }
      ) => ({})
    );
    const jobs = new BackgroundJobs(
      { api: { sendMessage } } as unknown as Bot,
      db,
      {} as OpenVpnGateway,
      appConfig,
      {} as TrafficService,
      testResolver
    );
    const now = DateTime.fromISO("2026-07-29T10:00:00", {
      zone: appConfig.timezone,
    });

    await jobs.sendReminders(now);
    await jobs.sendReminders(now);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [telegramId, text, options] = sendMessage.mock.calls[0]!;
    expect(telegramId).toBe(user.telegramId);
    expect(text).toContain("нескольких VPN-конфигов");
    expect(text).toContain("«Телефон» — через 3 дня");
    expect(text).toContain("«Ноутбук» — через 2 дня");
    expect(options.reply_markup.inline_keyboard[0]![0]!.url)
      .toBe(appConfig.contactUrl);
    await expect(
      db.notificationWasSent(first.id, "expires_3", "2026-07-29")
    ).resolves.toBe(true);
    await expect(
      db.notificationWasSent(second.id, "expires_2", "2026-07-29")
    ).resolves.toBe(true);
  });
});

describe("отложенный отзыв перевыпущенных конфигов", () => {
  it("повторяет неудачный отзыв до успешного выполнения", async () => {
    const scheduledAt = new Date("2026-08-11T10:00:00.000Z");
    await db.prisma.pendingRevocation.create({
      data: {
        configId: randomUUID(),
        serverKey: "old",
        clientName: "previous_client",
        scheduledAt,
      },
    });
    const revokeClient = vi
      .fn<(_server: VpnServerTarget, _client: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("server unavailable"))
      .mockResolvedValueOnce(undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const jobs = new BackgroundJobs(
      {} as Bot,
      db,
      { revokeClient } as unknown as OpenVpnGateway,
      appConfig,
      {} as TrafficService,
      testResolver
    );
    const now = DateTime.fromJSDate(scheduledAt).plus({ minutes: 1 });

    await jobs.revokeRecreatedClients(now);
    const failed = await db.prisma.pendingRevocation.findFirst();
    expect(failed).toMatchObject({ attempts: 1, lastError: "server unavailable" });

    await jobs.revokeRecreatedClients(now);
    expect(revokeClient).toHaveBeenCalledTimes(2);
    expect(revokeClient).toHaveBeenCalledWith(TEST_TARGET, "previous_client");
    expect(await db.prisma.pendingRevocation.count()).toBe(0);
    errorLog.mockRestore();
  });

  it("не отзывает клиент до назначенного времени", async () => {
    const scheduledAt = new Date("2026-08-11T10:05:00.000Z");
    await db.prisma.pendingRevocation.create({
      data: {
        configId: randomUUID(),
        serverKey: "new",
        clientName: "grace_client",
        scheduledAt,
      },
    });
    const revokeClient = vi.fn(async () => undefined);
    const jobs = new BackgroundJobs(
      {} as Bot,
      db,
      { revokeClient } as unknown as OpenVpnGateway,
      appConfig,
      {} as TrafficService,
      testResolver
    );

    await jobs.revokeRecreatedClients(
      DateTime.fromJSDate(scheduledAt).minus({ seconds: 1 })
    );

    expect(revokeClient).not.toHaveBeenCalled();
    expect(await db.prisma.pendingRevocation.count()).toBe(1);
  });
});

function reminderConfig(
  userId: number,
  displayName: string,
  clientName: string,
  expiryDate: string
): VpnConfigRecord {
  const expiresAt = expiryFromDate(expiryDate, appConfig.timezone)!;
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    userId,
    displayName,
    clientName,
    serverKey: "new",
    expiresAt,
    status: "active",
    isLegacy: false,
    revokedAt: null,
    hiddenAt: hiddenAtFromExpiry(expiresAt),
    createdAt: now,
    updatedAt: now,
  };
}
