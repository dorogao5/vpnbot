import { randomInt } from "node:crypto";

const VK_API_VERSION = "5.199";
const DOCUMENT_UPLOAD_ATTEMPTS = 3;
const DOCUMENT_UPLOAD_RETRY_DELAY_MS = 500;

export interface VkLongPollServer {
  key: string;
  server: string;
  ts: string;
}

export interface VkLongPollUpdate {
  type: string;
  group_id?: number;
  event_id?: string;
  object?: Record<string, unknown>;
}

export interface VkLongPollResponse {
  ts?: string;
  updates?: VkLongPollUpdate[];
  failed?: number;
}

export interface VkUserProfile {
  id: number;
  first_name: string;
  last_name: string;
  screen_name?: string;
}

interface VkApiEnvelope<T> {
  response?: T;
  error?: {
    error_code: number;
    error_msg: string;
  };
}

export class VkApiError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(`VK API ${code}: ${message}`);
    this.name = "VkApiError";
  }
}

export class VkApiClient {
  constructor(
    private readonly token: string,
    readonly groupId: number,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getLongPollServer(): Promise<VkLongPollServer> {
    const response = await this.call<{
      key: string;
      server: string;
      ts: string | number;
    }>("groups.getLongPollServer", { group_id: this.groupId });
    return { ...response, ts: String(response.ts) };
  }

  async checkLongPoll(
    server: VkLongPollServer,
    signal: AbortSignal,
    waitSeconds = 25
  ): Promise<VkLongPollResponse> {
    const url = new URL(server.server);
    url.searchParams.set("act", "a_check");
    url.searchParams.set("key", server.key);
    url.searchParams.set("ts", server.ts);
    url.searchParams.set("wait", String(waitSeconds));
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok) {
      throw new Error(`VK Long Poll вернул HTTP ${response.status}`);
    }
    return response.json() as Promise<VkLongPollResponse>;
  }

  async getUser(userId: number): Promise<VkUserProfile> {
    const users = await this.call<VkUserProfile[]>("users.get", {
      user_ids: userId,
      fields: "screen_name",
    });
    const user = users[0];
    if (!user) throw new Error(`VK не вернул пользователя ${userId}`);
    return user;
  }

  async sendMessage(input: {
    peerId: number;
    message: string;
    keyboard?: string;
    attachment?: string;
  }): Promise<number> {
    return this.call<number>("messages.send", {
      peer_id: input.peerId,
      random_id: randomInt(1, 2_147_483_647),
      message: input.message,
      ...(input.keyboard ? { keyboard: input.keyboard } : {}),
      ...(input.attachment ? { attachment: input.attachment } : {}),
    });
  }

  async editMessage(input: {
    peerId: number;
    conversationMessageId: number;
    message: string;
    keyboard?: string;
  }): Promise<void> {
    await this.call("messages.edit", {
      peer_id: input.peerId,
      cmid: input.conversationMessageId,
      message: input.message,
      ...(input.keyboard ? { keyboard: input.keyboard } : {}),
    });
  }

  async answerMessageEvent(input: {
    eventId: string;
    userId: number;
    peerId: number;
  }): Promise<void> {
    await this.call("messages.sendMessageEventAnswer", {
      event_id: input.eventId,
      user_id: input.userId,
      peer_id: input.peerId,
    });
  }

  async sendDocument(input: {
    peerId: number;
    file: Buffer;
    fileName: string;
    message: string;
  }): Promise<void> {
    let attachment: string | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= DOCUMENT_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        attachment = await this.uploadDocument(input);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < DOCUMENT_UPLOAD_ATTEMPTS) {
          await delay(DOCUMENT_UPLOAD_RETRY_DELAY_MS * attempt);
        }
      }
    }
    if (!attachment) throw lastError;
    await this.sendMessage({
      peerId: input.peerId,
      message: input.message,
      attachment,
    });
  }

  private async uploadDocument(input: {
    peerId: number;
    file: Buffer;
    fileName: string;
  }): Promise<string> {
    const upload = await this.call<{ upload_url: string }>(
      "docs.getMessagesUploadServer",
      { type: "doc", peer_id: input.peerId }
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.file)], { type: "application/octet-stream" }),
      input.fileName
    );
    const uploadedResponse = await this.fetchImpl(upload.upload_url, {
      method: "POST",
      body: form,
    });
    if (!uploadedResponse.ok) {
      throw new Error(`VK upload вернул HTTP ${uploadedResponse.status}`);
    }
    const uploaded = await uploadedResponse.json() as {
      file?: string;
      error?: string;
      error_msg?: string;
    };
    if (!uploaded.file) {
      const reason = uploaded.error_msg ?? uploaded.error;
      throw new Error(
        `VK upload не вернул идентификатор файла${reason ? `: ${reason}` : ""}`
      );
    }

    const saved = await this.call<unknown>("docs.save", {
      file: uploaded.file,
      title: input.fileName,
    });
    const document = savedDocument(saved);
    return `doc${document.ownerId}_${document.id}`;
  }

  private async call<T = unknown>(
    method: string,
    params: Record<string, string | number | boolean>
  ): Promise<T> {
    const body = new URLSearchParams();
    body.set("access_token", this.token);
    body.set("v", VK_API_VERSION);
    for (const [key, value] of Object.entries(params)) {
      body.set(key, String(value));
    }
    const response = await this.fetchImpl(
      `https://api.vk.com/method/${method}`,
      { method: "POST", body }
    );
    if (!response.ok) throw new Error(`VK API вернул HTTP ${response.status}`);
    const envelope = await response.json() as VkApiEnvelope<T>;
    if (envelope.error) {
      throw new VkApiError(envelope.error.error_code, envelope.error.error_msg);
    }
    if (!("response" in envelope)) {
      throw new Error(`VK API ${method} вернул пустой ответ`);
    }
    return envelope.response as T;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function savedDocument(value: unknown): { id: number; ownerId: number } {
  const candidate = Array.isArray(value)
    ? value[0]
    : value && typeof value === "object" && "doc" in value
      ? (value as { doc: unknown }).doc
      : value;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("VK docs.save вернул некорректный документ");
  }
  const item = candidate as { id?: unknown; owner_id?: unknown };
  if (!Number.isInteger(item.id) || !Number.isInteger(item.owner_id)) {
    throw new Error("VK docs.save не вернул ID документа");
  }
  return { id: item.id as number, ownerId: item.owner_id as number };
}
