# Runbook первого запуска и обновления VPN-бота

Этот документ — короткий практический маршрут для человека или агента, который
получил чистый сервер или должен повторно развернуть проект. Подробное устройство
приложения описано в [BOT_INTERNALS.md](BOT_INTERNALS.md), а настройка OpenVPN,
WireGuard, GeoIP-маршрутизации и reverse SOCKS — в
[SERVER_INFRASTRUCTURE.md](SERVER_INFRASTRUCTURE.md).

Актуальная проверенная база на момент создания runbook: ветка `main`, коммит
`ac4d0a7`. Не привязывайте автоматизацию к этому хешу навсегда: перед новым
развёртыванием прочитайте последующие коммиты и миграции.

## 1. Что должно получиться

На российском сервере работают один процесс Node.js и одна PostgreSQL:

- Telegram-бот обслуживает пользователей, админку и напоминания;
- VK-адаптер обслуживает только пользовательские конфиги;
- оба канала используют общие `User`, `VpnConfig` и сроки в PostgreSQL;
- VK начинает показывать конфиги только после привязки к Telegram;
- Telegram Bot API вызывается через зарубежный SOCKS;
- VK API вызывается с российского сервера напрямую;
- управляющий SSH обычно идёт через отдельный SOCKS, но для перечисленных
  московских VPN-серверов идёт напрямую;
- пользовательский OpenVPN всегда завершается в Москве: RU IPv4 выходит в
  Москве, остальной IPv4 — через WireGuard и зарубежный exit; при отказе exit
  весь IPv4 временно выходит через Москву.

Переменные `TELEGRAM_PROXY_URL`, `SSH_PROXY_URL` и
`VPN_DIRECT_SSH_SERVER_KEYS` управляют только служебными запросами приложения.
Они не заменяют и не настраивают WireGuard/GeoIP dataplane пользователя.

## 2. Подготовка Telegram и VK

### Telegram

1. Создайте бота через BotFather и получите token.
2. Узнайте числовой Telegram ID единственного администратора.
3. Не публикуйте token и не сохраняйте его в Git.

### VK

1. Создайте сообщество VK и включите сообщения сообщества.
2. Включите Bots Long Poll API версии `5.199`.
3. Включите события `message_new`, `message_event`, `message_allow` и
   `message_deny`.
4. Создайте token сообщества с доступом к сообщениям и документам.
5. Запишите числовой ID сообщества без префикса и token в `.env` как
   `VK_GROUP_ID` и `VK_GROUP_TOKEN`.

Callback URL, публичный HTTP-порт и TLS-сертификат для VK не нужны: приложение
само держит исходящее Long Poll-соединение. Оба VK-параметра задаются вместе;
если оба пусты, VK-адаптер отключён, а если заполнен только один, приложение
завершит запуск с ошибкой конфигурации.

## 3. Подготовка каталога на российском сервере

Канонический код находится в Git. Рабочая production-копия ожидается в
`/opt/vpnbot/app`:

```bash
install -d -m 0755 /opt/vpnbot/app
cd /opt/vpnbot/app
install -d -m 0700 secrets backups
cp .env.example .env
chmod 0600 .env
```

Подготовьте SSH-ключи, перечисленные в `compose.yaml`. Приватные ключи имеют
режим `0600`, публичные — `0644`. Не используйте один ключ одновременно для
control, bootstrap и reverse relay.

Внешняя Docker-сеть должна существовать до `docker compose up`. Для штатной
схемы reverse SOCKS её адреса фиксированы:

```bash
docker network create --driver bridge \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 vpnbot
docker network inspect vpnbot
```

Если сеть уже существует, только проверьте её IPAM. Не пересоздавайте рабочую
сеть вслепую.

## 4. Обязательные настройки `.env`

За основу всегда берите актуальный `.env.example`. Минимальный набор:

```dotenv
BOT_TOKEN=<TELEGRAM_BOT_TOKEN>
ADMIN_TELEGRAM_ID=<NUMERIC_TELEGRAM_ID>
CONTACT_URL=https://t.me/<CONTACT>

POSTGRES_DB=vpnbot
POSTGRES_USER=vpnbot
POSTGRES_PASSWORD=<LONG_RANDOM_PASSWORD>
DATABASE_URL=postgresql://vpnbot:<URL_ENCODED_PASSWORD>@postgres:5432/vpnbot

TIMEZONE=Europe/Moscow
REMINDER_HOUR=10

VK_GROUP_ID=<NUMERIC_COMMUNITY_ID>
VK_GROUP_TOKEN=<VK_COMMUNITY_TOKEN>

TELEGRAM_PROXY_URL=socks5h://172.30.0.1:1080
SSH_PROXY_URL=socks5h://172.30.0.1:1081
VPN_DIRECT_SSH_SERVER_KEYS=<MOSCOW_SERVER_KEY>
```

