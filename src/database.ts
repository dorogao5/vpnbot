import { PrismaPg } from "@prisma/adapter-pg";
import { DateTime } from "luxon";
import type {
  User,
  VpnConfig,
  LegacyClient,
  MessengerProvider,
  VpnServer,
  ConfigRequest,
} from "./generated/prisma/client.js";
import { PrismaClient } from "./generated/prisma/client.js";
import type {
  CompletedTrafficSession,
  ConfigRequestRecord,
  LegacyClientRecord,
  PendingRevocationRecord,
  ServerKey,
  ServerTraffic,
  UserRecord,
  VpnConfigRecord,
  VpnServerRecord,
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

function mapServer(row: VpnServer): VpnServerRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    host: row.host,
    port: row.port,
    sshUser: row.sshUser,
    sshPrivateKey: row.sshPrivateKey,
    hostFingerprint: row.hostFingerprint,
    relayPort: row.relayPort,
    relayManaged: row.relayManaged,
    status: row.status,
    enabled: row.enabled,
    isBuiltin: row.isBuiltin,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapConfigRequest(row: ConfigRequest): ConfigRequestRecord {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    note: row.note,
    configId: row.configId,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
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
    const row = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
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
      await tx.messengerIdentity.upsert({
        where: {
          provider_externalId: {
            provider: "telegram",
            externalId: input.telegramId,
          },
        },
        create: {
          userId: user.id,
          provider: "telegram",
          externalId: input.telegramId,
          peerId: input.telegramId,
          username: input.username ?? null,
        },
        update: {
          userId: user.id,
          peerId: input.telegramId,
          username: input.username ?? null,
          canMessage: true,
        },
      });
      return user;
    });
    return mapUser(row);
  }

  async upsertVkUser(input: {
    vkId: string;
    peerId: string;
    username?: string;
    firstName: string;
  }): Promise<UserRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      const identity = await tx.messengerIdentity.findUnique({
        where: {
          provider_externalId: { provider: "vk", externalId: input.vkId },
        },
        include: { user: true },
      });
      if (identity) {
        await tx.messengerIdentity.update({
          where: { id: identity.id },
          data: {
            peerId: input.peerId,
            username: input.username ?? null,
            canMessage: true,
          },
        });
        return tx.user.update({
          where: { id: identity.userId },
          data: {
            username: identity.user.telegramId
              ? identity.user.username
              : input.username ?? identity.user.username,
            firstName: identity.user.telegramId
              ? identity.user.firstName
              : input.firstName,
          },
        });
      }
      return tx.user.create({
        data: {
          telegramId: null,
          username: input.username ?? null,
          firstName: input.firstName,
          identities: {
            create: {
              provider: "vk",
              externalId: input.vkId,
              peerId: input.peerId,
              username: input.username ?? null,
            },
          },
        },
      });
    });
    return mapUser(row);
  }

  async getUserByVkId(vkId: string): Promise<UserRecord | null> {
    const identity = await this.prisma.messengerIdentity.findUnique({
      where: { provider_externalId: { provider: "vk", externalId: vkId } },
      include: { user: true },
    });
    return identity ? mapUser(identity.user) : null;
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
    return rows.flatMap(({ telegramId }) => telegramId ? [telegramId] : []);
  }

  async createAccountLinkToken(input: {
    userId: number;
    provider: MessengerProvider;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.accountLinkToken.deleteMany({
        where: {
          userId: input.userId,
          provider: input.provider,
          consumedAt: null,
        },
      });
      await tx.accountLinkToken.create({ data: input });
    });
  }

  async consumeVkAccountLink(input: {
    tokenHash: string;
    vkId: string;
    peerId: string;
    username?: string;
    firstName: string;
    now?: Date;
  }): Promise<UserRecord | null> {
    const now = input.now ?? new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const link = await tx.accountLinkToken.findUnique({
        where: { tokenHash: input.tokenHash },
      });
      if (
        !link ||
        link.provider !== "vk" ||
        link.consumedAt ||
        link.expiresAt <= now
      ) return null;

      const existingTarget = await tx.messengerIdentity.findUnique({
        where: {
          userId_provider: { userId: link.userId, provider: "vk" },
        },
      });
      if (existingTarget && existingTarget.externalId !== input.vkId) {
        throw new Error("К этому аккаунту уже привязана другая страница VK");
      }

      const current = await tx.messengerIdentity.findUnique({
        where: {
          provider_externalId: { provider: "vk", externalId: input.vkId },
        },
      });
      if (current && current.userId !== link.userId) {
        await tx.vpnConfig.updateMany({
          where: { userId: current.userId },
          data: { userId: link.userId },
        });
        await tx.messengerIdentity.update({
          where: { id: current.id },
          data: {
            userId: link.userId,
            peerId: input.peerId,
            username: input.username ?? null,
            canMessage: true,
          },
        });
        const remaining = await tx.messengerIdentity.count({
          where: { userId: current.userId },
        });
        if (remaining === 0) {
          await tx.user.delete({ where: { id: current.userId } });
        }
      } else if (current) {
        await tx.messengerIdentity.update({
          where: { id: current.id },
          data: {
            peerId: input.peerId,
            username: input.username ?? null,
            canMessage: true,
          },
        });
      } else {
        await tx.messengerIdentity.create({
          data: {
            userId: link.userId,
            provider: "vk",
            externalId: input.vkId,
            peerId: input.peerId,
            username: input.username ?? null,
          },
        });
      }

      await tx.accountLinkToken.update({
        where: { id: link.id },
        data: { consumedAt: now },
      });
      return tx.user.findUnique({ where: { id: link.userId } });
    });
    return row ? mapUser(row) : null;
  }

  async createConfigRequest(userId: number, note: string | null): Promise<{
    request: ConfigRequestRecord;
    created: boolean;
  }> {
    try {
      const row = await this.prisma.configRequest.create({
        data: { userId, note },
      });
      return { request: mapConfigRequest(row), created: true };
    } catch (error) {
      const existing = await this.prisma.configRequest.findFirst({
        where: { userId, status: { in: ["pending", "processing"] } },
        orderBy: { requestedAt: "desc" },
      });
      if (existing)
        return { request: mapConfigRequest(existing), created: false };
      throw error;
    }
  }

  async getOpenConfigRequestForUser(
    userId: number
  ): Promise<ConfigRequestRecord | null> {
    const row = await this.prisma.configRequest.findFirst({
      where: { userId, status: { in: ["pending", "processing"] } },
      orderBy: { requestedAt: "desc" },
    });
    return row ? mapConfigRequest(row) : null;
  }

  async getConfigRequest(id: number): Promise<ConfigRequestRecord | null> {
    const row = await this.prisma.configRequest.findUnique({ where: { id } });
    return row ? mapConfigRequest(row) : null;
  }

  async countPendingConfigRequests(): Promise<number> {
    return this.prisma.configRequest.count({ where: { status: "pending" } });
  }

  async listPendingConfigRequests(
    limit = 20
  ): Promise<Array<{ request: ConfigRequestRecord; user: UserRecord }>> {
    const rows = await this.prisma.configRequest.findMany({
      where: { status: "pending" },
      include: { user: true },
      orderBy: { requestedAt: "asc" },
      take: limit,
    });
    return rows.map((row) => ({
      request: mapConfigRequest(row),
      user: mapUser(row.user),
    }));
  }

  async claimConfigRequest(id: number): Promise<boolean> {
    const result = await this.prisma.configRequest.updateMany({
      where: { id, status: "pending" },
      data: { status: "processing" },
    });
    return result.count === 1;
  }

  async releaseConfigRequest(id: number): Promise<void> {
    await this.prisma.configRequest.updateMany({
      where: { id, status: "processing" },
      data: { status: "pending" },
    });
  }

  async releaseProcessingConfigRequests(): Promise<number> {
    const result = await this.prisma.configRequest.updateMany({
      where: { status: "processing" },
      data: { status: "pending" },
    });
    return result.count;
  }

  async rejectConfigRequest(id: number): Promise<boolean> {
    const result = await this.prisma.configRequest.updateMany({
      where: { id, status: "pending" },
      data: { status: "rejected", resolvedAt: new Date() },
    });
    return result.count === 1;
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

  async insertConfigForRequest(
    config: VpnConfigRecord,
    requestId: number
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await tx.configRequest.findFirst({
        where: {
          id: requestId,
          userId: config.userId,
          status: "processing",
        },
        select: { id: true },
      });
      if (!request) throw new Error("Заявка уже обработана или отменена");

      await tx.vpnConfig.create({ data: configData(config) });
      await tx.clientName.upsert({
        where: { name: config.clientName },
        create: { name: config.clientName, configId: config.id },
        update: { configId: config.id },
      });
      await tx.configRequest.update({
        where: { id: requestId },
        data: {
          status: "approved",
          configId: config.id,
          resolvedAt: new Date(),
        },
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

  async countExtendableConfigs(): Promise<number> {
    return this.prisma.vpnConfig.count({
      where: { status: "active", revokedAt: null },
    });
  }

  async extendAllActiveConfigs(
    period: { days?: number; months?: number; years?: number }
  ): Promise<number> {
    const configs = await this.prisma.vpnConfig.findMany({
      where: { status: "active", revokedAt: null },
      select: { id: true, expiresAt: true },
    });
    if (configs.length === 0) return 0;

    await this.prisma.$transaction(
      configs.map(({ id, expiresAt }) => {
        const extended = DateTime.fromJSDate(expiresAt, { zone: "utc" }).plus(period);
        return this.prisma.vpnConfig.update({
          where: { id },
          data: {
            expiresAt: extended.toJSDate(),
            hiddenAt: extended.plus({ days: 10 }).toJSDate(),
          },
        });
      })
    );
    return configs.length;
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
      WHERE events."server_key" = ${serverKey}
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
    const result: Record<ServerKey, ServerTraffic> = {};
    for (const row of rows) {
      result[row.serverKey] = {
        uploadBytes: Number(row._sum.uploadBytes ?? 0n),
        downloadBytes: Number(row._sum.downloadBytes ?? 0n),
      };
    }
    return result;
  }

  async trafficByConfigIds(configIds: string[]): Promise<Map<string, ServerTraffic>> {
    const result = new Map<string, ServerTraffic>();
    if (configIds.length === 0) return result;
    const rows = await this.prisma.trafficEvent.groupBy({
      by: ["configId"],
      where: { configId: { in: configIds } },
      _sum: { uploadBytes: true, downloadBytes: true },
    });
    for (const row of rows) {
      if (!row.configId) continue;
      result.set(row.configId, {
        uploadBytes: Number(row._sum.uploadBytes ?? 0n),
        downloadBytes: Number(row._sum.downloadBytes ?? 0n),
      });
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

  async stats(): Promise<{
    users: number;
    active: number;
    expired: number;
    perServer: Record<ServerKey, number>;
  }> {
    const now = new Date();
    const [users, active, expired, grouped] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.vpnConfig.count({ where: { status: "active", expiresAt: { gt: now } } }),
      this.prisma.vpnConfig.count({
        where: { status: { not: "revoked" }, expiresAt: { lte: now }, hiddenAt: { gt: now } },
      }),
      this.prisma.vpnConfig.groupBy({
        by: ["serverKey"],
        where: { status: { not: "revoked" } },
        _count: { _all: true },
      }),
    ]);
    const perServer: Record<ServerKey, number> = {};
    for (const row of grouped) perServer[row.serverKey] = row._count._all;
    return { users, active, expired, perServer };
  }

  async listServers(): Promise<VpnServerRecord[]> {
    const rows = await this.prisma.vpnServer.findMany({
      orderBy: [{ isBuiltin: "desc" }, { id: "asc" }],
    });
    return rows.map(mapServer);
  }

  async getServerByKey(key: string): Promise<VpnServerRecord | null> {
    const row = await this.prisma.vpnServer.findUnique({ where: { key } });
    return row ? mapServer(row) : null;
  }

  async getServerByHost(host: string): Promise<VpnServerRecord | null> {
    const row = await this.prisma.vpnServer.findFirst({ where: { host } });
    return row ? mapServer(row) : null;
  }

  async upsertBuiltinServer(input: {
    key: string;
    name: string;
    host: string;
    port: number;
    sshUser: string;
    sshPrivateKey: string;
    hostFingerprint: string;
  }): Promise<VpnServerRecord> {
    const row = await this.prisma.vpnServer.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        name: input.name,
        host: input.host,
        port: input.port,
        sshUser: input.sshUser,
        sshPrivateKey: input.sshPrivateKey,
        hostFingerprint: input.hostFingerprint,
        status: "ready",
        enabled: true,
        isBuiltin: true,
      },
      update: {
        name: input.name,
        host: input.host,
        port: input.port,
        sshUser: input.sshUser,
        sshPrivateKey: input.sshPrivateKey,
        hostFingerprint: input.hostFingerprint,
      },
    });
    return mapServer(row);
  }

  async createServerPlaceholder(input: {
    key: string;
    name: string;
    host: string;
    port: number;
    sshUser: string;
    sshPrivateKey: string;
    hostFingerprint: string;
    relayPort?: number;
    relayManaged?: boolean;
  }): Promise<VpnServerRecord> {
    const row = await this.prisma.vpnServer.create({
      data: {
        key: input.key,
        name: input.name,
        host: input.host,
        port: input.port,
        sshUser: input.sshUser,
        sshPrivateKey: input.sshPrivateKey,
        hostFingerprint: input.hostFingerprint,
        relayPort: input.relayPort ?? null,
        relayManaged: input.relayManaged ?? true,
        status: "pending",
        enabled: false,
        isBuiltin: false,
      },
    });
    return mapServer(row);
  }

  async updateServer(key: string, data: {
    name?: string;
    host?: string;
    port?: number;
    sshUser?: string;
    sshPrivateKey?: string;
    hostFingerprint?: string;
    relayPort?: number | null;
    relayManaged?: boolean;
    enabled?: boolean;
    status?: "ready" | "pending" | "error";
    lastError?: string | null;
  }): Promise<VpnServerRecord> {
    const row = await this.prisma.vpnServer.update({ where: { key }, data });
    return mapServer(row);
  }

  async deleteServer(key: string): Promise<{
    configs: number;
    legacyClients: number;
    pendingRevocations: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const server = await tx.vpnServer.findUnique({
        where: { key },
        select: { key: true },
      });
      if (!server) throw new Error("Сервер не найден");
      const [configs, legacyClients, pendingRevocations] = await Promise.all([
        tx.vpnConfig.count({ where: { serverKey: key } }),
        tx.legacyClient.count({ where: { serverKey: key } }),
        tx.pendingRevocation.count({ where: { serverKey: key } }),
      ]);
      await tx.pendingRevocation.deleteMany({ where: { serverKey: key } });
      await tx.legacyClient.deleteMany({ where: { serverKey: key } });
      await tx.vpnServer.delete({ where: { key } });
      return { configs, legacyClients, pendingRevocations };
    });
  }

  async serverDeletionImpact(key: string): Promise<{
    configs: number;
    legacyClients: number;
    pendingRevocations: number;
  }> {
    const [configs, legacyClients, pendingRevocations] = await Promise.all([
      this.prisma.vpnConfig.count({ where: { serverKey: key } }),
      this.prisma.legacyClient.count({ where: { serverKey: key } }),
      this.prisma.pendingRevocation.count({ where: { serverKey: key } }),
    ]);
    return { configs, legacyClients, pendingRevocations };
  }

  async maxDynamicServerId(): Promise<number> {
    const [servers, configs, legacyClients, trafficEvents, pendingRevocations] =
      await Promise.all([
      this.prisma.vpnServer.findMany({
        where: { key: { startsWith: "srv_" } },
        select: { key: true },
      }),
      this.prisma.vpnConfig.findMany({
        where: { serverKey: { startsWith: "srv_" } },
        distinct: ["serverKey"],
        select: { serverKey: true },
      }),
      this.prisma.legacyClient.findMany({
        where: { serverKey: { startsWith: "srv_" } },
        distinct: ["serverKey"],
        select: { serverKey: true },
      }),
      this.prisma.trafficEvent.findMany({
        where: { serverKey: { startsWith: "srv_" } },
        distinct: ["serverKey"],
        select: { serverKey: true },
      }),
      this.prisma.pendingRevocation.findMany({
        where: { serverKey: { startsWith: "srv_" } },
        distinct: ["serverKey"],
        select: { serverKey: true },
      }),
      ]);
    const keys = new Set<string>();
    for (const { key } of servers) keys.add(key);
    for (const { serverKey } of [
      ...configs,
      ...legacyClients,
      ...trafficEvents,
      ...pendingRevocations,
    ]) keys.add(serverKey);
    let max = 0;
    for (const key of keys) {
      const value = Number(key.slice(4));
      if (Number.isSafeInteger(value) && value > max) max = value;
    }
    return max;
  }

  async nextRelayPort(start: number, end: number): Promise<number> {
    const rows = await this.prisma.vpnServer.findMany({
      where: { relayPort: { not: null } },
      select: { relayPort: true },
    });
    const used = new Set(rows.flatMap((row) =>
      row.relayPort === null ? [] : [row.relayPort]
    ));
    for (let port = start; port <= end; port += 1) {
      if (!used.has(port)) return port;
    }
    throw new Error(`Нет свободных relay-портов в диапазоне ${start}–${end}`);
  }
}
