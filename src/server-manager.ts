import { AppDatabase } from "./database.js";
import type { VpnServerRecord } from "./domain.js";
import type { OpenVpnGateway, VpnServerTarget } from "./openvpn.js";
import { runSshShell } from "./ssh-run.js";
import type { AppConfig } from "./config.js";

const SERVER_NAME = /^[0-9A-Za-zА-Яа-яЁё _().-]{1,40}$/;

export interface ServerWithTarget {
  record: VpnServerRecord;
  target: VpnServerTarget;
}

export class ServerManager {
  constructor(
    private readonly db: AppDatabase,
    private readonly gateway: OpenVpnGateway,
    private readonly config: AppConfig
  ) {}

  async listServers(): Promise<ServerWithTarget[]> {
    const records = await this.db.listServers();
    const result: ServerWithTarget[] = [];
    for (const record of records) {
      const target = this.targetFor(record);
      if (target) result.push({ record, target });
    }
    for (const [key, env] of Object.entries(this.config.envServers)) {
      if (!records.some((record) => record.key === key)) {
        result.push({
          record: this.fallbackRecord(key, env.name),
          target: { ...env, key },
        });
      }
    }
    return result;
  }

  async getServer(serverKey: string): Promise<ServerWithTarget | null> {
    const record = await this.db.getServerByKey(serverKey);
    if (record) {
      const target = this.targetFor(record);
      return target ? { record, target } : null;
    }
    const env = this.gateway.envTarget(serverKey);
    if (!env) return null;
    return {
      record: this.fallbackRecord(serverKey, env.name),
      target: env,
    };
  }

  async resolveTarget(serverKey: string): Promise<VpnServerTarget | null> {
    return (await this.getServer(serverKey))?.target ?? null;
  }

  async usableTargets(): Promise<VpnServerTarget[]> {
    return (await this.listServers())
      .filter(
        (server) =>
          server.record.enabled &&
          server.record.status === "ready" &&
          server.target.hostFingerprint !== "pending"
      )
      .map((server) => server.target);
  }

  async serverName(serverKey: string): Promise<string> {
    const record = await this.db.getServerByKey(serverKey);
    if (record) return record.name;
    return this.gateway.serverName(serverKey);
  }

