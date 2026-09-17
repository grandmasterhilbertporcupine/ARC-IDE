import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import type { TeamDefinition, TeamGrant } from "./contract.js";
import { Field, selectClass } from "./inspector.js";
import { ReviewGrantRequirements } from "./review-grants-view.js";
import { relationshipLabels, removeTeamMember } from "./organization.js";

export function TeamPeople({
  definition,
  names,
  onChange,
}: {
  definition: TeamDefinition;
  names: Map<string, { name: string; model: string }>;
  onChange(definition: TeamDefinition): void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [action, setAction] = useState<TeamGrant["action"]>("delegate");
  const source = definition.members.some((member) => member.id === from)
    ? from
    : (definition.members[0]?.id ?? "");
  const target = definition.members.some((member) => member.id === to)
    ? to
    : (definition.members.find((member) => member.id !== source)?.id ?? "");
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 overflow-y-auto p-5">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Groups</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Organize your team with names and colors. Groups do not grant
              permissions.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const id = `group_${crypto.randomUUID()}`;
              onChange({
                ...definition,
                groups: [
                  ...definition.groups,
                  {
                    id,
                    name: "New group",
                    color: "#e2e8f0",
                    parentGroupId: null,
                  },
                ],
              });
            }}
          >
            Add group
          </Button>
        </div>
        {definition.groups.length === 0 && (
          <p className="border-b py-4 text-sm text-muted-foreground">
            Add a group such as Blue team or Frontend.
          </p>
        )}
        {definition.groups.map((group) => (
          <div
            key={group.id}
            className="grid grid-cols-[2.5rem_minmax(8rem,1fr)] items-end gap-3 border-b pb-3 @[800px]/teams:grid-cols-[2.5rem_1fr_1fr_auto]"
          >
            <Field label="Color">
              <input
                aria-label={`Color for ${group.name}`}
                type="color"
                className="h-8 w-9 cursor-pointer rounded border bg-background"
                value={group.color}
                onChange={(event) =>
                  onChange({
                    ...definition,
                    groups: definition.groups.map((item) =>
                      item.id === group.id
                        ? { ...item, color: event.target.value }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Group name">
              <Input
                aria-label={`Group name ${group.id}`}
                value={group.name}
                maxLength={100}
                onChange={(event) =>
                  onChange({
                    ...definition,
                    groups: definition.groups.map((item) =>
                      item.id === group.id
                        ? { ...item, name: event.target.value }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Inside group">
              <select
                aria-label={`Parent of ${group.name}`}
                className={selectClass}
                value={group.parentGroupId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...definition,
                    groups: definition.groups.map((item) =>
                      item.id === group.id
                        ? { ...item, parentGroupId: event.target.value || null }
                        : item,
                    ),
                  })
                }
              >
                <option value="">Top level</option>
                {definition.groups
                  .filter((item) => item.id !== group.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove group ${group.name}`}
              onClick={() =>
                onChange({
                  ...definition,
                  groups: definition.groups
                    .filter((item) => item.id !== group.id)
                    .map((item) =>
                      item.parentGroupId === group.id
                        ? { ...item, parentGroupId: group.parentGroupId }
                        : item,
                    ),
                  members: definition.members.map((item) =>
                    item.groupId === group.id
                      ? { ...item, groupId: group.parentGroupId }
                      : item,
                  ),
                  presentation: {
                    ...definition.presentation,
                    groups: definition.presentation.groups.filter(
                      (item) => item.groupId !== group.id,
                    ),
                  },
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">Members</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Versions stay pinned until you choose a different published
            revision.
          </p>
        </div>
        {definition.members.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Add published agents from the graph’s agent library.
          </p>
        )}
        {definition.members.map((member) => (
          <div
            key={member.id}
            className="grid grid-cols-1 items-center gap-3 border-b pb-3 @[800px]/teams:grid-cols-[1fr_6rem_1fr_auto]"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {names.get(member.id)?.name ?? "Loading agent…"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {names.get(member.id)?.model ?? member.agentId}
              </p>
            </div>
            <Field label="Revision">
              <Input
                type="number"
                aria-label={`Revision for ${names.get(member.id)?.name ?? member.id}`}
                min={1}
                value={member.revision}
                onChange={(event) =>
                  onChange({
                    ...definition,
                    members: definition.members.map((item) =>
                      item.id === member.id
                        ? { ...item, revision: Number(event.target.value) }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Group">
              <select
                aria-label={`Group for ${names.get(member.id)?.name ?? member.id}`}
                className={selectClass}
                value={member.groupId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...definition,
                    members: definition.members.map((item) =>
                      item.id === member.id
                        ? { ...item, groupId: event.target.value || null }
                        : item,
                    ),
                  })
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
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange(removeTeamMember(definition, member.id))}
            >
              Remove member
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Removing a member leaves its assigned stages visible for reassignment.
          Validation will point them out.
        </p>
      </section>
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">Collaboration permissions</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Connections order work. These directed grants allow one member to
            message, delegate to or review another. Leadership is separate.
          </p>
        </div>
        <div className="grid grid-cols-1 items-end gap-3 @[800px]/teams:grid-cols-[1fr_1fr_1fr_auto]">
          <Field label="From agent">
            <select
              aria-label="From agent"
              className={selectClass}
              value={source}
              onChange={(event) => setFrom(event.target.value)}
            >
              <option value="">Choose a member</option>
              {definition.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {names.get(member.id)?.name ?? member.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="May">
            <select
              aria-label="Collaboration action"
              className={selectClass}
              value={action}
              onChange={(event) =>
                setAction(
                  event.target.value === "review"
                    ? "review"
                    : event.target.value === "message"
                      ? "message"
                      : "delegate",
                )
              }
            >
              <option value="delegate">Delegate to</option>
              <option value="review">Review work by</option>
              <option value="message">Message</option>
            </select>
          </Field>
          <Field label="To agent">
            <select
              aria-label="To agent"
              className={selectClass}
              value={target}
              onChange={(event) => setTo(event.target.value)}
            >
              <option value="">Choose a member</option>
              {definition.members
                .filter((member) => member.id !== source)
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {names.get(member.id)?.name ?? member.id}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !source ||
              !target ||
              source === target ||
              definition.permissions.some(
                (grant) =>
                  grant.fromMemberId === source &&
                  grant.toMemberId === target &&
                  grant.action === action,
              )
            }
            onClick={() =>
              onChange({
                ...definition,
                permissions: [
                  ...definition.permissions,
                  {
                    id: `grant_${crypto.randomUUID()}`,
                    fromMemberId: source,
                    toMemberId: target,
                    action,
                  },
                ],
              })
            }
          >
            Add grant
          </Button>
        </div>
        <ReviewGrantRequirements definition={definition} names={names} />
        {definition.permissions.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            No communication, delegation or cross-member review grants.
          </p>
        )}
        {definition.permissions.map((grant) => (
          <div
            key={grant.id}
            className="flex items-center justify-between gap-3 border-b py-2 text-sm"
          >
            <span>
              {names.get(grant.fromMemberId)?.name ?? grant.fromMemberId}{" "}
              <span className="text-muted-foreground">
                may {relationshipLabels[grant.action].toLowerCase()}
              </span>{" "}
              {names.get(grant.toMemberId)?.name ?? grant.toMemberId}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...definition,
                  permissions: definition.permissions.filter(
                    (item) => item.id !== grant.id,
                  ),
                })
              }
            >
              Remove grant
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
