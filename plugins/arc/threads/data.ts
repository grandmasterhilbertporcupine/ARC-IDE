import type Database from "better-sqlite3";

export const threadBrowserMigrations = [
  "CREATE INDEX arc_runs_by_origin ON arc_runs(project_id, json_extract(request_json, '$.originThreadId'), created_at DESC, id DESC)",
];

export function createThreadBrowserStore(db: Database.Database) {
  return {
    page(
      projectId: string,
      threadIds: string[],
      limit: number,
      offset: number,
    ) {
      return db
        .prepare<
          [string, string, number, number],
          { runId: string; originThreadId: string; total: number }
        >(`WITH ranked AS (
        SELECT id AS runId, json_extract(request_json, '$.originThreadId') AS originThreadId,
          count(*) OVER (PARTITION BY json_extract(request_json, '$.originThreadId')) AS total,
          row_number() OVER (PARTITION BY json_extract(request_json, '$.originThreadId') ORDER BY created_at DESC, id DESC) AS position
        FROM arc_runs WHERE project_id = ? AND json_extract(request_json, '$.originThreadId') IN (SELECT value FROM json_each(?))
      ) SELECT runId, originThreadId, total FROM ranked WHERE position > ? AND position <= ? ORDER BY originThreadId, position`)
        .all(projectId, JSON.stringify(threadIds), offset, offset + limit);
    },
    latest(projectId: string, threadIds: string[]) {
      return this.page(projectId, threadIds, 1, 0);
    },
    workers(projectId: string, threadIds: string[]) {
      return db
        .prepare<
          [string, string],
          { effectId: string; runId: string }
        >(`SELECT e.effect_id AS effectId, e.run_id AS runId FROM arc_run_effects e JOIN arc_runs r ON r.id = e.run_id
        WHERE r.project_id = ? AND e.thread_id IN (SELECT value FROM json_each(?)) ORDER BY e.thread_id`)
        .all(projectId, JSON.stringify(threadIds));
    },
    workerCount(runId: string) {
      return (
        db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM arc_run_effects WHERE run_id = ? AND thread_id IS NOT NULL",
          )
          .get(runId)?.total ?? 0
      );
    },
    lineage(runId: string) {
      const predecessor = db
        .prepare<[string], { runId: string }>(
          "SELECT run_id AS runId FROM arc_instruction_updates WHERE successor_run_id = ? AND state != 'cancelled'",
        )
        .get(runId);
      const successor = db
        .prepare<[string], { runId: string; state: string }>(
          "SELECT successor_run_id AS runId, state FROM arc_instruction_updates WHERE run_id = ? AND state != 'cancelled' ORDER BY created_at DESC, operation_id DESC LIMIT 1",
        )
        .get(runId);
      return {
        predecessorRunId: predecessor?.runId ?? null,
        successor: successor ?? null,
      };
    },
  };
}
