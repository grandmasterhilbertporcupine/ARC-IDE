import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { buildSidebarEntitySectionId } from "@bb/client-core";
import type { ProjectResponse } from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { stripProjectThreads } from "@/hooks/queries/project-queries";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import {
  ProjectActionsContextMenu,
  ProjectActionsMenu,
} from "@/components/project/ProjectActionsMenu";
import {
  ALL_THREAD_PROJECTS,
  useThreadBrowserProject,
} from "./threadBrowserState";
import { useSidebarModeSectionOrder } from "./useSidebarModeSectionOrder";
import { ReorderableSidebarSectionOrderList } from "./ReorderableSidebarSectionOrderList";
import { useSidebarSortable } from "./sortableMotion";
import type { SidebarSectionId } from "./sidebarCollapsedAtoms";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";

interface ThreadBrowserProjectsProps {
  onNewProject?: () => void;
  onNavigate: () => void;
  isCreatingProject: boolean;
}

function SortableProjectLink({
  project,
  selected,
  onSelect,
  sectionId,
  disabled,
  consumeClickSuppression,
}: {
  project: ProjectResponse;
  selected: boolean;
  onSelect: (id: string) => void;
  sectionId: SidebarSectionId;
  disabled: boolean;
  consumeClickSuppression: ConsumeDragClickSuppression;
}) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: sectionId,
    disabled,
  });
  return (
    <ProjectActionsContextMenu project={project}>
      <div ref={setNodeRef} style={style} className="group/project relative">
        <button
          type="button"
          ref={dragBindings.setActivatorNodeRef}
          {...(disabled ? {} : dragBindings.attributes)}
          {...(disabled ? {} : dragBindings.listeners)}
          onClick={(event) => {
            if (consumeClickSuppression()) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onSelect(project.id);
          }}
          aria-current={selected ? "page" : undefined}
          title={project.name}
          className={cn(
            "arc-project-link pr-8",
            !disabled && "select-none",
            selected && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <Icon
            name="Folder"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{project.name}</span>
        </button>
        <div className="absolute right-1 top-1 opacity-0 focus-within:opacity-100 group-hover/project:opacity-100">
          <ProjectActionsMenu
            project={project}
            triggerClassName="size-6 text-muted-foreground"
          />
        </div>
      </div>
    </ProjectActionsContextMenu>
  );
}

export function ThreadBrowserProjects({
  onNewProject,
  onNavigate,
  isCreatingProject,
}: ThreadBrowserProjectsProps) {
  const query = useSidebarNavigation();
  const [selectedProject, setSelectedProject] = useThreadBrowserProject();
  const setComposeProject = useSetRootComposeProjectId();
  const navigate = useNavigate();
  const projects = useMemo(
    () => query.data?.projects.map(stripProjectThreads) ?? [],
    [query.data],
  );
  const projectsBySectionId = useMemo(
    () =>
      new Map<SidebarSectionId, ProjectResponse>(
        projects.map((project) => [
          buildSidebarEntitySectionId("project", project.id),
          project,
        ]),
      ),
    [projects],
  );
  const sectionIds = useMemo(
    () => [...projectsBySectionId.keys()],
    [projectsBySectionId],
  );
  const { order, persistedOrder, onOrderChange } = useSidebarModeSectionOrder({
    mode: "project",
    entitySectionIds: sectionIds,
    showPinnedSection: false,
    isReady: query.isSuccess && !query.isPlaceholderData,
  });
  const projectOrder = useMemo(
    () => order.filter((id) => projectsBySectionId.has(id)),
    [order, projectsBySectionId],
  );
  const selectProject = useCallback(
    (id: string) => {
      setSelectedProject(id);
      if (id !== ALL_THREAD_PROJECTS) setComposeProject(id);
      onNavigate();
      void navigate(getRootComposeRoutePath());
    },
    [navigate, onNavigate, setComposeProject, setSelectedProject],
  );

  return (
    <nav aria-label="Projects" className="px-2 pb-3">
      <button
        type="button"
        onClick={() => selectProject(ALL_THREAD_PROJECTS)}
        aria-current={
          selectedProject === ALL_THREAD_PROJECTS ? "page" : undefined
        }
        className={cn(
          "arc-project-link",
          selectedProject === ALL_THREAD_PROJECTS &&
            "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <Icon name="MessageSquare" className="size-4 shrink-0" />
        <span className="truncate">All threads</span>
      </button>
      <div className="mt-5 mb-1 flex h-7 items-center justify-between px-2">
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
        {onNewProject ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground"
            aria-label="New project"
            disabled={isCreatingProject}
            onClick={onNewProject}
          >
            <Icon name="Plus" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {query.isPending ? (
        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
          Loading projects…
        </p>
      ) : null}
      {query.isError ? (
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="px-2 py-3 text-left text-xs text-muted-foreground"
        >
          Projects unavailable. Retry
        </button>
      ) : null}
      <div className="[&>div]:space-y-0">
        <ReorderableSidebarSectionOrderList
          order={projectOrder}
          reorderOrder={persistedOrder}
          onOrderChange={onOrderChange}
        >
          {(sectionId, consumeClickSuppression) => {
            const project = projectsBySectionId.get(sectionId);
            return project ? (
              <SortableProjectLink
                key={sectionId}
                project={project}
                sectionId={sectionId}
                selected={selectedProject === project.id}
                onSelect={selectProject}
                disabled={
                  projectOrder.length < 2 ||
                  !query.isSuccess ||
                  query.isPlaceholderData
                }
                consumeClickSuppression={consumeClickSuppression}
              />
            ) : null;
          }}
        </ReorderableSidebarSectionOrderList>
      </div>
      <button
        type="button"
        onClick={() => selectProject(PERSONAL_PROJECT_ID)}
        aria-current={
          selectedProject === PERSONAL_PROJECT_ID ? "page" : undefined
        }
        className={cn(
          "arc-project-link mt-2",
          selectedProject === PERSONAL_PROJECT_ID &&
            "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">Personal</span>
      </button>
    </nav>
  );
}
