import { matchCompletedCheckRun } from "./check-run.js";
export function recognizeSonarQube(snapshot, trigger) {
    return matchCompletedCheckRun(snapshot, trigger, "sonarqube");
}
