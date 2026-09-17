import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  useRpc,
  experimental_ProviderModelPicker as ProviderModelPicker,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import type { AgentScope } from "../contract.js";
import { defaultAgentMetadata } from "../document.js";
import { errorMessage } from "../studio/data.js";
import { Field, selectClass } from "../teams/inspector.js";
import {
  templateConfigurationSchema,
  templateRoles,
  type ArcTemplatesRpcContract,
  type TemplateConfiguration,
} from "./contract.js";
import { efficientBuildTemplate } from "./catalog.js";

const pendingSchema = z
  .object({
    operationId: z.string().min(1),
    configuration: templateConfigurationSchema,
  })
  .strict();
const emptyRoles = (): TemplateConfiguration["roles"] => ({
  lead: defaultAgentMetadata().execution,
  reader: defaultAgentMetadata().execution,
  builder: defaultAgentMetadata().execution,
  reviewer: defaultAgentMetadata().execution,
});

export function TeamTemplateCatalog({
  projects,
  projectId,
  onOpen,
}: {
  projects: { id: string; name: string }[];
  projectId: string | null;
  onOpen(scope: AgentScope, teamId: string): void;
}) {
  const rpc = useRpc<ArcTemplatesRpcContract>();
  const [open, setOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");
  const [roles, setRoles] = useState(emptyRoles);
  const [executable, setExecutable] = useState("");
  const [argumentsText, setArgumentsText] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [hostId, setHostId] = useState<string | null>(null);
  const [defaultsSource, setDefaultsSource] = useState<
    "none" | "global" | "project" | "pending"
  >("none");
  const [blockers, setBlockers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const operation = useRef<z.infer<typeof pendingSchema> | null>(null);
  useEffect(() => {
    if (!open || !selectedProject) return;
    let active = true;
    setLoading(true);
    setError(null);
    setHostId(null);
    void rpc
      .call("getTeamTemplateSetup", {
        templateId: "efficient-build",
        version: 1,
        projectId: selectedProject,
      })
      .then(
        (result) => {
          if (!active) return;
          let pending: z.infer<typeof pendingSchema> | null = null;
          try {
            const parsed = pendingSchema.safeParse(
              JSON.parse(
                localStorage.getItem(
                  `arc.template.efficient-build.1.${selectedProject}`,
                ) ?? "null",
              ),
            );
            if (parsed.success) pending = parsed.data;
          } catch {}
          operation.current = pending;
          const configuration = pending?.configuration ?? result.configuration;
          setRoles(configuration?.roles ?? result.defaultRoles ?? emptyRoles());
          setDefaultsSource(pending ? "pending" : result.defaultsSource);
          setExecutable(configuration?.check.executable ?? "");
          setArgumentsText(configuration?.check.args.join("\n") ?? "");
          setTimeoutSeconds((configuration?.check.timeoutMs ?? 120000) / 1000);
          setHostId(result.hostId);
          setBlockers(result.blockers);
          setLoading(false);
        },
        (failure: unknown) => {
          if (active) {
            setError(errorMessage(failure));
            setLoading(false);
          }
        },
      );
    return () => {
      active = false;
    };
  }, [rpc, open, selectedProject, reload]);
  const configured =
    selectedProject !== "" &&
    hostId !== null &&
    templateRoles.every(
      (role) => roles[role].providerId !== null && roles[role].model !== null,
    ) &&
    executable.trim() !== "" &&
    timeoutSeconds >= 1 &&
    timeoutSeconds <= 3600;
  async function create() {
    const configuration = templateConfigurationSchema.safeParse({
      roles,
      check: {
        executable,
        args: argumentsText
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        timeoutMs: Math.round(timeoutSeconds * 1000),
      },
    });
    if (!configuration.success) {
      setError(
        configuration.error.issues.map((issue) => issue.message).join(" "),
      );
      return;
    }
    setBusy(true);
    setError(null);
    const pending =
      operation.current?.configuration &&
      JSON.stringify(operation.current.configuration) ===
        JSON.stringify(configuration.data)
        ? operation.current
        : {
            operationId: `template_${crypto.randomUUID()}`,
            configuration: configuration.data,
          };
    operation.current = pending;
    const key = `arc.template.efficient-build.1.${selectedProject}`;
    try {
      try {
        localStorage.setItem(key, JSON.stringify(pending));
      } catch {}
      const result = await rpc.call("instantiateTeamTemplate", {
        templateId: "efficient-build",
        version: 1,
        projectId: selectedProject,
        ...pending,
      });
      try {
        localStorage.removeItem(key);
      } catch {}
      operation.current = null;
      onOpen(result.team.scope, result.team.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-4 border-b pb-5"
      aria-label="Built-in team templates"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            Included with ARC · v1
          </p>
          <h2 className="mt-1 text-base font-medium">
            {efficientBuildTemplate.name}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A lead, focused reader, builder, and independent reviewer. Ready to
            customize, with source-linked handoffs and required verification.
          </p>
        </div>
        <Button
          size="sm"
          variant={open ? "ghost" : "outline"}
          onClick={() => setOpen(!open)}
          disabled={busy}
        >
          {open ? "Close setup" : "Use this team"}
        </Button>
      </div>
      {open && (
        <div className="space-y-4">
          <Field label="Project">
            <select
              aria-label="Template project"
              className={selectClass}
              value={selectedProject}
              disabled={busy}
              onChange={(event) => {
                operation.current = null;
                setSelectedProject(event.target.value);
              }}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
          {projects.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Add a project first, then return here to choose its team models
              and check command.
            </p>
          )}
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading project setup…
            </p>
          )}
          {error && (
            <div role="alert" className="text-sm text-destructive-text">
              {error}
              {hostId === null && selectedProject && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Retry setup
                </Button>
              )}
            </div>
          )}
          {blockers.map((blocker) => (
            <p
              key={blocker}
              role="alert"
              className="text-sm text-destructive-text"
            >
              {blocker}
            </p>
          ))}
          {hostId !== null && (
            <fieldset disabled={busy || loading} className="space-y-4">
              {defaultsSource !== "none" && (
                <p className="text-xs text-muted-foreground">
                  {defaultsSource === "pending"
                    ? "Restored your unfinished setup."
                    : defaultsSource === "project"
                      ? "Using this project's saved model choices and check command."
                      : "Using your last successful model choices. Select this project's required check command."}{" "}
                  Model availability is checked again when you create the team.
                </p>
              )}
              <div className="space-y-3">
                {efficientBuildTemplate.roles.map((role) => (
                  <div
                    key={role.id}
                    role="group"
                    aria-label={`${role.name} model`}
                    className="grid items-start gap-3 border-b pb-3 @[650px]/teams:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)]"
                  >
                    <div>
                      <h3 className="text-sm font-medium">{role.name}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {role.responsibility}
                      </p>
                    </div>
                    <ProviderModelPicker
                      routing={{ kind: "host", hostId }}
                      value={{
                        providerId: roles[role.id].providerId ?? "",
                        model: roles[role.id].model ?? "",
                        reasoningLevel:
                          roles[role.id].reasoningLevel ?? "medium",
                        serviceTier: roles[role.id].serviceTier ?? undefined,
                      }}
                      onChange={(value) =>
                        setRoles((previous) => ({
                          ...previous,
                          [role.id]: {
                            ...previous[role.id],
                            providerId: value.providerId,
                            model: value.model,
                            reasoningLevel: value.reasoningLevel ?? null,
                            serviceTier: value.serviceTier ?? null,
                          },
                        }))
                      }
                      disabled={busy || loading}
                      className="max-w-full"
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                You can choose a smaller model for focused reading and routine
                implementation. Savings vary; ARC does not guarantee a
                percentage reduction. Provider installation and authentication
                are managed in Settings.
              </p>
              <div className="grid gap-3 @[650px]/teams:grid-cols-2">
                <Field
                  label="Required check command"
                  hint="The executable ARC runs to verify the candidate, such as npm or node."
                >
                  <Input
                    aria-label="Template check executable"
                    value={executable}
                    onChange={(event) => setExecutable(event.target.value)}
                    placeholder="Executable"
                  />
                </Field>
                <Field label="Timeout in seconds">
                  <Input
                    aria-label="Template check timeout"
                    type="number"
                    min={1}
                    max={3600}
                    value={timeoutSeconds}
                    onChange={(event) =>
                      setTimeoutSeconds(Number(event.target.value))
                    }
                  />
                </Field>
                <Field
                  label="Arguments"
                  hint="One argument per line. ARC invokes the command directly, without a shell."
                >
                  <Textarea
                    aria-label="Template check arguments"
                    rows={3}
                    value={argumentsText}
                    onChange={(event) => setArgumentsText(event.target.value)}
                    placeholder={"test\n--\n--run"}
                  />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                Creates an editable project copy with pinned agents and skills.
                Includes at most two repair rounds. Saves these model choices as
                defaults for new projects, while existing project choices remain
                unchanged. Creating the team does not start agents, run
                commands, or publish code.
              </p>
              <Button
                disabled={!configured || busy || loading || blockers.length > 0}
                onClick={() => void create()}
              >
                {busy ? "Creating team…" : "Create project team"}
              </Button>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
