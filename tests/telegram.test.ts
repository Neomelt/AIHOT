import assert from "node:assert/strict";
import { after, test } from "node:test";
import { postTelegramMessage } from "@aihot/backend/notify/telegram";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

test("Telegram delivery uses the Bot API and keeps message text unparsed", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ ok: true, result: { message_id: 7 } });
  }) as typeof fetch;

  const result = await postTelegramMessage("123:token", "-100123", { text: "标题\n\n摘要", links: [{ text: "阅读", url: "https://example.com/item" }] });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(request?.url, "https://api.telegram.org/bot123:token/sendMessage");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    chat_id: "-100123",
    text: "标题\n\n摘要",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "阅读", url: "https://example.com/item" }]] },
  });
  assert.equal((request?.init?.headers as Record<string, string>)["content-type"], "application/json");
});

test("Telegram delivery truncates text at the Bot API limit", async () => {
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text: string };
    assert.equal(body.text.length, 4096);
    assert.equal(body.text.endsWith("…"), true);
    return Response.json({ ok: true, result: { message_id: 8 } });
  }) as typeof fetch;

  const result = await postTelegramMessage("123:token", "-100123", { text: "x".repeat(5000) });
  assert.equal(result.ok, true);
});

test("Telegram provider errors do not persist the bot token", async () => {
  globalThis.fetch = (async () => Response.json({ ok: false, description: "Unauthorized: 123:token" }, { status: 401 })) as typeof fetch;

  const result = await postTelegramMessage("123:token", "-100123", { text: "测试" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.doesNotMatch(result.body, /123:token/);
  assert.match(result.body, /redacted/);
});

test("an HTTP success without a Telegram message id is an unknown outcome", async () => {
  for (const body of ["upstream proxy", JSON.stringify({ ok: true, result: {} })]) {
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    await assert.rejects(postTelegramMessage("123:token", "-100123", { text: "测试" }), /outcome is unknown/);
  }
});

test("a transport error cannot leak the token through a persisted exception", async () => {
  globalThis.fetch = (async () => { throw new Error("request https://api.telegram.org/bot123:token/sendMessage timed out"); }) as typeof fetch;
  await assert.rejects(postTelegramMessage("123:token", "-100123", { text: "测试" }), (error: Error) => {
    assert.match(error.message, /outcome is unknown/);
    assert.doesNotMatch(error.message, /123:token/);
    return true;
  });
});
