-- AlterTable
ALTER TABLE "legacy_clients"
  ALTER COLUMN "server_key" SET DATA TYPE VARCHAR(32),
  ALTER COLUMN "server_key" SET DEFAULT 'old';

ALTER TABLE "pending_revocations"
  ALTER COLUMN "server_key" SET DATA TYPE VARCHAR(32),
  ALTER COLUMN "server_key" SET DEFAULT 'old';

ALTER TABLE "traffic_events"
  ALTER COLUMN "server_key" SET DATA TYPE VARCHAR(32),
  ALTER COLUMN "server_key" SET DEFAULT 'old';

ALTER TABLE "vpn_configs"
  ALTER COLUMN "server_key" SET DATA TYPE VARCHAR(32),
  ALTER COLUMN "server_key" SET DEFAULT 'old';

-- DropEnum
DROP TYPE "ServerKey";

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('ready', 'pending', 'error');

-- CreateTable
CREATE TABLE "vpn_servers" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "ssh_user" TEXT NOT NULL DEFAULT 'vpn-bot',
    "ssh_private_key" TEXT NOT NULL,
    "host_fingerprint" TEXT NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'ready',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vpn_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vpn_servers_key_key" ON "vpn_servers"("key");
