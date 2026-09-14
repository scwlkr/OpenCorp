# Owner Telegram conversation

The company daemon uses the established [Telegram Bot API](https://core.telegram.org/bots/api) over HTTPS with long polling. No public listener, new agent runtime or additional service is required. Telegram and local chat use the same SQLite messages, assignments, CEO identity and company context. Maintained `skills/management.md` guides replies, significant notifications, escalation and occasional reminders.

## Private setup

Use a dedicated bot with no webhook or other polling process. In Telegram, open the verified [BotFather](https://t.me/BotFather), send `/newbot`, and follow its name/username prompts. Save its token directly on your Mac in `<data-dir>/credentials/telegram.key`; never paste it into an employee conversation, issue, repository or log. The default data directory is `~/.local/share/opencorp`.

Create `<data-dir>/credentials/telegram.json` with `ownerUserId` and `chatId`, both the Owner's numeric Telegram user ID. They must match for this private-chat integration. Verify that identity through the Owner's authenticated account; a username, display name or first incoming message is not identity enrollment. Both files must have mode `600`, within the private credentials directory. Configuration is read on daemon start. Existing installations without these files remain unchanged. Restart using `opencorp service install` after the normal build/backup procedure.

Open the bot's private chat and send a text question. The service accepts only ordinary text from the configured numeric Owner ID in that exact private chat. It ignores groups, other senders, edits and nontext attachments. Start company execution to obtain a reply; while paused/stopped incoming messages remain durable and outgoing sends wait. The CEO must be active and have an eligible local engine: Telegram assignments are confidential and cannot silently fall back to hosted inference. No model or policy is changed by setup.

Use `opencorp integrations` and the existing messages, assignments, runs and actions API views to inspect actual progress. A configured adapter or accepted polling request does not prove a real Owner exchange. Observe the incoming message, attributed employee response, successful `telegram.send` receipt and actual private chat.

## Recovery and limitations

Intake and polling offset commit atomically before the next Telegram acknowledgment; repeated updates cannot duplicate assignments. An unavailable CEO does not discard accepted text. Bot API updates expire on Telegram after at most 24 hours, so a longer offline period can lose messages that were never received locally. Shared company history supplies bounded recent context; employees can inspect further authorized records through existing tools.

Outgoing plain-text messages are split into bounded parts, each with a durable intent and receipt. Only succeeded employee runs are sent; service acceptance is distinct from human reading. Explicit employee `send_message` with recipientId `owner` enables substantive notifications. Conversation final replies route automatically and should not also be manually sent. Existing messages before initial Telegram activation are not backfilled.

Telegram `sendMessage` offers neither an idempotency key nor a sent-history lookup. Timeout, ambiguous provider failure or interruption after dispatch therefore holds the send as uncertain. The service never infers absence or blindly retries it. Inspect the Owner's private chat, then use:

```
opencorp telegram-reconcile <action-id> delivered 'Observed this exact message in the private chat'
opencorp telegram-reconcile <action-id> absent 'Checked the private chat and confirmed this message is absent'
```

Only the authenticated local Owner service accepts reconciliation. Confirmed absence permits one retry; unresolved second failures remain held. Reconciliation evidence records the Owner's observation, not independent provider proof. Multipart continuations wait for earlier parts. Backups preserve newer intake, offsets and external receipts during restore; an interrupted restored conversation remains blocked for ordinary run reconciliation. Changing the configured bot/Owner identity is refused while the old binding is retained, to avoid routing old messages to a new recipient.

For exact reserved decisions, see [Owner proposals](OWNER_PROPOSALS.md). Ordinary conversational assent never changes permissions. Use `/full`, `/low`, and `/stop` for [shared power controls](POWER_CONTROLS.md); their direct receipts can send even while stopped. Protect the company data directory and backups as private; credentials stay in service-only files and never enter model context or transport error logs.