  async serverNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const server of await this.listServers()) {
      names.set(server.record.key, server.record.name);
    }
    return names;
  }

  async listClients(target: VpnServerTarget): Promise<string[]> {
    return this.gateway.listClients(target);
  }

  async addServer(input: {
    host: string;
    port: number;
    rootPassword: string;
    name: string;
  }): Promise<VpnServerRecord> {
    const host = input.host.trim();
    if (!/^[0-9a-zA-Z.-]{1,253}$/.test(host))
      throw new Error("Некорректный адрес сервера");
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
      throw new Error("Некорректный SSH-порт");
    if (!SERVER_NAME.test(input.name))
      throw new Error("Название сервера: 1–40 символов, без спецсимволов");
    if (!input.rootPassword)
      throw new Error("Пароль root не может быть пустым");
    if (!this.config.bootstrapPublicKey)
      throw new Error(
        "Не задан VPN_BOOTSTRAP_PUBLIC_KEY_PATH — публичный ключ для новых серверов"
      );
    if (await this.db.getServerByHost(host))
      throw new Error("Сервер с таким адресом уже добавлен");

    const sshKey = await this.nextServerKey();
    const server = await this.db.createServerPlaceholder({
      key: sshKey,
      name: input.name,
      host,
      port: input.port,
      sshUser: "vpn-bot",
      sshPrivateKey: "",
      hostFingerprint: "pending",
    });

    const notify = this.onBootstrapFinished;
    void this.bootstrap(server.key, input.rootPassword)
      .then(async () => {
        const updated = await this.db.getServerByKey(server.key);
        if (!updated) return;
        if (updated.status === "ready") {
          notify?.(
            `✅ Сервер «${updated.name}» готов к выдаче конфигов.\n🌐 ${updated.host}:${updated.port}`
          );
        } else {
          notify?.(
            `🔴 Настройка сервера «${updated.name}» завершилась ошибкой:\n${updated.lastError ?? "неизвестная ошибка"}`
          );
        }
      })
      .catch((error) => {
        console.error(`Bootstrap сервера ${server.key} завершился сбоем`, error);
        notify?.(
          `🔴 Настройка сервера «${server.name}» прервана: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    return server;
  }

  onBootstrapFinished: ((text: string) => void) | undefined;

  invalidateCache(): void {}

  async bootstrap(serverKey: string, rootPassword: string): Promise<void> {
    const record = await this.db.getServerByKey(serverKey);
    if (!record) return;
    const fail = async (error: unknown): Promise<void> => {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .updateServer(serverKey, {
          status: "error",
          lastError: message.slice(0, 500),
        })
        .catch(() => {});
    };

    let script: string;
    try {
      script = renderBootstrapScript(this.config.bootstrapPublicKey!)
        .replaceAll("\\$", "$");
    } catch (error) {
      await fail(error);
      return;
    }

    let output: Buffer;
    try {
      output = await runSshShell(
        {
          host: record.host,
          port: record.port,
          username: "root",
          password: rootPassword,
          timeoutMs: 600_000,
        },
        `bash -se <<'VPNBOT_BOOTSTRAP_EOF'\n${script.replaceAll("SRV_KEY_PLACEHOLDER", serverKey)}\nVPNBOT_BOOTSTRAP_EOF\n`
      );
    } catch (error) {
      await fail(error);
      return;
    }

    try {
      const result = parseBootstrapOutput(output.toString("utf8"));
      await this.db.updateServer(serverKey, {
        sshPrivateKey: result.privateKey,
        hostFingerprint: result.fingerprint,
        status: "ready",
        lastError: null,
      });
    } catch (error) {
      await fail(error);
    }
  }

  private targetFor(record: VpnServerRecord): VpnServerTarget | null {
    if (!record.sshPrivateKey || record.hostFingerprint === "pending")
      return null;
    return {
      key: record.key,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.sshUser,
      privateKey: record.sshPrivateKey,
      hostFingerprint: record.hostFingerprint,
      helperCommand: this.config.helperCommand,
    };
  }

  private fallbackRecord(key: string, name: string): VpnServerRecord {
    return {
      id: 0,
      key,
      name,
      host: "",
      port: 22,
      sshUser: "vpn-bot",
      sshPrivateKey: "",
      hostFingerprint: "",
      status: "ready",
      enabled: true,
      isBuiltin: true,
      lastError: null,
      createdAt: "",
      updatedAt: "",
    };
  }

  private async nextServerKey(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `srv_${(await this.db.maxDynamicServerId()) + 1 + attempt}`;
      if (!(await this.db.getServerByKey(candidate))) return candidate;
    }
    throw new Error("Не удалось выделить ключ сервера");
  }
}

function renderBootstrapScript(publicKey: string): string {
  if (!/^ssh-(ed25519|rsa|ecdsa-sha2-nistp256) \S+( \S+)?$/.test(publicKey))
    throw new Error("Некорректный публичный SSH-ключ в конфигурации бота");
  const keyComment = publicKey.split(/\s+/).slice(2).join(" ") || "";
  const keyLine = keyComment ? publicKey : `${publicKey} vpnbot`;
  return `set -Eeuo pipefail

SRV_KEY="SRV_KEY_PLACEHOLDER"

export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none
export NEEDRESTART_MODE=a

apt-get update -qq
apt-get install -y -qq openssh-server openssl ca-certificates curl sudo

SSH_DIR="/etc/ssh"
mkdir -p "\\$SSH_DIR"
if ! ls "\\$SSH_DIR"/ssh_host_*_key >/dev/null 2>&1; then
  ssh-keygen -A
fi

BOT_KEY_PATH="\\$SSH_DIR/vpnbot_ed25519"
rm -f "\\$BOT_KEY_PATH" "\\$BOT_KEY_PATH.pub"
ssh-keygen -q -t ed25519 -N "" -C "vpnbot-SRV_KEY_PLACEHOLDER" -f "\\$BOT_KEY_PATH"

if [[ ! -x /usr/local/sbin/openvpn-bot-helper ]]; then
  if [[ ! -x /etc/openvpn/server/easy-rsa/easyrsa ]]; then
    cd /root
    curl -fsSL https://git.io/vpn -o openvpn-install.sh
    chmod +x openvpn-install.sh
    AUTO_INSTALL=y bash openvpn-install.sh
  fi
  curl -fsSL https://raw.githubusercontent.com/Ralf303/vpnbot/main/deploy/openvpn-bot-helper -o /usr/local/sbin/openvpn-bot-helper
  chmod 0755 /usr/local/sbin/openvpn-bot-helper
fi

curl -fsSL https://raw.githubusercontent.com/Ralf303/vpnbot/main/deploy/openvpn-traffic-disconnect -o /usr/local/sbin/openvpn-traffic-disconnect
chmod 0755 /usr/local/sbin/openvpn-traffic-disconnect
install -d -o nobody -g nogroup -m 0700 /var/lib/openvpn-bot/traffic-events

SERVER_CONF="/etc/openvpn/server/server.conf"
touch "\\$SERVER_CONF"
grep -q '^script-security' "\\$SERVER_CONF" || echo 'script-security 2' >> "\\$SERVER_CONF"
grep -q '^status ' "\\$SERVER_CONF" || echo 'status /run/openvpn-server/server-status.tsv 10' >> "\\$SERVER_CONF"
grep -q '^status-version' "\\$SERVER_CONF" || echo 'status-version 3' >> "\\$SERVER_CONF"
grep -q '^client-disconnect' "\\$SERVER_CONF" || echo 'client-disconnect /usr/local/sbin/openvpn-traffic-disconnect' >> "\\$SERVER_CONF"
systemctl enable openvpn-server@server.service >/dev/null 2>&1 || true
systemctl restart openvpn-server@server.service

id -u vpn-bot >/dev/null 2>&1 || useradd -m -s /bin/sh vpn-bot
install -d -m 0700 -o vpn-bot -g vpn-bot /home/vpn-bot/.ssh
echo '${keyLine}' > /home/vpn-bot/.ssh/authorized_keys
chmod 0600 /home/vpn-bot/.ssh/authorized_keys
chown vpn-bot:vpn-bot /home/vpn-bot/.ssh/authorized_keys

printf 'vpn-bot ALL=(root) NOPASSWD: /usr/local/sbin/openvpn-bot-helper\\n' > /etc/sudoers.d/vpn-bot
chmod 0440 /etc/sudoers.d/vpn-bot
visudo -cf /etc/sudoers.d/vpn-bot >/dev/null

FP="\\$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print \\$2}')"
echo "===VPNBOT-RESULT==="
echo "fingerprint=\\$FP"
echo "-----BEGIN OPENSSH PRIVATE KEY-----"
cat "\\$BOT_KEY_PATH"
echo "-----END OPENSSH PRIVATE KEY-----"
`;
}

function parseBootstrapOutput(output: string): {
  fingerprint: string;
  privateKey: string;
} {
  const marker = output.indexOf("===VPNBOT-RESULT===");
  if (marker === -1) {
    const tail = output.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new Error(
      `Скрипт настройки не вернул результат (${tail || "пустой вывод"})`
    );
  }
  const result = output.slice(marker);
  const fingerprint = result.match(/fingerprint=(SHA256:\S+)/)?.[1];
  const keyMatch = result.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----\s*([\s\S]*?)\s*-----END OPENSSH PRIVATE KEY-----/
  );
  if (!fingerprint || !keyMatch?.[1])
    throw new Error("Не удалось разобрать ключ и fingerprint нового сервера");
  return {
    fingerprint,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${keyMatch[1].trim()}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}
