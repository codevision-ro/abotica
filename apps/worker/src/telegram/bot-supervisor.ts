/** What the supervisor needs from a bot; grammY's Bot has it. */
type PollingBot = { isRunning(): boolean; stop(): Promise<void> };

/**
 * Keeps one bot polling for the token in the vault. `reload` runs at startup and whenever the token may
 * have changed (Settings > Telegram): a new token stops the old bot and launches a new one, no token
 * stops it, and the same token leaves a running bot alone. Reloads run one after another, so quick
 * saves never leave two bots polling.
 */
export function createBotSupervisor<B extends PollingBot>(deps: {
  readToken: () => Promise<string | undefined>;
  /** Creates the bot and starts polling in the background; failures are reported by the bot itself. */
  launch: (token: string) => B;
  /** There is no token; `stopped` says whether a bot was running until now. */
  onMissing: (stopped: boolean) => Promise<void>;
}) {
  let current: { token: string; bot: B } | null = null;
  let closing = false;
  let queue: Promise<void> = Promise.resolve();

  async function apply() {
    if (closing) return;
    const token = (await deps.readToken()) ?? null;
    // A bot that stopped polling (a revoked token, another instance polling) is started again.
    if (current && current.token === token && current.bot.isRunning()) return;
    const previous = current;
    current = null;
    await previous?.bot.stop().catch((error: unknown) => console.error("[telegram] stopping the bot:", error));
    if (!token) return deps.onMissing(previous !== null);
    current = { token, bot: deps.launch(token) };
  }

  return {
    /** The bot to send with; null without a token. After `close` it still sends, it only stops polling. */
    bot: (): B | null => current?.bot ?? null,
    /** Whether `bot` is the one polling now; false for a bot replaced or stopped on purpose. */
    owns: (bot: B): boolean => !closing && current?.bot === bot,
    reload(): Promise<void> {
      queue = queue.then(apply).catch((error: unknown) => console.error("[telegram] reloading the bot:", error));
      return queue;
    },
    /** Stops polling for shutdown; replies of runs that are still finishing go out through `bot()`. */
    close(): Promise<void> {
      closing = true;
      queue = queue.then(() => current?.bot.stop());
      return queue;
    },
  };
}
