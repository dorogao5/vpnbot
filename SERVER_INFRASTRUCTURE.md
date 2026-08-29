# Серверная архитектура и пошаговое развёртывание

Документ фиксирует рабочую production-схему на 26 августа 2026 года и объясняет, как воспроизвести её на других серверах. Внутренняя логика Telegram-бота описана отдельно в [BOT_INTERNALS.md](BOT_INTERNALS.md).

Здесь намеренно используются заполнители. Не копируйте в Git реальные IP, пароли, Telegram token, приватные ключи, SSH fingerprint, содержимое `.env`, дампы PostgreSQL и OpenVPN PKI.

## 1. Что построено

Система использует две основные машины:

| Роль | Обозначение | Назначение |
| --- | --- | --- |
| Российский control/entry | `RU` | бот, PostgreSQL, OpenVPN endpoint, PKI, GeoIP-классификация, российский NAT |
| Зарубежный exit | `FI` | WireGuard peer, NAT зарубежного трафика, SOCKS для Telegram и управляющего SSH |

```text
                                      ┌─ RU IPv4 ── NAT ens1 ──► Интернет с RU IP
OpenVPN-клиент ── TCP/443 ── RU tun1 ─┤
                                      └─ прочее ── WireGuard ── FI NAT ens3

RU Docker: bot + PostgreSQL
     │
     ├── Telegram Bot API ── SOCKS 172.30.0.1:1080 ──► FI ──► Telegram
     └── SSH к VPN VPS ───── SOCKS 172.30.0.1:1081 ──► FI ──► SSH
```

OpenVPN всегда завершается в Москве. Российский или зарубежный выход выбирается на `RU` по IP назначения каждого пакета. В клиентских файлах нет белого списка доменов и не требуется устанавливать маршруты к российским сайтам. Изменение списка RU-префиксов не требует перевыпуска `.ovpn`.

При недоступности `FI` healthcheck удаляет policy rule: ранее помеченный трафик тоже использует обычную таблицу маршрутизации и выходит через `RU`. Интернет у клиента сохраняется, но временно весь IPv4 получает российский адрес.

## 2. Текущее размещение

На `RU`:

- приложение: `/opt/vpnbot/app`;
- `.env`: `/opt/vpnbot/app/.env`;
- Docker secrets: `/opt/vpnbot/app/secrets`;
- контейнеры `app-bot-1` и `app-postgres-1`;
- внешний Docker network `vpnbot`, production subnet `172.30.0.0/24`;
- OpenVPN service `openvpn-server@server-tcp.service`, `tun1`, `10.9.0.0/24`;
- локальный OpenVPN listener `127.0.0.1:54`;
- публичный TCP/443 через `vpn-relay.socket` и `systemd-socket-proxyd`;
- WireGuard `wg-vpnbot`, адрес `10.210.0.1/30`;
- nftables table `inet vpnbot_geo` и policy table `210`;
- резервные копии `/root/vpnbot-backups/<UTC_TIMESTAMP>`.

На `FI`:

- WireGuard `wg-vpnbot`, адрес `10.210.0.2/30`, UDP/51820;
- NAT трафика `10.9.0.0/24` во внешний интерфейс;
- `vpn-telegram-tunnel.service` и `vpn-control-tunnel.service`;
- ключ туннелей `/etc/vpn-relay/id_ed25519`;
- резервные копии `/root/vpn-backups/<UTC_TIMESTAMP>`.

На `FI` может оставаться старый `openvpn-server@server.service`/`tun0`. Он не участвует в текущей гибридной схеме и не должен использовать тот же порт, subnet или правила `tun1`.

## 3. Обозначения и параметры

До начала запишите значения в локальный закрытый password manager:

```text
<RU_PUBLIC_IP>             публичный IPv4 российского сервера
<FI_PUBLIC_IP>             публичный IPv4 зарубежного сервера
<RU_PUBLIC_INTERFACE>      production: ens1
<FI_PUBLIC_INTERFACE>      production: ens3
<ADMIN_SSH_KEY>            ваш отдельный административный public key
<BOT_CONTROL_KEY>          пара ключей bot -> OpenVPN host
<RELAY_KEY>                пара ключей FI -> RU для reverse SOCKS
<WG_RU_PRIVATE/PUBLIC>     пара WireGuard RU
<WG_FI_PRIVATE/PUBLIC>     пара WireGuard FI
<BOT_TOKEN>                токен BotFather
<ADMIN_TELEGRAM_ID>        Telegram ID администратора
<POSTGRES_PASSWORD>        длинный случайный пароль
```

Узнать внешний интерфейс, не предполагая его имя:

```bash
ip -4 route get 1.1.1.1
```

