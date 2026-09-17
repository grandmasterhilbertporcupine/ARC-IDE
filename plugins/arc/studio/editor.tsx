import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  Markdown,
  experimental_useAppPanel as useAppPanel,
  experimental_ProviderModelPicker as ProviderModelPicker,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { Icon } from "@bb/shared-ui/icon";
import {
  agentMetadataSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  type AgentDetail,
  type AgentMetadata,
  type AgentScope,
} from "../contract.js";
import { parseAgentDocument } from "../document.js";
import { AgentHistory, AgentSuggestions } from "./history.js";
import { SkillAssignments } from "./skills.js";
import { queueAssistantDraft } from "./assistant-draft.js";
import { assistantTab, testTab } from "./chat.js";
import { errorMessage, useStudioQuery, useStudioRpc } from "./data.js";

interface AgentEditorProps {
  agentId: string;
  scope: AgentScope;
  projects: { id: string; name: string }[];
  onRefresh(): void;
  onOpen(agentId: string, scope: AgentScope): void;
}

const localDraftSchema = z
  .object({
    version: z.number().int().positive(),
    document: z.string().max(65_536),
  })
  .strict();
const editableMetadataSchema = agentMetadataSchema.safeExtend({
  name: z.string().max(100),
  description: z.string().max(500),
  specialty: z.string().max(100),
  role: z.string().max(100),
});

function editableDocument(
  document: string,
): { metadata: AgentMetadata; body: string } | null {
  const end = document.indexOf("\n---\n", 4);
  if (!document.startsWith("---\n") || end < 0) return null;
  try {
    const metadata = editableMetadataSchema.parse(
      JSON.parse(document.slice(4, end)),
    );
    const body = document.slice(end + 5).replace(/^\n/, "");
    return { metadata, body };
  } catch {
    return null;
  }
}

