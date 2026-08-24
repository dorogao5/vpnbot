import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { MessageEntity } from "grammy/types";
import { DateTime } from "luxon";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { AppConfig } from "./config.js";
import { broadcastText } from "./broadcast-service.js";
import { ConfigService } from "./config-service.js";
import { AppDatabase } from "./database.js";
import type {
  LegacyClientRecord,
  ServerKey,
  UserRecord,
  VpnConfigRecord,
} from "./domain.js";
import type { VpnServerTarget } from "./openvpn.js";
import { ServerManager, type ServerWithTarget } from "./server-manager.js";
import { labeledVpnFileName, vpnFileName } from "./file-name.js";
import {
  TrafficService,
  type ConfigConnectionState,
  type ServerTrafficUsage,
} from "./traffic-service.js";
import {
  dateAfterDays,
  dateAfterMonths,
  dateAfterYears,
  expiryFromDate,
  formatDate,
  isExpired,
} from "./time.js";

type DateTarget =
  | { kind: "issue"; userId: number }
  | { kind: "bind"; userId: number; legacyId: number }
  | { kind: "change"; configId: string };

type PendingInput =
  | { kind: "search" }
  | { kind: "rename"; configId: string }
  | { kind: "date"; target: DateTarget }
  | { kind: "broadcast" }
  | { kind: "bypass-domain-add" }
  | { kind: "server-add" }
  | { kind: "server-rename"; serverKey: ServerKey };

const pendingInputs = new Map<string, PendingInput>();
const operationLocks = new Set<string>();
const CONFIG_PAGE_SIZE = 10;
const DOMAIN_PAGE_SIZE = 8;
const MASS_EXTENSION_PERIODS = {
  "7d": { label: "7 дней", duration: { days: 7 } },
  "1m": { label: "1 месяц", duration: { months: 1 } },
  "3m": { label: "3 месяца", duration: { months: 3 } },
  "6m": { label: "6 месяцев", duration: { months: 6 } },
  "1y": { label: "1 год", duration: { years: 1 } },
} as const;
type MassExtensionCode = keyof typeof MASS_EXTENSION_PERIODS;

export interface BotApplication {
  bot: Bot;
}