В `DATABASE_URL` специальные символы пароля percent-encode, но в
`POSTGRES_PASSWORD` оставляйте исходный пароль.

`VPN_DIRECT_SSH_SERVER_KEYS` содержит внутренние ключи серверов, а не
отображаемые названия. Для нескольких ключей используется строка через запятую,
например `srv_1,old`. Лишние пробелы удаляются. Если московский сервер забыть в
этом списке, его helper будет вызываться через `SSH_PROXY_URL`; в схеме, где
финский SOCKS не может вернуться на публичный адрес Москвы, выдача и скачивание
конфигов завершатся ошибкой. Это не отключает уже работающие VPN-соединения.

Полный набор `NEW_VPN_*`, `OLD_VPN_*`, relay и bootstrap-параметров находится в
`.env.example` и подробно разобран в `SERVER_INFRASTRUCTURE.md`.

## 5. Первый запуск

```bash
cd /opt/vpnbot/app
docker compose config -q
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=200 bot
docker compose exec -T bot npx prisma migrate status
```

Контейнер перед каждым стартом сам выполняет `prisma migrate deploy`. В
production запрещены `prisma migrate reset` и `prisma db push`.

В логах успешного запуска должны быть обе строки:

```text
VPN-бот запущен
VK-бот запущен для сообщества <VK_GROUP_ID>
```

PostgreSQL должен быть `healthy`, bot — `Up`, а `prisma migrate status` должен
сообщить, что схема актуальна. Если VK не настроен намеренно, второй строки не
будет.

## 6. Как устроена привязка Telegram ↔ VK

1. Пользователь открывает Telegram и нажимает «Связать VK».
2. Бот создаёт код формата `VK-XXXXXXXXXXXX` на 10 минут.
3. В Telegram код размечается сущностью `code`: клиент показывает его
   моноширно и позволяет быстро скопировать. У VK API нет эквивалентной
   сущности форматирования или системной кнопки копирования.
4. Пользователь отправляет код отдельным сообщением сообществу VK.
5. В транзакции VK identity переносится к Telegram-пользователю, а код
   помечается использованным.
6. С этого момента Telegram и VK видят один список конфигов и одинаковые сроки.

До успешной привязки любое обычное сообщение, payload сообщения и callback от
старой VK-клавиатуры возвращают только инструкцию получить код в Telegram.
Просмотр, скачивание, переименование и перевыпуск закрыты. Исключение — само
сообщение с корректным кодом. Неверный, истёкший или уже использованный код не
меняет данные.

Код хранится только как SHA-256-хеш. Если до привязки у VK identity уже были
данные старой версии приложения, связанные конфиги транзакционно переносятся к
Telegram-пользователю, а дублирующий пользователь удаляется безопасно.

VK не содержит админку и плановые напоминания. Эти функции намеренно остаются
только в Telegram.

## 7. Приёмочная проверка после первого запуска

Проверьте сценарии по порядку:

1. `/start` в Telegram открывает меню.
2. Непривязанный VK-пользователь отправляет произвольный текст и получает только
   инструкцию о коде.
3. Нажатие сохранённой старой VK-кнопки даёт ту же инструкцию.
4. «Связать VK» в Telegram выдаёт моноширный копируемый код.
5. Неверный код в VK не открывает меню и не меняет данные.
6. Корректный код открывает VK-меню.
7. Список, сроки и названия конфигов совпадают в обоих каналах.
8. Один активный `.ovpn` скачивается из Telegram и VK.
9. Переименование в VK сразу видно в Telegram.
10. Админ в Telegram выполняет безопасную тестовую выдачу и затем отзыв.
11. RU destination видит московский IP, зарубежный — IP exit.
12. После контролируемого отключения WireGuard интернет сохраняется и временно
    выходит через Москву; после восстановления возвращается policy route.

При переходах по VK-кнопкам главное меню, список и карточка должны редактировать
исходное сообщение. Новыми сообщениями приходят документы, ответы на введённый
текст и результаты длительных операций. При тесте массовой выдачи итог должен
совпасть с числом действующих конфигов; кратковременный сбой upload-сервера
повторяется автоматически до трёх раз.

Не используйте реальные пользовательские сертификаты для разрушительных
проверок. Создайте отдельного тестового пользователя/конфиг.

## 8. Проверки перед обновлением

Перед каждым production-обновлением:

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

Если есть новая миграция, сначала примените все миграции с нуля к отдельной
тестовой PostgreSQL из `compose.test.yaml` и прогоните полный набор тестов.

На сервере до замены кода сохраните:

- логический `pg_dump` и его SHA-256;
- текущий commit/маркер версии;
- текущие изменяемые исходники или весь каталог без `node_modules`;
- ID работающего Docker-образа и отдельный rollback-tag;
- `.env` и `secrets` в закрытом backup-каталоге, если обновление их затрагивает.

