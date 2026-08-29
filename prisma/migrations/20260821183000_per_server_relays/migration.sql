ALTER TABLE "vpn_servers"
  ADD COLUMN "relay_port" INTEGER,
  ADD COLUMN "relay_managed" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "vpn_servers_relay_port_key"
  ON "vpn_servers"("relay_port");
