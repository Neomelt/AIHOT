-- Telegram delivery targets for selected content. The existing Feishu targets remain unchanged.
ALTER TABLE notify_targets DROP CONSTRAINT IF EXISTS notify_targets_kind_check;
ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_kind_check CHECK (kind IN ('feishu_webhook', 'feishu_chat', 'telegram_bot', 'log'));

INSERT INTO notify_targets (key, purpose, kind, enabled, config_ref, note)
VALUES ('telegram-content-main', 'content', 'telegram_bot', false, 'TELEGRAM_BOT_TOKEN', 'Telegram 精选内容')
ON CONFLICT (key) DO NOTHING;
