import { describe, expect, it, vi } from "vitest";
import { VkApiClient, VkApiError } from "../src/vk-api.js";

describe("VkApiClient", () => {
  it("получает Bots Long Poll, передавая токен только в POST body", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.vk.com/method/groups.getLongPollServer");
      const body = init?.body as URLSearchParams;
      expect(body.get("access_token")).toBe("secret");
      expect(body.get("group_id")).toBe("123");
      return Response.json({
        response: { key: "key", server: "https://lp.vk.test", ts: 42 },
      });
    });
    const api = new VkApiClient("secret", 123, request as typeof fetch);

    await expect(api.getLongPollServer()).resolves.toEqual({
      key: "key",
      server: "https://lp.vk.test",
      ts: "42",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("преобразует ошибку VK API в типизированную ошибку", async () => {
    const request = vi.fn(async () => Response.json({
      error: { error_code: 901, error_msg: "Can't send messages" },
    }));
    const api = new VkApiClient("secret", 123, request as typeof fetch);

    await expect(api.sendMessage({ peerId: 1, message: "test" }))
      .rejects.toEqual(new VkApiError(901, "Can't send messages"));
  });

  it("редактирует сообщение сообщества по conversation message id", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.vk.com/method/messages.edit");
      const body = init?.body as URLSearchParams;
      expect(body.get("peer_id")).toBe("10");
      expect(body.get("cmid")).toBe("42");
      expect(body.get("message")).toBe("Обновлено");
      expect(body.get("keyboard")).toBe("keyboard");
      return Response.json({ response: 1 });
    });
    const api = new VkApiClient("secret", 123, request as typeof fetch);

    await expect(api.editMessage({
      peerId: 10,
      conversationMessageId: 42,
      message: "Обновлено",
      keyboard: "keyboard",
    })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it("повторяет временно неудачную загрузку документа", async () => {
    let uploadAttempts = 0;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://upload.vk.test") {
        uploadAttempts += 1;
        return Response.json(
          uploadAttempts === 1
            ? { error: "temporary" }
            : { file: "uploaded-file" }
        );
      }
      if (url.endsWith("docs.getMessagesUploadServer")) {
        return Response.json({ response: { upload_url: "https://upload.vk.test" } });
      }
      if (url.endsWith("docs.save")) {
        return Response.json({ response: [{ id: 7, owner_id: -123 }] });
      }
      if (url.endsWith("messages.send")) {
        return Response.json({ response: 99 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const api = new VkApiClient("secret", 123, request as typeof fetch);

    await expect(api.sendDocument({
      peerId: 10,
      file: Buffer.from("config"),
      fileName: "test.ovpn",
      message: "Файл",
    })).resolves.toBeUndefined();
    expect(uploadAttempts).toBe(2);
  });

  it("собирает callback-клавиатуру с JSON payload", async () => {
    const { keyboard } = await import("../src/vk-bot.js");
    const value = JSON.parse(keyboard([[
      { label: "Мои конфиги", action: { a: "list", page: 2 }, color: "primary" },
    ]]));

    expect(value.inline).toBe(true);
    expect(value.buttons[0][0].action.type).toBe("callback");
    expect(JSON.parse(value.buttons[0][0].action.payload)).toEqual({
      a: "list",
      page: 2,
    });
  });
});
