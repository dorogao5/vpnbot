import { randomInt, randomUUID } from "node:crypto";
import { AppDatabase } from "./database.js";
import type {
  LegacyClientRecord,
  ServerKey,
  UserRecord,
  VpnConfigRecord,
} from "./domain.js";
import { vpnFileName } from "./file-name.js";
import { hiddenAtFromExpiry, isExpired } from "./time.js";

export interface VpnOperations {
  isConfigured(serverKey: ServerKey): boolean;
  listClients(serverKey: ServerKey): Promise<string[]>;
  createClient(serverKey: "new" | "old", clientName: string): Promise<Buffer>;
  downloadClient(serverKey: "new" | "old", clientName: string): Promise<Buffer>;
  revokeClient(serverKey: "new" | "old", clientName: string): Promise<void>;
}

const CLIENT_NAME_LENGTH = 12;
const CLIENT_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const RECREATE_GRACE_PERIOD_MS = 5 * 60 * 1000;

function randomClientName(): string {
  return Array.from(
    { length: CLIENT_NAME_LENGTH },
    () => CLIENT_NAME_ALPHABET[randomInt(CLIENT_NAME_ALPHABET.length)]!
  ).join("");
}

export class ConfigService {
  constructor(
    private readonly db: AppDatabase,
    private readonly vpn: VpnOperations
  ) {}

