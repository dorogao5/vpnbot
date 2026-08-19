import { readFileSync } from "node:fs";
import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

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
  helperCommand: string
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
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const newServer = serverFromEnv(
    "new",
    parsed.NEW_VPN_NAME,
    parsed.NEW_VPN_HOST,
    parsed.NEW_VPN_PORT,
    parsed.NEW_VPN_USER,
    parsed.NEW_VPN_PRIVATE_KEY_PATH,
    parsed.NEW_VPN_HOST_FINGERPRINT,
    parsed.VPN_HELPER_COMMAND
  );
  const oldServer = serverFromEnv(
    "old",
    parsed.OLD_VPN_NAME,
    parsed.OLD_VPN_HOST,
    parsed.OLD_VPN_PORT,
    parsed.OLD_VPN_USER,
    parsed.OLD_VPN_PRIVATE_KEY_PATH,
    parsed.OLD_VPN_HOST_FINGERPRINT,
    parsed.VPN_HELPER_COMMAND
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
    envServers: {
      ...(newServer ? { new: newServer } : {}),
      ...(oldServer ? { old: oldServer } : {}),
    },
  };
}
