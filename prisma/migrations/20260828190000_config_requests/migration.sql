CREATE TYPE "ConfigRequestStatus" AS ENUM ('pending', 'processing', 'approved', 'rejected');

CREATE TABLE "config_requests" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" "ConfigRequestStatus" NOT NULL DEFAULT 'pending',
    "config_id" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "config_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "config_requests_status_requested_at_idx"
    ON "config_requests"("status", "requested_at");

CREATE INDEX "config_requests_user_id_idx"
    ON "config_requests"("user_id");

CREATE UNIQUE INDEX "config_requests_one_open_per_user_idx"
    ON "config_requests"("user_id")
    WHERE "status" IN ('pending', 'processing');

ALTER TABLE "config_requests"
    ADD CONSTRAINT "config_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "config_requests"
    ADD CONSTRAINT "config_requests_config_id_fkey"
    FOREIGN KEY ("config_id") REFERENCES "vpn_configs"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