В приведённых репозиторных скриптах интерфейсы зафиксированы как `ens1` на `RU` и `ens3` на `FI`. Если на новой машине это `eth0`, `ens3` или другое имя, замените его в копии скрипта и nft-конфиге до запуска.

Сети и идентификаторы текущей схемы:

```text
OpenVPN clients: 10.9.0.0/24, interface tun1
WireGuard:       10.210.0.0/30
RU WG:           10.210.0.1/30
FI WG:           10.210.0.2/30
fwmark:          0x210
policy table:    210
rule priority:   10210
Docker network:  172.30.0.0/24, gateway 172.30.0.1
```

Не пересекайте эти сети с LAN клиента, Docker-сетями, VPC провайдера и другими VPN.

## 4. Требования и открытые порты

Инструкция рассчитана на актуальный Ubuntu/Debian с systemd и root-доступом.

На `RU` извне нужны:

- TCP/22 или ваш административный SSH-порт;
- TCP/443 для OpenVPN-клиентов.

На `FI` извне нужны:

- TCP/22 для управления и исходящих reverse-туннелей;
- UDP/51820 для WireGuard, разрешённый желательно только от `<RU_PUBLIC_IP>`.

Порты `54`, `1080`, `1081`, PostgreSQL и Docker API наружу не публикуются. SOCKS слушает только gateway закрытой Docker-сети на `RU`.

Проверьте до установки:

```bash
# обе машины
uname -a
timedatectl
ip -br address
ip -4 route
ss -lntup

# с доступной внешней машины
nc -vz <RU_PUBLIC_IP> 22
nc -vz <RU_PUBLIC_IP> 443
nc -vzu <FI_PUBLIC_IP> 51820
```

## 5. Обязательная резервная копия

Перед изменением существующей системы создайте датированный каталог и скопируйте архив за пределы VPS.

На `RU`:

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/root/vpnbot-backups/$stamp"
install -d -m 0700 "$backup"
cp -a /opt/vpnbot/app/.env /opt/vpnbot/app/compose.yaml "$backup"/
cp -a /etc/openvpn/server /etc/wireguard "$backup"/
cp -a /etc/systemd/system/vpn-relay.* "$backup"/ 2>/dev/null || true
cp -a /etc/vpnbot-geo-routing.nft "$backup"/ 2>/dev/null || true
cd /opt/vpnbot/app
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$backup/vpnbot.dump"
tar -C /root/vpnbot-backups -czf "/root/vpnbot-$stamp.tar.gz" "$stamp"
```

Если переменные не экспортированы в shell, подставьте только имя пользователя и БД, но не печатайте пароль. `pg_dump` внутри контейнера обычно использует локальную доверенную аутентификацию.

На `FI`:

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/root/vpn-backups/$stamp"
install -d -m 0700 "$backup"
cp -a /etc/wireguard "$backup"/
cp -a /etc/systemd/system/vpn-*-tunnel.service "$backup"/ 2>/dev/null || true
iptables-save >"$backup/iptables.rules"
ip -4 rule >"$backup/ip-rule.txt"
ip -4 route show table all >"$backup/ip-route-all.txt"
```

Проверьте архив командой `tar -tzf` и храните копию не на том же сервере.

## 6. Базовая подготовка обеих машин

```bash
apt-get update
apt-get install -y ca-certificates curl nftables iptables wireguard-tools openssh-client jq netcat-openbsd
install -d -m 0755 /etc/sysctl.d
printf 'net.ipv4.ip_forward=1\n' >/etc/sysctl.d/99-vpnbot-forward.conf
sysctl --system
sysctl net.ipv4.ip_forward
```

Ожидается `net.ipv4.ip_forward = 1`.

Не отключайте firewall целиком. Добавьте только перечисленные входящие порты и не смешивайте `iptables-legacy` с `iptables-nft` без проверки `iptables --version`.

## 7. Установка приложения и PostgreSQL на RU

### 7.1. Docker

Установите Docker Engine и Compose plugin из официального репозитория Docker для вашей версии ОС, затем проверьте:

```bash
docker version
docker compose version
systemctl enable --now docker
```

### 7.2. Код и каталоги

Доставьте этот репозиторий в `/opt/vpnbot/app` через Git или проверенный архив:

```bash
install -d -m 0755 /opt/vpnbot/app
cd /opt/vpnbot/app
install -d -m 0700 secrets backups
cp .env.example .env
chmod 0600 .env
```

Создайте ключи, которые ожидает `compose.yaml`. Не используйте один ключ для всех ролей:

