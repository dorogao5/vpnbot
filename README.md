# Telegram-бот для управления OpenVPN

Бот управляет конфигами, созданными установщиком [Nyr/openvpn-install](https://github.com/Nyr/openvpn-install), через Telegram. Пользователь видит свои конфиги, срок действия и может повторно получить файл. Администратор ищет пользователей по username или Telegram ID, выдаёт конфиги, меняет сроки и отзывает доступ.

## Реализованные правила

- У каждого конфига отдельная дата окончания.
- Новые клиенты создаются на доступном VPS с меньшим количеством действующих пользовательских сертификатов; при равенстве приоритет получает новый VPS.
- За 3, 2 и 1 день до окончания бот отправляет напоминание в 10:00 по Москве; несколько конфигов одного пользователя объединяются в одно сообщение.
- Через 24 часа после окончания сертификат отзывается через CRL.
- Просроченная запись видна пользователю 10 дней, затем исчезает из его списка.
- Если уже отозванный конфиг продлевают, на новом VPS создаётся новый OpenVPN-клиент.
- Старый конфиг продолжает работать без изменений и повторно скачивается со своего VPS без обязательного переноса.
- При перевыпуске просроченного конфига новый сертификат по возможности создаётся на том же VPS.
- Пользовательское переименование не меняет техническое имя сертификата.
- Пользователь может перевыпустить активный конфиг: срок и название сохраняются, новый сертификат создаётся на другом VPS, а старый остаётся доступен примерно 5 минут и затем гарантированно отзывается фоновой задачей.
- Карточки и списки конфигов показывают, используется ли OpenVPN-клиент прямо сейчас; длинные списки разбиваются на страницы по 10 записей.
- Все меню и переходы используют inline-кнопки. Текст вводится только для поиска, названия и произвольной даты.
- Файлы `.ovpn` не хранятся в контейнере или базе бота: сервер формирует их по запросу.

## Технологии

- Node.js 22 и TypeScript
- grammY
- Prisma ORM 7 и Prisma Migrate
- PostgreSQL 17
- SSH с обязательной проверкой fingerprint сервера
- Docker Compose

PostgreSQL запускается отдельным контейнером. Перед стартом бот выполняет `prisma migrate deploy`, поэтому изменения схемы применяются из сохранённых SQL-миграций без пересоздания базы.

## Локальный запуск

Требуется Node.js 22.13 или новее.

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run prisma:migrate:deploy
npm run dev
```

Перед запуском заполните в `.env` как минимум `BOT_TOKEN`, `ADMIN_TELEGRAM_ID`, пароль PostgreSQL и `DATABASE_URL`. При запуске Node.js вне Docker укажите в `DATABASE_URL` адрес `localhost`, а не имя compose-сервиса `postgres`. Без параметров нового VPS бот откроет меню, но выдача и скачивание конфигов будут завершаться понятной ошибкой.

Проверки:

```bash
npm test
npm run typecheck
npm run build
```

Интеграционные тесты используют отдельный PostgreSQL:

```bash
docker compose -f compose.test.yaml up -d --wait
export TEST_DATABASE_URL=postgresql://vpnbot:vpnbot_test@localhost:55432/vpnbot_test
DATABASE_URL=$TEST_DATABASE_URL npm run prisma:migrate:deploy
npm test
docker compose -f compose.test.yaml down
```

## Переменные окружения

Основные параметры приведены в `.env.example`:

- `BOT_TOKEN` — токен от BotFather.
- `ADMIN_TELEGRAM_ID` — единственный Telegram ID с доступом в админ-панель.
- `DATABASE_URL` — строка подключения Prisma к PostgreSQL.
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` — параметры контейнера PostgreSQL.
- `TIMEZONE` — часовой пояс дат и заданий, по умолчанию `Europe/Moscow`.
- `REMINDER_HOUR` — час ежедневных напоминаний.
- `NEW_VPN_*` — обязательные параметры нового VPS для рабочих операций.
- `OLD_VPN_*` — заполняются только на этапе безопасного подключения старого VPS.
- `*_HOST_FINGERPRINT` — fingerprint SSH host key в виде `SHA256:...`; несовпадение блокирует подключение.
- `VPN_BOOTSTRAP_PUBLIC_KEY_PATH` — публичный SSH-ключ, который бот прописывает на новых серверах при настройке через админку. Пара: `ssh-keygen -t ed25519 -f secrets/bootstrap_key -N "" -C vpnbot-bootstrap`.

## Серверы через админку

В админ-панели раздел «🖥 Серверы» показывает все подключённые VPS (встроенные `new`/`old` из `.env` подтягиваются в БД при старте, динамические хранятся в таблице `vpn_servers`). Для каждого сервера доступны: статистика (конфиги, активные подключения, трафик), переименование для пользователей и пауза выдачи новых конфигов.

Кнопка «➕ Добавить сервер» принимает IP, SSH-порт, пароль root и название. Бот подключается по паролю один раз, ставит OpenVPN (через [Nyr/openvpn-install](https://github.com/Nyr/openvpn-install) в режиме `AUTO_INSTALL=y`), helper, disconnect-hook, создаёт пользователя `vpn-bot` с sudo только на helper и генерирует отдельный SSH-ключ. По окончании админ получает уведомление. Пароль root нигде не сохраняется.

Пользователь в карточке конфига видит название сервера и при перевыпуске выбирает целевой сервер сам; старый клиент живёт ~5 минут и отзывается фоновой задачей.

## Серверный helper

Интерактивное меню `openvpn-install.sh` не предназначено для автоматизации. Файл `deploy/openvpn-bot-helper` выполняет только шесть строго ограниченных операций:

- `create CLIENT` — создать сертификат и вернуть `.ovpn` в stdout;
- `download CLIENT` — повторно собрать активный `.ovpn`;
- `revoke CLIENT` — отозвать сертификат и обновить CRL;
- `list` — вывести активные имена клиентов;
- `stats` — вывести суммарный трафик интерфейсов `tun*` с момента их запуска.
- `traffic-sessions` — вывести активные и завершённые VPN-сессии для накопительного учёта.

Helper использует каталог `/etc/openvpn/server/easy-rsa`, `client-common.txt` и CRL, созданные исходным установщиком.
Служебный сертификат OpenVPN с именем `server` явно исключён из `list` и запрещён для операций `download` и `revoke`.

На каждом VPS создаётся отдельный непривилегированный пользователь `vpn-bot`. Ему разрешается через `sudo` запускать только helper:

```bash
sudo install -o root -g root -m 0755 deploy/openvpn-bot-helper /usr/local/sbin/openvpn-bot-helper
sudo install -o root -g root -m 0440 deploy/sudoers-vpn-bot /etc/sudoers.d/vpn-bot
sudo visudo -cf /etc/sudoers.d/vpn-bot
```

Для накопительного учёта трафика установите disconnect-hook и добавьте в `server.conf`:

```bash
sudo install -o root -g root -m 0755 deploy/openvpn-traffic-disconnect /usr/local/sbin/openvpn-traffic-disconnect
sudo install -d -o nobody -g nogroup -m 0700 /var/lib/openvpn-bot/traffic-events
```

```text
script-security 2
status /run/openvpn-server/server-status.tsv 10
status-version 3
client-disconnect /usr/local/sbin/openvpn-traffic-disconnect
```

После проверки конфигурации перезапустите OpenVPN. Завершённые сессии сохраняются hook-скриптом, а активные читаются из status-файла. Бот раз в минуту импортирует завершённые сессии в PostgreSQL.

SSH-ключ бота должен быть отдельным от Вашего административного ключа. В `authorized_keys` рекомендуется запретить forwarding и PTY:

```text
restrict ssh-ed25519 AAAA... vpnbot
```

## Развёртывание бота

На машине, где будет работать бот:

```bash
mkdir -p secrets backups
chmod 700 secrets
chmod 600 secrets/new_vpn_ssh_key
docker compose build
docker compose up -d
docker compose logs -f bot
```

Том `postgres_data` содержит рабочую базу. Пример логического резервного копирования:

```bash
docker compose exec -T postgres pg_dump -U vpnbot -d vpnbot -Fc > backups/vpnbot.dump
```

Каталог `secrets`, `.env` и дампы базы не должны попадать в Git.

## Миграции базы

После изменения `prisma/schema.prisma` в разработке создаётся новая миграция:

```bash
npm run prisma:migrate:dev -- --name short_description
npm run prisma:generate
```

SQL из `prisma/migrations` необходимо хранить вместе с кодом. В production используется только `prisma migrate deploy`; команды `migrate reset` и `db push` там не применяются.

## Безопасное подключение серверов

### Этап 1 — новый VPS

1. Установить OpenVPN исходным скриптом и проверить подключение тестовым файлом вручную.
2. Создать пользователя `vpn-bot`, установить helper и отдельный SSH-ключ.
3. Проверить вручную `list`, `create`, подключение созданным файлом и `revoke`.
4. Заполнить только `NEW_VPN_*` и проверить полный цикл через бота.
5. Убедиться, что после отзыва тестовый файл больше не подключается.

### Этап 2 — старый VPS

До первой изменяющей операции необходимо сохранить как минимум:

```bash
sudo tar -C / -czf /root/openvpn-before-vpnbot.tar.gz etc/openvpn/server
sudo cp -a /root/openvpn-install.sh /root/openvpn-install.before-vpnbot.sh
```

Далее:

1. Проверить целостность архива и отдельно сохранить его вне VPS.
2. Установить helper и подключить ключ, но сначала вызвать только `list` и `stats`.
3. Заполнить `OLD_VPN_*` и перезапустить контейнер.
4. В админ-панели найти пользователя, нажать «Привязать старый конфиг», выбрать имя клиента и дату.
5. После привязки текущий файл продолжает работать. Отзыв произойдёт только при ручном отзыве, окончании срока или подтверждённой пользователем миграции.

Старый VPS не нужно переустанавливать, менять его OpenVPN-конфигурацию или перезапускать сервис для импорта клиентов.

## Трафик

Раздел «Статистика» показывает накопительный трафик отдельно для каждого VPS и общий итог. Карточка конфига показывает его собственный трафик. Завершённые сессии хранятся в PostgreSQL, активные добавляются из OpenVPN status-файла и не удваиваются при последующем импорте завершённой сессии.
