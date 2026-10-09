// The bot's commands, in menu order. Client-safe: the worker registers them and Settings > Telegram lists them.

/** Command names stay the same in every language; their descriptions are `telegram.commands.<name>`. */
export const TELEGRAM_COMMANDS = ["status", "waiting", "tasks", "new", "stop", "resume"] as const;
export type TelegramCommand = (typeof TELEGRAM_COMMANDS)[number];
