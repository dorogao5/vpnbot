import { createHash, randomBytes } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { UserRecord } from "./domain.js";

const LINK_TTL_MS = 10 * 60 * 1000;
const LINK_CODE = /^VK-([A-F0-9]{12})$/i;

export function hashAccountLinkCode(code: string): string {
  return createHash("sha256")
    .update(code.trim().toUpperCase(), "utf8")
    .digest("hex");
}

export async function createVkAccountLinkCode(
  db: AppDatabase,
  userId: number,
  now = new Date()
): Promise<string> {
  const code = `VK-${randomBytes(6).toString("hex").toUpperCase()}`;
  await db.createAccountLinkToken({
    userId,
    provider: "vk",
    tokenHash: hashAccountLinkCode(code),
    expiresAt: new Date(now.getTime() + LINK_TTL_MS),
  });
  return code;
}

export async function consumeVkAccountLinkCode(
  db: AppDatabase,
  input: {
    code: string;
    vkId: string;
    peerId: string;
    username?: string;
    firstName: string;
  }
): Promise<UserRecord | null> {
  const normalized = input.code.trim().toUpperCase();
  if (!LINK_CODE.test(normalized)) return null;
  return db.consumeVkAccountLink({
    tokenHash: hashAccountLinkCode(normalized),
    vkId: input.vkId,
    peerId: input.peerId,
    ...(input.username ? { username: input.username } : {}),
    firstName: input.firstName,
  });
}

export function isVkAccountLinkCode(value: string): boolean {
  return LINK_CODE.test(value.trim());
}
