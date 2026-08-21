import { readFileSync } from "node:fs";
import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const optionalUrl = optionalString.pipe(z.string().url().optional());

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  ADMIN_TELEGRAM_ID: z.string().regex(/^\d+$/),
  CONTACT_URL: z.string().url().default("https://t.me/ralfy"),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  TIMEZONE: z.string().default("Europe/Moscow"),
  REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(10),
  VPN_HELPER_COMMAND: z
    .string()
    .default("sudo /usr/local/sbin/openvpn-bot-helper"),
  VPN_BOOTSTRAP_PUBLIC_KEY_PATH: optionalString,
  TELEGRAM_PROXY_URL: optionalUrl,
  SSH_PROXY_URL: optionalUrl,
  VPN_RELAY_HOST: optionalString,
  VPN_RELAY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  VPN_RELAY_PORT_START: z.coerce.number().int().min(1).max(65535).default(4443),
  VPN_RELAY_PORT_END: z.coerce.number().int().min(1).max(65535).default(4499),
  VPN_RELAY_SSH_HOST: optionalString,
  VPN_RELAY_SSH_PORT: z.coerce.number().int().min(1).max(65535).default(22),
  VPN_RELAY_SSH_USER: z.string().default("vpn-relay"),
  VPN_RELAY_TUNNEL_PRIVATE_KEY_PATH: optionalString,
  VPN_RELAY_HOST_PUBLIC_KEY_PATH: optionalString,
  VPN_BYPASS_ROUTES: z.string().default(""),
  VPN_BYPASS_DOMAINS: z.string().default(""),
  VPN_BLOCK_IPV6: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  NEW_VPN_NAME: z.string().default("Новый сервер"),
  NEW_VPN_HOST: optionalString,
  NEW_VPN_PORT: z.coerce.number().int().min(1).max(65535).default(22),
  NEW_VPN_USER: z.string().default("vpn-bot"),
  NEW_VPN_PRIVATE_KEY_PATH: optionalString,
  NEW_VPN_HOST_FINGERPRINT: optionalString,
  OLD_VPN_NAME: z.string().default("Старый сервер"),
  OLD_VPN_HOST: optionalString,
  OLD_VPN_PORT: z.coerce.number().int().min(1).max(65535).default(22),
  OLD_VPN_USER: z.string().default("vpn-bot"),
  OLD_VPN_PRIVATE_KEY_PATH: optionalString,
  OLD_VPN_HOST_FINGERPRINT: optionalString,
});

export interface VpnServerConfig {
  key: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
  hostFingerprint: string;
  helperCommand: string;
  proxyUrl: string | undefined;
}

export interface VpnProfileOptions {
  relay: { host: string; port: number } | undefined;
  bypassRoutes: string[];
  bypassDomains: string[];
  blockIpv6: boolean;
}

export interface AppConfig {
  botToken: string;
  adminTelegramId: string;
  contactUrl: string;
  databaseUrl: string;
  timezone: string;
  reminderHour: number;
  helperCommand: string;
  bootstrapPublicKey: string | undefined;
  telegramProxyUrl: string | undefined;
  sshProxyUrl: string | undefined;
  vpnProfile: VpnProfileOptions;
  relayProvisioning: {
    host: string;
    publicHost: string;
    port: number;
    username: string;
    privateKey: string;
    hostPublicKey: string;
    portStart: number;
    portEnd: number;
  } | undefined;
  envServers: Partial<Record<"new" | "old", VpnServerConfig>>;
}