```bash
ssh-keygen -t ed25519 -f secrets/new_vpn_ssh_key -N '' -C vpnbot-control
ssh-keygen -t ed25519 -f secrets/old_vpn_ssh_key -N '' -C vpnbot-legacy-control
ssh-keygen -t ed25519 -f secrets/bootstrap_key -N '' -C vpnbot-bootstrap
ssh-keygen -t ed25519 -f secrets/relay_tunnel_key -N '' -C vpnbot-server-relay
chmod 0600 secrets/*
chmod 0644 secrets/*.pub
```

Сохраните публичный host key `RU` для автоматических relay, например результат `ssh-keyscan`, только после независимой проверки fingerprint:

```bash
ssh-keyscan -t ed25519 <RU_PUBLIC_IP> >secrets/relay_host_key.pub
ssh-keygen -lf secrets/relay_host_key.pub -E sha256
```

`ssh-keyscan` сам по себе не подтверждает подлинность ключа. Сверьте SHA256 через консоль провайдера или уже доверенное SSH-соединение.

### 7.3. Docker network

Привязка reverse SOCKS к `172.30.0.1` зависит от стабильного subnet:

```bash
docker network create --driver bridge \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 vpnbot
docker network inspect vpnbot
```

Если сеть уже существует, не пересоздавайте её вслепую: проверьте IPAM. При другом gateway синхронно измените systemd tunnel services и `TELEGRAM_PROXY_URL`/`SSH_PROXY_URL`.

### 7.4. `.env`

Минимально заполните:

```dotenv
BOT_TOKEN=<BOT_TOKEN>
ADMIN_TELEGRAM_ID=<ADMIN_TELEGRAM_ID>
CONTACT_URL=https://t.me/<CONTACT_USERNAME>
POSTGRES_DB=vpnbot
POSTGRES_USER=vpnbot
POSTGRES_PASSWORD=<POSTGRES_PASSWORD>
DATABASE_URL=postgresql://vpnbot:<URL_ENCODED_POSTGRES_PASSWORD>@postgres:5432/vpnbot
TIMEZONE=Europe/Moscow
REMINDER_HOUR=10

TELEGRAM_PROXY_URL=socks5h://172.30.0.1:1080
SSH_PROXY_URL=socks5h://172.30.0.1:1081
VPN_RELAY_HOST=<RU_PUBLIC_IP>
VPN_RELAY_PORT=443
VPN_BLOCK_IPV6=true
```

Если пароль содержит `@`, `:`, `/`, `%` или другие специальные символы URI, percent-encode его только внутри `DATABASE_URL`; `POSTGRES_PASSWORD` остаётся исходным.

Параметры `NEW_VPN_*`, `OLD_VPN_*` и автоматического relay заполняйте только для реально подключаемых серверов. Полный список и комментарии находятся в `.env.example`.

### 7.5. Первый старт

```bash
cd /opt/vpnbot/app
docker compose config >/dev/null
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=200 bot
docker compose exec bot npx prisma migrate status
```

Ожидаются healthy PostgreSQL, запущенный bot и отсутствие ошибок миграции. До появления SOCKS бот может перезапускаться из-за недоступности Telegram — сначала завершите раздел 8.

## 8. Reverse SOCKS из FI для Telegram и SSH

Эта часть нужна, когда `RU` не может стабильно обращаться к Telegram или зарубежным VPS напрямую.

### 8.1. Ограниченный пользователь на RU

```bash
useradd --create-home --home-dir /var/lib/vpn-relay --shell /bin/bash vpn-relay
install -d -o vpn-relay -g vpn-relay -m 0700 /var/lib/vpn-relay/.ssh
```

Создайте `/etc/ssh/sshd_config.d/90-vpnbot-relay.conf`:

```text
Match User vpn-relay
    PasswordAuthentication no
    PubkeyAuthentication yes
    AllowTcpForwarding remote
    GatewayPorts clientspecified
    X11Forwarding no
    PermitTTY no
```

Проверьте и перечитайте SSH без разрыва текущей сессии:

```bash
sshd -t
systemctl reload ssh
sshd -T -C user=vpn-relay,host=localhost,addr=127.0.0.1 | grep -E 'allowtcpforwarding|gatewayports'
```

На `FI` создайте отдельный ключ:

```bash
install -d -m 0700 /etc/vpn-relay
ssh-keygen -t ed25519 -f /etc/vpn-relay/id_ed25519 -N '' -C vpn-relay-fi
chmod 0600 /etc/vpn-relay/id_ed25519
```

Добавьте его публичную часть в `/var/lib/vpn-relay/.ssh/authorized_keys` на `RU` одной строкой:

```text
restrict,port-forwarding,command="/usr/bin/sleep infinity",permitlisten="172.30.0.1:1080",permitlisten="172.30.0.1:1081",permitlisten="127.0.0.1:2222" ssh-ed25519 <RELAY_PUBLIC_KEY> vpn-relay-fi
```

