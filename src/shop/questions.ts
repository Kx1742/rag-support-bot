import type { DatabaseSync } from "node:sqlite";
import { keywords } from "../llm/offline.ts";
import { ShopError } from "./errors.ts";

/** Questions older than this are deleted: enough for trends, not a permanent record of what people asked. */
export const KEEP_DAYS = 90;

export interface UnansweredTopic {
  /** Grouping key (the question's keywords), used to mark the topic as handled. */
  key: string;
  /** The most recent way someone asked it. */
  question: string;
  count: number;
  lastAsked: string;
}

/**
 * Remembers what customers ask the chat assistant and whether it could answer, so the owner can see
 * which questions their documents are missing. Privacy first: phone numbers, emails and long numbers
 * are masked before anything is stored, nothing links a question to a person, and rows expire.
 */
export class QuestionLog {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(deps: { db: DatabaseSync; now: () => Date }) {
    this.db = deps.db;
    this.now = deps.now;
  }

  /** Records a question. Small talk ("hi", "thanks") is skipped. Returns false when skipped. */
  record(question: string, answered: boolean, at: Date = this.now()): boolean {
    const text = maskPersonalData(String(question ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);
    let key = topicKey(text);
    if (!key) return false;
    if (!answered) key = this.similarTopic(key) ?? key;
    const stamp = at.toISOString();
    this.db
      .prepare(`INSERT INTO chat_questions (asked_at, question, topic, answered) VALUES (?, ?, ?, ?)`)
      .run(stamp, text, key, answered ? 1 : 0);
    const cutoff = new Date(this.now().getTime() - KEEP_DAYS * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM chat_questions WHERE asked_at < ?`).run(cutoff);
    return true;
  }

  /**
   * An open unanswered topic that's the same question with one word more or less, e.g.
   * "kids menu son" joins "kids menu". The most-asked match wins.
   */
  private similarTopic(key: string): string | null {
    const words = new Set(key.split(" "));
    const open = this.db
      .prepare(`SELECT topic, COUNT(*) AS n FROM chat_questions WHERE answered = 0 AND handled = 0 GROUP BY topic ORDER BY n DESC`)
      .all() as { topic: string; n: number }[];
    for (const { topic } of open) {
      const other = new Set(topic.split(" "));
      const [small, big] = other.size <= words.size ? [other, words] : [words, other];
      if (big.size - small.size <= 1 && [...small].every((w) => big.has(w))) return topic;
    }
    return null;
  }

  /** Answer rate and the unanswered topics (most asked first) for the last `days` days. */
  summary(days = 30) {
    if (!Number.isInteger(days) || days < 1 || days > KEEP_DAYS) throw new ShopError("invalid_days", `Days must be 1-${KEEP_DAYS}.`);
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(answered), 0) AS answered FROM chat_questions WHERE asked_at >= ?`)
      .get(since) as { total: number; answered: number };
    const rows = this.db
      .prepare(
        `SELECT topic, COUNT(*) AS count, MAX(asked_at) AS lastAsked,
                (SELECT question FROM chat_questions q2 WHERE q2.topic = q.topic AND q2.answered = 0 AND q2.handled = 0
                   ORDER BY asked_at DESC, id DESC LIMIT 1) AS question
           FROM chat_questions q
          WHERE asked_at >= ? AND answered = 0 AND handled = 0
          GROUP BY topic
          ORDER BY count DESC, lastAsked DESC
          LIMIT 50`,
      )
      .all(since) as { topic: string; count: number; lastAsked: string; question: string }[];
    return {
      days,
      total: totals.total,
      answered: totals.answered,
      /** Share of questions answered, 0-100 (null when nobody asked anything). */
      answerRate: totals.total ? Math.round((totals.answered / totals.total) * 100) : null,
      unanswered: rows.map((r): UnansweredTopic => ({ key: r.topic, question: r.question, count: r.count, lastAsked: r.lastAsked })),
    };
  }

  /** The owner added the answer to their documents: hide this topic (new questions show again). */
  markHandled(key: string): number {
    const { changes } = this.db
      .prepare(`UPDATE chat_questions SET handled = 1 WHERE topic = ? AND answered = 0 AND handled = 0`)
      .run(String(key ?? ""));
    if (!changes) throw new ShopError("not_found", "That question isn't in the list any more.");
    return Number(changes);
  }
}

/** Hides emails, phone numbers and other long numbers (card numbers, booking refs with digits). */
export function maskPersonalData(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]");
}

/**
 * Groups different wordings of the same question: "Do you have parking?" and "parking available?"
 * share the key "park". Needs at least one meaningful word, so "hi" and "thanks!" are ignored.
 */
export function topicKey(text: string): string {
  // Words that don't tell one question from another: small talk, question filler, and "the café".
  const IGNORE = new Set(
    (
      "hi hello hey thank thanks ok okay bye good morning great cool yes no so much many very really just " +
      "there any about get need want know tell please possible available " +
      "cafe café shop store place here near nearby around"
    ).split(" "),
  );
  const words = [...new Set(keywords(text.replace(/\[(email|number)\]/g, " ")))].filter((w) => !IGNORE.has(w));
  return words.sort().join(" ");
}