function serverFromEnv(
  key: "new" | "old",
  name: string,
  host: string | undefined,
  port: number,
  username: string,
  keyPath: string | undefined,
  fingerprint: string | undefined,
  helperCommand: string,
  proxyUrl: string | undefined
): VpnServerConfig | undefined {
  if (!host && !keyPath && !fingerprint) return undefined;
  if (!host || !keyPath || !fingerprint) {
    throw new Error(
      `Для VPN-сервера ${key} необходимо заполнить host, путь к SSH-ключу и fingerprint`
    );
  }

  return {
    key,
    name,
    host,
    port,
    username,
    privateKey: readFileSync(keyPath),
    hostFingerprint: fingerprint,
    helperCommand,
    proxyUrl,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  if (parsed.VPN_RELAY_HOST && !parsed.VPN_RELAY_PORT) {
    throw new Error("Для VPN_RELAY_HOST необходимо задать VPN_RELAY_PORT");
  }
  if (parsed.VPN_RELAY_PORT_START > parsed.VPN_RELAY_PORT_END) {
    throw new Error("VPN_RELAY_PORT_START не может быть больше VPN_RELAY_PORT_END");
  }
  const relayPrivateKey = parsed.VPN_RELAY_TUNNEL_PRIVATE_KEY_PATH
    ? readFileSync(parsed.VPN_RELAY_TUNNEL_PRIVATE_KEY_PATH, "utf8").trim()
    : undefined;
  const relayHostPublicKey = parsed.VPN_RELAY_HOST_PUBLIC_KEY_PATH
    ? readFileSync(parsed.VPN_RELAY_HOST_PUBLIC_KEY_PATH, "utf8").trim()
    : undefined;
  const relaySshHost = parsed.VPN_RELAY_SSH_HOST ?? parsed.VPN_RELAY_HOST;
  const relayParts = [relaySshHost, parsed.VPN_RELAY_HOST, relayPrivateKey, relayHostPublicKey];
  const hasAnyRelayProvisioning = Boolean(
    parsed.VPN_RELAY_SSH_HOST ||
    parsed.VPN_RELAY_TUNNEL_PRIVATE_KEY_PATH ||
    parsed.VPN_RELAY_HOST_PUBLIC_KEY_PATH
  );
  const hasAllRelayProvisioning = relayParts.every(Boolean);
  if (hasAnyRelayProvisioning && !hasAllRelayProvisioning) {
    throw new Error(
      "Для автоматического relay нужны VPN_RELAY_HOST, VPN_RELAY_SSH_HOST (или тот же host), VPN_RELAY_TUNNEL_PRIVATE_KEY_PATH и VPN_RELAY_HOST_PUBLIC_KEY_PATH"
    );
  }
  const bypassRoutes = parsed.VPN_BYPASS_ROUTES
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const bypassDomains = parsed.VPN_BYPASS_DOMAINS
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const newServer = serverFromEnv(
    "new",
    parsed.NEW_VPN_NAME,
    parsed.NEW_VPN_HOST,
    parsed.NEW_VPN_PORT,
    parsed.NEW_VPN_USER,
    parsed.NEW_VPN_PRIVATE_KEY_PATH,
    parsed.NEW_VPN_HOST_FINGERPRINT,
    parsed.VPN_HELPER_COMMAND,
    parsed.SSH_PROXY_URL
  );
  const oldServer = serverFromEnv(
    "old",
    parsed.OLD_VPN_NAME,
    parsed.OLD_VPN_HOST,
    parsed.OLD_VPN_PORT,
    parsed.OLD_VPN_USER,
    parsed.OLD_VPN_PRIVATE_KEY_PATH,
    parsed.OLD_VPN_HOST_FINGERPRINT,
    parsed.VPN_HELPER_COMMAND,
    parsed.SSH_PROXY_URL
  );

  return {
    botToken: parsed.BOT_TOKEN,
    adminTelegramId: parsed.ADMIN_TELEGRAM_ID,
    contactUrl: parsed.CONTACT_URL,
    databaseUrl: parsed.DATABASE_URL,
    timezone: parsed.TIMEZONE,
    reminderHour: parsed.REMINDER_HOUR,
    helperCommand: parsed.VPN_HELPER_COMMAND,
    bootstrapPublicKey: parsed.VPN_BOOTSTRAP_PUBLIC_KEY_PATH
      ? readFileSync(parsed.VPN_BOOTSTRAP_PUBLIC_KEY_PATH, "utf8").trim()
      : undefined,
    telegramProxyUrl: parsed.TELEGRAM_PROXY_URL,
    sshProxyUrl: parsed.SSH_PROXY_URL,
    vpnProfile: {
      relay: parsed.VPN_RELAY_HOST && parsed.VPN_RELAY_PORT
        ? { host: parsed.VPN_RELAY_HOST, port: parsed.VPN_RELAY_PORT }
        : undefined,
      bypassRoutes,
      bypassDomains,
      blockIpv6: parsed.VPN_BLOCK_IPV6,
    },
    relayProvisioning: hasAllRelayProvisioning
      ? {
          host: relaySshHost!,
          publicHost: parsed.VPN_RELAY_HOST!,
          port: parsed.VPN_RELAY_SSH_PORT,
          username: parsed.VPN_RELAY_SSH_USER,
          privateKey: relayPrivateKey!,
          hostPublicKey: relayHostPublicKey!,
          portStart: parsed.VPN_RELAY_PORT_START,
          portEnd: parsed.VPN_RELAY_PORT_END,
        }
      : undefined,
    envServers: {
      ...(newServer ? { new: newServer } : {}),
      ...(oldServer ? { old: oldServer } : {}),
    },
  };
}
