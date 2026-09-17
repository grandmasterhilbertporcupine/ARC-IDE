import { useEffect, useRef, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import type { AgentSkillBundle, AgentSkillReference } from "../contract.js";
import { errorMessage, useStudioRpc } from "./data.js";
import { SkillBundleEditor } from "./skill-editor.js";

async function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
        : reject(new Error(`Could not encode ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function SkillAssignments({
  value,
  onChange,
  projectId,
  inherited = [],
  disabled = false,
  onAskAssistant,
}: {
  value: AgentSkillReference[];
  onChange(value: AgentSkillReference[]): void;
  projectId: string | null;
  inherited?: AgentSkillReference[];
  disabled?: boolean;
  onAskAssistant?(prompt: string): void;
}) {
  const rpc = useStudioRpc();
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [catalog, setCatalog] = useState<
    {
      id: string;
      name: string;
      description: string | null;
      scope: string;
      provider: string | null;
    }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentSkillBundle | "new" | null>(null);
  const [filter, setFilter] = useState("");
  const directory = useRef<HTMLInputElement>(null);
  const currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => {
    let active = true;
    if (projectId) {
      setSelectedProject(projectId);
      return;
    }
    if (!browsing) return;
    void rpc.call("listStudioProjects", null).then(
      (result) => {
        if (active) {
          setProjects(result.projects);
          setSelectedProject(
            (previous) =>
              previous ||
              result.personalProjectId ||
              result.projects[0]?.id ||
              "",
          );
        }
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, projectId, browsing]);
  useEffect(() => {
    let active = true;
    setCatalog([]);
    if (browsing && selectedProject)
      void rpc
        .call("listAssignedSkillCatalog", {
          projectId: selectedProject,
          environmentId: null,
        })
        .then(
          (result) => {
            if (active) setCatalog(result.skills);
          },
          (failure: unknown) => {
            if (active) setError(errorMessage(failure));
          },
        );
    return () => {
      active = false;
    };
  }, [rpc, selectedProject, browsing]);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  function assign(skill: AgentSkillBundle, replacingId?: string) {
    const retained = currentValue.current.filter(
      (ref) => ref.id !== replacingId && ref.name !== skill.name,
    );
    onChange([...retained, { id: skill.id, name: skill.name }]);
  }
  async function open(ref: AgentSkillReference) {
    await action(async () => {
      const { skill } = await rpc.call("readAgentSkillBundle", { id: ref.id });
      const entry = skill.files.find((file) => file.path === "SKILL.md");
      if (!entry) throw new Error("The saved skill is missing SKILL.md");
      setEditing(skill);
    });
  }
  return (
    <section className="space-y-3 border-t pt-4" aria-label="Assigned skills">
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Assign a skill to this role. Its description tells the agent when to
          use it; SKILL.md explains how. Shared and project skills remain
          available.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      <fieldset
        disabled={disabled || busy}
        className="min-w-0 space-y-3 disabled:opacity-60"
      >
        <div className="space-y-1">
          {inherited.map((ref) => (
            <div
              className="flex items-center justify-between gap-2 text-xs"
              key={`inherited:${ref.id}`}
            >
              <span>{ref.name}</span>
              <span className="text-muted-foreground">
                {value.some((item) => item.name === ref.name)
                  ? "Agent default · overridden here"
                  : "From agent"}
              </span>
            </div>
          ))}
          {value.map((ref) => (
            <div className="flex items-center gap-2 text-xs" key={ref.id}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left underline underline-offset-4"
                onClick={() => void open(ref)}
              >
                {ref.name}
              </button>
              <span className="text-muted-foreground" title={ref.id}>
                Pinned {ref.id.slice(0, 8)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${ref.name} assignment`}
                onClick={() =>
                  onChange(value.filter((item) => item.id !== ref.id))
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {!value.length && (
            <p className="text-xs text-muted-foreground">
              No extra skills assigned.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing("new");
            }}
          >
            Create skill
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => directory.current?.click()}
          >
            Import skill directory
          </Button>
        </div>
        <input
          type="file"
          multiple
          hidden
          aria-label="Import skill directory files"
          ref={(element) => {
            directory.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (!files.length) return;
            void action(async () => {
              if (
                files.length > 128 ||
                files.reduce((sum, file) => sum + file.size, 0) > 1024 * 1024
              )
                throw new Error(
                  "Select a skill directory with at most 128 files and 1 MiB total.",
                );
              const root = files[0].webkitRelativePath.split("/")[0];
              const imported = [];
              for (const file of files) {
                const relative = file.webkitRelativePath;
                if (!relative.startsWith(`${root}/`))
                  throw new Error("Select one skill directory.");
                const path = relative.slice(root.length + 1);
                imported.push({
                  path,
                  contentBase64: await encodeFile(file),
                  executable: /\.(sh|py|mjs|js)$/iu.test(path),
                });
              }
              const { skill } = await rpc.call("saveAgentSkillBundle", {
                files: imported,
              });
              assign(skill);
            });
          }}
        />
        {editing !== null && (
          <SkillBundleEditor
            key={editing === "new" ? "new" : editing.id}
            skill={editing}
            onCancel={() => setEditing(null)}
            onAskAssistant={onAskAssistant}
            onSave={(skill) => {
              assign(skill, editing === "new" ? undefined : editing.id);
              setEditing(null);
            }}
          />
        )}
        <details
          className="text-xs"
          onToggle={(event) => setBrowsing(event.currentTarget.open)}
        >
          <summary className="cursor-pointer py-1 font-medium">
            Choose from installed skills
          </summary>
          <div className="space-y-2 pt-2">
            {!projectId && (
              <select
                className="w-full rounded-md border bg-background px-2 py-2"
                aria-label="Skill source project"
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
            <Input
              aria-label="Filter installed skills"
              placeholder="Find a skill…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {catalog
              .filter((skill) =>
                `${skill.name} ${skill.description ?? ""}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((skill) => (
                <div
                  className="flex items-start gap-2 border-b py-2 last:border-0"
                  key={skill.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{skill.name}</p>
                    <p className="text-muted-foreground">{skill.description}</p>
                    <p className="mt-1 text-muted-foreground">
                      {skill.scope}
                      {skill.provider ? ` · ${skill.provider}` : ""} · inherited
                      when available
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void action(async () => {
                        const result = await rpc.call(
                          "importInstalledAgentSkill",
                          {
                            projectId: selectedProject,
                            environmentId: null,
                            skillId: skill.id,
                          },
                        );
                        assign(result.skill);
                      })
                    }
                  >
                    Assign copy
                  </Button>
                </div>
              ))}
            {!catalog.length && (
              <p className="text-muted-foreground">
                No installed skills found in this project. Create a skill or
                import its directory.
              </p>
            )}
          </div>
        </details>
      </fieldset>
    </section>
  );
}
