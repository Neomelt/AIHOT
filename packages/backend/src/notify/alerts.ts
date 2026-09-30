// Attempt each enabled alert channel even when another fails. A partial success is logged, not
// retried here: repeating the successful channel would duplicate an alert already delivered.
import { sendFeishuAlert } from "./feishu.ts";
import { sendTelegramAlert } from "./telegram.ts";

export async function sendAlert(title: string, lines: string[]): Promise<"sent" | "disabled"> {
  const results = await Promise.allSettled([sendFeishuAlert(title, lines), sendTelegramAlert(title, lines)]);
  const errors = results.flatMap((r, i) => r.status === "rejected" ? [`${i === 0 ? "Feishu" : "Telegram"}: ${String(r.reason)}`] : []);
  if (results.some((r) => r.status === "fulfilled" && r.value === "sent")) {
    if (errors.length) console.error(JSON.stringify({ level: "error", msg: "some alert channels failed", errors }));
    return "sent";
  }
  if (errors.length) throw new Error(errors.join("; "));
  console.log(JSON.stringify({ level: "warn", msg: "alert (not sent: no notification channel is enabled)", title, lines }));
  return "disabled";
}