function draftDocument(metadata: AgentMetadata, body: string): string {
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${body}`;
}

function draftKey(agentId: string) {
  return `arc.agentDraft.${agentId}`;
}

function localDraft(agent: AgentDetail) {
  try {
    const saved = localDraftSchema.safeParse(
      JSON.parse(localStorage.getItem(draftKey(agent.id)) ?? "null"),
    );
    return saved.success ? saved.data : null;
  } catch {
    return null;
  }
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== "string")
        return reject(new Error(`Could not read ${file.name}`));
      const start = reader.result.indexOf(",");
      if (start < 0) return reject(new Error(`Could not encode ${file.name}`));
      resolve(reader.result.slice(start + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function AgentEditor(props: AgentEditorProps) {
  const query = useStudioQuery(`agent:${props.agentId}`, (rpc) =>
    rpc.call("getAgent", { agentId: props.agentId, scope: props.scope }),
  );
  if (!query.data)
    return (
      <div className="p-5 text-sm">
        {query.error ? (
          <p role="alert" className="text-destructive-text">
            {query.error}{" "}
            <Button variant="ghost" size="sm" onClick={query.refresh}>
              Retry
            </Button>
          </p>
        ) : (
          <p role="status" className="text-muted-foreground">
            Loading agent…
          </p>
        )}
      </div>
    );
  return (
    <LoadedAgentEditor
      {...props}
      serverAgent={query.data.agent}
      refresh={() => {
        query.refresh();
        props.onRefresh();
      }}
    />
  );
}

function LoadedAgentEditor({
  serverAgent,
  refresh,
  ...props
}: AgentEditorProps & { serverAgent: AgentDetail; refresh(): void }) {
  const rpc = useStudioRpc();
  const appPanel = useAppPanel();
  const [base, setBase] = useState(serverAgent);
  const [recovered] = useState(() => localDraft(serverAgent));
  const [document, setDocument] = useState(
    recovered?.document ?? serverAgent.draft.document,
  );
  const [recoveryConflict, setRecoveryConflict] = useState(
    recovered !== null &&
      recovered.version !== serverAgent.draft.version &&
      recovered.document !== serverAgent.draft.document,
  );
  const [tab, setTab] = useState("guide");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyProject, setCopyProject] = useState("");
  const [selectingModel, setSelectingModel] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = document !== base.draft.document;
  const newerVersion = serverAgent.draft.version > base.draft.version;
  const editable = useMemo(() => editableDocument(document), [document]);
  const parsed = useMemo(() => {
    try {
      return { value: parseAgentDocument(document), error: null };
    } catch (failure) {
      return { value: null, error: errorMessage(failure) };
    }
  }, [document]);

  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey(base.id),
        JSON.stringify({
          version: recoveryConflict
            ? (recovered?.version ?? base.draft.version)
            : base.draft.version,
          document,
        }),
      );
    } catch {
      setNotice(
        "This device could not keep a local draft. Use Save draft to preserve your changes.",
      );
    }
  }, [base.id, base.draft.version, document, recovered, recoveryConflict]);

  function accept(agent: AgentDetail) {
    setBase(agent);
    setDocument(agent.draft.document);
    setRecoveryConflict(false);
    setNotice(null);
    refresh();
  }

  function metadataField<K extends keyof AgentMetadata>(
    key: K,
    value: AgentMetadata[K],
  ) {
    if (editable)
      setDocument(
        draftDocument({ ...editable.metadata, [key]: value }, editable.body),
      );
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (recoveryConflict)
      throw new Error(
        "Review your recovered draft before saving over the newer server draft.",
      );
    if (!parsed.value)
      throw new Error("Fix the Markdown metadata before saving.");
    if (!dirty) return base;
    const result = await rpc.call("saveAgentDraft", {
      agentId: base.id,
      scope: props.scope,
      expectedDraftVersion: base.draft.version,
      document: parsed.value.document,
      attachmentIds: base.draft.attachments.map((attachment) => attachment.id),
    });
    accept(result.agent);
    return result.agent;
  }

  async function publish() {
    const saved = await saveDraft();
    const result = await rpc.call("publishAgentRevision", {
      agentId: saved.id,
      scope: props.scope,
      expectedDraftVersion: saved.draft.version,
    });
    accept(result.agent);
    setNotice(
      `Version ${result.agent.currentRevision} saved. Existing sessions keep their earlier version.`,
    );
  }

  async function upload(files: FileList | File[]) {
    const selectedFiles = Array.from(files);
    if (selectedFiles.length === 0) return;
    await run(async () => {
      let saved = await saveDraft();
      for (const file of selectedFiles) {
        if (file.size > MAX_AGENT_ATTACHMENT_BYTES)
          throw new Error(`${file.name} exceeds the 25 MB file limit.`);
        const result = await rpc.call("addAgentAttachment", {
          agentId: saved.id,
          scope: props.scope,
          expectedDraftVersion: saved.draft.version,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await fileBase64(file),
        });
        saved = result.agent;
        accept(saved);
      }
    });
  }

  async function removeAttachment(id: string) {
    const saved = await saveDraft();
    const result = await rpc.call("saveAgentDraft", {
      agentId: saved.id,
      scope: props.scope,
      expectedDraftVersion: saved.draft.version,
      document: saved.draft.document,
      attachmentIds: saved.draft.attachments
        .filter((file) => file.id !== id)
        .map((file) => file.id),
    });
    accept(result.agent);
  }

  async function downloadAttachment(id: string) {
    const result = await rpc.call("readAgentAttachment", {
      agentId: base.id,
      scope: props.scope,
      attachmentId: id,
    });
    const bytes = Uint8Array.from(atob(result.contentBase64), (char) =>
      char.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = result.attachment.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function openChat(tab: typeof assistantTab | typeof testTab) {
    const opened = appPanel.openFixedTab({ surface: { kind: "current" }, tab });
    setError(
      opened
        ? null
        : "The chat panel is not ready yet. Please try opening it again.",
    );
  }

  const metadata = editable?.metadata;
  const archived = base.archivedAt !== null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">
            {metadata?.name || base.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            {archived
              ? "Archived"
              : base.currentRevision === null
                ? "Unpublished agent"
                : `Published version ${base.currentRevision}`}{" "}
            · {dirty ? "Unsaved draft" : "Draft saved"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openChat(assistantTab)}
          >
            Assistant
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={base.currentRevision === null}
            onClick={() => openChat(testTab)}
          >
            Test agent
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || archived || !dirty || !parsed.value}
            onClick={() =>
              void run(async () => {
                await saveDraft();
                setNotice("Draft saved.");
              })
            }
          >
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={
              busy ||
              archived ||
              !parsed.value ||
              (!dirty && !base.hasUnpublishedChanges)
            }
            onClick={() => void run(publish)}
          >
            {busy ? "Saving…" : "Save version"}
          </Button>
        </div>
      </div>
      {(newerVersion || recoveryConflict) && (
        <div
          role="status"
          className="border-b bg-surface-attention px-4 py-2 text-xs"
        >
          A newer draft was saved in another session. Your current edits are
          preserved here.{" "}
          <button
            type="button"
            disabled={busy}
            className="underline"
            onClick={() => {
              accept(serverAgent);
              setError(null);
            }}
          >
            Load saved draft and discard these edits
          </button>
          {recoveryConflict && (
            <button
              type="button"
              disabled={busy}
              className="ml-3 underline"
              onClick={() => setRecoveryConflict(false)}
            >
              Keep my recovered edits against the latest draft
            </button>
          )}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="border-b px-4 py-2 text-xs text-destructive-text"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="border-b px-4 py-2 text-xs text-muted-foreground"
        >
          {notice}
        </p>
      )}
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1"
        role="tablist"
        aria-label="Agent editor views"
      >
        {[
          ["guide", "Guide"],
          ["markdown", "Markdown"],
          ["preview", "Preview"],
          ["history", "Versions"],
          ["suggestions", "Suggestions"],
        ].map(([id, title]) => (
          <button
            type="button"
            role="tab"
            id={`arc-tab-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            aria-controls={`arc-panel-${id}`}
            key={id}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const names = [
                "guide",
                "markdown",
                "preview",
                "history",
                "suggestions",
              ];
              const index = names.indexOf(id);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % names.length
                  : event.key === "ArrowLeft"
                    ? (index + names.length - 1) % names.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? names.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                setTab(names[next]);
                window.document
                  .getElementById(`arc-tab-${names[next]}`)
                  ?.focus();
              }
            }}
            className={`rounded-md px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${tab === id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
          >
            {title}
          </button>
        ))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto p-4"
        role="tabpanel"
        id={`arc-panel-${tab}`}
        aria-labelledby={`arc-tab-${tab}`}
      >
        {tab === "guide" &&
          (metadata && editable ? (
            <fieldset
              disabled={busy || archived}
              className="min-w-0 space-y-5 disabled:opacity-60"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={metadata.name}
                    maxLength={100}
                    onChange={(event) =>
                      metadataField("name", event.target.value)
                    }
                    aria-label="Agent name"
                  />
                </Field>
                <Field label="Role">
                  <Input
                    value={metadata.role}
                    maxLength={100}
                    placeholder="e.g. Frontend builder"
                    onChange={(event) =>
                      metadataField("role", event.target.value)
                    }
                    aria-label="Agent role"
                  />
                </Field>
                <Field label="Specialty">
                  <Input
                    value={metadata.specialty}
                    maxLength={100}
                    placeholder="e.g. Accessible React interfaces"
                    onChange={(event) =>
                      metadataField("specialty", event.target.value)
                    }
                    aria-label="Agent specialty"
                  />
                </Field>
                <Field label="Short description">
                  <Input
                    value={metadata.description}
                    maxLength={500}
                    onChange={(event) =>
                      metadataField("description", event.target.value)
                    }
                    aria-label="Agent description"
                  />
                </Field>
              </div>
              <Field label="Instructions">
                <Textarea
                  aria-label="Agent instructions"
                  className="min-h-64 resize-y font-mono text-sm leading-relaxed"
                  value={editable.body}
                  maxLength={60_000}
                  onChange={(event) =>
                    setDocument(draftDocument(metadata, event.target.value))
                  }
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Describe its job, the context it should use, what a good
                  result includes, and how it should verify its work.
                </p>
              </Field>
              <SkillAssignments
                value={metadata.skills ?? []}
                onAskAssistant={(prompt) => {
                  void run(async () => {
                    await saveDraft();
                    queueAssistantDraft(
                      `arc.agentChatDraft.${base.id}.assistant`,
                      prompt,
                    );
                    openChat(assistantTab);
                  });
                }}
                projectId={
                  props.scope.kind === "project" ? props.scope.projectId : null
                }
                disabled={busy || archived}
                onChange={(skills) =>
                  setDocument(
                    draftDocument(
                      { ...metadata, schemaVersion: 2, skills },
                      editable.body,
                    ),
                  )
                }
              />
              <div className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-medium">Model and permissions</h3>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={
                      metadata.execution.providerId === null && !selectingModel
                    }
                    onChange={(event) => {
                      setSelectingModel(!event.target.checked);
                      if (event.target.checked)
                        metadataField("execution", {
                          ...metadata.execution,
                          providerId: null,
                          model: null,
                          reasoningLevel: null,
                          serviceTier: null,
                        });
                    }}
                  />
                  Use the project’s model
                </label>
                {(metadata.execution.providerId !== null || selectingModel) && (
                  <ProviderModelPicker
                    value={{
                      providerId: metadata.execution.providerId ?? "",
                      model: metadata.execution.model ?? "",
                      reasoningLevel:
                        metadata.execution.reasoningLevel ?? "medium",
                      ...(metadata.execution.serviceTier === null
                        ? {}
                        : { serviceTier: metadata.execution.serviceTier }),
                    }}
                    onChange={(value) =>
                      metadataField("execution", {
                        ...metadata.execution,
                        providerId: value.providerId,
                        model: value.model,
                        reasoningLevel: value.reasoningLevel ?? null,
                        serviceTier: value.serviceTier ?? null,
                      })
                    }
                    className="h-8 max-w-full"
                  />
                )}
                <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  Permissions
                  <select
                    aria-label="Agent permissions"
                    className="h-8 rounded-md border bg-background px-2 text-foreground"
                    value={metadata.execution.permissionMode ?? "inherit"}
                    onChange={(event) => {
                      const mode = event.target.value;
                      if (
                        mode === "inherit" ||
                        mode === "accept-edits" ||
                        mode === "auto" ||
                        mode === "full"
                      )
                        metadataField("execution", {
                          ...metadata.execution,
                          permissionMode: mode === "inherit" ? null : mode,
                        });
                    }}
                  >
                    <option value="inherit">Use session settings</option>
                    <option value="accept-edits">Accept edits</option>
                    <option value="auto">Approve for me</option>
                    <option value="full">Full access</option>
                  </select>
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The selected provider’s actual permission controls still
                  apply. A role does not grant additional tool or file access.
                </p>
              </div>
              <div
                className="space-y-2 border-t pt-4"
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("Files"))
                    event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!busy && !archived) void upload(event.dataTransfer.files);
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Reference files</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Icon name="Plus" className="size-4" />
                    Add files
                  </Button>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="hidden"
                  aria-label="Add agent reference files"
                  onChange={(event) => {
                    if (event.target.files) void upload(event.target.files);
                    event.target.value = "";
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Drop files here. References are saved with each agent version;
                  up to 25 MB per file.
                </p>
                {base.draft.attachments.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 border-b py-2 text-xs"
                  >
                    <Icon
                      name="File"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline"
                      onClick={() =>
                        void run(() => downloadAttachment(file.id))
                      }
                    >
                      {file.name}
                    </button>
                    <span className="text-muted-foreground">
                      {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => void run(() => removeAttachment(file.id))}
                    >
                      <Icon name="X" className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </fieldset>
          ) : (
            <p role="alert" className="text-sm text-destructive-text">
              The Markdown metadata needs attention. Open Markdown to correct
              it.
            </p>
          ))}
        {tab === "markdown" && (
          <div className="flex h-full min-h-96 flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              The Guide and this document share one definition. JSON metadata is
              between the opening --- lines.
            </p>
            <Textarea
              aria-label="Agent Markdown document"
              spellCheck={false}
              disabled={busy || archived}
              value={document}
              maxLength={65_536}
              onChange={(event) => setDocument(event.target.value)}
              className="min-h-80 flex-1 resize-none font-mono text-sm leading-relaxed"
            />
            {parsed.error && (
              <p role="alert" className="text-xs text-destructive-text">
                {parsed.error}
              </p>
            )}
          </div>
        )}
        {tab === "preview" &&
          (parsed.value ? (
            <Markdown content={parsed.value.body} />
          ) : (
            <p className="text-sm text-destructive-text">
              Fix the metadata to preview this definition.
            </p>
          ))}
        {tab === "history" && (
          <AgentHistory
            agent={base}
            scope={props.scope}
            disabled={busy || dirty}
            onAccept={accept}
            onError={setError}
          />
        )}
        {tab === "suggestions" && (
          <AgentSuggestions
            agent={base}
            scope={props.scope}
            disabled={busy || dirty}
            onAccept={accept}
            onError={setError}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2">
        {props.scope.kind === "library" ? (
          <div className="flex items-center gap-2">
            <select
              aria-label="Copy agent to project"
              className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs"
              value={copyProject}
              onChange={(event) => setCopyProject(event.target.value)}
            >
              <option value="">Choose a project</option>
              {props.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                archived ||
                base.currentRevision === null ||
                !copyProject
              }
              onClick={() =>
                void run(async () => {
                  if (base.currentRevision === null) return;
                  const result = await rpc.call("copyAgentToProject", {
                    agentId: base.id,
                    scope: props.scope,
                    revision: base.currentRevision,
                    projectId: copyProject,
                  });
                  props.onOpen(result.agent.id, {
                    kind: "project",
                    projectId: copyProject,
                  });
                })
              }
            >
              Copy v{base.currentRevision ?? "—"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Project copy
            {base.sourceRevision !== null
              ? ` · from library v${base.sourceRevision}`
              : ""}
          </p>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || dirty}
          onClick={() =>
            void run(async () => {
              const result = await rpc.call("setAgentArchived", {
                agentId: base.id,
                scope: props.scope,
                expectedDraftVersion: base.draft.version,
                archived: !archived,
              });
              accept(result.agent);
            })
          }
        >
          {archived ? "Restore agent" : "Archive agent"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium">{label}</span>
      {children}
    </div>
  );
}
