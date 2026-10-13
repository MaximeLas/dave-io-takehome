// Reads the thirty questions from eval/QUESTIONS.md, the assignment's own list, so the
// ids used everywhere (run records, scores, expected.generated.json) are its ids.
import { readFile } from "node:fs/promises";
import path from "node:path";

/** One eval question: the id from QUESTIONS.md and the question as asked. */
export interface Question {
  id: string;
  text: string;
}

// Relative to the working directory, the repo root, as the baselines and runs/ are, so the
// compiled server under dist/ reads the same file as the commands run with tsx.
const QUESTIONS_FILE = path.join("eval", "QUESTIONS.md");
// Each question is a bullet: - `question-id` — The question text?
const QUESTION_LINE = /^- `([a-z0-9-]+)` — (.+)$/;

/** The thirty questions, in the order of QUESTIONS.md. */
export async function loadQuestions(): Promise<Question[]> {
  const markdown = await readFile(QUESTIONS_FILE, "utf8");
  return markdown
    .split("\n")
    .map((line) => QUESTION_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ id: match[1]!, text: match[2]!.trim() }));
}

/** One question by its eval id, or undefined when the id is not in the list. */
export async function findQuestion(id: string): Promise<Question | undefined> {
  return (await loadQuestions()).find((question) => question.id === id);
}
