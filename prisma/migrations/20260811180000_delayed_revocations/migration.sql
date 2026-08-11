CREATE TABLE "pending_revocations" (
    "id" SERIAL NOT NULL,
    "config_id" UUID NOT NULL,
    "server_key" "ServerKey" NOT NULL,
    "client_name" VARCHAR(64) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_revocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_revocations_server_key_client_name_key"
ON "pending_revocations"("server_key", "client_name");

CREATE INDEX "pending_revocations_scheduled_at_idx"
ON "pending_revocations"("scheduled_at");
