import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AgentStudio } from "./studio/studio.js";
import { RuntimePanel } from "./runtime/panel.js";
import { WorkspacePanel } from "./workspace/view.js";
import { TeamBuilder } from "./teams/builder.js";
import { OrchestrationPanel } from "./policy/panel.js";
import { ContextPanel } from "./context/panel.js";
import { ArcThreadTeam } from "./threads/view.js";
import { ArcThreadAnnotations } from "./threads/annotations.js";
import { TeamAssistantPanel, teamAssistantTab } from "./teams/chat.js";
import {
  AgentAssistantPanel,
  AgentTestPanel,
  assistantTab,
  testTab,
} from "./studio/chat.js";

export default definePluginApp((app) => {
  app.slots.experimental_threadView({
    id: "team",
    label: "Team",
    component: ArcThreadTeam,
  });
  app.slots.experimental_threadListAnnotations({
    id: "team-bindings",
    component: ArcThreadAnnotations,
  });
  app.slots.navPanel({
    id: "workspace",
    title: "Workspace",
    icon: "Workflow",
    path: "workspace",
    component: WorkspacePanel,
  });
  app.slots.navPanel({
    id: "runs",
    title: "Runs",
    icon: "ListView",
    path: "runs",
    component: RuntimePanel,
  });
  app.slots.navPanel({
    id: "teams",
    title: "Teams",
    icon: "Layers",
    path: "teams",
    component: TeamBuilder,
    fixedTabs: [
      {
        ...teamAssistantTab,
        title: "Team assistant",
        icon: "MessageSquare",
        component: TeamAssistantPanel,
        layout: "flush",
      },
    ],
  });
  app.slots.navPanel({
    id: "context",
    title: "Context",
    icon: "Explore",
    path: "context",
    component: ContextPanel,
  });
  app.slots.navPanel({
    id: "orchestration",
    title: "Orchestration",
    icon: "SlidersHorizontal",
    path: "orchestration",
    component: OrchestrationPanel,
  });
  app.slots.navPanel({
    id: "agents",
    title: "Agents",
    icon: "Bot",
    path: "agents",
    component: AgentStudio,
    fixedTabs: [
      {
        ...assistantTab,
        title: "Assistant",
        icon: "MessageSquare",
        component: AgentAssistantPanel,
        layout: "flush",
      },
      {
        ...testTab,
        title: "Test agent",
        icon: "Play",
        component: AgentTestPanel,
        layout: "flush",
      },
    ],
  });
});
