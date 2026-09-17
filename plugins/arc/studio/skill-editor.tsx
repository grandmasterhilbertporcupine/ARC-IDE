import { useEffect, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import type { AgentSkillBundle } from "../contract.js";
import type { SkillAuthoringFields } from "../skill-contract.js";
import { agentSkillFilesSchema } from "../skill-contract.js";
import { Field } from "../teams/inspector.js";
import { errorMessage, useStudioRpc } from "./data.js";

const encode = (text: string) =>
  btoa(
    Array.from(new TextEncoder().encode(text), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
const decode = (base64: string) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
  if (text.includes("\0")) throw new Error("Binary file");
  return text;
};

export function SkillBundleEditor({
  skill,
  onSave,
  onCancel,
  onAskAssistant,
}: {
  skill: AgentSkillBundle | "new";
  onSave(skill: AgentSkillBundle): void;
  onCancel(): void;
  onAskAssistant?(prompt: string): void;
}) {
  const rpc = useStudioRpc();
  const [files, setFiles] = useState<AgentSkillBundle["files"]>(
    skill === "new"
      ? [{ path: "SKILL.md", executable: false, contentBase64: "" }]
      : skill.files,
  );
  const [markdown, setMarkdown] = useState(() =>
    skill === "new"
      ? ""
      : decode(
          skill.files.find((file) => file.path === "SKILL.md")!.contentBase64,
        ),
  );
  const [fields, setFields] = useState<SkillAuthoringFields>({
    name: "",
    description: "",
    instructions: "",
  });
  const [raw, setRaw] = useState(false);
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [newPath, setNewPath] = useState("");
  const [busy, setBusy] = useState(skill !== "new");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (skill === "new") return;
    let active = true;
    void rpc.call("parseAgentSkillMarkdown", { markdown }).then(
      (result) => {
        if (active) {
          setFields(result.fields);
          setBusy(false);
        }
      },
      (failure: unknown) => {
        if (active) {
          setError(errorMessage(failure));
          setRaw(true);
          setBusy(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, skill]);
  const selected = files.find((file) => file.path === selectedPath);
  let selectedText: string | null = null;
  if (selected && selectedPath !== "SKILL.md") {
    try {
      selectedText = decode(selected.contentBase64);
    } catch {}
  }
  const field = (name: keyof SkillAuthoringFields, value: string) =>
    setFields((previous) => ({ ...previous, [name]: value }));
  const updateFile = (
    path: string,
    update: Partial<AgentSkillBundle["files"][number]>,
  ) =>
    setFiles((previous) =>
      previous.map((file) =>
        file.path === path ? { ...file, ...update } : file,
      ),
    );
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function switchMode() {
    await action(async () => {
      if (raw)
        setFields(
          (await rpc.call("parseAgentSkillMarkdown", { markdown })).fields,
        );
      else
        setMarkdown(
          (await rpc.call("renderAgentSkillMarkdown", { markdown, fields }))
            .markdown,
        );
      setRaw(!raw);
    });
  }
  async function save() {
    await action(async () => {
      const text = raw
        ? markdown
        : (await rpc.call("renderAgentSkillMarkdown", { markdown, fields }))
            .markdown;
      const result = await rpc.call("saveAgentSkillBundle", {
        files: files.map((file) =>
          file.path === "SKILL.md"
            ? { ...file, contentBase64: encode(text) }
            : file,
        ),
      });
      onSave(result.skill);
    });
  }
  async function ask() {
    await action(async () => {
      const requested = raw
        ? (await rpc.call("parseAgentSkillMarkdown", { markdown })).fields
        : fields;
      const supportingFiles = files
        .filter(
          (file) =>
            file.path !== "SKILL.md" &&
            (skill === "new" ||
              !skill.files.some(
                (original) =>
                  original.path === file.path &&
                  original.contentBase64 === file.contentBase64 &&
                  original.executable === file.executable,
              )),
        )
        .map((file) => ({
          path: file.path,
          text: decode(file.contentBase64),
          executable: file.executable,
        }));
      const request = {
        baseSkillId: skill === "new" ? null : skill.id,
        fields: requested,
        supportingFiles,
        removePaths:
          skill === "new"
            ? []
            : skill.files
                .filter(
                  (file) =>
                    !files.some((retained) => retained.path === file.path),
                )
                .map((file) => file.path),
      };
      const prompt = `Help me build this skill. Clarify when to use it and write concrete instructions and verification. Use arc_skill_bundle_create to prepare an immutable unassigned bundle, then propose its pinned reference through the bound agent or team proposal tool for my review. Preserve unrelated definition fields and existing supporting files. Do not apply or publish.\n\nSkill request:\n${JSON.stringify(request, null, 2)}`;
      if (prompt.length > 90000)
        throw new Error(
          "This skill draft is too large for an assistant request. Save the skill and ask for a smaller change.",
        );
      onAskAssistant?.(prompt);
    });
  }
  return (
    <fieldset
      disabled={busy}
      className="min-w-0 space-y-3 rounded-md border p-3"
      aria-label="Skill editor"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">
          {skill === "new" ? "Create a skill" : skill.name}
        </h4>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating skill…
        </p>
      )}
      <div className="flex flex-wrap gap-1" aria-label="Skill files">
        {files.map((file) => (
          <Button
            key={file.path}
            size="sm"
            variant={selectedPath === file.path ? "secondary" : "ghost"}
            onClick={() => setSelectedPath(file.path)}
          >
            {file.path}
          </Button>
        ))}
      </div>
      {selectedPath === "SKILL.md" ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {raw ? "Standard SKILL.md" : "Agent procedure"}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void switchMode()}>
              {raw ? "Guided editor" : "Edit raw Markdown"}
            </Button>
          </div>
          {raw ? (
            <Textarea
              aria-label="Skill Markdown"
              className="min-h-56 font-mono text-xs"
              value={markdown}
              maxLength={1000000}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          ) : (
            <>
              <Field
                label="Name"
                hint="A short lowercase name, using hyphens between words."
              >
                <Input
                  aria-label="Skill name"
                  value={fields.name}
                  maxLength={64}
                  placeholder="review-accessibility"
                  onChange={(event) => field("name", event.target.value)}
                />
              </Field>
              <Field
                label="When to use"
                hint="Describe the tasks or situations that should trigger this skill."
              >
                <Textarea
                  aria-label="When to use this skill"
                  rows={3}
                  value={fields.description}
                  maxLength={1024}
                  placeholder="Use when reviewing interface changes for keyboard and screen-reader accessibility."
                  onChange={(event) => field("description", event.target.value)}
                />
              </Field>
              <Field
                label="Instructions"
                hint="Explain the steps, expected output, and how to verify the result. Reference supporting files by their relative paths."
              >
                <Textarea
                  aria-label="Skill instructions"
                  rows={9}
                  value={fields.instructions}
                  maxLength={1000000}
                  placeholder="1. Inspect the changed controls…"
                  onChange={(event) =>
                    field("instructions", event.target.value)
                  }
                />
              </Field>
            </>
          )}
        </>
      ) : (
        selected && (
          <>
            {selectedText === null ? (
              <p className="text-xs text-muted-foreground">
                Binary supporting file. Its exact contents are retained when you
                save.
              </p>
            ) : (
              <Textarea
                aria-label={`Contents of ${selectedPath}`}
                rows={10}
                className="font-mono text-xs"
                maxLength={1000000}
                value={selectedText}
                onChange={(event) =>
                  updateFile(selectedPath, {
                    contentBase64: encode(event.target.value),
                  })
                }
              />
            )}
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected.executable}
                  onChange={(event) =>
                    updateFile(selectedPath, {
                      executable: event.target.checked,
                    })
                  }
                />
                Executable file
              </label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFiles((previous) =>
                    previous.filter((file) => file.path !== selectedPath),
                  );
                  setSelectedPath("SKILL.md");
                }}
              >
                Remove file
              </Button>
            </div>
          </>
        )
      )}
      <div className="flex items-end gap-2">
        <Field label="Add a supporting text file">
          <Input
            aria-label="New supporting file path"
            value={newPath}
            placeholder="references/checklist.md"
            onChange={(event) => setNewPath(event.target.value)}
          />
        </Field>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const path = newPath.trim();
            if (
              !agentSkillFilesSchema.element.shape.path.safeParse(path)
                .success ||
              files.some(
                (file) => file.path.toLowerCase() === path.toLowerCase(),
              )
            ) {
              setError("Choose a new relative file path.");
              return;
            }
            setFiles((previous) => [
              ...previous,
              { path, contentBase64: "", executable: false },
            ]);
            setSelectedPath(path);
            setNewPath("");
            setError(null);
          }}
        >
          Add file
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {files.length} {files.length === 1 ? "file" : "files"}. Saving creates a
        new pinned copy; published agents keep their existing version. Other
        frontmatter is retained.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void save()}>
          Save skill and assign
        </Button>
        {onAskAssistant && (
          <Button size="sm" variant="outline" onClick={() => void ask()}>
            Build with assistant
          </Button>
        )}
      </div>
      {onAskAssistant && (
        <p className="text-xs text-muted-foreground">
          The assistant opens with your request ready to send and saves the
          current agent or team draft. Skill suggestions need your review before
          assignment.
        </p>
      )}
    </fieldset>
  );
}
