import { matchCompletedCheckRun } from "./check-run.ts";
import type { CompletionCandidate, PrSnapshot, TriggerConfig } from "../types.ts";

type CursorBugbotTrigger = Extract<TriggerConfig, { recognizer: "cursor-bugbot" }>;

export function recognizeCursorBugbot(
  snapshot: PrSnapshot,
  trigger: CursorBugbotTrigger,
): CompletionCandidate[] {
  return matchCompletedCheckRun(snapshot, trigger, "cursor-bugbot");
}
