import { consumeVkAccountLinkCode, isVkAccountLinkCode } from "./account-link.js";
import type { AppDatabase } from "./database.js";
import type { ConfigService } from "./config-service.js";
import type { UserRecord, VpnConfigRecord } from "./domain.js";
import { labeledVpnFileName, vpnFileName } from "./file-name.js";
import type { ServerManager } from "./server-manager.js";
import { formatDate, isExpired } from "./time.js";
import type { TrafficService } from "./traffic-service.js";
import {
  VkApiClient,
  type VkLongPollServer,
  type VkLongPollUpdate,
  type VkUserProfile,
} from "./vk-api.js";

const CONFIG_PAGE_SIZE = 5;
const LINK_REQUIRED_MESSAGE = [
  "🔗 Сначала свяжите VK с Telegram.",
  "",
  "Откройте Telegram-бота, нажмите «Связать VK», получите одноразовый код и отправьте его сюда отдельным сообщением.",
].join("\n");

interface VkMessage {
  from_id: number;
  peer_id: number;
  text: string;
  payload?: string;
}

interface VkMessageEvent {
  event_id: string;
  user_id: number;
  peer_id: number;
  payload?: unknown;
}

export interface VkAction {
  a: string;
  id?: string;
  server?: string;
  page?: number;
}

export interface VkButton {
  label: string;
  action: VkAction;
  color?: "primary" | "secondary" | "positive" | "negative";
}

export class VkBot {
  private abortController: AbortController | null = null;
  private readonly profiles = new Map<number, VkUserProfile>();
  private readonly pendingRename = new Map<string, string>();
  private readonly operationLocks = new Set<string>();

  constructor(
    private readonly api: VkApiClient,
    private readonly db: AppDatabase,
    private readonly configService: ConfigService,
    private readonly trafficService: TrafficService,
    private readonly serverManager: ServerManager,
    private readonly timezone: string
  ) {}

