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
import type { VpnServerTarget } from "./openvpn.js";
import type { VpnProfileOptions } from "./config.js";
import { prepareVpnProfile } from "./vpn-profile.js";

export interface VpnOperations {
  createClient(server: VpnServerTarget, clientName: string): Promise<Buffer>;
  downloadClient(server: VpnServerTarget, clientName: string): Promise<Buffer>;
  revokeClient(server: VpnServerTarget, clientName: string): Promise<void>;
  listClients(server: VpnServerTarget): Promise<string[]>;
}

export interface ServerResolver {
  resolveTarget(serverKey: ServerKey): Promise<VpnServerTarget | null>;
  usableTargets(): Promise<VpnServerTarget[]>;
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
    private readonly vpn: VpnOperations,
    private readonly servers: ServerResolver,
    private readonly profileOptions: VpnProfileOptions = {
      relay: undefined,
      blockIpv6: false,
    }
  ) {}

  async issue(user: UserRecord, expiresAt: string): Promise<VpnConfigRecord> {
    const target = await this.selectIssueTarget();
    return (await this.issueForTarget(user, expiresAt, target)).config;
  }

  async issueOnServer(
    user: UserRecord,
    expiresAt: string,
    serverKey: ServerKey
  ): Promise<VpnConfigRecord> {
    const target = await this.servers.resolveTarget(serverKey);
    if (!target) throw new Error("Выбранный VPN-сервер недоступен");
    return (await this.issueForTarget(user, expiresAt, target)).config;
  }

  async issueForRequest(
    user: UserRecord,
    expiresAt: string,
    serverKey: ServerKey,
    requestId: number
  ): Promise<{ config: VpnConfigRecord; file: Buffer }> {
    const target = await this.servers.resolveTarget(serverKey);
    if (!target) throw new Error("Выбранный VPN-сервер недоступен");
    return this.issueForTarget(user, expiresAt, target, requestId);
  }

  private async issueForTarget(
    user: UserRecord,
    expiresAt: string,
    target: VpnServerTarget,
    requestId?: number
  ): Promise<{ config: VpnConfigRecord; file: Buffer }> {
    const { clientName, file } = await this.createUniqueClient(target);
    const now = new Date().toISOString();
    const record: VpnConfigRecord = {
      id: randomUUID(),
      userId: user.id,
      displayName: `VPN #${await this.db.nextConfigNumber(user.id)}`,
      clientName,
      serverKey: target.key,
      expiresAt,
      status: "active",
      isLegacy: false,
      revokedAt: null,
      hiddenAt: hiddenAtFromExpiry(expiresAt),
      createdAt: now,
      updatedAt: now,
    };

    try {
      if (requestId === undefined) {
        await this.db.insertConfig(record);
      } else {
        await this.db.insertConfigForRequest(record, requestId);
      }
      return { config: record, file };
    } catch (error) {
      await this.vpn
        .revokeClient(target, clientName)
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
    if (!(await this.servers.resolveTarget(legacy.serverKey)))
      throw new Error("Сервер этого клиента не подключён к боту");
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
    const target = await this.requireTarget(config.serverKey);
    return prepareVpnProfile(
      await this.vpn.downloadClient(target, config.clientName),
      await this.profileOptionsFor(target)
    );
  }

  async downloadExisting(config: VpnConfigRecord): Promise<Buffer> {
    if (config.status === "revoked") {
      throw new Error("Конфиг отозван");
    }
    const target = await this.requireTarget(config.serverKey);
    return prepareVpnProfile(
      await this.vpn.downloadClient(target, config.clientName),
      await this.profileOptionsFor(target)
    );
  }

  async changeExpiry(
    config: VpnConfigRecord,
    expiresAt: string
  ): Promise<VpnConfigRecord> {
    const hiddenAt = hiddenAtFromExpiry(expiresAt);
    if (config.status === "expired" || config.revokedAt) {
      const target =
        (await this.servers.resolveTarget(config.serverKey)) ??
        (await this.selectIssueTarget());
      const { clientName: newClientName } = await this.createUniqueClient(target);
      try {
        await this.db.replaceClient(
          config.id,
          newClientName,
          target.key,
          expiresAt,
          hiddenAt
        );
      } catch (error) {
        await this.vpn
          .revokeClient(target, newClientName)
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

  async recreate(
    config: VpnConfigRecord,
    targetServerKey: ServerKey
  ): Promise<{
    config: VpnConfigRecord;
    file: Buffer;
  }> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      throw new Error("Срок действия конфига истёк");
    }
    const target = await this.servers.resolveTarget(targetServerKey);
    if (!target) throw new Error("Выбранный VPN-сервер не настроен");
    return this.recreateOnServer(config, target, true);
  }

  async moveToServer(
    config: VpnConfigRecord,
    targetServerKey: ServerKey
  ): Promise<{
    config: VpnConfigRecord;
    file: Buffer;
  }> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      throw new Error("Срок действия конфига истёк");
    }
    if (config.serverKey === targetServerKey) {
      throw new Error("Конфиг уже находится на выбранном сервере");
    }
    const target = await this.servers.resolveTarget(targetServerKey);
    if (!target) throw new Error("Выбранный VPN-сервер не настроен");
    return this.recreateOnServer(config, target);
  }

  private async recreateOnServer(
    config: VpnConfigRecord,
    target: VpnServerTarget,
    delayedRevocation = false
  ): Promise<{
    config: VpnConfigRecord;
    file: Buffer;
  }> {
    const previous = delayedRevocation
      ? null
      : await this.servers.resolveTarget(config.serverKey);
    const { clientName: newClientName, file } =
      await this.createUniqueClient(target);
    try {
      if (delayedRevocation) {
        await this.db.replaceClientAndScheduleRevocation(
          config.id,
          newClientName,
          target.key,
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
          target.key,
          config.expiresAt,
          config.hiddenAt
        );
      }
    } catch (error) {
      await this.vpn
        .revokeClient(target, newClientName)
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

    if (!previous) {
      console.info(
        `Конфиг ${config.id} перенесён без отзыва старого клиента: сервер ${config.serverKey} удалён или недоступен`
      );
      return {
        config: (await this.db.getConfig(config.id))!,
        file,
      };
    }

    try {
      await this.vpn.revokeClient(previous, config.clientName);
    } catch (error) {
      await this.db.restoreClient(config);
      await this.vpn
        .revokeClient(target, newClientName)
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
      const target = await this.requireTarget(config.serverKey);
      await this.vpn.revokeClient(target, config.clientName);
    }
    await this.db.markRevoked(config.id);
  }

  private async createUniqueClient(target: VpnServerTarget): Promise<{
    clientName: string;
    file: Buffer;
  }> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const clientName = randomClientName();
      if (!(await this.db.reserveClientName(clientName))) continue;
      const file = prepareVpnProfile(
        await this.vpn.createClient(target, clientName),
        await this.profileOptionsFor(target)
      );
      return { clientName, file };
    }
    throw new Error("Не удалось сгенерировать уникальное имя VPN-конфига");
  }

  private async requireTarget(serverKey: ServerKey): Promise<VpnServerTarget> {
    const target = await this.servers.resolveTarget(serverKey);
    if (!target) throw new Error("VPN-сервер этого конфига не подключён к боту");
    return target;
  }

  private async profileOptionsFor(target: VpnServerTarget): Promise<VpnProfileOptions> {
    return {
      ...this.profileOptions,
      relay: target.relay ?? this.profileOptions.relay,
    };
  }

  private async selectIssueTarget(): Promise<VpnServerTarget> {
    const candidates = await this.servers.usableTargets();
    const available: Array<{ target: VpnServerTarget; clients: number }> = [];
    for (const target of candidates) {
      try {
        available.push({
          target,
          clients: (await this.vpn.listClients(target)).length,
        });
      } catch (error) {
        console.error(`VPN-сервер ${target.key} недоступен для выдачи`, error);
      }
    }

    if (available.length === 0) {
      throw new Error("Нет доступных VPN-серверов для выдачи конфига");
    }
    available.sort(
      (left, right) =>
        left.clients - right.clients || left.target.key.localeCompare(right.target.key)
    );
    return available[0]!.target;
  }
}
