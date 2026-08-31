export type ServerKey = string;
export type ConfigStatus = "active" | "expired" | "revoked" | "error";
export type ServerStatus = "ready" | "pending" | "error";

export interface UserRecord {
  id: number;
  telegramId: string | null;
  username: string | null;
  firstName: string;
  createdAt: string;
  updatedAt: string;
}

export interface VpnConfigRecord {
  id: string;
  userId: number;
  displayName: string;
  clientName: string;
  serverKey: ServerKey;
  expiresAt: string;
  status: ConfigStatus;
  isLegacy: boolean;
  revokedAt: string | null;
  hiddenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyClientRecord {
  id: number;
  serverKey: ServerKey;
  clientName: string;
  assignedConfigId: string | null;
  discoveredAt: string;
}

export interface VpnServerRecord {
  id: number;
  key: ServerKey;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  sshPrivateKey: string;
  hostFingerprint: string;
  relayPort: number | null;
  relayManaged: boolean;
  status: ServerStatus;
  enabled: boolean;
  isBuiltin: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerTraffic {
  uploadBytes: number;
  downloadBytes: number;
}

export interface ActiveTrafficSession extends ServerTraffic {
  clientName: string;
  connectedAt: number;
}

export interface CompletedTrafficSession extends ActiveTrafficSession {
  eventId: string;
  disconnectedAt: number;
}

export interface TrafficSnapshot {
  active: ActiveTrafficSession[];
  completed: CompletedTrafficSession[];
}

export interface TrafficUsage extends ServerTraffic {
  totalBytes: number;
}

export interface PendingRevocationRecord {
  id: number;
  configId: string;
  serverKey: ServerKey;
  clientName: string;
  scheduledAt: string;
  attempts: number;
}
