import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function approveOwnedFixturePlan(rpc, admitted, artifacts) {
  const runId = admitted.summary.runId;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await rpc("listRunControls", { runId, limit: 100, offset: 0 });
    assert(
      page.total <= 100,
      "Initial fixture control list exceeded its bound",
    );
    const plans = page.controls.filter(
      (control) => control.context.nodeId === "arcg_plan_approval",
    );
    assert(
      plans.length <= 1,
      "Fixture has more than one initial plan approval",
    );
    const control = plans[0];
    if (!control) {
      await new Promise((done) => setTimeout(done, 300));
      continue;
    }
    assert.equal(control.runId, runId);
    assert.equal(control.context.runId, runId);
    assert.equal(control.context.planHash, admitted.summary.planHash);
    assert.equal(control.context.iteration, 0);
    assert.equal(control.context.operation.type, "approval");
    assert.equal(control.context.operation.candidate, null);
    assert.equal(control.context.candidate, null);
    assert.equal(control.context.proposedAssignments, null);
    assert.deepEqual(control.context.dependencyReceipts, []);
    assert.equal(control.state, "pending");
    assert.equal(control.decision, null);
    const request = {
      runId,
      controlId: control.controlId,
      expectedRevision: control.revision,
      contextHash: control.contextHash,
      operationId: randomUUID(),
      decision: "approved",
    };
    const response = await rpc("resolveRunControl", request);
    assert.equal(response.state, "resolved");
    assert.equal(response.decision, "approved");
    await writeFile(
      join(artifacts, "initial-plan-approval.json"),
      JSON.stringify(
        {
          purpose:
            "Approve only this owned disposable fixture's initial null-candidate plan; independent candidate review and all other controls remain untouched.",
          request,
          response,
        },
        null,
        2,
      ),
    );
    return response.controlId;
  }
  throw new Error(
    "Initial fixture plan approval was not available within 30 seconds",
  );
}
