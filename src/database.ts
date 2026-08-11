import { PrismaPg } from "@prisma/adapter-pg";
import type { User, VpnConfig, LegacyClient } from "./generated/prisma/client.js";
import { PrismaClient } from "./generated/prisma/client.js";
import type {
  CompletedTrafficSession,
  LegacyClientRecord,
  PendingRevocationRecord,
  ServerKey,
  ServerTraffic,
  UserRecord,
  VpnConfigRecord,
} from "./domain.js";

function mapUser(row: User): UserRecord {
  return {
    id: row.id,
    telegramId: row.telegramId,
    username: row.username,
    firstName: row.firstName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapConfig(row: VpnConfig): VpnConfigRecord {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    clientName: row.clientName,
    serverKey: row.serverKey,
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    isLegacy: row.isLegacy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    hiddenAt: row.hiddenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapLegacy(row: LegacyClient): LegacyClientRecord {
  return {
    id: row.id,
    serverKey: row.serverKey,
    clientName: row.clientName,
    assignedConfigId: row.assignedConfigId,
    discoveredAt: row.discoveredAt.toISOString(),
  };
}

function configData(config: VpnConfigRecord) {
  return {
    id: config.id,
    userId: config.userId,
    displayName: config.displayName,
    clientName: config.clientName,
    serverKey: config.serverKey,
    expiresAt: new Date(config.expiresAt),
    status: config.status,
    isLegacy: config.isLegacy,
    revokedAt: config.revokedAt ? new Date(config.revokedAt) : null,
    hiddenAt: new Date(config.hiddenAt),
    createdAt: new Date(config.createdAt),
    updatedAt: new Date(config.updatedAt),
  };
}

export class AppDatabase {
  readonly prisma: PrismaClient;

  constructor(databaseUrl: string) {
    const adapter = new PrismaPg({ connectionString: databaseUrl, max: 5 });
    this.prisma = new PrismaClient({ adapter });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async upsertUser(input: { telegramId: string; username?: string; firstName: string }): Promise<UserRecord> {
    const row = await this.prisma.user.upsert({
      where: { telegramId: input.telegramId },
      create: {
        telegramId: input.telegramId,
        username: input.username ?? null,
        firstName: input.firstName,
      },
      update: {
        username: input.username ?? null,
        firstName: input.firstName,
      },
    });
    return mapUser(row);
  }

  async getUserByTelegramId(telegramId: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { telegramId } });
    return row ? mapUser(row) : null;
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? mapUser(row) : null;
  }

  async searchUsers(query: string): Promise<UserRecord[]> {
    const normalized = query.trim().replace(/^@/, "");
    const rows = await this.prisma.user.findMany({
      where: {
        OR: [
          { telegramId: normalized },
          { username: { equals: normalized, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });
    return rows.map(mapUser);
  }

  async listBroadcastRecipients(excludedTelegramId: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { telegramId: { not: excludedTelegramId } },
      orderBy: { id: "asc" },
      select: { telegramId: true },
    });
    return rows.map(({ telegramId }) => telegramId);
  }

  async insertConfig(config: VpnConfigRecord): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.vpnConfig.create({ data: configData(config) });
      await tx.clientName.upsert({
        where: { name: config.clientName },
        create: { name: config.clientName, configId: config.id },
        update: { configId: config.id },
      });
    });
  }

  async reserveClientName(name: string): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "client_names" ("name")
      VALUES (${name})
      ON CONFLICT ("name") DO NOTHING
    `;
    return inserted === 1;
  }

  async insertConfigAndAssignLegacy(config: VpnConfigRecord, legacyId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const legacy = await tx.legacyClient.findFirst({
        where: { id: legacyId, assignedConfigId: null },
        select: { id: true },
      });
      if (!legacy) throw new Error("Этот клиент уже привязан");
      await tx.vpnConfig.create({ data: configData(config) });
      await tx.clientName.upsert({
        where: { name: config.clientName },
        create: { name: config.clientName, configId: config.id },
        update: { configId: config.id },
      });
      await tx.legacyClient.update({ where: { id: legacyId }, data: { assignedConfigId: config.id } });
    });
  }

  async getConfig(id: string): Promise<VpnConfigRecord | null> {
    const row = await this.prisma.vpnConfig.findUnique({ where: { id } });
    return row ? mapConfig(row) : null;
  }

  async listVisibleConfigs(userId: number, now = new Date()): Promise<VpnConfigRecord[]> {
    const rows = await this.prisma.vpnConfig.findMany({
      where: { userId, status: { not: "revoked" }, hiddenAt: { gt: now } },
      orderBy: [{ expiresAt: "desc" }, { createdAt: "desc" }],
    });
    return rows.map(mapConfig);
  }

  async listConfigsForUserAdmin(userId: number): Promise<VpnConfigRecord[]> {
    const rows = await this.prisma.vpnConfig.findMany({
      where: { userId, status: { not: "revoked" } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapConfig);
  }

  async listReminderCandidates(): Promise<Array<{ config: VpnConfigRecord; user: UserRecord }>> {
    const rows = await this.prisma.vpnConfig.findMany({
      where: { status: "active" },
      include: { user: true },
    });
    return rows.map((row) => ({ config: mapConfig(row), user: mapUser(row.user) }));
  }

  async listActiveConfigs(): Promise<VpnConfigRecord[]> {
    return (await this.prisma.vpnConfig.findMany({ where: { status: "active" } })).map(mapConfig);
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await this.prisma.vpnConfig.update({ where: { id }, data: { displayName } });
  }

  async updateExpiry(id: string, expiresAt: string, hiddenAt: string): Promise<void> {
    await this.prisma.vpnConfig.update({
      where: { id },
      data: {
        expiresAt: new Date(expiresAt),
        hiddenAt: new Date(hiddenAt),
        status: "active",
        revokedAt: null,
      },
    });
  }

  async replaceClient(
    id: string,
    clientName: string,
    serverKey: ServerKey,
    expiresAt: string,
    hiddenAt: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.vpnConfig.update({
        where: { id },
        data: {
          clientName,
          serverKey,
          isLegacy: false,
          expiresAt: new Date(expiresAt),
          hiddenAt: new Date(hiddenAt),
          status: "active",
          revokedAt: null,
        },
      });
      await tx.clientName.update({ where: { name: clientName }, data: { configId: id } });
    });
  }

  async replaceClientAndScheduleRevocation(
    id: string,
    clientName: string,
    serverKey: ServerKey,
    expiresAt: string,
    hiddenAt: string,
    previousServerKey: ServerKey,
    previousClientName: string,
    scheduledAt: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.vpnConfig.update({
        where: { id },
        data: {
          clientName,
          serverKey,
          isLegacy: false,
          expiresAt: new Date(expiresAt),
          hiddenAt: new Date(hiddenAt),
          status: "active",
          revokedAt: null,
        },
      });
      await tx.clientName.update({
        where: { name: clientName },
        data: { configId: id },
      });
      await tx.pendingRevocation.create({
        data: {
          configId: id,
          serverKey: previousServerKey,
          clientName: previousClientName,
          scheduledAt: new Date(scheduledAt),
        },
      });
    });
  }

  async listDuePendingRevocations(
    now = new Date()
  ): Promise<PendingRevocationRecord[]> {
    const rows = await this.prisma.pendingRevocation.findMany({
      where: { scheduledAt: { lte: now } },
      orderBy: { scheduledAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      configId: row.configId,
      serverKey: row.serverKey,
      clientName: row.clientName,
      scheduledAt: row.scheduledAt.toISOString(),
      attempts: row.attempts,
    }));
  }

  async completePendingRevocation(id: number): Promise<void> {
    await this.prisma.pendingRevocation.delete({ where: { id } });
  }

  async markPendingRevocationFailed(id: number, error: string): Promise<void> {
    await this.prisma.pendingRevocation.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        lastError: error.slice(0, 2000),
      },
    });
  }

  async restoreClient(config: VpnConfigRecord): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.vpnConfig.update({
        where: { id: config.id },
        data: {
          clientName: config.clientName,
          serverKey: config.serverKey,
          isLegacy: config.isLegacy,
          expiresAt: new Date(config.expiresAt),
          hiddenAt: new Date(config.hiddenAt),
          status: config.status,
          revokedAt: config.revokedAt ? new Date(config.revokedAt) : null,
        },
      });
      await tx.clientName.upsert({
        where: { name: config.clientName },
        create: { name: config.clientName, configId: config.id },
        update: { configId: config.id },
      });
    });
  }

  async importTrafficEvents(
    serverKey: ServerKey,
    events: CompletedTrafficSession[]
  ): Promise<void> {
    if (events.length === 0) return;
    const storedCount = await this.prisma.trafficEvent.count({
      where: { serverKey },
    });
    if (storedCount !== events.length) {
      const clientNames = [...new Set(events.map((event) => event.clientName))];
      const mappings = await this.prisma.clientName.findMany({
        where: { name: { in: clientNames } },
        select: { name: true, configId: true },
      });
      const configByClient = new Map(
        mappings.map(({ name, configId }) => [name, configId])
      );
      const batchSize = 500;
      for (let offset = 0; offset < events.length; offset += batchSize) {
        const batch = events.slice(offset, offset + batchSize);
        await this.prisma.trafficEvent.createMany({
          data: batch.map((event) => ({
            serverKey,
            eventId: event.eventId,
            configId: configByClient.get(event.clientName) ?? null,
            clientName: event.clientName,
            uploadBytes: BigInt(event.uploadBytes),
            downloadBytes: BigInt(event.downloadBytes),
            connectedAt: new Date(event.connectedAt * 1000),
            disconnectedAt: new Date(event.disconnectedAt * 1000),
          })),
          skipDuplicates: true,
        });
      }
    }

    await this.prisma.$executeRaw`
      UPDATE "traffic_events" AS events
      SET "config_id" = names."config_id"
      FROM "client_names" AS names
      WHERE events."server_key" = CAST(${serverKey} AS "ServerKey")
        AND events."config_id" IS NULL
        AND names."name" = events."client_name"
        AND names."config_id" IS NOT NULL
    `;
  }

  async trafficForConfig(configId: string): Promise<ServerTraffic> {
    const totals = await this.prisma.trafficEvent.aggregate({
      where: { configId },
      _sum: { uploadBytes: true, downloadBytes: true },
    });
    return {
      uploadBytes: Number(totals._sum.uploadBytes ?? 0n),
      downloadBytes: Number(totals._sum.downloadBytes ?? 0n),
    };
  }

  async clientNamesForConfig(configId: string): Promise<string[]> {
    return (
      await this.prisma.clientName.findMany({
        where: { configId },
        select: { name: true },
      })
    ).map((row) => row.name);
  }

  async completedTrafficByServer(): Promise<Record<ServerKey, ServerTraffic>> {
    const rows = await this.prisma.trafficEvent.groupBy({
      by: ["serverKey"],
      _sum: { uploadBytes: true, downloadBytes: true },
    });
    const result: Record<ServerKey, ServerTraffic> = {
      new: { uploadBytes: 0, downloadBytes: 0 },
      old: { uploadBytes: 0, downloadBytes: 0 },
    };
    for (const row of rows) {
      result[row.serverKey] = {
        uploadBytes: Number(row._sum.uploadBytes ?? 0n),
        downloadBytes: Number(row._sum.downloadBytes ?? 0n),
      };
    }
    return result;
  }

  async markExpired(id: string): Promise<void> {
    await this.prisma.vpnConfig.update({
      where: { id },
      data: { status: "expired", revokedAt: new Date() },
    });
  }

  async markRevoked(id: string): Promise<void> {
    const now = new Date();
    await this.prisma.vpnConfig.update({
      where: { id },
      data: { status: "revoked", revokedAt: now, hiddenAt: now },
    });
  }

  async notificationWasSent(configId: string, kind: string, localDate: string): Promise<boolean> {
    return Boolean(await this.prisma.notification.findUnique({
      where: { configId_kind_localDate: { configId, kind, localDate } },
      select: { id: true },
    }));
  }

  async markNotificationsSent(
    items: Array<{ configId: string; kind: string }>,
    localDate: string
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const { configId, kind } of items) {
        await tx.notification.upsert({
          where: { configId_kind_localDate: { configId, kind, localDate } },
          create: { configId, kind, localDate },
          update: {},
        });
      }
    });
  }

  async syncLegacyClients(serverKey: ServerKey, clientNames: string[]): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.legacyClient.deleteMany({ where: { serverKey, assignedConfigId: null } });
      for (const clientName of clientNames) {
        await tx.clientName.upsert({
          where: { name: clientName },
          create: { name: clientName },
          update: {},
        });
        await tx.legacyClient.upsert({
          where: { serverKey_clientName: { serverKey, clientName } },
          create: { serverKey, clientName, discoveredAt: now },
          update: { discoveredAt: now },
        });
      }
    });
  }

  async listUnassignedLegacyClients(serverKey: ServerKey): Promise<LegacyClientRecord[]> {
    const rows = await this.prisma.legacyClient.findMany({
      where: { serverKey, assignedConfigId: null },
      orderBy: { clientName: "asc" },
    });
    return rows.map(mapLegacy);
  }

  async getLegacyClient(id: number): Promise<LegacyClientRecord | null> {
    const row = await this.prisma.legacyClient.findUnique({ where: { id } });
    return row ? mapLegacy(row) : null;
  }

  async nextConfigNumber(userId: number): Promise<number> {
    return await this.prisma.vpnConfig.count({ where: { userId } }) + 1;
  }

  async stats(): Promise<{ users: number; active: number; expired: number; old: number; new: number }> {
    const now = new Date();
    const [users, active, expired, old, newCount] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.vpnConfig.count({ where: { status: "active", expiresAt: { gt: now } } }),
      this.prisma.vpnConfig.count({
        where: { status: { not: "revoked" }, expiresAt: { lte: now }, hiddenAt: { gt: now } },
      }),
      this.prisma.vpnConfig.count({ where: { status: { not: "revoked" }, serverKey: "old" } }),
      this.prisma.vpnConfig.count({ where: { status: { not: "revoked" }, serverKey: "new" } }),
    ]);
    return { users, active, expired, old, new: newCount };
  }
}