  async issue(user: UserRecord, expiresAt: string): Promise<VpnConfigRecord> {
    const serverKey = await this.selectIssueServer();
    const { clientName } = await this.createUniqueClient(serverKey);
    const now = new Date().toISOString();
    const record: VpnConfigRecord = {
      id: randomUUID(),
      userId: user.id,
      displayName: `VPN #${await this.db.nextConfigNumber(user.id)}`,
      clientName,
      serverKey,
      expiresAt,
      status: "active",
      isLegacy: false,
      revokedAt: null,
      hiddenAt: hiddenAtFromExpiry(expiresAt),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.db.insertConfig(record);
      return record;
    } catch (error) {
      await this.vpn
        .revokeClient(serverKey, clientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать клиент после ошибки БД",
            rollbackError
          );
        });
      throw error;
    }
  }

  async bindLegacy(
    user: UserRecord,
    legacy: LegacyClientRecord,
    expiresAt: string
  ): Promise<VpnConfigRecord> {
    if (legacy.assignedConfigId) throw new Error("Этот клиент уже привязан");
    const now = new Date().toISOString();
    const record: VpnConfigRecord = {
      id: randomUUID(),
      userId: user.id,
      displayName: vpnFileName(legacy.clientName),
      clientName: legacy.clientName,
      serverKey: legacy.serverKey,
      expiresAt,
      status: "active",
      isLegacy: true,
      revokedAt: null,
      hiddenAt: hiddenAtFromExpiry(expiresAt),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insertConfigAndAssignLegacy(record, legacy.id);
    return record;
  }

  async download(config: VpnConfigRecord): Promise<Buffer> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      throw new Error("Срок действия конфига истёк");
    }
    return this.vpn.downloadClient(config.serverKey, config.clientName);
  }

  async downloadExisting(config: VpnConfigRecord): Promise<Buffer> {
    if (config.status === "revoked") {
      throw new Error("Конфиг отозван");
    }
    return this.vpn.downloadClient(config.serverKey, config.clientName);
  }

  async migrateLegacy(config: VpnConfigRecord): Promise<{
    file: Buffer;
    clientName: string;
  }> {
    if (!config.isLegacy || config.serverKey !== "old")
      throw new Error("Конфиг уже находится на новом сервере");
    if (config.status !== "active" || isExpired(config.expiresAt))
      throw new Error("Сначала продлите срок действия конфига");

    const { clientName: newClientName, file } = await this.createUniqueClient("new");
    try {
      await this.db.replaceClient(
        config.id,
        newClientName,
        "new",
        config.expiresAt,
        config.hiddenAt
      );
    } catch (error) {
      await this.vpn
        .revokeClient("new", newClientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать новый клиент после ошибки записи миграции",
            rollbackError
          );
        });
      throw error;
    }

    try {
      await this.vpn.revokeClient("old", config.clientName);
      return { file, clientName: newClientName };
    } catch (error) {
      await this.db.restoreClient(config);
      await this.vpn
        .revokeClient("new", newClientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать новый клиент после отката миграции",
            rollbackError
          );
        });
      throw error;
    }
  }

  async changeExpiry(
    config: VpnConfigRecord,
    expiresAt: string
  ): Promise<VpnConfigRecord> {
    const hiddenAt = hiddenAtFromExpiry(expiresAt);
    if (config.status === "expired" || config.revokedAt) {
      const serverKey = this.vpn.isConfigured(config.serverKey)
        ? config.serverKey
        : await this.selectIssueServer();
      const { clientName: newClientName } = await this.createUniqueClient(serverKey);
      try {
        await this.db.replaceClient(
          config.id,
          newClientName,
          serverKey,
          expiresAt,
          hiddenAt
        );
      } catch (error) {
        await this.vpn
          .revokeClient(serverKey, newClientName)
          .catch((rollbackError: unknown) => {
            console.error(
              "Не удалось отозвать новый клиент после ошибки продления",
              rollbackError
            );
          });
        throw error;
      }
    } else {
      await this.db.updateExpiry(config.id, expiresAt, hiddenAt);
    }
    return (await this.db.getConfig(config.id))!;
  }

  async recreate(config: VpnConfigRecord): Promise<{
    config: VpnConfigRecord;
    file: Buffer;
  }> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      throw new Error("Срок действия конфига истёк");
    }

    const serverKey: ServerKey = config.serverKey === "new" ? "old" : "new";
    if (!this.vpn.isConfigured(serverKey)) {
      throw new Error("Другой VPN-сервер не настроен");
    }
    return this.recreateOnServer(config, serverKey, true);
  }

  async moveToServer(
    config: VpnConfigRecord,
    serverKey: ServerKey
  ): Promise<{
    config: VpnConfigRecord;
    file: Buffer;
  }> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      throw new Error("Срок действия конфига истёк");
    }
    if (config.serverKey === serverKey) {
      throw new Error("Конфиг уже находится на выбранном сервере");
    }
    if (!this.vpn.isConfigured(serverKey)) {
      throw new Error("Выбранный VPN-сервер не настроен");
    }
    return this.recreateOnServer(config, serverKey);
  }

  private async recreateOnServer(
    config: VpnConfigRecord,
    serverKey: ServerKey,
    delayedRevocation = false
  ): Promise<{
    config: VpnConfigRecord;
    file: Buffer;
  }> {
    const { clientName: newClientName, file } =
      await this.createUniqueClient(serverKey);
    try {
      if (delayedRevocation) {
        await this.db.replaceClientAndScheduleRevocation(
          config.id,
          newClientName,
          serverKey,
          config.expiresAt,
          config.hiddenAt,
          config.serverKey,
          config.clientName,
          new Date(Date.now() + RECREATE_GRACE_PERIOD_MS).toISOString()
        );
      } else {
        await this.db.replaceClient(
          config.id,
          newClientName,
          serverKey,
          config.expiresAt,
          config.hiddenAt
        );
      }
    } catch (error) {
      await this.vpn
        .revokeClient(serverKey, newClientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать новый клиент после ошибки пересоздания",
            rollbackError
          );
        });
      throw error;
    }

    if (delayedRevocation) {
      return {
        config: (await this.db.getConfig(config.id))!,
        file,
      };
    }

    try {
      await this.vpn.revokeClient(config.serverKey, config.clientName);
    } catch (error) {
      await this.db.restoreClient(config);
      await this.vpn
        .revokeClient(serverKey, newClientName)
        .catch((rollbackError: unknown) => {
          console.error(
            "Не удалось отозвать новый клиент после отката пересоздания",
            rollbackError
          );
        });
      throw error;
    }

    return {
      config: (await this.db.getConfig(config.id))!,
      file,
    };
  }

  async revoke(config: VpnConfigRecord): Promise<void> {
    if (config.status !== "expired" && !config.revokedAt) {
      await this.vpn.revokeClient(config.serverKey, config.clientName);
    }
    await this.db.markRevoked(config.id);
  }

  private async createUniqueClient(serverKey: ServerKey): Promise<{
    clientName: string;
    file: Buffer;
  }> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const clientName = randomClientName();
      if (!(await this.db.reserveClientName(clientName))) continue;
      const file = await this.vpn.createClient(serverKey, clientName);
      return { clientName, file };
    }
    throw new Error("Не удалось сгенерировать уникальное имя VPN-конфига");
  }

  private async selectIssueServer(): Promise<ServerKey> {
    const available = (
      await Promise.all(
        (["new", "old"] as const).map(async (serverKey) => {
          if (!this.vpn.isConfigured(serverKey)) return null;
          try {
            return {
              serverKey,
              clients: (await this.vpn.listClients(serverKey)).length,
            };
          } catch (error) {
            console.error(`VPN-сервер ${serverKey} недоступен для выдачи`, error);
            return null;
          }
        })
      )
    ).filter((item): item is { serverKey: ServerKey; clients: number } => Boolean(item));

    if (available.length === 0) {
      throw new Error("Нет доступных VPN-серверов для выдачи конфига");
    }
    available.sort(
      (left, right) =>
        left.clients - right.clients ||
        (left.serverKey === "new" ? -1 : 1)
    );
    return available[0]!.serverKey;
  }
}
