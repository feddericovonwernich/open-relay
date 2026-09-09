import { matchCompletedCheckRun } from "./check-run.ts";
import type { CompletionCandidate, PrSnapshot, TriggerConfig } from "../types.ts";

type SonarQubeTrigger = Extract<TriggerConfig, { recognizer: "sonarqube" }>;

export function recognizeSonarQube(snapshot: PrSnapshot, trigger: SonarQubeTrigger): CompletionCandidate[] {
  return matchCompletedCheckRun(snapshot, trigger, "sonarqube");
}
