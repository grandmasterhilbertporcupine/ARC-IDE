export type DesktopShutdownSignal = "SIGINT" | "SIGTERM";
export type DesktopSignalListener = () => void;

interface DesktopShutdownState {
  inProgress: boolean;
}

export interface DesktopSignalProcess {
  off(signal: DesktopShutdownSignal, listener: DesktopSignalListener): void;
  on(signal: DesktopShutdownSignal, listener: DesktopSignalListener): void;
}

interface HandleDesktopShutdownSignalArgs {
  exitProcess(code: number): void;
  onError(error: unknown): void;
  quitApplication(): void;
  signal: DesktopShutdownSignal;
  state: DesktopShutdownState;
  stopOwnedRuntime(): Promise<void>;
}

interface RegisterDesktopShutdownSignalHandlersArgs {
  exitProcess(code: number): void;
  onError(error: unknown): void;
  processEvents: DesktopSignalProcess;
  quitApplication(): void;
  state: DesktopShutdownState;
  stopOwnedRuntime(): Promise<void>;
}

interface RegisteredDesktopShutdownSignalHandlers {
  remove(): void;
}

interface SignalExitCodeArgs {
  signal: DesktopShutdownSignal;
}

interface HandleDesktopQuitArgs {
  finishQuit(): Promise<void>;
  onError(error: unknown): void;
  quitApplication(): void;
}

export async function handleDesktopQuit(
  args: HandleDesktopQuitArgs,
): Promise<void> {
  try {
    await args.finishQuit();
  } catch (error) {
    args.onError(error);
  } finally {
    args.quitApplication();
  }
}

export function createDesktopShutdownState(): DesktopShutdownState {
  return { inProgress: false };
}

function signalExitCode(args: SignalExitCodeArgs): number {
  return args.signal === "SIGINT" ? 130 : 143;
}

export async function handleDesktopShutdownSignal(
  args: HandleDesktopShutdownSignalArgs,
): Promise<void> {
  if (args.state.inProgress) {
    return;
  }

  args.state.inProgress = true;
  try {
    await args.stopOwnedRuntime();
    args.exitProcess(signalExitCode({ signal: args.signal }));
    args.quitApplication();
  } catch (error) {
    args.state.inProgress = false;
    args.onError(error);
  }
}

export function registerDesktopShutdownSignalHandlers(
  args: RegisterDesktopShutdownSignalHandlersArgs,
): RegisteredDesktopShutdownSignalHandlers {
  const sigintHandler = (): void => {
    void handleDesktopShutdownSignal({
      exitProcess: args.exitProcess,
      onError: args.onError,
      quitApplication: args.quitApplication,
      signal: "SIGINT",
      state: args.state,
      stopOwnedRuntime: args.stopOwnedRuntime,
    });
  };
  const sigtermHandler = (): void => {
    void handleDesktopShutdownSignal({
      exitProcess: args.exitProcess,
      onError: args.onError,
      quitApplication: args.quitApplication,
      signal: "SIGTERM",
      state: args.state,
      stopOwnedRuntime: args.stopOwnedRuntime,
    });
  };

  args.processEvents.on("SIGINT", sigintHandler);
  args.processEvents.on("SIGTERM", sigtermHandler);

  return {
    remove() {
      args.processEvents.off("SIGINT", sigintHandler);
      args.processEvents.off("SIGTERM", sigtermHandler);
    },
  };
}
