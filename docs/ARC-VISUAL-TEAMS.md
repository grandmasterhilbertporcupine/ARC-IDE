# Visual teams, skills and Preview

Build a team, give it work in chat, inspect the collaboration, and test its result in Preview. ARC uses the coding providers you have connected. The bundled Efficient Build team does not require Spotify Portal or promise a particular token saving.

## Start with Efficient Build

1. Open Team Builder and choose **Efficient Build** from the templates.
2. Choose a project, a connected model for each role, and the command that verifies this project. A typical command is `npm test`, but use the command your project actually supports.
3. Create the team. ARC creates editable project copies of the Lead, Reader, Builder and Reviewer and their skills. Creating a copy does not start work.
4. Review the Team and Workflow views, then address the published team in a project conversation.

The Lead plans and coordinates. The Reader returns concise findings and source references. The Builder makes scoped changes. The Reviewer independently checks the combined result. Failed checks can enter the configured repair rounds. Model defaults can be reused; each project keeps its own setup and verification command. Later template updates do not overwrite your copies.

## Build or edit a team

**Team** describes the people and their permissions. Drag an agent from the library onto the canvas, or use its Add action. Select a member to edit its role, responsibility, group, leader and skills. Use the connection controls as a keyboard alternative to drawing a line. Undo and Redo let you revise the draft.

Name the team and choose its accent color directly in the builder toolbar. The color appears on member and workflow cards; groups keep their own outlines. Reset color restores the group/theme accents.

Each member and assigned workflow card shows its model and provider logo. Click the model to open that member's model settings on the same page. Choose a connected provider/model and its reasoning settings, then **Apply model**. Opening or cancelling the picker leaves the draft unchanged. Choose **Use agent default** to inherit the pinned agent revision again. Model choices apply only to this team member. Save the draft and publish a new team version to use them in new runs; existing runs retain their original model snapshots.

| Connection   | Meaning                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| Reports to   | The selected agent reports to this leader. This describes the hierarchy.            |
| Can message  | The agent at the start of the arrow can send to the agent at the end.               |
| Can delegate | The first agent may delegate to the second within the workflow's configured limits. |
| Can review   | The first agent may review work contributed by the second.                          |
| Run after    | In Workflow, this stage waits for the connected stage and its required outcome.     |

The **Show** filter starts with Reports to so the hierarchy is easy to read. Switch to a permission type or All connections to inspect other relationships. **Draw** chooses the type of connection you create; creating one reveals it. Filtering only changes the view.

Hierarchy does not create permissions or execution order. **Add sub-agent** shows the delegation and messaging connections it will add. A fixed workflow can run without a designated team lead.

**Workflow** describes the work: assignments, parallel branches, joins, conditions, checks, review and bounded repair. It edits the same team definition as Team. Selecting a member also highlights its assignments. Fix validation errors before running, and publish a revision when the draft is ready for chat recipients.

## Give agents skills

Open **Skills** in Agent Studio or the selected team member's inspector. Choose an installed skill, import a folder, or create one with Name, When to use, Instructions and supporting files. Raw `SKILL.md` remains available. **Build with assistant** prepares a request in the authoring conversation for you to send; review its proposed draft before applying it.

Keep reusable defaults on the agent. Add project-team responsibilities and extra skills on the member. Assigned and inherited skills are shown separately. An explicit assignment takes precedence when it has the same skill name as a shared skill; a member assignment takes precedence over its agent default.

Published revisions and run snapshots retain the exact assigned files. Editing a skill or publishing another revision does not change an active run. If a skill is missing or the selected provider cannot load it, ARC reports the setup problem instead of silently dropping the assignment.

## Address work in chat

Type `@` and choose a published Team or Agent. Suggestions show its scope and version. Selecting one only adds a recipient chip. Work starts when you press Send. Chips remain for follow-ups until you remove or change them.

Several recipients share one coordinated run and one limit on calls and active time. You can inspect worker conversations, retained reader reports, messages, check results and review from the run. Directional messaging permissions still apply. Explicit questions can admit bounded reply turns; informational messages do not automatically wake another agent.

Follow-ups wait for controlled admission. They retain the previous verified candidate and consumed limits, and verify source again. Pause holds work; Stop does not automatically restart it. If a follow-up needs attention, read its saved error and use its available Retry or Cancel action. Retrying an uncertain Send preserves its operation identity rather than creating duplicate work.

Changing recipients preserves mandatory checks and supported check-based branch choices. If earlier verification depends on approval/release controls, nested conditions or another decision ARC cannot safely replay, the follow-up stays saved and needs attention. Cancel that unadmitted follow-up in Workspace, restore the previous recipient versions and send again. This keeps the verified candidate, consumed limits and existing gates.

**Usage & results** shows available provider input, output and cached-input tokens by role and model. Unreported values say Unavailable. Partial coverage is labeled. Inspect the recorded checks, independent review and candidate before deciding what to do with the result; this milestone does not automatically merge or deploy it.

## Test with Preview

Open **Preview** in the secondary panel. Select a detected project script or enter a launch command. The saved configuration includes its working folder and host. Saving does not execute it.

Use **Start**, **Stop**, **Restart** and logs to manage the preview. ARC checks that the announced local URL belongs to that preview's process before reporting Running. If another process owns the port, change the command or port. Stop targets the preview session; it does not stop unrelated terminals. A disconnected host must reconnect before ARC can confirm cleanup.

If ARC loses the terminal and cannot confirm that its process exited, it keeps replacement launches blocked. Inspect the recorded host, terminal and logs, and stop any remaining server using that host's tools. **Detach lost session** is a separate, explicitly confirmed recovery action: it releases tracking and retains the session evidence. It does not stop the old process or certify cleanup. A new launch must still prove ownership of its own listening URL.

Application hot reload continues to work. Open an `.html` or `.htm` file and choose **Inspect in Preview** for an isolated live preview of the file and its relative assets. Active file previews renew their session; reopening recovers an expired session. Large asset sets show their coverage limit.

Select an element, take a screenshot, add a note and choose **Send to agent** to attach feedback to the composer. Review it there before sending. The attachment includes the selected element, URL or file and bounded diagnostic context. Agents can inspect the visible Electron preview on Windows. **Stop / Take over** returns control to you.

A remote host's localhost is not this computer's localhost. Use an existing configured connection or an explicitly reachable URL. ARC does not silently expose project ports.

## CLI, SDK and verification

The same operations are available through the `bb` CLI and SDK. Use `bb guide plugins`, `bb guide threads`, `bb guide browser` and the ARC agents skill for exact inputs, operation identities and experimental API contracts. Relevant CLI groups include `bb arc templates`, `bb arc agents`, `bb arc teams`, `bb arc runs`, `bb arc workspace`, `bb thread` and `bb preview`.

Actual test and packaged-acceptance results are recorded in [ARC-PROGRESS.md](ARC-PROGRESS.md). Local desktop verification does not certify a clean Windows installation. Public publishing, automatic promotion and expanded remote hosting remain outside this milestone.