Выставьте владельца и режим:

```bash
chown vpn-relay:vpn-relay /var/lib/vpn-relay/.ssh/authorized_keys
chmod 0600 /var/lib/vpn-relay/.ssh/authorized_keys
```

### 8.2. Закрепление host key RU на FI

```bash
ssh-keyscan -t ed25519 <RU_PUBLIC_IP> >/etc/vpn-relay/known_hosts
ssh-keygen -lf /etc/vpn-relay/known_hosts -E sha256
chmod 0600 /etc/vpn-relay/known_hosts
```

Снова независимо сверьте fingerprint.

### 8.3. Два systemd-сервиса на FI

`/etc/systemd/system/vpn-telegram-tunnel.service`:

```ini
[Unit]
Description=Reverse SOCKS for vpnbot Telegram API
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ssh -NT -i /etc/vpn-relay/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/vpn-relay/known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 172.30.0.1:1080 vpn-relay@<RU_PUBLIC_IP>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/vpn-control-tunnel.service`:

```ini
[Unit]
Description=Reverse SOCKS and SSH control path for vpnbot
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ssh -NT -i /etc/vpn-relay/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/vpn-relay/known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 172.30.0.1:1081 -R 127.0.0.1:2222:127.0.0.1:22 vpn-relay@<RU_PUBLIC_IP>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Одноаргументный `-R host:port` — remote dynamic SOCKS. Трёхаргументный `-R bind:port:host:port` — обычный TCP-forward.

```bash
systemctl daemon-reload
systemctl enable --now vpn-telegram-tunnel.service vpn-control-tunnel.service
systemctl status vpn-telegram-tunnel.service vpn-control-tunnel.service --no-pager
```

На `RU`:

```bash
ss -lntp | grep -E '172\.30\.0\.1:(1080|1081)|127\.0\.0\.1:2222'
curl --proxy socks5h://172.30.0.1:1080 https://api.telegram.org/ -I
curl --proxy socks5h://172.30.0.1:1081 https://ifconfig.me
```

После этого перезапустите bot и убедитесь, что он отвечает:

```bash
cd /opt/vpnbot/app
docker compose restart bot
docker compose logs --tail=100 bot
```

## 9. OpenVPN на RU

Есть два варианта:

- свежая PKI: установить OpenVPN/EasyRSA и выпускать только новые профили;
- миграция PKI: перенести весь серверный каталог, чтобы старые сертификаты и файлы продолжили работать.

### 9.1. Главное правило миграции PKI

Для сохранения существующих профилей переносится единым согласованным комплектом:

- CA certificate и CA private key;
- серверный certificate/key;
- `easy-rsa/pki/index.txt`, `serial`, `crlnumber`, issued/private/reqs;
- `crl.pem`;
- `tls-crypt.key` или `ta.key`;
- параметры DH, если они используются;
- `client-common.txt` и серверный конфиг.

Нельзя создать новый CA и ожидать, что старые клиентские сертификаты продолжат подключаться.

Безопасный перенос:

1. Остановить операции выдачи в админке.
2. Сделать архив `/etc/openvpn/server` на источнике и проверить checksum.
3. Передать архив по защищённому каналу на `RU`.
4. Установить совместимую версию OpenVPN/EasyRSA.
5. Остановить OpenVPN на источнике на время финальной синхронизации `index.txt`, `serial` и CRL.
6. Развернуть каталог на `RU`, сохранить владельцев и режимы.
7. Изменить только transport/listener, subnet и hooks, не перевыпуская CA.
8. Проверить `openvpn --config ... --test-crypto` там, где поддерживается, затем journal.
9. Подключить один существующий профиль до переключения всех пользователей.

Храните исходный сервер выключенным, но не уничтоженным, до завершения проверки. Одновременная выдача из двух копий одной PKI приведёт к расхождению serial/index.

### 9.2. Рабочая серверная конфигурация

Сервис: `openvpn-server@server-tcp.service`. Конфиг: `/etc/openvpn/server/server-tcp.conf`.

Существенные директивы текущей схемы:

```conf
local 127.0.0.1
port 54
proto tcp-server
dev tun1
server 10.9.0.0 255.255.255.0
topology subnet

push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 1.1.1.1"
push "dhcp-option DNS 1.0.0.1"
push "block-outside-dns"

