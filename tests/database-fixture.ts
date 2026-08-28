import { AppDatabase } from "../src/database.js";

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgresql://vpnbot:vpnbot_test@localhost:55432/vpnbot_test";

export async function createCleanDatabase(): Promise<AppDatabase> {
  const db = new AppDatabase(databaseUrl);
  await db.prisma.$transaction([
    db.prisma.configRequest.deleteMany(),
    db.prisma.pendingRevocation.deleteMany(),
    db.prisma.trafficEvent.deleteMany(),
    db.prisma.notification.deleteMany(),
    db.prisma.legacyClient.deleteMany(),
    db.prisma.clientName.deleteMany(),
    db.prisma.vpnConfig.deleteMany(),
    db.prisma.user.deleteMany(),
    db.prisma.vpnServer.deleteMany(),
  ]);
  return db;
}
