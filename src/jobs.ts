import type { Bot } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import { DateTime } from "luxon";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import type { UserRecord, VpnConfigRecord } from "./domain.js";
import { OpenVpnGateway } from "./openvpn.js";
import { daysUntilExpiry, formatDate, isRevocationDue } from "./time.js";
import { TrafficService } from "./traffic-service.js";

export class BackgroundJobs {
  private readonly tasks: ScheduledTask[] = [];
  private remindersRunning = false;
  private revocationsRunning = false;
  private delayedRevocationsRunning = false;
  private trafficRunning = false;

  constructor(
    private readonly bot: Bot,
    private readonly db: AppDatabase,
    private readonly vpn: OpenVpnGateway,
    private readonly config: AppConfig,
    private readonly traffic: TrafficService
  ) {}

  start(): void {
    this.tasks.push(
      cron.schedule(
        `0 ${this.config.reminderHour} * * *`,
        () => void this.sendReminders(),
        { timezone: this.config.timezone }
      )
    );
    this.tasks.push(
      cron.schedule("5 * * * *", () => void this.revokeExpired(), {
        timezone: this.config.timezone,
      })
    );
    this.tasks.push(
      cron.schedule("* * * * *", () => void this.syncTraffic(), {
        timezone: this.config.timezone,
      })
    );
    this.tasks.push(
      cron.schedule("* * * * *", () => void this.revokeRecreatedClients(), {
        timezone: this.config.timezone,
      })
    );
    void this.sendReminders();
    void this.revokeExpired();
    void this.syncTraffic();
    void this.revokeRecreatedClients();
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
  }

  async sendReminders(now = DateTime.now()): Promise<void> {
    if (this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      const localDate = now.setZone(this.config.timezone).toISODate()!;
      const remindersByUser = new Map<
        string,
        {
          user: UserRecord;
          items: Array<{
            config: VpnConfigRecord;
            days: number;
            kind: string;
          }>;
        }
      >();

      for (const { config, user } of await this.db.listReminderCandidates()) {
        const days = daysUntilExpiry(
          config.expiresAt,
          this.config.timezone,
          now
        );
        if (![1, 2, 3].includes(days)) continue;
        const kind = `expires_${days}`;
        if (await this.db.notificationWasSent(config.id, kind, localDate)) continue;

        const batch = remindersByUser.get(user.telegramId) ?? {
          user,
          items: [],
        };
        batch.items.push({ config, days, kind });
        remindersByUser.set(user.telegramId, batch);
      }

      for (const { user, items } of remindersByUser.values()) {
        items.sort((left, right) =>
          left.config.expiresAt.localeCompare(right.config.expiresAt)
        );
        const heading = items.length === 1
          ? "⚠️ Скоро закончится срок действия VPN-конфига:"
          : "⚠️ Скоро закончится срок действия нескольких VPN-конфигов:";
        const lines = items.map(
          ({ config, days }) =>
            `• «${config.displayName}» — через ${days} ${dayWord(days)}, до ${formatDate(config.expiresAt, this.config.timezone)}`
        );

        try {
          await this.bot.api.sendMessage(
            user.telegramId,
            `${heading}\n\n${lines.join("\n")}\n\n💳 Для продления оплатите подписку и после оплаты сообщите администратору.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "💬 Сообщить об оплате",
                      url: this.config.contactUrl,
                    },
                  ],
                ],
              },
            }
          );
          await this.db.markNotificationsSent(
            items.map(({ config, kind }) => ({ configId: config.id, kind })),
            localDate
          );
        } catch (error) {
          console.error(
            `Не удалось отправить напоминание пользователю ${user.telegramId}`,
            error
          );
        }
      }
    } finally {
      this.remindersRunning = false;
    }
  }

  async revokeExpired(now = DateTime.now()): Promise<void> {
    if (this.revocationsRunning) return;
    this.revocationsRunning = true;
    try {
      for (const config of await this.db.listActiveConfigs()) {
        if (!isRevocationDue(config.expiresAt, now)) continue;
        try {
          await this.vpn.revokeClient(config.serverKey, config.clientName);
          await this.db.markExpired(config.id);
        } catch (error) {
          console.error(
            `Не удалось автоматически отозвать ${config.clientName}`,
            error
          );
        }
      }
    } finally {
      this.revocationsRunning = false;
    }
  }

  async syncTraffic(): Promise<void> {
    if (this.trafficRunning) return;
    this.trafficRunning = true;
    try {
      await this.traffic.syncAll();
    } finally {
      this.trafficRunning = false;
    }
  }

  async revokeRecreatedClients(now = DateTime.now()): Promise<void> {
    if (this.delayedRevocationsRunning) return;
    this.delayedRevocationsRunning = true;
    try {
      for (const pending of await this.db.listDuePendingRevocations(now.toJSDate())) {
        try {
          await this.vpn.revokeClient(pending.serverKey, pending.clientName);
          await this.db.completePendingRevocation(pending.id);
        } catch (error) {
          console.error(
            `Не удалось отозвать ранее пересозданный клиент ${pending.clientName}`,
            error
          );
          await this.db.markPendingRevocationFailed(
            pending.id,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } finally {
      this.delayedRevocationsRunning = false;
    }
  }
}

function dayWord(days: number): string {
  return days === 1 ? "день" : "дня";
}
