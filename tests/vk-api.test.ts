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
