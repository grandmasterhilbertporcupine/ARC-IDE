import { useEffect, useRef, useState } from "react";
import type { ProviderInfo } from "@bb/domain";
import type { SystemProviderState, TerminalSession } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  TerminalHostSelector,
  resolveTerminalHost,
} from "@/components/secondary-panel/TerminalHostSelector";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import { useHosts } from "@/hooks/queries/host-queries";
import {
  useHostProviderCliStatus,
  useSystemProviderStates,
  useSystemProviderUsageLimits,
} from "@/hooks/queries/system-queries";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const STATUS_LABELS: Record<SystemProviderState["status"], string> = {
  ready: "Ready",
  not_installed: "Not installed",
  unauthenticated: "Sign-in required",
  expired: "Sign-in expired",
  unsupported_version: "Update required",
  unknown: "Readiness unverified",
};

export function ProviderOnboarding({
  providers,
  disabled,
}: {
  providers: readonly ProviderInfo[];
  disabled: boolean;
}) {
  const hosts = useHosts();
  const [preferredHostId, setPreferredHostId] = useState<string | null>(null);
  const host = resolveTerminalHost({
    hosts: hosts.data ?? [],
    preferredHostId,
    primaryHostId: null,
  });
  const connected = host?.status === "connected";
  const states = useSystemProviderStates({
    hostId: host?.id,
    enabled: connected,
    poll: false,
  });
  const installations = useHostProviderCliStatus({
    hostId: host?.id ?? null,
    enabled: connected,
  });
  const usage = useSystemProviderUsageLimits({
    hostId: host?.id,
    enabled: connected,
    providerIds: providers
      .filter(
        (provider) =>
          provider.maintenance.usage &&
          states.data?.providers.some(
            (state) =>
              state.providerId === provider.id && state.status === "ready",
          ),
      )
      .map((provider) => provider.id),
  });
  const installer = useProviderCliInstallRunner();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownedSession = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const terminalId = ownedSession.current;
      if (terminalId !== null)
        void sdk.terminals
          .close({ terminalId, mode: "force" })
          .catch(() => undefined);
    };
  }, []);

  async function refresh() {
    await Promise.all([
      states.refetch(),
      installations.refetch(),
      usage.refetch(),
    ]);
  }

  async function signIn(provider: ProviderInfo, command: string) {
    if (!connected || host === null || starting || session !== null) return;
    setStarting(true);
    setError(null);
    try {
      const next = await sdk.terminals.create({
        scope: { kind: "host_path", hostId: host.id, cwd: null },
        title: `${provider.displayName} sign-in`,
        cols: 100,
        rows: 18,
        start: { mode: "command", command },
      });
      if (!mounted.current) {
        await sdk.terminals.close({ terminalId: next.id, mode: "force" });
        return;
      }
      ownedSession.current = next.id;
      setSession(next);
    } catch {
      if (mounted.current)
        setError(
          "The sign-in terminal could not start. Refresh provider status and try again.",
        );
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function closeSignIn() {
    if (session === null || closing) return;
    setClosing(true);
    try {
      await sdk.terminals.close({ terminalId: session.id, mode: "force" });
      ownedSession.current = null;
      setSession(null);
      await refresh();
    } catch {
      setError("The sign-in terminal could not close. Try again.");
    } finally {
      setClosing(false);
    }
  }

  return (
    <SettingsSection
      title="Provider setup"
      description="Connect the agent runtimes on this machine. Each provider owns sign-in, subscriptions, and billing."
      action={
        <TerminalHostSelector
          disabled={disabled || starting || session !== null}
          hosts={hosts.data ?? []}
          isLoading={hosts.isPending}
          selectedHostId={host?.id ?? null}
          onChange={setPreferredHostId}
        />
      }
    >
      <div className="space-y-4">
        {!connected ? (
          <p className="text-sm text-muted-foreground">
            Connect a machine to install providers and verify sign-in.
          </p>
        ) : null}
        {states.isError || installations.isError ? (
          <p role="alert" className="text-sm text-destructive-text">
            Provider status could not be loaded. Refresh to retry.
          </p>
        ) : null}
        <SettingsRowList>
          {providers.map((provider) => {
            const state = states.data?.providers.find(
              (candidate) => candidate.providerId === provider.id,
            );
            const installation = installations.data?.[provider.id];
            const issue = installation
              ? buildProviderCliIssue({
                  provider: provider.id,
                  status: installation,
                })
              : null;
            const installAction =
              issue !== null && hasProviderCliAction(issue) ? issue : null;
            const jobKey = `${host?.id}:${provider.id}`;
            const installing =
              installer.runningJobKey === jobKey ||
              installer.queuedJobKeys.has(jobKey);
            const limit = usage.usage[provider.id];
            const status = !connected
              ? "Machine offline"
              : states.isPending
                ? "Checking…"
                : state
                  ? STATUS_LABELS[state.status]
                  : "Readiness unverified";
            return (
              <SettingsRow key={provider.id} className="flex-wrap items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{provider.displayName}</span>
                    <span
                      className="text-xs text-muted-foreground"
                      role="status"
                    >
                      {status}
                    </span>
                    {state?.installedVersion ? (
                      <span className="text-xs text-muted-foreground">
                        {state.installedVersion}
                      </span>
                    ) : null}
                  </div>
                  {state?.accountEmail || state?.planLabel ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {[state.accountEmail, state.planLabel]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  ) : null}
                  {state?.statusMessage ? (
                    <p className="text-xs text-muted-foreground">
                      {state.statusMessage}
                    </p>
                  ) : null}
                  {limit?.status === "ok" ? (
                    <p className="text-xs text-muted-foreground">
                      {limit.windows
                        .map(
                          (window) =>
                            `${window.label}: ${window.usedPercent}% used`,
                        )
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {installAction ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || !connected || installing}
                      onClick={() => {
                        if (host)
                          installer.startInstall({
                            hostId: host.id,
                            issue: installAction,
                          });
                      }}
                    >
                      {installing ? "Installing…" : installAction.action.label}
                    </Button>
                  ) : null}
                  {state?.loginCommand &&
                  state.status !== "ready" &&
                  state.status !== "not_installed" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        disabled || !connected || starting || session !== null
                      }
                      onClick={() => void signIn(provider, state.loginCommand!)}
                    >
                      Sign in to {provider.displayName}
                    </Button>
                  ) : null}
                  {provider.strings?.installUrl && state?.status !== "ready" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        openUrlInExternalBrowser(provider.strings!.installUrl)
                      }
                    >
                      Setup guide
                    </Button>
                  ) : null}
                </div>
              </SettingsRow>
            );
          })}
        </SettingsRowList>
        {error ? (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        ) : null}
        {session ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{session.title}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={closing}
                onClick={() => void closeSignIn()}
              >
                {session.status === "exited"
                  ? "Close sign-in"
                  : "Cancel sign-in"}
              </Button>
            </div>
            <div className="h-72 overflow-hidden rounded-md border border-border">
              <ThreadTerminalView
                autoFocus
                isPanelOpen
                session={session}
                onSessionChange={(next) => {
                  setSession(next);
                  if (next.status === "exited") void refresh();
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Complete authentication in the provider’s terminal or browser.
              Refresh status to verify readiness.
            </p>
          </div>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!connected || states.isFetching || installations.isFetching}
          onClick={() => void refresh()}
        >
          Refresh provider status
        </Button>
      </div>
    </SettingsSection>
  );
}
