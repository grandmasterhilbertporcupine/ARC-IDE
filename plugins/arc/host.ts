import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
} from "@get-bb/plugin-sdk/host";
import { arcHostContract } from "./host-contract.js";
import { NativeEffects } from "./host/effects.js";
import { HostContextService } from "./host/context/service.js";
import { readBoundedWorkspaceFile } from "./host/bounded-reading.js";

export function createArcHostEntry() {
  const stores = new Map<string, Promise<NativeEffects>>();
  const contextStores = new Map<string, Promise<HostContextService>>();
  const contextStore = (context: ExperimentalHostRpcContext) => {
    context.signal.throwIfAborted();
    const path = context.experimental_paths.dataDir;
    let existing = contextStores.get(path);
    if (!existing) {
      existing = HostContextService.open(path);
      contextStores.set(path, existing);
      void existing.catch(() => contextStores.delete(path));
    }
    return existing;
  };
  const store = (context: ExperimentalHostRpcContext) => {
    context.signal.throwIfAborted();
    const path = context.experimental_paths.dataDir;
    let existing = stores.get(path);
    if (!existing) {
      existing = NativeEffects.open(path);
      stores.set(path, existing);
      void existing.catch(() => stores.delete(path));
    }
    return existing;
  };
  return experimental_defineHostEntry({
    contract: arcHostContract,
    handlers: {
      readBoundedWorkspaceFile: (input, context) =>
        readBoundedWorkspaceFile(input, context.signal),
      async startContextIndex(input, context) {
        return (await contextStore(context)).start(input, context);
      },
      async getContextIndexStatus(input, context) {
        return (await contextStore(context)).status(input, context);
      },
      async listContextIndexSources(input, context) {
        return (await contextStore(context)).sources(input, context);
      },
      async searchContextIndex(input, context) {
        return (await contextStore(context)).search(input, context);
      },
      async readContextIndexExcerpt(input, context) {
        return (await contextStore(context)).excerpt(input, context);
      },
      async cancelContextIndex(input, context) {
        return (await contextStore(context)).cancel(input, context);
      },
      async inspectProjectSource(input, context) {
        return await (
          await store(context)
        ).inspectProjectSource(input.path, context.signal);
      },
      async startDirectoryEffect(input, context) {
        return await (
          await store(context)
        ).startDirectory(
          input,
          () => context.experimental_retainWorker(),
          context.signal,
        );
      },
      async observeDirectoryEffect(input, context) {
        return await (await store(context)).observeDirectory(input);
      },
      async interruptDirectoryEffect(input, context) {
        return await (await store(context)).interruptDirectory(input);
      },
      async inspectWorkspace(input, context) {
        return await (
          await store(context)
        ).inspect(input.path, input.expected, context.signal);
      },
      async startEffect(input, context) {
        return await (
          await store(context)
        ).start(
          input,
          () => context.experimental_retainWorker(),
          context.signal,
        );
      },
      async observeEffect(input, context) {
        return await (await store(context)).observe(input);
      },
      async interruptEffect(input, context) {
        return await (await store(context)).interrupt(input);
      },
    },
    async dispose() {
      await Promise.allSettled(
        [...stores.values()].map(async (store) => (await store).dispose()),
      );
      stores.clear();
      await Promise.allSettled(
        [...contextStores.values()].map(async (store) =>
          (await store).dispose(),
        ),
      );
      contextStores.clear();
    },
  });
}

export default createArcHostEntry();
