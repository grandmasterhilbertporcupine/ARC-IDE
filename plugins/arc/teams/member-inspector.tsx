import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import type { AgentMetadata, AgentSkillReference } from "../contract.js";
import { MemberModelEditor, type MemberIdentity } from "./member-model.js";
import { SkillAssignments } from "../studio/skills.js";
import type { TeamDefinition, TeamMember } from "./contract.js";
import { Field, selectClass } from "./inspector.js";
import { canLead, relationshipLabels } from "./organization.js";

export function TeamMemberInspector({
  member,
  definition,
  names,
  inheritedSkills,
  inheritedRole,
  inheritedExecution,
  editingModel,
  onEditModel,
  projectId,
  onChange,
  onDelete,
  onAddSubagent,
  onAddTask,
  onOpenAgent,
  onOpenStage,
  onAskSkillAssistant,
}: {
  member: TeamMember;
  definition: TeamDefinition;
  names: Map<string, MemberIdentity>;
  inheritedSkills: AgentSkillReference[];
  inheritedRole: string;
  inheritedExecution: AgentMetadata["execution"] | null;
  editingModel: boolean;
  onEditModel(editing: boolean): void;
  projectId: string | null;
  onChange(definition: TeamDefinition): void;
  onDelete(): void;
  onAddSubagent(): void;
  onAddTask(): void;
  onOpenAgent(): void;
  onOpenStage(stageId: string): void;
  onAskSkillAssistant(prompt: string): void;
}) {
  const update = (next: TeamMember) =>
    onChange({
      ...definition,
      schemaVersion: 2,
      members: definition.members.map((item) =>
        item.id === member.id ? next : item,
      ),
    });
  const stages = definition.graph.nodes.filter((node) =>
    node.kind === "agent" || node.kind === "review"
      ? node.memberId === member.id
      : node.kind === "repair"
        ? node.body.memberId === member.id
        : node.kind === "delegation"
          ? node.requesterMemberId === member.id
          : false,
  );
  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-medium">
          {names.get(member.id)?.name ?? "Agent"}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Published v{member.revision} ·{" "}
          {names.get(member.id)?.model ?? "Project model"}
        </p>
        <Button size="sm" variant="ghost" onClick={onOpenAgent}>
          Edit agent defaults
        </Button>
      </div>
      <MemberModelEditor
        member={member}
        identity={
          names.get(member.id) ?? { name: "Agent", model: "Loading model…" }
        }
        inherited={inheritedExecution}
        editing={editingModel}
        onEdit={onEditModel}
        onChange={update}
      />
      <Field
        label="Team role"
        hint="A role for this team. Leave blank to use the agent’s default role."
      >
        <Input
          aria-label="Member team role"
          value={member.role ?? ""}
          placeholder={inheritedRole || "e.g. Frontend lead"}
          maxLength={100}
          onChange={(event) => update({ ...member, role: event.target.value })}
        />
      </Field>
      <Field
        label="Responsibility"
        hint="What this member owns in the team. Precise work is assigned in Workflow."
      >
        <Textarea
          aria-label="Member responsibility"
          rows={4}
          maxLength={16000}
          value={member.responsibility ?? ""}
          onChange={(event) =>
            update({ ...member, responsibility: event.target.value })
          }
        />
      </Field>
      <Field label="Reports to">
        <select
          className={selectClass}
          aria-label="Member reports to"
          value={member.leaderMemberId ?? ""}
          disabled={definition.leaderMemberId === member.id}
          onChange={(event) =>
            update({ ...member, leaderMemberId: event.target.value || null })
          }
        >
          <option value="">No direct leader</option>
          {definition.members
            .filter((candidate) => canLead(definition, candidate.id, member.id))
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {names.get(candidate.id)?.name ?? candidate.id}
              </option>
            ))}
        </select>
      </Field>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={definition.leaderMemberId === member.id}
          onChange={(event) =>
            onChange({
              ...definition,
              schemaVersion: 2,
              leaderMemberId: event.target.checked ? member.id : null,
              members: event.target.checked
                ? definition.members.map((item) =>
                    item.id === member.id
                      ? { ...item, leaderMemberId: null }
                      : item,
                  )
                : definition.members,
            })
          }
        />
        <span>
          Team lead
          <span className="mt-1 block text-muted-foreground">
            The main point of coordination. Permissions stay explicit.
          </span>
        </span>
      </label>
      <Field label="Group">
        <select
          className={selectClass}
          aria-label="Member group"
          value={member.groupId ?? ""}
          onChange={(event) =>
            update({ ...member, groupId: event.target.value || null })
          }
        >
          <option value="">No group</option>
          {definition.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Published agent version">
        <Input
          type="number"
          aria-label="Member published version"
          min={1}
          value={member.revision}
          onChange={(event) => {
            const revision = Number(event.target.value);
            if (Number.isInteger(revision) && revision > 0)
              update({ ...member, revision });
          }}
        />
      </Field>
      <SkillAssignments
        value={member.skills ?? []}
        inherited={inheritedSkills}
        projectId={projectId}
        onChange={(skills) => update({ ...member, skills })}
        onAskAssistant={onAskSkillAssistant}
      />
      <section className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-medium">Assigned work</h4>
        {stages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No workflow stages yet.
          </p>
        )}
        {stages.map((stage) => (
          <Button
            key={stage.id}
            size="sm"
            variant="ghost"
            className="w-full justify-start"
            onClick={() => onOpenStage(stage.id)}
          >
            {stage.label || "Unnamed stage"}
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={onAddTask}>
          Add a task
        </Button>
      </section>
      <section className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-medium">Outgoing permissions</h4>
        {definition.permissions
          .filter((grant) => grant.fromMemberId === member.id)
          .map((grant) => (
            <p className="text-xs text-muted-foreground" key={grant.id}>
              {relationshipLabels[grant.action]}{" "}
              {names.get(grant.toMemberId)?.name ?? grant.toMemberId}
            </p>
          ))}
        <Button size="sm" variant="outline" onClick={onAddSubagent}>
          Add subagent
        </Button>
        <p className="text-xs text-muted-foreground">
          Choose an agent from the library. This adds delegation and messages in
          both directions.
        </p>
      </section>
      <Button size="sm" variant="ghost" onClick={onDelete}>
        Remove member
      </Button>
      <p className="text-xs text-muted-foreground">
        Assigned stages remain for reassignment. Direct reports become
        unassigned.
      </p>
    </div>
  );
}
