import type { OwnedStepRef } from "bb-plugin-workflows/owned-contract";

export function completionProgram(
  graphSource: string,
  mainCompletion: OwnedStepRef,
  name: string,
  description: string,
): string {
  const graphBody = graphSource.slice(graphSource.indexOf("\n") + 1);
  return `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} };
let graphOutcome;
try {
  graphOutcome = {state:"succeeded",value:await (async () => {
${graphBody}
  })()};
} catch (error) {
  if (!error || typeof error.message !== "string" || !error.message.startsWith("Required gate did not succeed: ")) throw error;
  graphOutcome = {state:"failed",reason:error.message};
}
await step(${JSON.stringify(mainCompletion.nodeId)},${mainCompletion.iteration},null);
if (graphOutcome.state === "failed") throw new Error(graphOutcome.reason);
return graphOutcome.value;`;
}