script-security 2
status /run/openvpn-server/server-status.tsv 10
status-version 3
client-disconnect /usr/local/sbin/openvpn-traffic-disconnect
```

Также оставьте созданные вашей PKI директивы `ca`, `cert`, `key`, `crl-verify`, `tls-crypt`/`tls-auth`, cipher/data-ciphers, `keepalive`, `persist-key`, `persist-tun`, `user` и `group`. Не копируйте слепо криптографические строки из чужой установки.

Путь status должен быть ровно `/run/openvpn-server/server-status.tsv`: его читает текущий `deploy/openvpn-bot-helper`. Несовпадение не ломает VPN, но скрывает активные подключения и живой трафик в боте. В одной из live-инвентаризаций встречалось имя `server-status-tcp.tsv`, поэтому совпадение этих путей является обязательным пунктом проверки после переноса или переустановки.

В `client-common.txt` transport должен соответствовать TCP, но адрес и порт при отправке всё равно заменяются приложением на `<RU_PUBLIC_IP>:443`.

### 9.3. Helper, hook и пользователь управления

Из корня репозитория на `RU`:

```bash
install -o root -g root -m 0755 deploy/openvpn-bot-helper /usr/local/sbin/openvpn-bot-helper
install -o root -g root -m 0755 deploy/openvpn-traffic-disconnect /usr/local/sbin/openvpn-traffic-disconnect
install -o root -g root -m 0440 deploy/sudoers-vpn-bot /etc/sudoers.d/vpn-bot
visudo -cf /etc/sudoers.d/vpn-bot
install -d -o nobody -g nogroup -m 0700 /var/lib/openvpn-bot/traffic-events
```

Создайте непривилегированного пользователя и установите публичную часть control key:

```bash
id vpn-bot >/dev/null 2>&1 || useradd --create-home --shell /bin/sh vpn-bot
install -d -o vpn-bot -g vpn-bot -m 0700 /home/vpn-bot/.ssh
```

В `/home/vpn-bot/.ssh/authorized_keys`:

```text
restrict ssh-ed25519 <BOT_CONTROL_PUBLIC_KEY> vpnbot-control
```

```bash
chown vpn-bot:vpn-bot /home/vpn-bot/.ssh/authorized_keys
chmod 0600 /home/vpn-bot/.ssh/authorized_keys
systemctl enable --now openvpn-server@server-tcp.service
systemctl status openvpn-server@server-tcp.service --no-pager
sudo /usr/local/sbin/openvpn-bot-helper list
sudo /usr/local/sbin/openvpn-bot-helper active-sessions
```

Доступ проверяется фактическим вызовом helper из контейнера, а не только локальным sudo. Не заменяйте shell на `nologin` без отдельного forced-command wrapper: обычное выполнение удалённой команды SSH может перестать работать.

## 10. Публичный TCP/443 через systemd socket proxy

OpenVPN слушает только loopback:54. Публичный сокет принадлежит systemd.

`/etc/systemd/system/vpn-relay.socket`:

```ini
[Unit]
Description=Public OpenVPN TCP relay socket

[Socket]
ListenStream=0.0.0.0:443
NoDelay=true
ReusePort=false

[Install]
WantedBy=sockets.target
```

`/etc/systemd/system/vpn-relay.service`:

```ini
[Unit]
Description=Proxy public OpenVPN socket to local OpenVPN
Requires=vpn-relay.socket
After=openvpn-server@server-tcp.service

