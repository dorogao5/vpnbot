import { AppDatabase } from "./database.js";
import type {
  ActiveTrafficSession,
  ServerKey,
  ServerTraffic,
  TrafficSnapshot,
  TrafficUsage,
  VpnConfigRecord,
} from "./domain.js";
import type { OpenVpnGateway, VpnServerTarget } from "./openvpn.js";
import type { ServerResolver } from "./config-service.js";

export interface ServerTrafficUsage extends TrafficUsage {
  activeConnections: number;
  liveAvailable: boolean;
}

export interface ConfigTrafficUsage extends TrafficUsage {
  activeConnections: number;
  liveAvailable: boolean;
}

export interface ConfigConnectionState {
  activeConnections: number;
  liveAvailable: boolean;
}

export interface AllTrafficUsage {
  total: TrafficUsage;
  servers: Record<ServerKey, ServerTrafficUsage>;
}

export class TrafficService {
  constructor(
    private readonly db: AppDatabase,
    private readonly vpn: OpenVpnGateway,
    private readonly servers: ServerResolver
  ) {}

  async syncAll(): Promise<void> {
    const targets = await this.servers.usableTargets();
    await Promise.all(
      targets.map(async (target) => {
        try {
          await this.snapshot(target);
        } catch (error) {
          console.error(
            `Не удалось синхронизировать трафик сервера ${target.key}`,
            error
          );
        }
      })
    );
  }

  async forConfig(config: VpnConfigRecord): Promise<ConfigTrafficUsage> {
    let active: ActiveTrafficSession[] = [];
    let liveAvailable = false;
    try {
      const target = await this.servers.resolveTarget(config.serverKey);
      if (target) {
        active = await this.vpn.activeSessions(target);
        liveAvailable = true;
      }
    } catch (error) {
      console.error(
        `Не удалось получить активный трафик конфига ${config.id}`,
        error
      );
    }
    const [completed, names] = await Promise.all([
      this.db.trafficForConfig(config.id),
      this.db.clientNamesForConfig(config.id),
    ]);
    const knownNames = new Set([...names, config.clientName]);
    const relevantActive = active.filter((session) =>
      knownNames.has(session.clientName)
    );
    return {
      ...usage(add(completed, sumActive(relevantActive))),
      activeConnections: relevantActive.length,
      liveAvailable,
    };
  }

  async connectionStates(
    configs: VpnConfigRecord[]
  ): Promise<Map<string, ConfigConnectionState>> {
    const activeCounts = new Map<ServerKey, Map<string, number>>();
    const liveAvailable = new Map<ServerKey, boolean>();
    const serverKeys = [...new Set(configs.map((config) => config.serverKey))];
    await Promise.all(
      serverKeys.map(async (serverKey) => {
        const target = await this.servers.resolveTarget(serverKey);
        if (!target) return;
        activeCounts.set(serverKey, new Map());
        try {
          const sessions = await this.vpn.activeSessions(target);
          liveAvailable.set(serverKey, true);
          const counts = activeCounts.get(serverKey)!;
          for (const session of sessions) {
            counts.set(
              session.clientName,
              (counts.get(session.clientName) ?? 0) + 1
            );
          }
        } catch (error) {
          console.error(
            `Не удалось получить подключения сервера ${serverKey}`,
            error
          );
        }
      })
    );

    return new Map(
      configs.map((config) => [
        config.id,
        {
          activeConnections:
            activeCounts.get(config.serverKey)?.get(config.clientName) ?? 0,
          liveAvailable: liveAvailable.get(config.serverKey) ?? false,
        },
      ])
    );
  }

  async activeSessionsForServer(serverKey: ServerKey): Promise<{
    sessions: ActiveTrafficSession[];
    liveAvailable: boolean;
  }> {
    const target = await this.servers.resolveTarget(serverKey);
    if (!target) return { sessions: [], liveAvailable: false };
    try {
      return { sessions: await this.vpn.activeSessions(target), liveAvailable: true };
    } catch (error) {
      console.error(
        `Не удалось получить подключения сервера ${serverKey}`,
        error
      );
      return { sessions: [], liveAvailable: false };
    }
  }

  async all(): Promise<AllTrafficUsage> {
    const targets = await this.servers.usableTargets();
    const activeByServer = new Map<ServerKey, ActiveTrafficSession[]>();
    const liveAvailable = new Map<ServerKey, boolean>();
    await Promise.all(
      targets.map(async (target) => {
        try {
          activeByServer.set(target.key, await this.vpn.activeSessions(target));
          liveAvailable.set(target.key, true);
        } catch (error) {
          console.error(
            `Не удалось получить активный трафик сервера ${target.key}`,
            error
          );
          activeByServer.set(target.key, []);
          liveAvailable.set(target.key, false);
        }
      })
    );
    const completed = await this.db.completedTrafficByServer();
    const servers: Record<ServerKey, ServerTrafficUsage> = {};
    let total: ServerTraffic = { uploadBytes: 0, downloadBytes: 0 };
    for (const serverKey of [
      ...new Set([...Object.keys(completed), ...targets.map((t) => t.key)]),
    ]) {
      const completedTraffic = completed[serverKey] ?? {
        uploadBytes: 0,
        downloadBytes: 0,
      };
      const active = activeByServer.get(serverKey) ?? [];
      servers[serverKey] = {
        ...usage(add(completedTraffic, sumActive(active))),
        activeConnections: active.length,
        liveAvailable: liveAvailable.get(serverKey) ?? false,
      };
      total = add(total, completedTraffic);
      total = add(total, sumActive(active));
    }
    return { total: usage(total), servers };
  }

  private async snapshot(target: VpnServerTarget): Promise<TrafficSnapshot> {
    const snapshot = await this.vpn.trafficSessions(target);
    try {
      await this.db.importTrafficEvents(target.key, snapshot.completed);
    } catch (error) {
      console.error(
        `Не удалось импортировать историю трафика сервера ${target.key}`,
        error
      );
    }
    return snapshot;
  }
}

function sumActive(
  sessions: ActiveTrafficSession[],
  names?: ReadonlySet<string>
): ServerTraffic {
  return sessions.reduce<ServerTraffic>(
    (total, session) => {
      if (names && !names.has(session.clientName)) return total;
      total.uploadBytes += session.uploadBytes;
      total.downloadBytes += session.downloadBytes;
      return total;
    },
    { uploadBytes: 0, downloadBytes: 0 }
  );
}

function add(left: ServerTraffic, right: ServerTraffic): ServerTraffic {
  return {
    uploadBytes: left.uploadBytes + right.uploadBytes,
    downloadBytes: left.downloadBytes + right.downloadBytes,
  };
}

function usage(traffic: ServerTraffic): TrafficUsage {
  return {
    ...traffic,
    totalBytes: traffic.uploadBytes + traffic.downloadBytes,
  };
}
