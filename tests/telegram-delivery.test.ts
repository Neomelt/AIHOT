// Real delivery ledger, mocked Telegram transport. No request can leave this process.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { deliverContent, resendDelivery, type DeliveryRequest } from "@aihot/backend/notify/deliver";
import { sendTelegramAlert } from "@aihot/backend/notify/telegram";

const T = tag();
const TARGET = `test-telegram-${T}`;
const FEISHU = `test-feishu-${T}`;
const enabledAt = new Date();
const telegram = { text: "中文精选 <b>原样文本</b>", links: [{ text: "阅读", url: "https://example.com/item" }] };
const realFetch = globalThis.fetch;
const saved = { content: config.telegramContentPushEnabled, alert: config.telegramAlertEnabled, feishu: config.feishuContentPushEnabled };
const envNames = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALERT_CHAT_ID"] as const;
const savedEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
const requests: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
let reply: () => Response = () => Response.json({ ok: true, result: { message_id: 17 } });
const request = (key: string): DeliveryRequest => ({
  subjectKind: "selected", subjectId: `${T}-${key}`, dedupeKey: `${T}-${key}`, contentAt: new Date(),
  card: { header: { title: { content: "Feishu card" } } }, telegram,
});
const row = async (key: string) => (await sql`SELECT * FROM deliveries WHERE target_key = ${TARGET} AND dedupe_key = ${`${T}-${key}`}`)[0]!;

before(async () => {
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://api.telegram.org/bot123:test-token/sendMessage");
    requests.push(JSON.parse(String(init?.body)));
    return reply();
  }) as typeof fetch;
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_CHAT_ID = "-100123";
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
  config.feishuContentPushEnabled = false;
  config.telegramContentPushEnabled = false;
  config.telegramAlertEnabled = false;
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, config_ref) VALUES
    (${TARGET}, 'content', 'telegram_bot', true, ${enabledAt}, 'TELEGRAM_BOT_TOKEN'),
    (${FEISHU}, 'content', 'feishu_webhook', true, ${enabledAt}, 'FEISHU_PUSH_WEBHOOK_URL')`;
});

after(async () => {
  globalThis.fetch = realFetch;
  config.telegramContentPushEnabled = saved.content;
  config.telegramAlertEnabled = saved.alert;
  config.feishuContentPushEnabled = saved.feishu;
  for (const key of envNames) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await sql`DELETE FROM deliveries WHERE target_key IN (${TARGET}, ${FEISHU})`;
  await sql`DELETE FROM notify_targets WHERE key IN (${TARGET}, ${FEISHU})`;
  await closeDb();
});

test("Telegram's safety valve records a skip without sending", async () => {
  await deliverContent(request("disabled"));
  assert.equal((await row("disabled")).status, "skipped");
  assert.equal(requests.length, 0);
});

test("Telegram sends once per target and keeps its own payload while Feishu stays disabled", async () => {
  config.telegramContentPushEnabled = true; // The transport above remains fully mocked.
  const before = requests.length;
  await deliverContent(request("sent"));
  const sent = await row("sent");
  assert.equal(sent.status, "sent");
  assert.equal(sent.attempts, 1);
  assert.deepEqual(sent.payload, telegram);
  assert.equal(requests.at(-1)!.chat_id, "-100123");
  assert.deepEqual(await deliverContent(request("sent")), []);
  assert.equal(requests.length, before + 1);
  const [feishu] = await sql`SELECT status FROM deliveries WHERE target_key = ${FEISHU} AND dedupe_key = ${`${T}-sent`}`;
  assert.equal(feishu!.status, "skipped");
});

test("old content and Codex reset cards do not produce Telegram deliveries", async () => {
  const before = requests.length;
  await deliverContent({ ...request("old"), contentAt: new Date(enabledAt.getTime() - 1) });
  await deliverContent({ ...request("reset"), subjectKind: "codex_reset" });
  assert.equal(await row("old"), undefined);
  assert.equal(await row("reset"), undefined);
  assert.equal(requests.length, before);
});

test("Telegram rejections are failed; uncertain requests stay unknown until one manual resend", async () => {
  reply = () => Response.json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 30 } }, { status: 429 });
  await deliverContent(request("refused"));
  assert.equal((await row("refused")).status, "failed");
  assert.match((await row("refused")).response, /retry after 30s/);

  reply = () => { throw new Error("timeout with token 123:test-token"); };
  await deliverContent(request("unknown"));
  const unknown = await row("unknown");
  assert.equal(unknown.status, "unknown");
  assert.doesNotMatch(unknown.response, /123:test-token/);
  const before = requests.length;
  await deliverContent(request("unknown"));
  assert.equal(requests.length, before, "no automatic resend");

  reply = () => Response.json({ ok: true, result: { message_id: 18 } });
  const results = await Promise.allSettled([resendDelivery(unknown.id), resendDelivery(unknown.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(requests.length, before + 1, "two operator requests cannot send twice");
  assert.equal((await row("unknown")).status, "sent");
  assert.equal((await row("unknown")).attempts, 2);
  assert.deepEqual(requests.at(-1)!.reply_markup, { inline_keyboard: [telegram.links] });
});

test("alerts require their own chat id and never fall back to the content channel", async () => {
  const before = requests.length;
  assert.equal(await sendTelegramAlert("告警", ["测试"]), "disabled");
  config.telegramAlertEnabled = true;
  await assert.rejects(sendTelegramAlert("告警", ["测试"]), /TELEGRAM_ALERT_CHAT_ID/);
  assert.equal(requests.length, before);
  process.env.TELEGRAM_ALERT_CHAT_ID = "-100456";
  assert.equal(await sendTelegramAlert("告警", ["测试"]), "sent");
  assert.equal(requests.at(-1)!.chat_id, "-100456");
});