export function createBot(
  appConfig: AppConfig,
  db: AppDatabase,
  configService: ConfigService,
  trafficService: TrafficService,
  serverManager: ServerManager
): BotApplication {
  const bot = new Bot(
    appConfig.botToken,
    appConfig.telegramProxyUrl
      ? {
          client: {
            baseFetchConfig: {
              agent: new SocksProxyAgent(appConfig.telegramProxyUrl),
              compress: true,
            },
          },
        }
      : undefined
  );
  const broadcastDrafts = new Map<
    string,
    { text: string; entities?: MessageEntity[] }
  >();
  let broadcastRunning = false;
  const allFilesLocks = new Set<string>();

  serverManager.onBootstrapFinished = (text) => notifyAdmin(bot, appConfig, text);

  bot.catch((error) => {
    console.error("Необработанная ошибка Telegram-бота", error.error);
  });

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await db.upsertUser({
        telegramId: String(ctx.from.id),
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
        firstName: ctx.from.first_name || "Пользователь",
      });
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    pendingInputs.delete(String(ctx.from?.id ?? ""));
    await ctx.reply(
      "👋 Добро пожаловать! Здесь Вы можете получить свои VPN-конфиги и проверить срок их действия.",
      {
        reply_markup: mainKeyboard(
          isAdmin(ctx, appConfig),
          appConfig.contactUrl
        ),
      }
    );
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const telegramId = String(ctx.from.id);
    const pending = pendingInputs.get(telegramId);
    if (!pending) {
      await ctx.reply("Выберите действие с помощью кнопок ниже.", {
        reply_markup: mainKeyboard(
          isAdmin(ctx, appConfig),
          appConfig.contactUrl
        ),
      });
      return;
    }
    pendingInputs.delete(telegramId);

    if (pending.kind === "search") {
      if (!isAdmin(ctx, appConfig)) return;
      const users = await db.searchUsers(ctx.message.text);
      if (users.length === 0) {
        await ctx.reply(
          "Пользователь не найден. Он должен хотя бы один раз запустить бота.",
          {
            reply_markup: new InlineKeyboard()
              .text("🔎 Повторить поиск", "as")
              .row()
              .text("⬅️ Назад", "a"),
          }
        );
      } else {
        await ctx.reply("Найден пользователь:", {
          reply_markup: usersKeyboard(users),
        });
      }
      return;
    }

    if (pending.kind === "broadcast") {
      if (!isAdmin(ctx, appConfig)) return;
      const message = ctx.message.text;
      if (!message.trim()) {
        pendingInputs.set(telegramId, pending);
        await ctx.reply("Сообщение для рассылки не должно быть пустым.", {
          reply_markup: new InlineKeyboard().text("❌ Отмена", "bca"),
        });
        return;
      }
      broadcastDrafts.set(telegramId, {
        text: message,
        ...(ctx.message.entities ? { entities: ctx.message.entities } : {}),
      });
      const recipients = await db.listBroadcastRecipients(telegramId);
      await ctx.reply(
        `📣 Предпросмотр рассылки\n\nПолучателей: ${recipients.length}\nСледующее сообщение будет отправлено без изменений:`,
        {
          reply_markup: new InlineKeyboard().text("❌ Отменить", "bca"),
        }
      );
      await ctx.reply(message, {
        ...(ctx.message.entities ? { entities: ctx.message.entities } : {}),
        reply_markup: new InlineKeyboard()
          .text("✅ Отправить сообщение", "bcc")
          .row()
          .text("📦 Отправить с кнопкой файлов", "bccf")
          .row()
          .text("❌ Отменить", "bca"),
      });
      return;
    }

    if (pending.kind === "bypass-domain-add") {
      if (!isAdmin(ctx, appConfig)) return;
      const values = ctx.message.text.split(/[\s,]+/).filter(Boolean);
      try {
        const added = await db.addBypassDomains(values);
        await ctx.reply(
          added > 0
            ? `✅ Добавлено доменов: ${added}. Чтобы правило появилось в существующем конфиге, его нужно скачать заново.`
            : "Эти домены уже находятся в белом списке.",
          { reply_markup: new InlineKeyboard().text("🌐 К белому списку", "wd") }
        );
      } catch (error) {
        pendingInputs.set(telegramId, pending);
        await ctx.reply(error instanceof Error ? error.message : String(error), {
          reply_markup: new InlineKeyboard().text("❌ Отмена", "wd"),
        });
      }
      return;
    }

    if (pending.kind === "rename") {
      const config = await db.getConfig(pending.configId);
      const user = await db.getUserByTelegramId(telegramId);
      if (
        !config ||
        !user ||
        config.userId !== user.id ||
        config.status === "revoked"
      ) {
        await ctx.reply("Конфиг не найден.", {
          reply_markup: backToMainKeyboard(),
        });
        return;
      }
      const name = normalizeDisplayName(ctx.message.text);
      if (!name) {
        await ctx.reply("Название должно содержать от 1 до 40 символов.", {
          reply_markup: new InlineKeyboard()
            .text("Попробовать снова", `rn|${config.id}`)
            .row()
            .text("Назад", `uc|${config.id}`),
        });
        return;
      }
      await db.updateDisplayName(config.id, name);
      await ctx.reply(`✅ Название изменено на «${name}».`, {
        reply_markup: new InlineKeyboard()
          .text("🔎 Открыть конфиг", `uc|${config.id}`)
          .row()
          .text("🏠 Главное меню", "m"),
      });
      return;
    }

    if (pending.kind === "server-add") {
      if (!isAdmin(ctx, appConfig)) return;
      const parts = ctx.message.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const [host = "", portText = "22", password = "", name = ""] = parts;
      const port = Number(portText);
      try {
        const server = await serverManager.addServer({
          host,
          port,
          rootPassword: password,
          name,
        });
        await ctx.reply(
          `⏳ Началась настройка сервера «${server.name}» (${server.host}). Это займёт несколько минут — по окончании пришлю уведомление.`,
          {
            reply_markup: new InlineKeyboard()
              .text("🖥 К серверам", "sv")
              .row()
              .text("🛠 Админ-панель", "a"),
          }
        );
      } catch (error) {
        pendingInputs.set(telegramId, pending);
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(
          `Не удалось запустить настройку: ${message}\n\nПопробуйте ещё раз. Формат:\nIP\nSSH-порт (по умолчанию 22)\nпароль root\nназвание сервера`,
          {
            reply_markup: new InlineKeyboard().text("❌ Отмена", "sv"),
          }
        );
      }
      return;
    }

    if (pending.kind === "server-rename") {
      if (!isAdmin(ctx, appConfig)) return;
      const server = await serverManager.getServer(pending.serverKey);
      const name = normalizeDisplayName(ctx.message.text);
      if (!server) {
        await ctx.reply("Сервер не найден.", {
          reply_markup: new InlineKeyboard().text("🖥 К серверам", "sv"),
        });
        return;
      }
      if (!name) {
        await ctx.reply("Название должно содержать от 1 до 40 символов.", {
          reply_markup: new InlineKeyboard()
            .text("Попробовать снова", `svrn|${server.record.key}`)
            .row()
            .text("Назад", `svo|${server.record.key}`),
        });
        return;
      }
      if (server.record.isBuiltin) {
        await db.updateServer(server.record.key, { name });
      } else {
        await db.updateServer(server.record.key, { name });
      }
      serverManager.invalidateCache();
      await ctx.reply(`✅ Сервер переименован в «${name}».`, {
        reply_markup: new InlineKeyboard()
          .text("🖥 К серверу", `svo|${server.record.key}`)
          .row()
          .text("🛠 Админ-панель", "a"),
      });
      return;
    }

    if (!isAdmin(ctx, appConfig)) return;
    if (pending.kind !== "date") return;
    const expiresAt = parseFutureDate(ctx.message.text, appConfig.timezone);
    if (!expiresAt) {
      pendingInputs.set(telegramId, pending);
      await ctx.reply(
        "Укажите дату в формате ГГГГ-ММ-ДД. Дата не должна быть раньше сегодняшнего дня.",
        {
          reply_markup: new InlineKeyboard().text("Отмена", "a"),
        }
      );
      return;
    }
    await applyDateTarget(
      ctx,
      pending.target,
      expiresAt,
      appConfig,
      db,
      configService,
      serverManager
    );
  });

  bot.callbackQuery("m", async (ctx) => {
    pendingInputs.delete(String(ctx.from.id));
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "🏠 Личный кабинет",
      mainKeyboard(isAdmin(ctx, appConfig), appConfig.contactUrl)
    );
  });

  bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "📖 Как установить VPN\n\nСначала установите официальное приложение OpenVPN Connect. Затем получите файл в разделе «Мои конфиги» и импортируйте его в приложение.\n\nВыберите Ваше устройство:",
      new InlineKeyboard()
        .text("🍎 iPhone / iPad", "help_ios")
        .row()
        .text("🤖 Android", "help_android")
        .row()
        .text("💻 Компьютер", "help_pc")
        .row()
        .url("💬 Нужна помощь", appConfig.contactUrl)
        .row()
        .text("⬅️ Главное меню", "m")
    );
  });

  bot.callbackQuery("help_ios", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "🍎 Установка на iPhone / iPad\n\n1️⃣ Установите OpenVPN Connect из App Store.\n\n2️⃣ В боте откройте «Мои конфиги», выберите нужный конфиг и нажмите «Получить файл».\n\n3️⃣ Нажмите на присланный файл .ovpn. Когда он откроется, нажмите «Поделиться» и выберите OpenVPN.\n\n4️⃣ Подтвердите добавление профиля и нажмите Connect. Если iPhone запросит разрешение на добавление VPN-конфигурации — разрешите.",
      new InlineKeyboard()
        .url(
          "📲 Установить OpenVPN Connect",
          "https://apps.apple.com/app/openvpn-connect/id590379981"
        )
        .row()
        .url("💬 Возникли трудности", appConfig.contactUrl)
        .row()
        .text("⬅️ Выбрать устройство", "help")
    );
  });

  bot.callbackQuery("help_android", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "🤖 Установка на Android\n\n1️⃣ Установите OpenVPN Connect из Google Play.\n\n2️⃣ В боте откройте «Мои конфиги», выберите нужный конфиг, нажмите «Получить файл» и скачайте файл .ovpn.\n\n3️⃣ Откройте OpenVPN Connect, нажмите Upload File и выберите скачанный файл. Обычно он находится в папке «Загрузки» или Downloads.\n\n4️⃣ Подтвердите импорт профиля и нажмите Connect.",
      new InlineKeyboard()
        .url(
          "📲 Установить OpenVPN Connect",
          "https://play.google.com/store/apps/details?id=net.openvpn.openvpn"
        )
        .row()
        .url("💬 Возникли трудности", appConfig.contactUrl)
        .row()
        .text("⬅️ Выбрать устройство", "help")
    );
  });

  bot.callbackQuery("help_pc", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "💻 Установка на компьютер\n\n1️⃣ Скачайте и установите OpenVPN Connect для Вашей операционной системы.\n\n2️⃣ В боте откройте «Мои конфиги», выберите нужный конфиг, нажмите «Получить файл» и сохраните файл .ovpn.\n\n3️⃣ Перетащите файл .ovpn в окно OpenVPN Connect. Также можно выбрать Upload File или Import Profile → File.\n\n4️⃣ Добавьте профиль и нажмите Connect.",
      new InlineKeyboard()
        .url(
          "🪟 Скачать для Windows",
          "https://openvpn.net/client-connect-vpn-for-windows/"
        )
        .row()
        .url(
          "🍎 Скачать для macOS",
          "https://openvpn.net/connect-docs/connect-for-macos.html"
        )
        .row()
        .url("💬 Возникли трудности", appConfig.contactUrl)
        .row()
        .text("⬅️ Выбрать устройство", "help")
    );
  });

  bot.callbackQuery("ul", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = (await db.getUserByTelegramId(String(ctx.from.id)))!;
    const configs = await db.listVisibleConfigs(user.id);
    await showUserConfigs(ctx, configs, 0, trafficService, serverManager);
  });

  bot.callbackQuery(/^ulp\|(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = (await db.getUserByTelegramId(String(ctx.from.id)))!;
    const configs = await db.listVisibleConfigs(user.id);
    await showUserConfigs(ctx, configs, Number(ctx.match[1]), trafficService, serverManager);
  });

  bot.callbackQuery(/^uc\|(.+)$/, async (ctx) => {
    const config = await ownedConfig(ctx, db, ctx.match[1]!);
    if (!config) return showAlert(ctx, "Конфиг не найден.");
    await ctx.answerCallbackQuery();
    await showUserConfig(ctx, config, appConfig, trafficService, serverManager);
  });

  bot.callbackQuery(/^rn\|(.+)$/, async (ctx) => {
    const config = await ownedConfig(ctx, db, ctx.match[1]!);
    if (!config) return showAlert(ctx, "Конфиг не найден.");
    pendingInputs.set(String(ctx.from.id), {
      kind: "rename",
      configId: config.id,
    });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `✏️ Отправьте новое название для «${config.displayName}». Не более 40 символов.`,
      new InlineKeyboard().text("❌ Отмена", `uc|${config.id}`)
    );
  });

  bot.callbackQuery("dla", async (ctx) => {
    const telegramId = String(ctx.from.id);
    if (allFilesLocks.has(telegramId)) {
      return showAlert(ctx, "Файлы уже подготавливаются.");
    }
    const user = await db.getUserByTelegramId(telegramId);
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    const configs = (await db.listVisibleConfigs(user.id)).filter(
      (config) => config.status === "active" && !isExpired(config.expiresAt)
    );
    if (configs.length === 0) {
      return showAlert(ctx, "У Вас нет действующих конфигов.");
    }

    allFilesLocks.add(telegramId);
    await ctx.answerCallbackQuery({ text: "Подготавливаю файлы…" });
    await ctx.reply(
      `⏳ Подготавливаю Ваши действующие конфиги: ${configs.length}. Файлы придут отдельными сообщениями.`
    );
    let delivered = 0;
    let failed = 0;
    try {
      for (const config of configs) {
        try {
          const file = await configService.download(config);
          await ctx.replyWithDocument(
            new InputFile(
              file,
              labeledVpnFileName(config.displayName, config.clientName)
            ),
            {
              caption: `🔐 ${config.displayName}\n📅 Действует до ${formatDate(config.expiresAt, appConfig.timezone)}`,
            }
          );
          delivered += 1;
        } catch (error) {
          failed += 1;
          logError(error);
        }
      }
      await ctx.reply(
        failed === 0
          ? `✅ Все файлы отправлены: ${delivered}. Удалите старые профили из OpenVPN Connect и импортируйте полученные заново.`
          : `⚠️ Отправлено файлов: ${delivered}. Не удалось подготовить: ${failed}. Если нужного файла нет, обратитесь к администратору.`,
        {
          reply_markup: mainKeyboard(
            isAdmin(ctx, appConfig),
            appConfig.contactUrl
          ),
        }
      );
    } finally {
      allFilesLocks.delete(telegramId);
    }
  });

  bot.callbackQuery(/^dl\|(.+)$/, async (ctx) => {
    const config = await ownedConfig(ctx, db, ctx.match[1]!);
    if (!config) return showAlert(ctx, "Конфиг не найден.");
    if (isExpired(config.expiresAt) || config.status !== "active")
      return showAlert(ctx, "Срок действия конфига истёк.");

    await ctx.answerCallbackQuery({ text: "Подготавливаю файл…" });
    try {
      const file = await configService.download(config);
      await ctx.replyWithDocument(
        new InputFile(file, vpnFileName(config.clientName)),
        {
          caption: `🔐 Конфиг «${config.displayName}». Действует до ${formatDate(config.expiresAt, appConfig.timezone)}.`,
        }
      );
    } catch (error) {
      logError(error);
      await ctx.reply(
        "Не удалось получить файл. Попробуйте позднее или свяжитесь с администратором.",
        {
          reply_markup: new InlineKeyboard()
            .url("Связаться с администратором", appConfig.contactUrl)
            .row()
            .text("Назад", `uc|${config.id}`),
        }
      );
    }
  });

  bot.callbackQuery(/^rr\|(.+)$/, async (ctx) => {
    const config = await ownedConfig(ctx, db, ctx.match[1]!);
    if (!config) return showAlert(ctx, "Конфиг не найден.");
    if (isExpired(config.expiresAt) || config.status !== "active")
      return showAlert(ctx, "Просроченный конфиг нельзя перевыпустить.");
    const servers = (await serverManager.listServers()).filter(
      (server) => server.record.status === "ready"
    );
    if (servers.filter((server) => server.record.key !== config.serverKey).length === 0)
      return showAlert(ctx, "Нет других серверов для перевыпуска.");
    await ctx.answerCallbackQuery();
    const currentName = await serverManager.serverName(config.serverKey);
    const keyboard = new InlineKeyboard();
    for (const server of servers) {
      const here = server.record.key === config.serverKey;
      keyboard
        .text(
          `${here ? "· " : ""}${server.record.name}${here ? " (сейчас)" : ""}`,
          `rrs|${config.id}|${server.record.key}`
        )
        .row();
    }
    keyboard.text("❌ Отмена", `uc|${config.id}`);
    await edit(
      ctx,
      `🔄 Перевыпуск «${config.displayName}»\n\nСейчас конфиг на сервере «${currentName}». Выберите сервер для нового файла — старый файл останется доступен ещё примерно 5 минут, чтобы Вы успели переключиться. Название и срок действия сохранятся.`,
      keyboard
    );
  });

  bot.callbackQuery(/^rrs\|([^|]+)\|(.+)$/, async (ctx) => {
    const config = await ownedConfig(ctx, db, ctx.match[1]!);
    if (!config) return showAlert(ctx, "Конфиг не найден.");
    if (isExpired(config.expiresAt) || config.status !== "active")
      return showAlert(ctx, "Просроченный конфиг нельзя перевыпустить.");
    const server = await serverManager.getServer(ctx.match[2]!);
    if (!server || server.record.status !== "ready")
      return showAlert(ctx, "Сервер недоступен.");
    if (server.record.key === config.serverKey)
      return showAlert(ctx, "Конфиг уже находится на этом сервере.");
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `🔄 Перевыпустить файл «${config.displayName}» на сервере «${server.record.name}»?\n\nСтарый файл останется доступен ещё примерно 5 минут, чтобы Вы успели переключиться, а затем перестанет подключаться. Название и срок действия сохранятся.`,
      new InlineKeyboard()
        .text("✅ Перевыпустить", `rrc|${config.id}|${server.record.key}`)
        .row()
        .text("❌ Отмена", `rr|${config.id}`)
    );
  });

  bot.callbackQuery(/^rrc\|([^|]+)\|(.+)$/, async (ctx) => {
    const config = await ownedConfig(ctx, db, ctx.match[1]!);
    if (!config) return showAlert(ctx, "Конфиг не найден.");
    if (isExpired(config.expiresAt) || config.status !== "active")
      return showAlert(ctx, "Просроченный конфиг нельзя перевыпустить.");
    const server = await serverManager.getServer(ctx.match[2]!);
    if (!server || server.record.status !== "ready")
      return showAlert(ctx, "Сервер недоступен.");
    if (operationLocks.has(config.id))
      return showAlert(ctx, "Перевыпуск уже выполняется.");

    operationLocks.add(config.id);
    await ctx.answerCallbackQuery({ text: "Перевыпускаю файл…" });
    try {
      const recreated = await configService.recreate(config, server.record.key);
      try {
        await edit(
          ctx,
          `✅ Файл «${recreated.config.displayName}» перевыпущен на сервере «${server.record.name}». Старый конфиг отключится примерно через 5 минут.`,
          new InlineKeyboard()
            .text("🔎 Открыть конфиг", `uc|${recreated.config.id}`)
            .row()
            .text("🏠 Главное меню", "m")
        );
        await ctx.replyWithDocument(
          new InputFile(
            recreated.file,
            vpnFileName(recreated.config.clientName)
          ),
          {
            caption: `🔐 Новый файл для «${recreated.config.displayName}» (сервер «${server.record.name}»). Действует до ${formatDate(recreated.config.expiresAt, appConfig.timezone)}. Переключитесь на него: старый конфиг отключится примерно через 5 минут.`,
          }
        );
      } catch (deliveryError) {
        logError(deliveryError);
        await ctx
          .reply(
            "Файл перевыпущен, но отправить его не удалось. Откройте конфиг и нажмите «Получить файл».",
            {
              reply_markup: new InlineKeyboard().text(
                "🔎 Открыть конфиг",
                `uc|${recreated.config.id}`
              ),
            }
          )
          .catch(logError);
      }
    } catch (error) {
      logError(error);
      await ctx.reply(
        "Перевыпуск не выполнен. Текущий конфиг оставлен без изменений. Попробуйте позднее или свяжитесь с администратором.",
        {
          reply_markup: new InlineKeyboard()
            .url("Связаться с администратором", appConfig.contactUrl)
            .row()
            .text("Назад", `uc|${config.id}`),
        }
      );
    } finally {
      operationLocks.delete(config.id);
    }
  });

  bot.callbackQuery("a", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    pendingInputs.delete(String(ctx.from.id));
    await ctx.answerCallbackQuery();
    await showAdminMain(ctx, db);
  });

  bot.callbackQuery("at", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    await ctx.answerCallbackQuery({ text: "Обновляю статистику…" });
    await showTrafficStats(ctx, trafficService, serverManager);
  });

  bot.callbackQuery("wd", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    pendingInputs.delete(String(ctx.from.id));
    await ctx.answerCallbackQuery();
    await showBypassDomains(ctx, db, 0);
  });

  bot.callbackQuery(/^wdp\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    await ctx.answerCallbackQuery();
    await showBypassDomains(ctx, db, Number(ctx.match[1]));
  });

  bot.callbackQuery("wda", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    pendingInputs.set(String(ctx.from.id), { kind: "bypass-domain-add" });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "➕ Отправьте домены одним сообщением — по одному в строке либо через пробел/запятую.\n\nУказывайте точные имена без https:// и пути. Для example.com и www.example.com нужны две отдельные записи.",
      new InlineKeyboard().text("❌ Отмена", "wd")
    );
  });

  bot.callbackQuery(/^wdr\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const id = Number(ctx.match[1]);
    const entry = (await db.listBypassDomains()).find((item) => item.id === id);
    if (!entry) return showAlert(ctx, "Домен уже удалён.");
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `Удалить ${entry.domain} из белого списка?`,
      new InlineKeyboard()
        .text("🗑 Удалить", `wdc|${entry.id}`)
        .row()
        .text("❌ Отмена", "wd")
    );
  });

  bot.callbackQuery(/^wdc\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const deleted = await db.deleteBypassDomain(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({
      text: deleted ? "Домен удалён." : "Домен уже был удалён.",
    });
    await showBypassDomains(ctx, db, 0);
  });

  bot.callbackQuery("ax", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const count = await db.countExtendableConfigs();
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `⏳ Массовое продление\n\nБудут продлены ${count} действующих конфигов. Просроченные и отозванные конфиги не изменятся.\n\nСрок прибавляется к текущей дате окончания каждого конфига.`,
      new InlineKeyboard()
        .text("+7 дней", "axp|7d")
        .text("+1 месяц", "axp|1m")
        .row()
        .text("+3 месяца", "axp|3m")
        .text("+6 месяцев", "axp|6m")
        .row()
        .text("+1 год", "axp|1y")
        .row()
        .text("❌ Отмена", "a")
    );
  });

  bot.callbackQuery(/^axp\|(7d|1m|3m|6m|1y)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const code = ctx.match[1] as MassExtensionCode;
    const period = MASS_EXTENSION_PERIODS[code];
    const count = await db.countExtendableConfigs();
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `Подтвердите массовое продление.\n\nКонфигов: ${count}\nДобавить каждому: ${period.label}\n\nОтменить это действие автоматически будет нельзя.`,
      new InlineKeyboard()
        .text(`✅ Добавить ${period.label}`, `axc|${code}`)
        .row()
        .text("❌ Отмена", "ax")
    );
  });

  bot.callbackQuery(/^axc\|(7d|1m|3m|6m|1y)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const lockKey = "mass-extension";
    if (operationLocks.has(lockKey))
      return showAlert(ctx, "Массовое продление уже выполняется.");
    const code = ctx.match[1] as MassExtensionCode;
    const period = MASS_EXTENSION_PERIODS[code];
    operationLocks.add(lockKey);
    await ctx.answerCallbackQuery({ text: "Продлеваю конфиги…" });
    try {
      const count = await db.extendAllActiveConfigs(period.duration);
      await edit(
        ctx,
        `✅ Массовое продление завершено.\n\nПродлено конфигов: ${count}\nДобавлено каждому: ${period.label}.`,
        new InlineKeyboard().text("🛠 Админ-панель", "a")
      );
    } catch (error) {
      logError(error);
      await ctx.reply("Не удалось выполнить массовое продление.", {
        reply_markup: new InlineKeyboard()
          .text("Попробовать снова", "ax")
          .row()
          .text("🛠 Админ-панель", "a"),
      });
    } finally {
      operationLocks.delete(lockKey);
    }
  });

  bot.callbackQuery("sv", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    pendingInputs.delete(String(ctx.from.id));
    await ctx.answerCallbackQuery();
    await showServersList(ctx, serverManager);
  });

  bot.callbackQuery(/^svo\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    await ctx.answerCallbackQuery();
    await showServerCard(ctx, serverManager, db, trafficService, ctx.match[1]!);
  });

  bot.callbackQuery(/^svt\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const server = await serverManager.getServer(ctx.match[1]!);
    if (!server) return showAlert(ctx, "Сервер не найден.");
    const enabled = !server.record.enabled;
    await db.updateServer(server.record.key, { enabled });
    await ctx.answerCallbackQuery({
      text: enabled
        ? "Сервер снова доступен для новых конфигов."
        : "Новые конфиги на этом сервере создаваться не будут.",
    });
    await showServerCard(ctx, serverManager, db, trafficService, server.record.key);
  });

  bot.callbackQuery(/^svrn\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const server = await serverManager.getServer(ctx.match[1]!);
    if (!server) return showAlert(ctx, "Сервер не найден.");
    pendingInputs.set(String(ctx.from.id), {
      kind: "server-rename",
      serverKey: server.record.key,
    });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `✏️ Отправьте новое название для сервера «${server.record.name}». Не более 40 символов. Его увидят пользователи в своих конфигах.`,
      new InlineKeyboard().text("❌ Отмена", `svo|${server.record.key}`)
    );
  });

  bot.callbackQuery(/^svd\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const server = await serverManager.getServer(ctx.match[1]!);
    if (!server) return showAlert(ctx, "Сервер не найден.");
    const impact = await db.serverDeletionImpact(server.record.key);
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      [
        `🗑 Удалить сервер «${server.record.name}» из бота?`,
        "",
        `Связанных конфигов в базе: ${impact.configs}`,
        `Импортированных клиентов: ${impact.legacyClients}`,
        `Ожидающих отзывов: ${impact.pendingRevocations}`,
        "",
        "Сами пользовательские конфиги и история трафика сохранятся, но операции с ними через этот сервер станут недоступны. На VPS ничего удаляться не будет.",
      ].join("\n"),
      new InlineKeyboard()
        .text("🗑 Да, удалить из бота", `svdc|${server.record.key}`)
        .row()
        .text("❌ Отмена", `svo|${server.record.key}`)
    );
  });

  bot.callbackQuery(/^svdc\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const server = await serverManager.getServer(ctx.match[1]!);
    if (!server) return showAlert(ctx, "Сервер уже удалён.");
    const lockKey = `server-delete:${server.record.key}`;
    if (operationLocks.has(lockKey))
      return showAlert(ctx, "Удаление уже выполняется.");
    operationLocks.add(lockKey);
    await ctx.answerCallbackQuery({ text: "Удаляю сервер…" });
    try {
      const impact = await serverManager.deleteServer(server.record.key);
      await edit(
        ctx,
        `✅ Сервер «${server.record.name}» удалён из бота.\n\nСохранено пользовательских конфигов: ${impact.configs}.`,
        new InlineKeyboard()
          .text("🖥 К серверам", "sv")
          .row()
          .text("🛠 Админ-панель", "a")
      );
    } catch (error) {
      logError(error);
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Не удалось удалить сервер: ${message}`, {
        reply_markup: new InlineKeyboard().text(
          "Назад",
          `svo|${server.record.key}`
        ),
      });
    } finally {
      operationLocks.delete(lockKey);
    }
  });

  bot.callbackQuery("svadd", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    pendingInputs.set(String(ctx.from.id), { kind: "server-add" });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "➕ Добавление сервера\n\nОтправьте одним сообщением четыре строки:\n1️⃣ IP или домен\n2️⃣ SSH-порт (обычно 22)\n3️⃣ Пароль root\n4️⃣ Название для пользователей\n\nБот подключится по SSH, установит OpenVPN и настроит сервер автоматически. Пароль используется один раз и нигде не сохраняется.",
      new InlineKeyboard().text("❌ Отмена", "sv")
    );
  });

  bot.callbackQuery("as", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    pendingInputs.set(String(ctx.from.id), { kind: "search" });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "🔎 Отправьте username пользователя или его числовой Telegram ID.",
      new InlineKeyboard().text("❌ Отмена", "a")
    );
  });

  bot.callbackQuery("bc", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    if (broadcastRunning)
      return showAlert(ctx, "Предыдущая рассылка ещё выполняется.");
    const telegramId = String(ctx.from.id);
    broadcastDrafts.delete(telegramId);
    pendingInputs.set(telegramId, { kind: "broadcast" });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "📣 Отправьте текст сообщения для рассылки. После этого бот покажет предпросмотр и попросит подтверждение.",
      new InlineKeyboard().text("❌ Отмена", "bca")
    );
  });

  bot.callbackQuery("bca", async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const telegramId = String(ctx.from.id);
    pendingInputs.delete(telegramId);
    broadcastDrafts.delete(telegramId);
    await ctx.answerCallbackQuery({ text: "Рассылка отменена." });
    await showAdminMain(ctx, db);
  });

  bot.callbackQuery(/^bcc(f)?$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    if (broadcastRunning)
      return showAlert(ctx, "Предыдущая рассылка ещё выполняется.");
    const telegramId = String(ctx.from.id);
    const draft = broadcastDrafts.get(telegramId);
    if (!draft) return showAlert(ctx, "Черновик рассылки не найден.");
    const includeFilesButton = ctx.match[1] === "f";

    broadcastRunning = true;
    broadcastDrafts.delete(telegramId);
    pendingInputs.delete(telegramId);
    await ctx.answerCallbackQuery({ text: "Рассылка запущена." });
    await edit(
      ctx,
      "⏳ Рассылка выполняется. Ошибки отдельных пользователей не остановят отправку. По завершении Вы получите отчёт.",
      new InlineKeyboard().text("🛠 Админ-панель", "a")
    );

    void (async () => {
      try {
        const recipients = await db.listBroadcastRecipients(telegramId);
        const report = await broadcastText(
          recipients,
          draft.text,
          async (recipientId, text) => {
            await bot.api.sendMessage(recipientId, text, {
              ...(draft.entities ? { entities: draft.entities } : {}),
              ...(includeFilesButton
                ? {
                    reply_markup: new InlineKeyboard().text(
                      "📦 Получить все новые файлы",
                      "dla"
                    ),
                  }
                : {}),
            });
          }
        );
        await bot.api.sendMessage(
          telegramId,
          [
            "✅ Рассылка завершена",
            "",
            `👥 Получателей: ${report.total}`,
            `✅ Доставлено: ${report.delivered}`,
            `🚫 Бот заблокирован или чат недоступен: ${report.unavailable}`,
            `⚠️ Другие ошибки: ${report.failed}`,
          ].join("\n"),
          { reply_markup: new InlineKeyboard().text("🛠 Админ-панель", "a") }
        );
      } catch (error) {
        logError(error);
        await bot.api
          .sendMessage(
            telegramId,
            "❌ Не удалось выполнить рассылку из-за общей ошибки. Попробуйте ещё раз.",
            { reply_markup: new InlineKeyboard().text("🛠 Админ-панель", "a") }
          )
          .catch(logError);
      } finally {
        broadcastRunning = false;
      }
    })();
  });

  bot.callbackQuery(/^au\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const user = await db.getUserById(Number(ctx.match[1]));
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    await ctx.answerCallbackQuery();
    await showAdminUser(ctx, user, db, trafficService, 0);
  });

  bot.callbackQuery(/^aup\|(\d+)\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const user = await db.getUserById(Number(ctx.match[1]));
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    await ctx.answerCallbackQuery();
    await showAdminUser(
      ctx,
      user,
      db,
      trafficService,
      Number(ctx.match[2])
    );
  });

  bot.callbackQuery(/^ac\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг не найден.");
    await ctx.answerCallbackQuery();
    await showAdminConfig(ctx, config, db, appConfig, trafficService, serverManager);
  });

  bot.callbackQuery(/^adl\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг не найден.");
    await ctx.answerCallbackQuery({ text: "Подготавливаю файл…" });
    try {
      const file = await configService.downloadExisting(config);
      await ctx.replyWithDocument(
        new InputFile(file, vpnFileName(config.clientName)),
        {
          caption: `🔐 Текущий файл конфига «${config.displayName}». Файл не перевыпускался.`,
          reply_markup: new InlineKeyboard().text(
            "🔎 Вернуться к конфигу",
            `ac|${config.id}`
          ),
        }
      );
    } catch (error) {
      logError(error);
      await ctx.reply(
        "Не удалось получить текущий файл. Возможно, клиент уже отозван на VPN-сервере.",
        {
          reply_markup: new InlineKeyboard().text("Назад", `ac|${config.id}`),
        }
      );
    }
  });

  bot.callbackQuery(/^am\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг не найден.");
    if (isExpired(config.expiresAt) || config.status !== "active")
      return showAlert(ctx, "Сначала продлите срок действия конфига.");
    const targets = (await serverManager.listServers()).filter(
      (server) =>
        server.record.status === "ready" &&
        server.record.key !== config.serverKey
    );
    if (targets.length === 0)
      return showAlert(ctx, "Нет других готовых серверов для переноса.");
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    for (const server of targets) {
      keyboard
        .text(server.record.name, `amc|${config.id}|${server.record.key}`)
        .row();
    }
    keyboard.text("❌ Отмена", `ac|${config.id}`);
    await edit(
      ctx,
      `🔄 Перенести «${config.displayName}» на другой сервер?\n\nБудет создан новый OpenVPN-клиент. Текущий файл сразу перестанет подключаться, а пользователю будет отправлен новый файл. Название и срок действия сохранятся.\n\nВыберите сервер:`,
      keyboard
    );
  });

  bot.callbackQuery(/^amc\|([^|]+)\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    const targetServer = await serverManager.getServer(ctx.match[2]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг не найден.");
    if (isExpired(config.expiresAt) || config.status !== "active")
      return showAlert(ctx, "Сначала продлите срок действия конфига.");
    if (!targetServer || targetServer.record.status !== "ready")
      return showAlert(ctx, "Сервер недоступен.");
    if (config.serverKey === targetServer.record.key)
      return showAlert(ctx, "Конфиг уже находится на выбранном сервере.");
    if (operationLocks.has(config.id))
      return showAlert(ctx, "Операция уже выполняется.");

    operationLocks.add(config.id);
    await ctx.answerCallbackQuery({ text: "Переношу конфиг…" });
    try {
      const moved = await configService.moveToServer(config, targetServer.record.key);
      const targetName = targetServer.record.name;
      const user = await db.getUserById(config.userId);

      if (user) {
        await bot.api
          .sendDocument(
            user.telegramId,
            new InputFile(moved.file, vpnFileName(moved.config.clientName)),
            {
              caption: `🔄 Конфиг «${moved.config.displayName}» перенесён администратором на сервер «${targetName}». Старый файл больше не подключится. Используйте этот новый файл. Срок действия: до ${formatDate(moved.config.expiresAt, appConfig.timezone)}.`,
              reply_markup: new InlineKeyboard().text(
                "🔎 Открыть конфиг",
                `uc|${moved.config.id}`
              ),
            }
          )
          .catch(logError);
      }

      await edit(
        ctx,
        `✅ Конфиг «${moved.config.displayName}» перенесён на сервер «${targetName}». Старый файл больше не используется.`,
        new InlineKeyboard()
          .text("📥 Получить новый файл", `adl|${moved.config.id}`)
          .row()
          .text("🔎 Открыть конфиг", `ac|${moved.config.id}`)
      );
    } catch (error) {
      logError(error);
      await ctx.reply("Не удалось перенести конфиг. Исходный конфиг сохранён.", {
        reply_markup: new InlineKeyboard()
          .text("Повторить", `am|${config.id}`)
          .row()
          .text("Назад", `ac|${config.id}`),
      });
    } finally {
      operationLocks.delete(config.id);
    }
  });

  bot.callbackQuery(/^ai\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const user = await db.getUserById(Number(ctx.match[1]));
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    await ctx.answerCallbackQuery();
    await showDateMenu(
      ctx,
      { kind: "issue", userId: user.id },
      user.id,
      appConfig.timezone
    );
  });

  bot.callbackQuery(/^ae\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг не найден.");
    await ctx.answerCallbackQuery();
    await showDateMenu(
      ctx,
      { kind: "change", configId: config.id },
      config.userId,
      appConfig.timezone
    );
  });

  bot.callbackQuery(/^dt\|([ibe])\|([^|]+)\|(30|60|90|6m|1y)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const target = decodeDateTarget(ctx.match[1]!, ctx.match[2]!);
    if (!target) return showAlert(ctx, "Действие устарело.");
    const period = ctx.match[3]!;
    const date = period === "6m"
      ? dateAfterMonths(6, appConfig.timezone)
      : period === "1y"
        ? dateAfterYears(1, appConfig.timezone)
        : dateAfterDays(Number(period), appConfig.timezone);
    const expiresAt = expiryFromDate(date, appConfig.timezone)!;
    await ctx.answerCallbackQuery({ text: "Выполняю…" });
    await applyDateTarget(ctx, target, expiresAt, appConfig, db, configService, serverManager);
  });

  bot.callbackQuery(/^dc\|([ibe])\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const target = decodeDateTarget(ctx.match[1]!, ctx.match[2]!);
    if (!target) return showAlert(ctx, "Действие устарело.");
    pendingInputs.set(String(ctx.from.id), { kind: "date", target });
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "📅 Отправьте дату окончания в формате ГГГГ-ММ-ДД, например 2026-12-31.",
      new InlineKeyboard().text("❌ Отмена", "a")
    );
  });

  bot.callbackQuery(/^ab\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const user = await db.getUserById(Number(ctx.match[1]));
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    const servers = (await serverManager.listServers()).filter(
      (server) => server.record.status === "ready"
    );
    if (servers.length === 0)
      return showAlert(ctx, "Нет подключённых серверов.");
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    for (const server of servers) {
      keyboard
        .text(server.record.name, `abs|${user.id}|${server.record.key}`)
        .row();
    }
    keyboard.text("⬅️ Назад", `au|${user.id}`);
    await edit(
      ctx,
      "🔗 Привязка существующего OpenVPN-клиента. Выберите сервер:",
      keyboard
    );
  });

  bot.callbackQuery(/^abs\|(\d+)\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const user = await db.getUserById(Number(ctx.match[1]));
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    const server = await serverManager.getServer(ctx.match[2]!);
    if (!server || server.record.status !== "ready")
      return showAlert(ctx, "Сервер недоступен.");
    await ctx.answerCallbackQuery({ text: "Обновляю список…" });
    try {
      const names = await serverListClients(serverManager, server.target);
      await db.syncLegacyClients(server.record.key, names);
      const clients = await db.listUnassignedLegacyClients(server.record.key);
      await showLegacyClients(ctx, user.id, clients, 0, server.record.key);
    } catch (error) {
      logError(error);
      await ctx.reply(
        `Не удалось прочитать список клиентов сервера «${server.record.name}».`,
        {
          reply_markup: new InlineKeyboard().text("Назад", `au|${user.id}`),
        }
      );
    }
  });

  bot.callbackQuery(/^abp\|(\d+)\|(\d+)\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const userId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const serverKey = ctx.match[3]!;
    const user = await db.getUserById(userId);
    if (!user) return showAlert(ctx, "Пользователь не найден.");
    await ctx.answerCallbackQuery();
    const clients = await db.listUnassignedLegacyClients(serverKey);
    await showLegacyClients(ctx, userId, clients, page, serverKey);
  });

  bot.callbackQuery(/^abl\|(\d+)\|(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const userId = Number(ctx.match[1]);
    const legacyId = Number(ctx.match[2]);
    const [user, legacy] = await Promise.all([db.getUserById(userId), db.getLegacyClient(legacyId)]);
    if (!user || !legacy)
      return showAlert(ctx, "Запись не найдена.");
    await ctx.answerCallbackQuery();
    await showDateMenu(
      ctx,
      { kind: "bind", userId, legacyId },
      userId,
      appConfig.timezone
    );
  });

  bot.callbackQuery(/^ar\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг не найден.");
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `Отозвать «${config.displayName}»? Файл сразу перестанет подключаться и исчезнет у пользователя.`,
      new InlineKeyboard()
        .text("⛔ Подтвердить отзыв", `arc|${config.id}`)
        .row()
        .text("❌ Отмена", `ac|${config.id}`)
    );
  });

  bot.callbackQuery(/^arc\|(.+)$/, async (ctx) => {
    if (!isAdmin(ctx, appConfig)) return showAlert(ctx, "Недостаточно прав.");
    const config = await db.getConfig(ctx.match[1]!);
    if (!config || config.status === "revoked")
      return showAlert(ctx, "Конфиг уже отозван.");
    if (operationLocks.has(config.id))
      return showAlert(ctx, "Операция уже выполняется.");
    operationLocks.add(config.id);
    await ctx.answerCallbackQuery({ text: "Отзываю…" });
    try {
      await configService.revoke(config);
      const user = await db.getUserById(config.userId);
      if (user) {
        await bot.api
          .sendMessage(
            user.telegramId,
            `Конфиг «${config.displayName}» отозван администратором.`
          )
          .catch(logError);
      }
      await edit(
        ctx,
        "✅ Конфиг отозван.",
        new InlineKeyboard()
          .text("👤 К пользователю", `au|${config.userId}`)
          .row()
          .text("🛠 Админ-панель", "a")
      );
    } catch (error) {
      logError(error);
      await ctx.reply("Не удалось отозвать конфиг. Запись не изменена.", {
        reply_markup: new InlineKeyboard()
          .text("Повторить", `ar|${config.id}`)
          .row()
          .text("Назад", `ac|${config.id}`),
      });
    } finally {
      operationLocks.delete(config.id);
    }
  });

  return { bot };
}

function mainKeyboard(admin: boolean, contactUrl: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("🗂 Мои конфиги", "ul")
    .row()
    .url("💳 Оплатить или продлить", contactUrl)
    .row()
    .text("📖 Как установить", "help");
  if (admin) keyboard.row().text("🛠 Админ-панель", "a");
  return keyboard;
}

function backToMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏠 Главное меню", "m");
}

function usersKeyboard(users: UserRecord[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const user of users)
    keyboard.text(userLabel(user), `au|${user.id}`).row();
  return keyboard.text("🔎 Новый поиск", "as").row().text("🛠 Админ-панель", "a");
}

async function showUserConfigs(
  ctx: Context,
  configs: VpnConfigRecord[],
  requestedPage: number,
  trafficService: TrafficService,
  serverManager: ServerManager
): Promise<void> {
  const { page, totalPages, items } = paginateConfigs(configs, requestedPage);
  const connectionStates = await trafficService.connectionStates(items);
  const keyboard = new InlineKeyboard();
  for (const config of items) {
    keyboard
      .text(
        configListLabel(config, connectionStates.get(config.id)),
        `uc|${config.id}`
      )
      .row();
  }
  addPaginationRow(keyboard, page, totalPages, (targetPage) =>
    `ulp|${targetPage}`
  );
  keyboard.text("⬅️ Назад", "m");
  await edit(
    ctx,
    configs.length
      ? `🗂 Ваши конфиги\n\n🟢 срок действует\n🔴 срок истёк\n🔌 подключён\n⚪ не подключён\n❔ нет данных\n\nСтраница ${page + 1} из ${totalPages} · всего: ${configs.length}`
      : "📭 У Вас пока нет доступных конфигов.",
    keyboard
  );
}

async function showUserConfig(
  ctx: Context,
  config: VpnConfigRecord,
  appConfig: AppConfig,
  trafficService: TrafficService,
  serverManager: ServerManager
): Promise<void> {
  const expired = isExpired(config.expiresAt) || config.status === "expired";
  const status = expired ? "Просрочен" : "Активен";
  const traffic = await trafficService.forConfig(config);
  const serverName = await serverManager.serverName(config.serverKey);
  const keyboard = new InlineKeyboard()
    .text("✏️ Переименовать", `rn|${config.id}`)
    .row();
  if (expired) {
    keyboard.url("💳 Продлить", appConfig.contactUrl).row();
  } else {
    keyboard
      .text("📥 Получить файл", `dl|${config.id}`)
      .row()
      .text("🔄 Перевыпустить файл", `rr|${config.id}`)
      .row();
  }
  keyboard.text("⬅️ Назад", "ul").text("🏠 Главное меню", "m");
  await edit(
    ctx,
    `🔐 Конфиг: ${config.displayName}\n${expired ? "🔴" : "🟢"} Статус: ${status}\n${connectionStatusLine(traffic)}\n🖥 Сервер: ${serverName}\n📅 Действует до: ${formatDate(config.expiresAt, appConfig.timezone)}\n📊 Трафик: ${formatBytes(traffic.totalBytes)} (↑ ${formatBytes(traffic.uploadBytes)}, ↓ ${formatBytes(traffic.downloadBytes)})`,
    keyboard
  );
}

async function showAdminMain(
  ctx: Context,
  db: AppDatabase
): Promise<void> {
  const stats = await db.stats();

  const text = [
    "🛠 Админ-панель",
    "",
    `👥 Пользователей: ${stats.users}`,
    `🟢 Активных конфигов: ${stats.active}`,
    `🔴 Просроченных в меню: ${stats.expired}`,
  ].join("\n");
  await edit(
    ctx,
    text,
    new InlineKeyboard()
      .text("🔎 Найти пользователя", "as")
      .row()
      .text("🖥 Серверы", "sv")
      .row()
      .text("🌐 Белые домены", "wd")
      .row()
      .text("📣 Рассылка", "bc")
      .row()
      .text("⏳ Продлить все конфиги", "ax")
      .row()
      .text("📊 Статистика", "at")
      .row()
      .text("🏠 Главное меню", "m")
  );
}

async function showBypassDomains(
  ctx: Context,
  db: AppDatabase,
  requestedPage: number
): Promise<void> {
  const domains = await db.listBypassDomains();
  const pages = Math.max(1, Math.ceil(domains.length / DOMAIN_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const start = page * DOMAIN_PAGE_SIZE;
  const visible = domains.slice(start, start + DOMAIN_PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const entry of visible) {
    const label = entry.domain.length > 48
      ? `${entry.domain.slice(0, 45)}…`
      : entry.domain;
    keyboard.text(`🗑 ${label}`, `wdr|${entry.id}`).row();
  }
  if (pages > 1) {
    if (page > 0) keyboard.text("⬅️", `wdp|${page - 1}`);
    keyboard.text(`${page + 1}/${pages}`, `wdp|${page}`);
    if (page + 1 < pages) keyboard.text("➡️", `wdp|${page + 1}`);
    keyboard.row();
  }
  keyboard
    .text("➕ Добавить домены", "wda")
    .row()
    .text("⬅️ Админ-панель", "a");
  const lines = [
    "🌐 Белые домены",
    "",
    "Эти сайты открываются напрямую через обычный шлюз пользователя, минуя VPN.",
    "После изменения списка конфиг нужно скачать заново.",
    "Для домена и его поддоменов нужны отдельные записи.",
    "",
    domains.length ? `Всего доменов: ${domains.length}` : "Список пока пуст.",
  ];
  await edit(ctx, lines.join("\n"), keyboard);
}

async function showTrafficStats(
  ctx: Context,
  trafficService: TrafficService,
  serverManager: ServerManager
): Promise<void> {
  const stats = await trafficService.all();
  const names = await serverManager.serverNames();
  const lines: string[] = [
    "📊 Статистика трафика",
    "",
    "🌐 Всего за всё время",
    `Всего: ${formatBytes(stats.total.totalBytes)}`,
    `↑ От пользователей: ${formatBytes(stats.total.uploadBytes)}`,
    `↓ Пользователям: ${formatBytes(stats.total.downloadBytes)}`,
  ];
  for (const [serverKey, traffic] of Object.entries(stats.servers)) {
    lines.push(
      "",
      ...trafficServerLines(names.get(serverKey) ?? serverKey, traffic)
    );
  }
  await edit(
    ctx,
    lines.join("\n"),
    new InlineKeyboard()
      .text("🔄 Обновить", "at")
      .row()
      .text("⬅️ Админ-панель", "a")
  );
}

async function showServersList(
  ctx: Context,
  serverManager: ServerManager
): Promise<void> {
  const servers = await serverManager.listServers();
  const keyboard = new InlineKeyboard();
  for (const server of servers) {
    keyboard
      .text(
        `${serverStatusIcon(server)} ${server.record.name}`,
        `svo|${server.record.key}`
      )
      .row();
  }
  keyboard.text("➕ Добавить сервер", "svadd").row();
  keyboard.text("⬅️ Админ-панель", "a");
  await edit(
    ctx,
    servers.length
      ? `🖥 Серверы\n\n🟢 работает\n⏳ настраивается\n🔴 ошибка настройки\n⏸ не выдаёт конфиги\n\nВсего: ${servers.length}`
      : "🖥 Серверы пока не подключены.",
    keyboard
  );
}

async function showServerCard(
  ctx: Context,
  serverManager: ServerManager,
  db: AppDatabase,
  trafficService: TrafficService,
  serverKey: ServerKey
): Promise<void> {
  const server = await serverManager.getServer(serverKey);
  if (!server) {
    await edit(
      ctx,
      "Сервер не найден.",
      new InlineKeyboard().text("🖥 К серверам", "sv")
    );
    return;
  }
  const { record } = server;
  const lines: string[] = [
    `🖥 Сервер: ${record.name}`,
    `🌐 Адрес: ${record.host}:${record.port}`,
    ...(record.relayPort ? [`🔀 VPN relay: ${record.relayPort}/TCP`] : []),
    record.status === "ready"
      ? "🟢 Статус: работает"
      : record.status === "pending"
        ? "⏳ Статус: настраивается"
        : `🔴 Статус: ошибка настройки${record.lastError ? ` — ${record.lastError}` : ""}`,
    record.enabled
      ? "✅ Выдача новых конфигов: включена"
      : "⏸ Выдача новых конфигов: выключена",
  ];

  if (record.status === "ready") {
    const stats = await db.stats();
    const configs = stats.perServer[record.key] ?? 0;
    const { sessions, liveAvailable } =
      await trafficService.activeSessionsForServer(record.key);
    lines.push(`🔐 Конфигов на сервере: ${configs}`);
    lines.push(
      liveAvailable
        ? `🔌 Подключений сейчас: ${sessions.length}`
        : "❔ Сервер не отвечает по SSH"
    );
    const completed = (await db.completedTrafficByServer())[record.key] ?? {
      uploadBytes: 0,
      downloadBytes: 0,
    };
    const upload = completed.uploadBytes + sumActiveUpload(sessions);
    const download = completed.downloadBytes + sumActiveDownload(sessions);
    lines.push(
      `📊 Трафик: ${formatBytes(upload + download)} (↑ ${formatBytes(upload)}, ↓ ${formatBytes(download)})`
    );
  }

  const keyboard = new InlineKeyboard();
  if (record.status === "ready") {
    keyboard
      .text(
        record.enabled ? "⏸ Остановить выдачу" : "▶️ Возобновить выдачу",
        `svt|${record.key}`
      )
      .row()
      .text("✏️ Переименовать", `svrn|${record.key}`)
      .row();
  }
  keyboard
    .text("🗑 Удалить сервер", `svd|${record.key}`)
    .row()
    .text("🔄 Обновить", `svo|${record.key}`)
    .row()
    .text("⬅️ К серверам", "sv")
    .row()
    .text("🛠 Админ-панель", "a");
  await edit(ctx, lines.join("\n"), keyboard);
}

function sumActiveUpload(sessions: { uploadBytes: number }[]): number {
  return sessions.reduce((total, session) => total + session.uploadBytes, 0);
}

function sumActiveDownload(sessions: { downloadBytes: number }[]): number {
  return sessions.reduce((total, session) => total + session.downloadBytes, 0);
}

function serverStatusIcon(server: ServerWithTarget): string {
  if (server.record.status === "pending") return "⏳";
  if (server.record.status === "error") return "🔴";
  return server.record.enabled ? "🟢" : "⏸";
}

async function showAdminUser(
  ctx: Context,
  user: UserRecord,
  db: AppDatabase,
  trafficService: TrafficService,
  requestedPage: number
): Promise<void> {
  const configs = await db.listConfigsForUserAdmin(user.id);
  const { page, totalPages, items } = paginateConfigs(configs, requestedPage);
  const connectionStates = await trafficService.connectionStates(items);
  const keyboard = new InlineKeyboard();
  for (const config of items)
    keyboard
      .text(
        configListLabel(config, connectionStates.get(config.id)),
        `ac|${config.id}`
      )
      .row();
  addPaginationRow(keyboard, page, totalPages, (targetPage) =>
    `aup|${user.id}|${targetPage}`
  );
  keyboard.text("➕ Выдать новый конфиг", `ai|${user.id}`).row();
  keyboard.text("🔗 Привязать старый конфиг", `ab|${user.id}`).row();
  keyboard.text("🔎 Новый поиск", "as").text("🛠 Админ-панель", "a");
  await edit(
    ctx,
    `Пользователь: ${userLabel(user)}\nКонфигов: ${configs.length}\n\n🟢 срок действует\n🔴 срок истёк\n🔌 подключён\n⚪ не подключён\n❔ нет данных\n\nСтраница ${page + 1} из ${totalPages}`,
    keyboard
  );
}

async function showAdminConfig(
  ctx: Context,
  config: VpnConfigRecord,
  db: AppDatabase,
  appConfig: AppConfig,
  trafficService: TrafficService,
  serverManager: ServerManager
): Promise<void> {
  const user = (await db.getUserById(config.userId))!;
  const expired = isExpired(config.expiresAt) || config.status === "expired";
  const traffic = await trafficService.forConfig(config);
  const serverName = await serverManager.serverName(config.serverKey);
  const text = [
    `Конфиг: ${config.displayName}`,
    `Пользователь: ${userLabel(user)}`,
    `Статус: ${expired ? "Просрочен" : "Активен"}`,
    connectionStatusLine(traffic),
    `Действует до: ${formatDate(config.expiresAt, appConfig.timezone)}`,
    `Сервер: ${serverName}`,
    `OpenVPN-клиент: ${config.clientName}`,
    `Трафик: ${formatBytes(traffic.totalBytes)} (↑ ${formatBytes(traffic.uploadBytes)}, ↓ ${formatBytes(traffic.downloadBytes)})`,
  ].join("\n");
  await edit(
    ctx,
    text,
    new InlineKeyboard()
      .text(expired ? "💳 Продлить" : "📅 Изменить срок", `ae|${config.id}`)
      .row()
      .text("📥 Получить файл", `adl|${config.id}`)
      .text("🔄 Поменять сервер", `am|${config.id}`)
      .row()
      .text("⛔ Отозвать", `ar|${config.id}`)
      .row()
      .text("👤 К пользователю", `au|${config.userId}`)
      .text("🛠 Админ-панель", "a")
  );
}

async function showDateMenu(
  ctx: Context,
  target: DateTarget,
  backUserId: number,
  timezone: string
): Promise<void> {
  const { code, value } = encodeDateTarget(target);
  await edit(
    ctx,
    `📅 Выберите дату окончания. Быстрые варианты считаются от сегодняшней даты (${DateTime.now().setZone(timezone).toFormat("dd.MM.yyyy")}).`,
    new InlineKeyboard()
      .text("+30 дней", `dt|${code}|${value}|30`)
      .text("+60 дней", `dt|${code}|${value}|60`)
      .text("+90 дней", `dt|${code}|${value}|90`)
      .row()
      .text("+6 месяцев", `dt|${code}|${value}|6m`)
      .text("+1 год", `dt|${code}|${value}|1y`)
      .row()
      .text("📅 Указать дату", `dc|${code}|${value}`)
      .row()
      .text("⬅️ Назад", `au|${backUserId}`)
  );
}

async function showLegacyClients(
  ctx: Context,
  userId: number,
  clients: LegacyClientRecord[],
  requestedPage: number,
  serverKey: ServerKey
): Promise<void> {
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(clients.length / pageSize));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  const pageClients = clients.slice(page * pageSize, (page + 1) * pageSize);
  const keyboard = new InlineKeyboard();
  for (const client of pageClients)
    keyboard.text(client.clientName, `abl|${userId}|${client.id}`).row();
  if (totalPages > 1) {
    if (page > 0) keyboard.text("⬅️", `abp|${userId}|${page - 1}|${serverKey}`);
    keyboard.text(`${page + 1}/${totalPages}`, `abp|${userId}|${page}|${serverKey}`);
    if (page < totalPages - 1)
      keyboard.text("➡️", `abp|${userId}|${page + 1}|${serverKey}`);
    keyboard.row();
  }
  keyboard.text("Назад", `au|${userId}`);
  await edit(
    ctx,
    clients.length
      ? `Выберите существующий OpenVPN-клиент:\n\nСтраница ${page + 1} из ${totalPages} · доступно: ${clients.length}`
      : "Непривязанных клиентов на этом сервере нет.",
    keyboard
  );
}

async function applyDateTarget(
  ctx: Context,
  target: DateTarget,
  expiresAt: string,
  appConfig: AppConfig,
  db: AppDatabase,
  service: ConfigService,
  serverManager: ServerManager
): Promise<void> {
  const lockKey =
    target.kind === "issue"
      ? `issue:${target.userId}`
      : target.kind === "bind"
        ? `bind:${target.legacyId}`
        : target.configId;
  if (operationLocks.has(lockKey)) {
    await ctx.reply("Эта операция уже выполняется.");
    return;
  }
  operationLocks.add(lockKey);
  try {
    if (target.kind === "issue") {
      const user = await db.getUserById(target.userId);
      if (!user) throw new Error("Пользователь не найден");
      const config = await service.issue(user, expiresAt);
      await notifyConfigReady(
        ctx,
        user,
        config,
        appConfig,
        "✅ Новый конфиг готов."
      );
      const serverName = await serverManager.serverName(config.serverKey);
      await respond(
        ctx,
        `Конфиг «${config.displayName}» выдан пользователю ${userLabel(user)}. Сервер: ${serverName}.`,
        new InlineKeyboard()
          .text("🔎 Открыть конфиг", `ac|${config.id}`)
          .row()
          .text("👤 К пользователю", `au|${user.id}`)
      );
      return;
    }

    if (target.kind === "bind") {
      const [user, legacy] = await Promise.all([
        db.getUserById(target.userId),
        db.getLegacyClient(target.legacyId),
      ]);
      if (!user || !legacy)
        throw new Error("Пользователь или клиент не найден");
      const config = await service.bindLegacy(user, legacy, expiresAt);
      await notifyConfigReady(
        ctx,
        user,
        config,
        appConfig,
        "Существующий конфиг добавлен в Ваш кабинет."
      );
      await respond(
        ctx,
        `Клиент «${legacy.clientName}» привязан к ${userLabel(user)}.`,
        new InlineKeyboard()
          .text("🔎 Открыть конфиг", `ac|${config.id}`)
          .row()
          .text("👤 К пользователю", `au|${user.id}`)
      );
      return;
    }

    const config = await db.getConfig(target.configId);
    if (!config || config.status === "revoked")
      throw new Error("Конфиг не найден");
    const updated = await service.changeExpiry(config, expiresAt);
    const user = await db.getUserById(updated.userId);
    if (user)
      await notifyConfigReady(
        ctx,
        user,
        updated,
        appConfig,
        "✅ Срок действия конфига изменён."
      );
    await respond(
      ctx,
      `Новый срок для «${updated.displayName}»: ${formatDate(expiresAt, appConfig.timezone)}.`,
      new InlineKeyboard()
        .text("🔎 Открыть конфиг", `ac|${updated.id}`)
        .row()
        .text("👤 К пользователю", `au|${updated.userId}`)
    );
  } catch (error) {
    logError(error);
    await respond(
      ctx,
      "Операцию выполнить не удалось. Данные не были изменены.",
      new InlineKeyboard().text("🛠 Админ-панель", "a")
    );
  } finally {
    operationLocks.delete(lockKey);
  }
}

async function serverListClients(
  serverManager: ServerManager,
  target: VpnServerTarget
): Promise<string[]> {
  return serverManager.listClients(target);
}

async function notifyConfigReady(
  ctx: Context,
  user: UserRecord,
  config: VpnConfigRecord,
  appConfig: AppConfig,
  prefix: string
): Promise<void> {
  await ctx.api
    .sendMessage(
      user.telegramId,
      `${prefix}\n«${config.displayName}» действует до ${formatDate(config.expiresAt, appConfig.timezone)}.`,
      {
        reply_markup: new InlineKeyboard()
          .text("🔎 Открыть конфиг", `uc|${config.id}`)
          .row()
          .text("🏠 Главное меню", "m"),
      }
    )
    .catch(logError);
}

async function ownedConfig(
  ctx: Context,
  db: AppDatabase,
  configId: string
): Promise<VpnConfigRecord | null> {
  if (!ctx.from) return null;
  const [user, config] = await Promise.all([
    db.getUserByTelegramId(String(ctx.from.id)),
    db.getConfig(configId),
  ]);
  return user &&
    config &&
    user.id === config.userId &&
    config.status !== "revoked"
    ? config
    : null;
}

function notifyAdmin(bot: Bot, appConfig: AppConfig, text: string): void {
  bot.api
    .sendMessage(appConfig.adminTelegramId, text, {
      reply_markup: new InlineKeyboard().text("🖥 К серверам", "sv"),
    })
    .catch(logError);
}

function statusIcon(config: VpnConfigRecord): string {
  return isExpired(config.expiresAt) || config.status === "expired"
    ? "🔴"
    : "🟢";
}

function connectionIcon(state: ConfigConnectionState | undefined): string {
  if (!state?.liveAvailable) return "❔";
  return state.activeConnections > 0 ? "🔌" : "⚪";
}

function configListLabel(
  config: VpnConfigRecord,
  state: ConfigConnectionState | undefined
): string {
  return `${statusIcon(config)}${connectionIcon(state)} ${config.displayName}`;
}

function connectionStatusLine(state: ConfigConnectionState): string {
  if (!state.liveAvailable)
    return "❔ Подключён сейчас: данные сервера недоступны";
  if (state.activeConnections === 0) return "⚪ Подключён сейчас: нет";
  return state.activeConnections === 1
    ? "🔌 Подключён сейчас: да"
    : `🔌 Подключён сейчас: да (активных подключений: ${state.activeConnections})`;
}

function paginateConfigs(
  configs: VpnConfigRecord[],
  requestedPage: number
): {
  page: number;
  totalPages: number;
  items: VpnConfigRecord[];
} {
  const totalPages = Math.max(1, Math.ceil(configs.length / CONFIG_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  return {
    page,
    totalPages,
    items: configs.slice(
      page * CONFIG_PAGE_SIZE,
      (page + 1) * CONFIG_PAGE_SIZE
    ),
  };
}

function addPaginationRow(
  keyboard: InlineKeyboard,
  page: number,
  totalPages: number,
  callback: (page: number) => string
): void {
  if (totalPages <= 1) return;
  if (page > 0) keyboard.text("⬅️", callback(page - 1));
  keyboard.text(`${page + 1}/${totalPages}`, callback(page));
  if (page < totalPages - 1) keyboard.text("➡️", callback(page + 1));
  keyboard.row();
}

function userLabel(user: UserRecord): string {
  return user.username
    ? `@${user.username} (${user.telegramId})`
    : `${user.firstName} (${user.telegramId})`;
}

function isAdmin(ctx: Context, config: AppConfig): boolean {
  return String(ctx.from?.id ?? "") === config.adminTelegramId;
}

function normalizeDisplayName(value: string): string | null {
  const name = value.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
}

function parseFutureDate(value: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const date = DateTime.fromFormat(value.trim(), "yyyy-MM-dd", {
    zone: timezone,
  });
  if (
    !date.isValid ||
    date.startOf("day") < DateTime.now().setZone(timezone).startOf("day")
  )
    return null;
  return expiryFromDate(value.trim(), timezone);
}

function encodeDateTarget(target: DateTarget): {
  code: "i" | "b" | "e";
  value: string;
} {
  if (target.kind === "issue")
    return { code: "i", value: String(target.userId) };
  if (target.kind === "bind")
    return { code: "b", value: `${target.userId}.${target.legacyId}` };
  return { code: "e", value: target.configId };
}

function decodeDateTarget(code: string, value: string): DateTarget | null {
  if (code === "i" && /^\d+$/.test(value))
    return { kind: "issue", userId: Number(value) };
  if (code === "b" && /^\d+\.\d+$/.test(value)) {
    const [userId, legacyId] = value.split(".").map(Number);
    return { kind: "bind", userId: userId!, legacyId: legacyId! };
  }
  if (code === "e" && /^[0-9a-f-]{36}$/.test(value))
    return { kind: "change", configId: value };
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let unit = "Б";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function trafficServerLines(
  name: string,
  traffic: ServerTrafficUsage
): string[] {
  return [
    `🖥 ${name}`,
    `Всего: ${formatBytes(traffic.totalBytes)}`,
    `↑ ${formatBytes(traffic.uploadBytes)} · ↓ ${formatBytes(traffic.downloadBytes)}`,
    traffic.liveAvailable
      ? `Подключений сейчас: ${traffic.activeConnections}`
      : "Текущие подключения: сервер не подключён",
  ];
}

async function edit(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("message is not modified"))
      await ctx.reply(text, { reply_markup: keyboard });
  }
}

async function respond(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  if (ctx.callbackQuery?.message) {
    await edit(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

async function showAlert(ctx: Context, text: string): Promise<void> {
  await ctx.answerCallbackQuery({ text, show_alert: true });
}

function logError(error: unknown): void {
  console.error(error);
}
