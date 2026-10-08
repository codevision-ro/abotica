// Limits shared by server code and client forms. Keep this module free of server-only imports.

/** Longest memory entry the forms accept. */
export const MEMORY_MAX_LENGTH = 10_000;

/** Longest text of the instructions for all agents (Settings), which goes into every system prompt. */
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 10_000;

/** A skill folder: number of files, size of one file and of the whole folder, in bytes of UTF-8 text. */
export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_FILE_BYTES = 1024 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** Largest stored file: an upload, a file an agent shares or hands over (also Telegram's limit for bot uploads). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
