import { matchCompletedCheckRun } from "./check-run.js";
export function recognizeCursorBugbot(snapshot, trigger) {
    return matchCompletedCheckRun(snapshot, trigger, "cursor-bugbot");
}
