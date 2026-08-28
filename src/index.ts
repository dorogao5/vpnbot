import "dotenv/config";
import { loadConfig } from "./config.js";
import { ConfigService } from "./config-service.js";
import { AppDatabase } from "./database.js";
import { createBot } from "./bot.js";
import { BackgroundJobs } from "./jobs.js";
import { OpenVpnGateway } from "./openvpn.js";
import { ServerManager } from "./server-manager.js";
import { TrafficService } from "./traffic-service.js";

const config = loadConfig();
const db = new AppDatabase(config.databaseUrl);
const vpn = new OpenVpnGateway(config.envServers, (key) =>
  key === "new" ? "Новый сервер" : key === "old" ? "Старый сервер" : key
);
const serverManager = new ServerManager(db, vpn, config);
const configService = new ConfigService(db, vpn, serverManager, config.vpnProfile);
const trafficService = new TrafficService(db, vpn, serverManager);
const { bot } = createBot(config, db, configService, trafficService, serverManager);
const jobs = new BackgroundJobs(bot, db, vpn, config, trafficService, serverManager);

const recoveredRequests = await db.releaseProcessingConfigRequests();
if (recoveredRequests > 0) {
  console.warn(
    `Возвращено в очередь незавершённых заявок: ${recoveredRequests}`
  );
}

for (const envServer of Object.values(config.envServers)) {
  await db
    .upsertBuiltinServer({
      key: envServer.key,
      name: envServer.name,
      host: envServer.host,
      port: envServer.port,
      sshUser: envServer.username,
      sshPrivateKey: envServer.privateKey.toString("utf8"),
      hostFingerprint: envServer.hostFingerprint,
    })
    .catch((error) =>
      console.error(`Не удалось синхронизировать сервер ${envServer.key}`, error)
    );
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(`Получен ${signal}, завершаю работу`);
  jobs.stop();
  await bot.stop();
  await db.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await bot.api.setMyCommands([
    { command: "start", description: "Открыть главное меню" },
  ]);
  jobs.start();
  console.info("VPN-бот запущен");
  await bot.start({ allowed_updates: ["message", "callback_query"] });
} catch (error) {
  console.error("Не удалось запустить VPN-бота", error);
  jobs.stop();
  await db.close();
  process.exitCode = 1;
}
