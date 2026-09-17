export function requireWithin(root: string, candidate: string): string;
export function verifyOwnedApplicationProcess(
  raw: unknown,
  expected: { pid: number; executable: string; startedAt?: string },
): {
  exists: true;
  id: number;
  executablePath: string;
  startedAt: string;
} | null;
export function createSmokeEnvironment(
  original: NodeJS.ProcessEnv,
  root: string,
  serverPort: number,
  daemonPort: number,
): NodeJS.ProcessEnv;
export function validateSmokeEnvironment(
  original: NodeJS.ProcessEnv,
  configured: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export interface SmokeDebuggerClient {
  facts: { pid: number; execPath: string; userData: string; version: string };
  evaluate(expression: string): Promise<{ result: { value?: unknown } }>;
  close(): void;
}
export interface SmokeFeatureContext {
  debuggerClient: SmokeDebuggerClient;
  baseUrl: string;
  root: string;
  saved: {
    project: {
      id: string;
      name: string;
      sources: {
        id: string;
        type: "local_path";
        hostId: string;
        path: string;
      }[];
    };
    workspace: string;
    sentinel: string;
    token: string;
  };
  daemon: { hostId: string; platform: string; protocolVersion: number };
  check(name: string): void;
  pass: number;
  captureRenderer(
    debuggerClient: SmokeDebuggerClient,
    baseUrl: string,
    screenshot: string,
  ): Promise<string>;
  executable: string;
  env: NodeJS.ProcessEnv;
  cli: {
    path: string;
    runtime: string;
    version: string;
    nodeOnPath: false;
    projectId: string;
  };
}
export function verifyProjectBinding(
  raw: unknown,
  expected: {
    projectId: string;
    name: string;
    hostId: string;
    workspace: string;
  },
): {
  id: string;
  name: string;
  sources: { id: string; type: "local_path"; hostId: string; path: string }[];
};
export function parseSmokeResume(raw: unknown): {
  projectId: string;
  serverPort: number;
  daemonPort: number;
  previousContext: {
    pass: number;
    reference: { id: string; revision: number; sha256: string };
  };
};
export function verifyProjectContext(
  baseUrl: string,
  saved: { project: { id: string }; token: string },
  hostId: string,
  pass: number,
  previous?: { reference: { id: string; revision: number; sha256: string } },
): Promise<Record<string, unknown>>;
export function runSmoke(
  executable: string,
  options?: {
    artifactsParent?: string;
    resume?: string;
    diagnosticReload?: boolean;
    configureEnvironment?: (
      environment: NodeJS.ProcessEnv,
    ) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
    verifyFeatures?: (context: SmokeFeatureContext) => Promise<unknown>;
  },
): Promise<Record<string, unknown>>;
