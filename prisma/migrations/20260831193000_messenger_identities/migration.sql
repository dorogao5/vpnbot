-- AlterTable
ALTER TABLE "users" ALTER COLUMN "telegram_id" DROP NOT NULL;

-- CreateEnum
CREATE TYPE "MessengerProvider" AS ENUM ('telegram', 'vk');

-- CreateTable
CREATE TABLE "messenger_identities" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "provider" "MessengerProvider" NOT NULL,
    "external_id" TEXT NOT NULL,
    "peer_id" TEXT,
    "username" TEXT,
    "can_message" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "messenger_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_link_tokens" (
    "id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "provider" "MessengerProvider" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_link_tokens_pkey" PRIMARY KEY ("id")
);

-- Preserve every existing Telegram account as an explicit messenger identity.
INSERT INTO "messenger_identities" (
    "user_id", "provider", "external_id", "peer_id", "username", "updated_at"
)
SELECT
    "id", 'telegram'::"MessengerProvider", "telegram_id", "telegram_id", "username", CURRENT_TIMESTAMP
FROM "users"
WHERE "telegram_id" IS NOT NULL;

CREATE UNIQUE INDEX "messenger_identities_provider_external_id_key"
ON "messenger_identities"("provider", "external_id");

CREATE UNIQUE INDEX "messenger_identities_user_id_provider_key"
ON "messenger_identities"("user_id", "provider");

CREATE INDEX "messenger_identities_provider_can_message_idx"
ON "messenger_identities"("provider", "can_message");

CREATE UNIQUE INDEX "account_link_tokens_token_hash_key"
ON "account_link_tokens"("token_hash");

CREATE INDEX "account_link_tokens_provider_expires_at_idx"
ON "account_link_tokens"("provider", "expires_at");

ALTER TABLE "messenger_identities" ADD CONSTRAINT "messenger_identities_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_link_tokens" ADD CONSTRAINT "account_link_tokens_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
