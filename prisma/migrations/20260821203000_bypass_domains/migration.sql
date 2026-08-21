CREATE TABLE "bypass_domains" (
    "id" SERIAL NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bypass_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bypass_domains_domain_key" ON "bypass_domains"("domain");