Не выводите `.env`, token или приватные ключи в CI/терминальные логи.

## 9. Обновление production

1. Сначала зафиксируйте и отправьте изменения в `main`.
2. Доставьте на сервер ровно этот commit через `git pull --ff-only` или архив с
   проверенной SHA-256-суммой.
3. Не редактируйте production как единственную копию кода.
4. Соберите новый образ до переключения работающего контейнера.
5. Выполните `docker compose config -q`.
6. Пересоздайте только bot, если PostgreSQL/compose не менялись.
7. Проверьте миграции, обе строки запуска, отсутствие restart loop и ошибки VK
   Long Poll.
8. Повторите короткую приёмку Telegram, VK и одного control SSH-вызова.

Обычный вариант после backup:

```bash
cd /opt/vpnbot/app
docker compose build bot
docker compose config -q
docker compose up -d --no-deps --force-recreate bot
docker compose ps
docker compose logs --tail=200 bot
docker compose exec -T bot npx prisma migrate status
```

Для изменений схемы не откатывайте только код на версию, несовместимую с уже
применённой миграцией. Сначала изучите SQL конкретной миграции и восстановление
из backup.

## 10. Быстрая диагностика

| Симптом | Что проверить |
| --- | --- |
| Telegram не отвечает | `TELEGRAM_PROXY_URL`, `vpn-telegram-tunnel`, логи bot |
| VK не отвечает | оба `VK_GROUP_*`, сообщения/Long Poll/события сообщества, ошибки `VK Long Poll` |
| VK всегда просит код после успешной привязки | `messenger_identities`, корректность общей БД и отсутствие восстановления старого дампа |
| Код не принимается | 10-минутный TTL, одноразовость, формат `VK-` и 12 hex-символов, время сервера |
| Не выдаётся конфиг на Москве | server key в `VPN_DIRECT_SSH_SERVER_KEYS`, fingerprint, helper и control key |
| Не выдаётся конфиг на удалённом VPS | `SSH_PROXY_URL`, `vpn-control-tunnel`, fingerprint и helper |
| VPN подключён, но неверный выход | nftables RU set, rule/table 210, WireGuard handshake и NAT на exit |
| После отказа exit пропал интернет | `vpnbot-route-health.timer`, удаление policy rule/table и московский NAT |

Полезные команды:

```bash
cd /opt/vpnbot/app
docker compose ps
docker compose logs --since=10m bot
docker compose exec -T bot npx prisma migrate status
systemctl status vpn-telegram-tunnel.service
systemctl status vpn-control-tunnel.service
systemctl status wg-quick@wg-vpnbot.service
systemctl status vpnbot-route-health.timer
ip -4 rule show
ip -4 route show table 210
```

## 11. Откат

Если новый bot не остаётся в `Up` или не проходит smoke-проверки:

1. сохраните его логи;
2. верните backup исходников и предыдущий Docker-образ;
3. пересоздайте только bot;
4. снова проверьте миграции и логи;
5. не трогайте PostgreSQL, PKI, OpenVPN или WireGuard без отдельной причины.

Если обновление успело применить миграцию, простой откат образа допустим только
при доказанной обратной совместимости схемы. Иначе восстановите согласованные
код и БД из backup в отдельной среде, проверьте и лишь затем меняйте production.

## 12. Секреты и передача проекта

Никогда не добавляйте в Git `.env`, VK/Telegram tokens, root-пароли, дампы БД,
приватные SSH/WireGuard-ключи, PKI и пользовательские `.ovpn`.

После передачи проекта или публикации секрета:

1. выпустите новый token в соответствующем сервисе;
2. измените только зависимую переменную/secret;
3. пересоздайте bot;
4. проверьте соответствующий канал;
5. отзовите старый token после успешной проверки нового.

Telegram token и VK token ротируются независимо. Ротация messenger token не
требует изменения PostgreSQL, VPN-сертификатов или WireGuard.

## 13. Что обновлять вместе с кодом

При изменении VK или привязки синхронно обновляйте:

- `src/vk-api.ts`, `src/vk-bot.ts`, `src/account-link.ts`;
- Telegram callback в `src/bot.ts`;
- Prisma schema и новую миграцию, если меняются данные;
- тесты account-link, database, VK API и VK bot;
- `.env.example`, этот runbook, `BOT_INTERNALS.md` и
  `SERVER_INFRASTRUCTURE.md`.

При изменении маршрутизации управляющего SSH отдельно проверьте сервер из
`VPN_DIRECT_SSH_SERVER_KEYS` и сервер, который должен идти через SOCKS. При
изменении dataplane обязательно проверьте все три режима: RU, foreign и
московский fallback.
