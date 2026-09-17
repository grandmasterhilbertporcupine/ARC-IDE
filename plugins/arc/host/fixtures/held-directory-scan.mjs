import { NativeEffects } from "../effects.ts";
import { directoryEffectRequestSchema } from "../../host-directory-contract.ts";
import { directoryEffectRequestHash } from "../hash.ts";

const [dataDir, encodedRequest] = process.argv.slice(2);
const request = directoryEffectRequestSchema.parse(JSON.parse(encodedRequest));
const engine = await NativeEffects.open(dataDir);
await engine.startDirectory(request);
setTimeout(async () => {
  const record = await engine.observeDirectory({
    runId: request.runId,
    effectId: request.effectId,
    requestHash: directoryEffectRequestHash(request),
  });
  process.send({ pid: process.pid, record }, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}, 20);
