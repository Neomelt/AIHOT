// Telegram Bot API delivery. Messages are plain text on purpose: source content is untrusted and
// should not be interpreted as Markdown or HTML by Telegram.
import { config, credential } from "../config.ts";

const API = "https://api.telegram.org";
const MAX_TEXT = 4096;

export interface TelegramMessage {
  text: string;
  links?: Array<{ text: string; url: string }>;
}

function trimText(text: string): string {
  // Count UTF-16 units conservatively and never cut an emoji in half.
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

export async function postTelegramMessage(
  botToken: string,
  chatId: string,
  message: TelegramMessage,
): Promise<{ ok: boolean; status: number; body: string }> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: trimText(message.text),
        link_preview_options: { is_disabled: true },
        ...(message.links?.length ? { reply_markup: { inline_keyboard: [message.links] } } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.text();
  } catch {
    // Fetch errors can include the request URL (and thus the bot token). Never persist them.
    throw new Error("Telegram request failed or timed out; delivery outcome is unknown");
  }
  let json: { ok?: boolean; description?: string; result?: { message_id?: number }; parameters?: { retry_after?: number } } | null = null;
  try { json = JSON.parse(body); } catch { /* An HTML/proxy response is not confirmation. */ }
  if (res.ok && json?.ok === true && Number.isSafeInteger(json.result?.message_id)) {
    return { ok: true, status: res.status, body: JSON.stringify({ ok: true, message_id: json.result!.message_id }) };
  }
  if (res.ok && json?.ok !== false) throw new Error("Telegram returned no delivery confirmation; delivery outcome is unknown");
  const description = typeof json?.description === "string" ? json.description : `Telegram HTTP ${res.status}`;
  const retry = Number.isSafeInteger(json?.parameters?.retry_after) ? `; retry after ${json!.parameters!.retry_after}s` : "";
  return { ok: false, status: res.status, body: (description + retry).replaceAll(botToken, "[redacted]").replaceAll(encodeURIComponent(botToken), "[redacted]").slice(0, 500) };
}

export async function sendTelegramAlert(title: string, lines: string[]): Promise<"sent" | "disabled"> {
  if (!config.telegramAlertEnabled) return "disabled";
  const token = credential("integrations", "TELEGRAM_BOT_TOKEN");
  // Operations details must never fall back to a potentially public content channel.
  const chatId = credential("integrations", "TELEGRAM_ALERT_CHAT_ID");
  if (!token || !chatId) {
    throw new Error("Telegram alerts require TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID");
  }
  const prefix = config.environmentName === "production" ? "" : `【${config.environmentName}】`;
  const res = await postTelegramMessage(token, chatId, { text: `${prefix}${title}\n${lines.join("\n")}` });
  if (!res.ok) throw new Error(`telegram send: ${res.body || res.status}`);
  return "sent";
}
