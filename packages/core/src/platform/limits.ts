// Limits shared by server code and client forms. Keep this module free of server-only imports.

/** Longest memory entry the forms accept. */
export const MEMORY_MAX_LENGTH = 10_000;

/** A skill folder: number of files, size of one file and of the whole folder, in bytes of UTF-8 text. */
export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_FILE_BYTES = 1024 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** Largest stored file: an upload, a file an agent shares or hands over (also Telegram's limit for bot uploads). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;

/** Shortest account password (sign-up, password change and the auth server). */
export const PASSWORD_MIN_LENGTH = 10;

/** Longest note saved with a new version of an agent or a skill. */
export const VERSION_NOTE_MAX_LENGTH = 300;

/** An agent's name and role (its one-line description). */
export const AGENT_NAME_MAX_LENGTH = 80;
export const AGENT_ROLE_MAX_LENGTH = 200;

/** Longest system prompt of an agent: a specialist's profession, or a manager's additional instructions. */
export const AGENT_PROMPT_MAX_LENGTH = 100_000;

/** A skill's display name, and its description (the Agent Skills format caps it at 1024 characters). */
export const SKILL_NAME_MAX_LENGTH = 120;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
