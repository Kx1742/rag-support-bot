import type { DatabaseSync } from "node:sqlite";
import type { SourceDocument } from "../types.ts";
import { ShopError } from "./errors.ts";

/** The extra document the assistant reads, made from answers added on the staff desk. */
export const ANSWERS_DOC_ID = "answers-from-the-team.md";
export const MAX_ANSWERS = 200;

export interface TeamAnswer {
  id: number;
  question: string;
  answer: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Questions and answers the café adds from the staff desk ("Answer it" in the report).
 * Stored in the shop database (so they survive redeploys) and given to the assistant as one more
 * document, one section per question, so it can answer them and cite them like any other source.
 */
export class AnswerBook {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly onChange: () => void;

  constructor(deps: { db: DatabaseSync; now: () => Date; onChange?: () => void }) {
    this.db = deps.db;
    this.now = deps.now;
    this.onChange = deps.onChange ?? (() => {});
  }

  list(): TeamAnswer[] {
    return (
      this.db.prepare(`SELECT id, question, answer, updated_at, updated_by FROM team_answers ORDER BY id DESC`).all() as {
        id: number;
        question: string;
        answer: string;
        updated_at: string;
        updated_by: string;
      }[]
    ).map((r) => ({ id: r.id, question: r.question, answer: r.answer, updatedAt: r.updated_at, updatedBy: r.updated_by }));
  }

  create(input: { question: string; answer: string }, by = ""): TeamAnswer {
    const { question, answer } = clean(input);
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM team_answers`).get() as { n: number };
    if (n >= MAX_ANSWERS) throw new ShopError("too_many", `You can add up to ${MAX_ANSWERS} answers. Edit or delete some first.`);
    const stamp = this.now().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO team_answers (question, answer, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`)
      .run(question, answer, stamp, stamp, by);
    this.onChange();
    return this.get(Number(lastInsertRowid))!;
  }

  update(id: number, input: { question: string; answer: string }, by = ""): TeamAnswer {
    const { question, answer } = clean(input);
    const { changes } = this.db
      .prepare(`UPDATE team_answers SET question = ?, answer = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
      .run(question, answer, this.now().toISOString(), by, id);
    if (!changes) throw new ShopError("not_found", "Answer not found");
    this.onChange();
    return this.get(id)!;
  }

  remove(id: number): void {
    const { changes } = this.db.prepare(`DELETE FROM team_answers WHERE id = ?`).run(id);
    if (!changes) throw new ShopError("not_found", "Answer not found");
    this.onChange();
  }

  get(id: number): TeamAnswer | null {
    return this.list().find((a) => a.id === id) ?? null;
  }

  /**
   * All answers as one Markdown document ("## question" + answer per section, so each becomes its
   * own search chunk), or null when there are none.
   */
  asDocument(): SourceDocument | null {
    const answers = this.list().reverse(); // oldest first, so the document is stable as answers are added
    if (!answers.length) return null;
    const sections = answers.map((a) => `## ${a.question}\n${a.answer}`);
    return { docId: ANSWERS_DOC_ID, text: `# Answers from the team\n\n${sections.join("\n\n")}\n` };
  }
}

function clean(input: { question: string; answer: string }) {
  // One line for the question: it becomes a heading.
  const question = String(input?.question ?? "").replace(/\s+/g, " ").trim().replace(/^#+\s*/, "");
  // Keep line breaks in answers, but no headings that would split the section.
  const answer = String(input?.answer ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (question.length < 3 || question.length > 200) throw new ShopError("invalid_question", "The question needs 3-200 characters.");
  if (answer.length < 2 || answer.length > 1500) throw new ShopError("invalid_answer", "The answer needs 2-1500 characters.");
  return { question, answer };
}
