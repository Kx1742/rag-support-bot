import type { ChatMessage } from "../types.ts";

export const LIMITS = {
  messageChars: 1000,
  historyItems: 10,
  historyItemChars: 4000,
  bodyBytes: 64 * 1024,
};

export class ValidationError extends Error {}

/** Checks the chat request body. Never trust what the browser sends. */
export function parseChatBody(body: unknown): { message: string; history: ChatMessage[] } {
  if (!body || typeof body !== "object") throw new ValidationError("Body must be a JSON object");
  const { message, history = [] } = body as { message?: unknown; history?: unknown };

  if (typeof message !== "string" || !message.trim()) throw new ValidationError("message is required");
  if (message.length > LIMITS.messageChars) {
    throw new ValidationError(`message is too long (max ${LIMITS.messageChars} characters)`);
  }
  if (!Array.isArray(history)) throw new ValidationError("history must be an array");

  const cleanHistory = history.slice(-LIMITS.historyItems).map((item, i): ChatMessage => {
    const { role, text } = (item ?? {}) as { role?: unknown; text?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
      throw new ValidationError(`history[${i}] must be { role: "user" | "assistant", text: string }`);
    }
    return { role, text: text.slice(0, LIMITS.historyItemChars) };
  });

  return { message: message.trim(), history: cleanHistory };
}
