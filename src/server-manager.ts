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
    const server = await this.getServer(serverKey);
    if (
      !server ||
      !server.record.enabled ||
      server.record.status !== "ready"
    ) {
      return null;
    }
    return server.target;
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

  async deleteServer(serverKey: string): Promise<{
    configs: number;
    legacyClients: number;
    pendingRevocations: number;
  }> {
    if (this.gateway.isConfigured(serverKey)) {
      throw new Error(
        "Этот сервер задан через .env. Сначала удалите его параметры из окружения."
      );
    }
    const record = await this.db.getServerByKey(serverKey);
    if (record?.relayManaged) {
      const target = this.targetFor(record);
      if (target) await this.gateway.stopManagedRelay(target);
    }
    return this.db.deleteServer(serverKey);
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
    if (!this.config.relayProvisioning)
      throw new Error("Не настроен автоматический relay для новых серверов");
    if (await this.db.getServerByHost(host))
      throw new Error("Сервер с таким адресом уже добавлен");

    const sshKey = await this.nextServerKey();
    const relayPort = await this.db.nextRelayPort(
      this.config.relayProvisioning.portStart,
      this.config.relayProvisioning.portEnd
    );
    const server = await this.db.createServerPlaceholder({
      key: sshKey,
      name: input.name,
      host,
      port: input.port,
      sshUser: "vpn-bot",
      sshPrivateKey: "",
      hostFingerprint: "pending",
      relayPort,
      relayManaged: true,
    });

    const notify = this.onBootstrapFinished;
    void this.bootstrap(server.key, input.rootPassword)
      .then(async () => {
        const updated = await this.db.getServerByKey(server.key);
        if (!updated) return;
        if (updated.status === "ready") {
          notify?.(
            `✅ Сервер «${updated.name}» готов к выдаче конфигов.\n🌐 VPN relay: ${this.config.vpnProfile.relay?.host}:${updated.relayPort}`
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
      if (!record.relayPort) throw new Error("Серверу не выделен relay-порт");
      script = renderBootstrapScript(
        this.config.bootstrapPublicKey!,
        this.config.relayProvisioning!,
        record.relayPort
      )
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
          proxyUrl: this.sshProxyFor(record.key),
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
        enabled: true,
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
      proxyUrl: this.sshProxyFor(record.key),
      ...(this.config.vpnProfile.relay
        ? {
            relay: {
              host: this.config.vpnProfile.relay.host,
              port: record.relayPort ?? this.config.vpnProfile.relay.port,
            },
          }
        : {}),
    };
  }

  private sshProxyFor(serverKey: string): string | undefined {
    return this.config.directSshServerKeys.has(serverKey)
      ? undefined
      : this.config.sshProxyUrl;
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
      relayPort: null,
      relayManaged: false,
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

function renderBootstrapScript(
  publicKey: string,
  relay: NonNullable<AppConfig["relayProvisioning"]>,
  relayPort: number
): string {
  if (!/^ssh-(ed25519|rsa|ecdsa-sha2-nistp256) \S+( \S+)?$/.test(publicKey))
    throw new Error("Некорректный публичный SSH-ключ в конфигурации бота");
  const keyComment = publicKey.split(/\s+/).slice(2).join(" ") || "";
  const keyLine = keyComment ? publicKey : `${publicKey} vpnbot`;
  if (!/^[0-9A-Za-z.-]{1,253}$/.test(relay.host))
    throw new Error("Некорректный SSH-адрес relay-сервера");
  if (!/^[0-9A-Za-z.-]{1,253}$/.test(relay.publicHost))
    throw new Error("Некорректный публичный адрес relay-сервера");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(relay.username))
    throw new Error("Некорректный SSH-пользователь relay-сервера");
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(relay.privateKey))
    throw new Error("Некорректный приватный ключ relay-туннеля");
  const relayHostKey = relay.hostPublicKey.match(
    /(?:^|\s)(ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp256)\s+(\S+)/
  );
  if (!relayHostKey)
    throw new Error("Некорректный публичный host key relay-сервера");
  const relayKeyBase64 = Buffer.from(`${relay.privateKey}\n`).toString("base64");
  const knownHostsBase64 = Buffer.from(
    `vpnbot-relay ${relayHostKey[1]} ${relayHostKey[2]}\n`
  ).toString("base64");
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
BOT_PUB_LINE="\\$(cat "\\$BOT_KEY_PATH.pub")"

if [[ ! -x /usr/local/sbin/openvpn-bot-helper ]]; then
  if [[ ! -x /etc/openvpn/server/easy-rsa/easyrsa ]]; then
    cd /root
    curl -fsSL https://raw.githubusercontent.com/hwdsl2/openvpn-install/5aeec9eac6e663a5908f56c971d9278dd861c66e/openvpn-install.sh -o openvpn-install.sh
    chmod +x openvpn-install.sh
    bash openvpn-install.sh --auto --proto TCP --port 1194 --clientname vpnbot-bootstrap --dns1 1.1.1.1 --dns2 1.0.0.1
  fi
  curl -fsSL https://raw.githubusercontent.com/Ralf303/vpnbot/main/deploy/openvpn-bot-helper -o /usr/local/sbin/openvpn-bot-helper
  chmod 0755 /usr/local/sbin/openvpn-bot-helper
fi

grep -Eq '^proto (tcp|tcp-server)$' /etc/openvpn/server/server.conf || {
  echo 'Существующий OpenVPN настроен не на TCP' >&2
  exit 1
}
grep -Eq '^port 1194$' /etc/openvpn/server/server.conf || {
  echo 'Существующий OpenVPN использует порт, отличный от 1194' >&2
  exit 1
}
/usr/local/sbin/openvpn-bot-helper revoke vpnbot-bootstrap >/dev/null 2>&1 || true

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
echo "\\$BOT_PUB_LINE" > /home/vpn-bot/.ssh/authorized_keys
echo '${keyLine}' >> /home/vpn-bot/.ssh/authorized_keys
chmod 0600 /home/vpn-bot/.ssh/authorized_keys
chown vpn-bot:vpn-bot /home/vpn-bot/.ssh/authorized_keys

printf 'vpn-bot ALL=(root) NOPASSWD: /usr/local/sbin/openvpn-bot-helper\\nvpn-bot ALL=(root) NOPASSWD: /usr/bin/systemctl disable --now vpnbot-relay-tunnel.service\\n' > /etc/sudoers.d/vpn-bot
chmod 0440 /etc/sudoers.d/vpn-bot
visudo -cf /etc/sudoers.d/vpn-bot >/dev/null

install -d -m 0700 /etc/vpnbot-relay
echo '${relayKeyBase64}' | base64 -d > /etc/vpnbot-relay/id_ed25519
echo '${knownHostsBase64}' | base64 -d > /etc/vpnbot-relay/known_hosts
chmod 0600 /etc/vpnbot-relay/id_ed25519 /etc/vpnbot-relay/known_hosts

cat > /etc/systemd/system/vpnbot-relay-tunnel.service <<'RELAY_UNIT'
[Unit]
Description=VPN bot reverse relay tunnel
After=network-online.target openvpn-server@server.service
Wants=network-online.target
Requires=openvpn-server@server.service

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT -4 -p ${relay.port} -i /etc/vpnbot-relay/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o HostKeyAlias=vpnbot-relay -o UserKnownHostsFile=/etc/vpnbot-relay/known_hosts -R 0.0.0.0:${relayPort}:127.0.0.1:1194 ${relay.username}@${relay.host}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
RELAY_UNIT

systemctl daemon-reload
systemctl enable --now vpnbot-relay-tunnel.service
sleep 3
systemctl is-active --quiet vpnbot-relay-tunnel.service
timeout 10 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1194'
timeout 10 bash -c 'exec 3<>/dev/tcp/${relay.publicHost}/${relayPort}'

FP="\\$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print \\$2}')"
echo "===VPNBOT-RESULT==="
echo "fingerprint=\\$FP"
echo "relay_port=${relayPort}"
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