[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd 127.0.0.1:54
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
```

Путь `systemd-socket-proxyd` проверьте командой `command -v systemd-socket-proxyd`; на части дистрибутивов он находится в `/usr/lib/systemd/`.

```bash
systemctl daemon-reload
systemctl enable --now vpn-relay.socket
systemctl restart openvpn-server@server-tcp.service
systemctl status vpn-relay.socket openvpn-server@server-tcp.service --no-pager
ss -lntp | grep -E ':443|127\.0\.0\.1:54'
```

## 11. WireGuard между RU и FI

### 11.1. Ключи

На каждой машине отдельно:

```bash
install -d -m 0700 /etc/wireguard
umask 077
wg genkey | tee /etc/wireguard/vpnbot-private.key | wg pubkey >/etc/wireguard/vpnbot-public.key
chmod 0600 /etc/wireguard/vpnbot-private.key
```

Обменяйтесь только public keys.

### 11.2. RU `/etc/wireguard/wg-vpnbot.conf`

```ini
[Interface]
Address = 10.210.0.1/30
PrivateKey = <WG_RU_PRIVATE>
Table = off

[Peer]
PublicKey = <WG_FI_PUBLIC>
Endpoint = <FI_PUBLIC_IP>:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 15
```

### 11.3. FI `/etc/wireguard/wg-vpnbot.conf`

```ini
[Interface]
Address = 10.210.0.2/30
ListenPort = 51820
PrivateKey = <WG_FI_PRIVATE>
Table = off

[Peer]
PublicKey = <WG_RU_PUBLIC>
AllowedIPs = 10.210.0.1/32, 10.9.0.0/24
```

```bash
chmod 0600 /etc/wireguard/wg-vpnbot.conf
systemctl enable --now wg-quick@wg-vpnbot.service
wg show wg-vpnbot
```

С `RU`:

```bash
ping -c 3 -I wg-vpnbot 10.210.0.2
```

Не продолжайте с policy routing, пока нет свежего handshake и двустороннего ping.

## 12. Зарубежный NAT на FI

Репозиторный скрипт ожидает внешний интерфейс `ens3`. Сначала замените его при необходимости, затем:

```bash
install -o root -g root -m 0755 deploy/vpnbot-finland-egress /usr/local/sbin/vpnbot-finland-egress
install -o root -g root -m 0644 deploy/vpnbot-finland-egress.service /etc/systemd/system/vpnbot-finland-egress.service
systemctl daemon-reload
systemctl enable --now vpnbot-finland-egress.service
systemctl status vpnbot-finland-egress.service --no-pager
```

Сервис делает три вещи:

- маршрут `10.9.0.0/24 dev wg-vpnbot`;
- разрешение forward из WireGuard и обратного established-трафика;
- `MASQUERADE` источника `10.9.0.0/24` во внешний интерфейс `FI`.

Проверка:

```bash
ip -4 route get 10.9.0.2
iptables -S FORWARD | grep vpnbot-finland-egress
iptables -t nat -S POSTROUTING | grep vpnbot-finland-egress
```

## 13. GeoIP и policy routing на RU

Репозиторные файлы:

- `deploy/vpnbot-geo-routing.nft`;
- `deploy/vpnbot-update-ru-routes` + `.service` + `.timer`;
- `deploy/vpnbot-route-health` + `.service` + `.timer`;
- `deploy/vpnbot-moscow-routing` + `.service`.

До установки проверьте/измените в них `tun1`, `10.9.0.0/24`, `ens1`, `wg-vpnbot` и `10.210.0.2`.

```bash
install -o root -g root -m 0644 deploy/vpnbot-geo-routing.nft /etc/vpnbot-geo-routing.nft
install -o root -g root -m 0755 deploy/vpnbot-update-ru-routes /usr/local/sbin/vpnbot-update-ru-routes
install -o root -g root -m 0755 deploy/vpnbot-route-health /usr/local/sbin/vpnbot-route-health
install -o root -g root -m 0755 deploy/vpnbot-moscow-routing /usr/local/sbin/vpnbot-moscow-routing
install -o root -g root -m 0644 deploy/vpnbot-update-ru-routes.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/vpnbot-update-ru-routes.timer /etc/systemd/system/
install -o root -g root -m 0644 deploy/vpnbot-route-health.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/vpnbot-route-health.timer /etc/systemd/system/
install -o root -g root -m 0644 deploy/vpnbot-moscow-routing.service /etc/systemd/system/
```

Проверьте nft-конфиг без применения:

```bash
nft --check --file /etc/vpnbot-geo-routing.nft
```

Запуск:

```bash
systemctl daemon-reload
systemctl enable --now vpnbot-moscow-routing.service
systemctl enable --now vpnbot-update-ru-routes.timer vpnbot-route-health.timer
systemctl start vpnbot-update-ru-routes.service vpnbot-route-health.service
```

Как это работает:

1. nft `prerouting` смотрит только пакеты с `tun1` и source `10.9.0.0/24`.
2. Reserved/private IPv4 не маркируются.
3. IP из набора `ru4` не маркируются и выходят через обычный default route `RU`.
4. Остальные назначения получают mark `0x210`.
5. Rule preference `10210` отправляет mark в table `210`.
6. Table `210` содержит default route через `wg-vpnbot`, только если healthcheck видит `10.210.0.2`.
7. На `RU` весь `10.9.0.0/24`, который идёт обычным путём, маскарадуется во внешний интерфейс.

Список RU IPv4 загружается с `https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone`. Скрипт требует не менее 1000 корректных CIDR, проверяет nft batch и только затем атомарно заменяет set. Timer запускается ежедневно около 04:20 `Europe/Moscow` с случайной задержкой до 15 минут.

Проверка:

```bash
nft list table inet vpnbot_geo
nft list set inet vpnbot_geo ru4 | head -50
ip -4 rule show
ip -4 route show table 210
systemctl list-timers 'vpnbot-*'
journalctl -u vpnbot-update-ru-routes.service -n 50 --no-pager
journalctl -u vpnbot-route-health.service -n 50 --no-pager
```

Ожидаются rule `10210`, default route table 210 через `wg-vpnbot` и больше 1000 RU prefixes.

## 14. Подключение бота к OpenVPN на RU

Если бот управляет тем же `RU`, всё равно используйте SSH boundary — это сохраняет одинаковый интерфейс с удалёнными серверами.

1. Поместите control private key в `/opt/vpnbot/app/secrets/new_vpn_ssh_key`.
2. Добавьте его public key пользователю `vpn-bot`.
3. Получите host fingerprint через доверенный канал.
4. Заполните `NEW_VPN_*`:

```dotenv
NEW_VPN_NAME=Основной сервер
NEW_VPN_HOST=<RU_PUBLIC_IP_OR_REACHABLE_HOST>
NEW_VPN_PORT=22
NEW_VPN_USER=vpn-bot
NEW_VPN_PRIVATE_KEY_PATH=/run/secrets/new_vpn_ssh_key
NEW_VPN_HOST_FINGERPRINT=SHA256:<VERIFIED_FINGERPRINT>
VPN_HELPER_COMMAND=sudo /usr/local/sbin/openvpn-bot-helper
```

5. Перезапустите контейнер и проверьте логи:

```bash
cd /opt/vpnbot/app
docker compose up -d --build bot
docker compose logs --tail=200 bot
```

6. В админке проверьте статус, затем выполните тестовый полный цикл: выдача → скачивание → подключение → трафик → отзыв.

Если `RU` не может соединиться с собственным публичным IP через SOCKS `FI`, для `NEW_VPN_HOST` используйте специально разрешённый достижимый адрес/маршрут, но host fingerprint должен соответствовать именно этому SSH endpoint.

## 15. Полная приёмочная проверка

### 15.1. Control plane

- `/start` получает ответ без задержки;
- контейнеры остаются `Up`, миграции применены;
- админка видит один активный сервер;
- helper выполняет `list`, `create`, `download`, `revoke`;
- root-пароль нигде не появился в `.env`, БД или логах;
- после перезапуска контейнеров пользователи и сроки сохраняются.

### 15.2. VPN handshake

- новый профиль содержит `<RU_PUBLIC_IP>` и TCP/443;
- клиент получает адрес `10.9.0.x`;
- `journalctl -u openvpn-server@server-tcp.service` показывает подключение;
- helper `active-sessions` показывает CN и байты;
- после отключения появляется TSV в `/var/lib/openvpn-bot/traffic-events` и затем запись в статистике бота.

### 15.3. Маршрутизация

Под подключённым VPN откройте несколько заранее проверенных RU и зарубежных сервисов определения IP. DNS-имя само по себе не является критерием: классифицируется итоговый IPv4 каждого соединения.

Ожидается:

- RU destination видит публичный IP `RU`;
- зарубежный destination видит публичный IP `FI`;
- DNS работает;
- IPv6 не обходит VPN;
- при `systemctl stop wg-quick@wg-vpnbot` весь IPv4 временно выходит через `RU`, а не пропадает;
- после восстановления WireGuard rule/table появляются не позднее следующего 10-секундного healthcheck.

Наблюдение пакетов:

```bash
# RU
tcpdump -ni tun1 host 10.9.0.2
tcpdump -ni wg-vpnbot

# FI
tcpdump -ni wg-vpnbot net 10.9.0.0/24
```

## 16. Перезапуск и порядок восстановления после reboot

Systemd зависимости и timers восстанавливают dataplane автоматически:

1. сеть;
2. `wg-quick@wg-vpnbot`;
3. OpenVPN и публичный socket;
4. FI egress / RU routing;
5. health и RU-prefix timers;
6. reverse SOCKS;
7. Docker Compose с restart policy.

После перезагрузки обеих машин проверьте:

```bash
systemctl --failed
wg show
ip -4 rule show
ip -4 route show table 210
nft list table inet vpnbot_geo
systemctl list-timers 'vpnbot-*'
docker compose -f /opt/vpnbot/app/compose.yaml ps
```

Docker Compose не является systemd unit в репозитории, но контейнеры имеют `restart: unless-stopped`. После первого `docker compose up -d` Docker поднимет их при своём старте.

## 17. Аварийный откат

### 17.1. FI недоступен

Обычно ничего делать не нужно: healthcheck удалит rule/table, и будет московский fallback.

Принудительно:

```bash
systemctl stop vpnbot-route-health.timer
/usr/local/sbin/vpnbot-moscow-routing down
```

Это уберёт GeoIP-policy и московский NAT из репозиторного сервиса. Для сохранения всего трафика через `RU` лучше оставить nft/NAT, но удалить только rule/table:

```bash
ip -4 rule del preference 10210 2>/dev/null || true
ip -4 route flush table 210
```

### 17.2. GeoIP-набор не обновился

Старый nft set остаётся активным. Посмотрите journal и URL, не очищайте set вручную. После устранения сети:

```bash
systemctl start vpnbot-update-ru-routes.service
```

### 17.3. Новая версия бота не стартует

Не используйте `prisma migrate reset` или `db push` в production. Сохраните `pg_dump`, верните предыдущий Git commit/образ и выполните:

```bash
docker compose up -d --build bot
docker compose logs --tail=200 bot
```

Миграции проектируются вперёд-совместимыми; ручной SQL rollback возможен только после анализа конкретной миграции.

### 17.4. Повреждение БД

Остановите bot, не PostgreSQL, создайте копию текущего volume/дамп, затем восстановите проверенный custom dump в чистую БД. После восстановления выполните `prisma migrate deploy`, и только потом включите bot.

### 17.5. Ошибка PKI

Остановите выдачу и OpenVPN, сохраните повреждённое состояние отдельно, восстановите весь согласованный каталог `/etc/openvpn/server` из одной резервной точки. Не восстанавливайте только `index.txt` без matching serial, certificates, private keys и CRL.

## 18. Добавление нового сервера через админку

Кнопка добавления сервера реализует другой сценарий:

- одноразовый вход по root-паролю;
- установка закреплённой ревизии `hwdsl2/openvpn-install`;
- OpenVPN/TCP на новом VPS;
- helper, hook, `vpn-bot` и отдельный управляющий ключ;
- постоянный reverse SSH relay на одном из портов `VPN_RELAY_PORT_START..END`;
- проверка и включение сервера в пул.

Root-пароль не сохраняется. Используется зафиксированный commit установщика, указанный в `src/server-manager.ts`, а не плавающая ветка upstream.

Это удобно для автономного OpenVPN VPS, но не превращает его в новый зарубежный exit текущей GeoIP-схемы. Чтобы заменить `FI`, вручную настройте WireGuard, NAT, health peer/endpoint и проверьте маршрутизацию по разделам 11–15. Чтобы добавить несколько exit одновременно, текущие скрипты надо расширить: сейчас table 210 содержит один default dev и один health peer.

## 19. Мониторинг и регулярное обслуживание

Ежедневно или внешним мониторингом проверяйте:

- Telegram heartbeat бота;
- `docker compose ps` и ошибки bot/PostgreSQL;
- свободное место и размер Docker volume;
- возраст последнего PostgreSQL backup и тест восстановления;
- WireGuard latest handshake;
- наличие rule 10210 и default table 210;
- успешность `vpnbot-update-ru-routes.service`;
- OpenVPN service, TCP/443 и срок серверного сертификата;
- размер `/var/lib/openvpn-bot/traffic-events`;
- `systemctl --failed` на обеих машинах.

Полезные команды:

```bash
journalctl -u openvpn-server@server-tcp.service -n 100 --no-pager
journalctl -u vpn-telegram-tunnel.service -n 100 --no-pager
journalctl -u vpn-control-tunnel.service -n 100 --no-pager
journalctl -u vpnbot-route-health.service -n 100 --no-pager
wg show
ss -lntup
docker compose -f /opt/vpnbot/app/compose.yaml logs --tail=200 bot
```

## 20. Ротация секретов

Ротируйте роли независимо:

- BotFather token → `.env` → restart bot;
- PostgreSQL password → роль PostgreSQL и обе переменные `.env` согласованно;
- control SSH key → сначала добавить новый public key, обновить secret/настройку, проверить, затем удалить старый;
- reverse relay key → сначала добавить новый key на `RU`, обновить `FI`, проверить оба tunnel service, затем удалить старый;
- WireGuard key → обновить private одной стороны и peer public другой в согласованное окно;
- root-пароли → не используются приложением после bootstrap и могут меняться владельцем серверов отдельно.

После любой ротации проверьте именно зависимый канал. Не перезапускайте одновременно OpenVPN, WireGuard, reverse SOCKS и bot без необходимости.

## 21. Чек-лист для другого человека или агента

Перед изменениями:

1. Прочитать этот документ и [BOT_INTERNALS.md](BOT_INTERNALS.md).
2. Убедиться, какая машина играет `RU`, а какая `FI`.
3. Снять backup БД, PKI, WireGuard и systemd units.
4. Зафиксировать `ip route`, `ip rule`, nft/iptables и `wg show`.
5. Не публиковать секреты в терминальном выводе, Git или сообщениях.

После изменений:

1. Проверить systemd и Docker.
2. Проверить Telegram отдельно от управляющего SSH.
3. Выпустить отдельный тестовый сертификат.
4. Проверить RU, foreign и fallback-маршруты.
5. Отозвать тестовый сертификат и убедиться, что он больше не подключается.
6. Проверить импорт трафика.
7. Обновить оба MD-документа, если изменилась архитектура или бизнес-логика.