  async start(): Promise<void> {
    if (this.abortController) throw new Error("VK-бот уже запущен");
    const controller = new AbortController();
    this.abortController = controller;
    console.info(`VK-бот запущен для сообщества ${this.api.groupId}`);
    try {
      while (!controller.signal.aborted) {
        try {
          await this.poll(controller.signal);
        } catch (error) {
          if (controller.signal.aborted) break;
          console.error("Ошибка VK Long Poll", error);
          await wait(2_000, controller.signal).catch(() => {});
        }
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  stop(): void {
    this.abortController?.abort();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let server = await this.api.getLongPollServer();
    while (!signal.aborted) {
      const response = await this.api.checkLongPoll(server, signal);
      if (response.failed === 1 && response.ts) {
        server = { ...server, ts: response.ts };
        continue;
      }
      if (response.failed === 2 || response.failed === 3) return;
      if (response.failed) {
        throw new Error(`VK Long Poll вернул failed=${response.failed}`);
      }
      if (response.ts) server = { ...server, ts: response.ts };
      for (const update of response.updates ?? []) {
        try {
          await this.handleUpdate(update);
        } catch (error) {
          console.error(`Не удалось обработать VK-событие ${update.type}`, error);
        }
      }
    }
  }

  private async handleUpdate(update: VkLongPollUpdate): Promise<void> {
    if (update.type === "message_new") {
      const message = parseMessage(update.object);
      if (message && message.from_id > 0) await this.handleMessage(message);
      return;
    }
    if (update.type === "message_event") {
      const event = parseMessageEvent(update.object);
      if (!event) return;
      await this.api.answerMessageEvent({
        eventId: event.event_id,
        userId: event.user_id,
        peerId: event.peer_id,
      }).catch((error) => console.error("Не удалось подтвердить VK callback", error));
      await this.handleAction(
        event.user_id,
        event.peer_id,
        parseAction(event.payload)
      );
    }
  }

  private async handleMessage(message: VkMessage): Promise<void> {
    const profile = await this.profile(message.from_id);
    let user = await this.db.upsertVkUser({
      vkId: String(message.from_id),
      peerId: String(message.peer_id),
      ...(profile.screen_name ? { username: profile.screen_name } : {}),
      firstName: profile.first_name || "Пользователь VK",
    });
    const text = message.text.trim();

    if (isVkAccountLinkCode(text)) {
      const linked = await consumeVkAccountLinkCode(this.db, {
        code: text,
        vkId: String(message.from_id),
        peerId: String(message.peer_id),
        ...(profile.screen_name ? { username: profile.screen_name } : {}),
        firstName: profile.first_name || "Пользователь VK",
      });
      if (!linked) {
        await this.api.sendMessage({
          peerId: message.peer_id,
          message: "Код привязки неверен, уже использован или истёк. Получите новый код в Telegram.",
          ...(vkRequiresTelegramLink(user) ? {} : { keyboard: mainKeyboard() }),
        });
        return;
      }
      user = linked;
      await this.api.sendMessage({
        peerId: message.peer_id,
        message: "✅ VK успешно связан с Вашим аккаунтом Telegram. Конфиги и сроки теперь общие.",
        keyboard: mainKeyboard(),
      });
      return;
    }

    if (vkRequiresTelegramLink(user)) {
      this.pendingRename.delete(String(message.from_id));
      await this.showLinkRequired(message.peer_id);
      return;
    }

    const pendingConfigId = this.pendingRename.get(String(message.from_id));
    if (pendingConfigId && text) {
      this.pendingRename.delete(String(message.from_id));
      const config = await this.db.getConfig(pendingConfigId);
      const name = normalizeDisplayName(text);
      if (!config || config.userId !== user.id || config.status === "revoked") {
        await this.api.sendMessage({
          peerId: message.peer_id,
          message: "Конфиг не найден.",
          keyboard: mainKeyboard(),
        });
      } else if (!name) {
        await this.api.sendMessage({
          peerId: message.peer_id,
          message: "Название должно содержать от 1 до 40 символов.",
          keyboard: configKeyboard(config.id),
        });
      } else {
        await this.db.updateDisplayName(config.id, name);
        await this.api.sendMessage({
          peerId: message.peer_id,
          message: `✅ Название изменено на «${name}».`,
          keyboard: configKeyboard(config.id),
        });
      }
      return;
    }

    const action = parseAction(message.payload);
    if (action) {
      await this.handleAction(message.from_id, message.peer_id, action);
      return;
    }
    await this.showMain(message.peer_id);
  }

  private async handleAction(
    vkId: number,
    peerId: number,
    action: VkAction | null
  ): Promise<void> {
    const user = await this.db.getUserByVkId(String(vkId));
    if (!user || vkRequiresTelegramLink(user)) return this.showLinkRequired(peerId);
    if (!action) return this.showMain(peerId);

    if (action.a === "main") return this.showMain(peerId);
    if (action.a === "help") return this.showHelp(peerId);
    if (action.a === "list") {
      return this.showConfigs(user.id, peerId, action.page ?? 0);
    }
    if (action.a === "all") return this.downloadAll(user.id, vkId, peerId);
    if (!action.id) return this.showMain(peerId);

    const config = await this.db.getConfig(action.id);
    if (!config || config.userId !== user.id || config.status === "revoked") {
      await this.api.sendMessage({
        peerId,
        message: "Конфиг не найден.",
        keyboard: mainKeyboard(),
      });
      return;
    }
    if (action.a === "cfg") return this.showConfig(config, peerId);
    if (action.a === "download") return this.download(config, peerId);
    if (action.a === "rename") {
      this.pendingRename.set(String(vkId), config.id);
      await this.api.sendMessage({
        peerId,
        message: `Отправьте новое название для «${config.displayName}» — от 1 до 40 символов.`,
        keyboard: keyboard([[button("Отмена", { a: "cfg", id: config.id })]]),
      });
      return;
    }
    if (action.a === "reissue") return this.showReissueServers(config, peerId);
    if (action.a === "reissue-confirm" && action.server) {
      return this.reissue(config, action.server, peerId);
    }
  }

  private async showMain(peerId: number): Promise<void> {
    await this.api.sendMessage({
      peerId,
      message: "👋 VPN-бот\n\nЗдесь можно получить конфиги, проверить срок действия и перевыпустить файл.",
      keyboard: mainKeyboard(),
    });
  }

  private async showLinkRequired(peerId: number): Promise<void> {
    await this.api.sendMessage({
      peerId,
      message: LINK_REQUIRED_MESSAGE,
    });
  }

  private async showHelp(peerId: number): Promise<void> {
    await this.api.sendMessage({
      peerId,
      message: [
        "ℹ️ Как подключиться",
        "",
        "1. Скачайте .ovpn-файл.",
        "2. Установите OpenVPN Connect.",
        "3. Импортируйте полученный файл и включите VPN.",
        "",
        "Если профиль перестал работать после перевыпуска, удалите старый профиль и импортируйте новый файл.",
      ].join("\n"),
      keyboard: keyboard([[button("Назад", { a: "main" })]]),
    });
  }

  private async showConfigs(
    userId: number,
    peerId: number,
    requestedPage: number
  ): Promise<void> {
    const configs = await this.db.listVisibleConfigs(userId);
    const totalPages = Math.max(1, Math.ceil(configs.length / CONFIG_PAGE_SIZE));
    const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
    const items = configs.slice(
      page * CONFIG_PAGE_SIZE,
      (page + 1) * CONFIG_PAGE_SIZE
    );
    const rows: VkButton[][] = items.map((config) => [
      button(
        `${isExpired(config.expiresAt) || config.status !== "active" ? "🔴" : "🟢"} ${config.displayName}`,
        { a: "cfg", id: config.id }
      ),
    ]);
    if (totalPages > 1) {
      const pagination: VkButton[] = [];
      if (page > 0) pagination.push(button("←", { a: "list", page: page - 1 }));
      if (page + 1 < totalPages)
        pagination.push(button("→", { a: "list", page: page + 1 }));
      rows.push(pagination);
    }
    rows.push([button("Главное меню", { a: "main" })]);
    await this.api.sendMessage({
      peerId,
      message: configs.length
        ? `🔐 Ваши конфиги: ${configs.length}\nСтраница ${page + 1} из ${totalPages}`
        : "У Вас пока нет VPN-конфигов. Обратитесь к администратору после оплаты.",
      keyboard: keyboard(rows),
    });
  }

  private async showConfig(config: VpnConfigRecord, peerId: number): Promise<void> {
    const [traffic, serverName] = await Promise.all([
      this.trafficService.forConfig(config),
      this.serverManager.serverName(config.serverKey),
    ]);
    const active = config.status === "active" && !isExpired(config.expiresAt);
    await this.api.sendMessage({
      peerId,
      message: [
        `🔐 ${config.displayName}`,
        `Статус: ${active ? "🟢 действует" : "🔴 срок истёк"}`,
        `Действует до: ${formatDate(config.expiresAt, this.timezone)}`,
        `Сервер: ${serverName}`,
        `Подключений сейчас: ${traffic.liveAvailable ? traffic.activeConnections : "нет данных"}`,
        `Трафик: ${formatBytes(traffic.totalBytes)}`,
      ].join("\n"),
      keyboard: configKeyboard(config.id, active),
    });
  }

  private async download(config: VpnConfigRecord, peerId: number): Promise<void> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      await this.api.sendMessage({
        peerId,
        message: "Срок действия конфига истёк.",
        keyboard: configKeyboard(config.id, false),
      });
      return;
    }
    try {
      const file = await this.configService.download(config);
      await this.api.sendDocument({
        peerId,
        file,
        fileName: vpnFileName(config.clientName),
        message: `🔐 «${config.displayName}» — действует до ${formatDate(config.expiresAt, this.timezone)}.`,
      });
    } catch (error) {
      console.error(`Не удалось отправить VK-файл ${config.id}`, error);
      await this.api.sendMessage({
        peerId,
        message: "Не удалось подготовить файл. Попробуйте позднее или обратитесь к администратору.",
        keyboard: configKeyboard(config.id),
      });
    }
  }

  private async downloadAll(
    userId: number,
    vkId: number,
    peerId: number
  ): Promise<void> {
    const lock = `all:${vkId}`;
    if (this.operationLocks.has(lock)) return;
    this.operationLocks.add(lock);
    try {
      const configs = (await this.db.listVisibleConfigs(userId)).filter(
        (config) => config.status === "active" && !isExpired(config.expiresAt)
      );
      if (configs.length === 0) {
        await this.api.sendMessage({
          peerId,
          message: "У Вас нет действующих конфигов.",
          keyboard: mainKeyboard(),
        });
        return;
      }
      await this.api.sendMessage({
        peerId,
        message: `Подготавливаю файлы: ${configs.length}.`,
      });
      let delivered = 0;
      for (const config of configs) {
        try {
          const file = await this.configService.download(config);
          await this.api.sendDocument({
            peerId,
            file,
            fileName: labeledVpnFileName(config.displayName, config.clientName),
            message: `🔐 ${config.displayName} — до ${formatDate(config.expiresAt, this.timezone)}`,
          });
          delivered += 1;
        } catch (error) {
          console.error(`Не удалось массово отправить VK-файл ${config.id}`, error);
        }
      }
      await this.api.sendMessage({
        peerId,
        message: `✅ Отправлено файлов: ${delivered} из ${configs.length}.`,
        keyboard: mainKeyboard(),
      });
    } finally {
      this.operationLocks.delete(lock);
    }
  }

  private async showReissueServers(
    config: VpnConfigRecord,
    peerId: number
  ): Promise<void> {
    if (config.status !== "active" || isExpired(config.expiresAt)) {
      await this.api.sendMessage({
        peerId,
        message: "Просроченный конфиг нельзя перевыпустить.",
        keyboard: configKeyboard(config.id, false),
      });
      return;
    }
    const servers = (await this.serverManager.listServers()).filter(
      (server) =>
        server.record.status === "ready" &&
        server.record.enabled &&
        server.record.key !== config.serverKey
    );
    if (servers.length === 0) {
      await this.api.sendMessage({
        peerId,
        message: "Сейчас нет другого доступного сервера для перевыпуска.",
        keyboard: configKeyboard(config.id),
      });
      return;
    }
    await this.api.sendMessage({
      peerId,
      message: "Выберите сервер для нового файла. Старый профиль будет работать ещё примерно пять минут.",
      keyboard: keyboard([
        ...servers.map((server) => [
          button(server.record.name, {
            a: "reissue-confirm",
            id: config.id,
            server: server.record.key,
          }, "primary"),
        ]),
        [button("Отмена", { a: "cfg", id: config.id })],
      ]),
    });
  }

  private async reissue(
    config: VpnConfigRecord,
    serverKey: string,
    peerId: number
  ): Promise<void> {
    const lock = `reissue:${config.id}`;
    if (this.operationLocks.has(lock)) return;
    this.operationLocks.add(lock);
    try {
      const server = await this.serverManager.getServer(serverKey);
      if (
        !server ||
        server.record.status !== "ready" ||
        !server.record.enabled ||
        server.record.key === config.serverKey
      ) {
        throw new Error("Выбранный сервер недоступен");
      }
      const recreated = await this.configService.recreate(config, serverKey);
      await this.api.sendDocument({
        peerId,
        file: recreated.file,
        fileName: vpnFileName(recreated.config.clientName),
        message: `✅ «${recreated.config.displayName}» перевыпущен на сервере «${server.record.name}». Старый файл отключится примерно через пять минут.`,
      });
      await this.api.sendMessage({
        peerId,
        message: "Импортируйте новый файл в OpenVPN Connect.",
        keyboard: configKeyboard(recreated.config.id),
      });
    } catch (error) {
      console.error(`Не удалось перевыпустить VK-конфиг ${config.id}`, error);
      await this.api.sendMessage({
        peerId,
        message: "Перевыпуск не выполнен. Текущий конфиг оставлен без изменений.",
        keyboard: configKeyboard(config.id),
      });
    } finally {
      this.operationLocks.delete(lock);
    }
  }

  private async profile(userId: number): Promise<VkUserProfile> {
    const cached = this.profiles.get(userId);
    if (cached) return cached;
    const profile = await this.api.getUser(userId);
    this.profiles.set(userId, profile);
    return profile;
  }
}

export function vkRequiresTelegramLink(
  user: Pick<UserRecord, "telegramId"> | null
): boolean {
  return !user?.telegramId;
}

function mainKeyboard(): string {
  return keyboard([
    [button("🔐 Мои конфиги", { a: "list" }, "primary")],
    [button("📦 Получить все файлы", { a: "all" }, "positive")],
    [button("ℹ️ Помощь", { a: "help" })],
  ]);
}

function configKeyboard(configId: string, active = true): string {
  const rows: VkButton[][] = [];
  if (active) {
    rows.push([
      button("📥 Получить файл", { a: "download", id: configId }, "positive"),
    ]);
    rows.push([
      button("🔄 Перевыпустить", { a: "reissue", id: configId }, "primary"),
      button("✏️ Переименовать", { a: "rename", id: configId }),
    ]);
  }
  rows.push([button("⬅️ К конфигам", { a: "list" })]);
  return keyboard(rows);
}

function button(
  label: string,
  action: VkAction,
  color: VkButton["color"] = "secondary"
): VkButton {
  return { label, action, color };
}

export function keyboard(rows: VkButton[][]): string {
  return JSON.stringify({
    inline: true,
    buttons: rows.filter((row) => row.length > 0).map((row) =>
      row.map((item) => ({
        action: {
          type: "callback",
          label: item.label,
          payload: JSON.stringify(item.action),
        },
        color: item.color ?? "secondary",
      }))
    ),
  });
}

function parseAction(payload: unknown): VkAction | null {
  try {
    const value = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!value || typeof value !== "object") return null;
    const action = value as Partial<VkAction>;
    return typeof action.a === "string" ? action as VkAction : null;
  } catch {
    return null;
  }
}

function parseMessage(object: Record<string, unknown> | undefined): VkMessage | null {
  const value = object?.message;
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<VkMessage>;
  if (
    !Number.isInteger(message.from_id) ||
    !Number.isInteger(message.peer_id) ||
    typeof message.text !== "string"
  ) return null;
  return message as VkMessage;
}

function parseMessageEvent(
  object: Record<string, unknown> | undefined
): VkMessageEvent | null {
  if (!object) return null;
  const event = object as Partial<VkMessageEvent>;
  if (
    typeof event.event_id !== "string" ||
    !Number.isInteger(event.user_id) ||
    !Number.isInteger(event.peer_id)
  ) return null;
  return event as VkMessageEvent;
}

function normalizeDisplayName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 1 && normalized.length <= 40 ? normalized : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Остановлено"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
