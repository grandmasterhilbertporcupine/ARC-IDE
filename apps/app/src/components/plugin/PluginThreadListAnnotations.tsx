import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import type { ExperimentalThreadListAnnotation } from "@get-bb/plugin-sdk";
import {
  usePluginSlots,
  type ExperimentalThreadListAnnotationsSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

export interface ResolvedThreadListAnnotation extends ExperimentalThreadListAnnotation {
  pluginId: string;
  registrationId: string;
}

const emptyAnnotations: readonly ResolvedThreadListAnnotation[] = [];
const threadRowsSchema = z.array(z.tuple([z.string(), z.string()]));
const AnnotationContext = createContext<
  ReadonlyMap<string, readonly ResolvedThreadListAnnotation[]>
>(new Map());
const annotationsSchema = z
  .array(
    z.object({
      threadId: z.string().min(1).max(256),
      identities: z
        .array(
          z.object({
            kind: z.enum(["agent", "group"]),
            id: z.string().min(1).max(256),
            label: z.string().min(1).max(256),
            detail: z.string().max(512).nullable(),
            color: z.string().max(128).nullable(),
          }),
        )
        .max(8)
        .refine(
          (items) =>
            new Set(items.map((item) => item.id)).size === items.length,
        ),
      counters: z
        .array(
          z.object({
            id: z.string().min(1).max(256),
            label: z.string().min(1).max(128),
            value: z.number().int().nonnegative(),
          }),
        )
        .max(8)
        .refine(
          (items) =>
            new Set(items.map((item) => item.id)).size === items.length,
        ),
      viewId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .max(128)
        .nullable(),
    }),
  )
  .max(500);

interface Batch {
  key: string;
  projectId: string;
  threadIds: readonly string[];
  slot: ExperimentalThreadListAnnotationsSlot;
}

function AnnotationPublisher({
  batch,
  publish,
}: {
  batch: Batch;
  publish: (
    key: string,
    annotations: readonly ExperimentalThreadListAnnotation[] | null,
  ) => void;
}) {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      publish(batch.key, null);
    };
  }, [batch.key, publish]);
  const onChange = useCallback(
    (value: readonly ExperimentalThreadListAnnotation[]) => {
      if (!live.current) return;
      const parsed = annotationsSchema.safeParse(value);
      const seen = new Set<string>();
      const allowed = new Set(batch.threadIds);
      publish(
        batch.key,
        parsed.success
          ? parsed.data.filter((annotation) => {
              if (
                !allowed.has(annotation.threadId) ||
                seen.has(annotation.threadId)
              )
                return false;
              seen.add(annotation.threadId);
              return true;
            })
          : [],
      );
    },
    [batch, publish],
  );
  const Component = batch.slot.component;
  return (
    <Component
      projectId={batch.projectId}
      threadIds={batch.threadIds}
      onChange={onChange}
    />
  );
}

export function PluginThreadListAnnotationsProvider({
  threads,
  children,
}: {
  threads: readonly { id: string; projectId: string }[];
  children: ReactNode;
}) {
  const { threadListAnnotations, threadViews } = usePluginSlots();
  const rowsKey = JSON.stringify(
    threads
      .slice(0, 500)
      .map(({ id, projectId }) => [projectId, id])
      .sort(),
  );
  const batches = useMemo(() => {
    const projects = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const [projectId, id] of threadRowsSchema.parse(JSON.parse(rowsKey))) {
      if (!id || !projectId || seen.has(id)) continue;
      seen.add(id);
      const ids = projects.get(projectId) ?? [];
      ids.push(id);
      projects.set(projectId, ids);
    }
    return [...projects.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([projectId, ids]) => {
        const threadIds = ids.sort();
        return threadListAnnotations.map((slot): Batch => ({
          key: JSON.stringify([
            slot.pluginId,
            slot.id,
            slot.generation,
            projectId,
            threadIds,
          ]),
          projectId,
          threadIds,
          slot,
        }));
      });
  }, [rowsKey, threadListAnnotations]);
  const [published, setPublished] = useState<
    ReadonlyMap<string, readonly ExperimentalThreadListAnnotation[]>
  >(new Map());
  const publish = useCallback(
    (
      key: string,
      annotations: readonly ExperimentalThreadListAnnotation[] | null,
    ) => {
      setPublished((previous) => {
        if (annotations === null && !previous.has(key)) return previous;
        const next = new Map(previous);
        if (annotations === null) next.delete(key);
        else next.set(key, annotations);
        return next;
      });
    },
    [],
  );
  const resolved = useMemo(() => {
    const result = new Map<string, ResolvedThreadListAnnotation[]>();
    for (const batch of batches) {
      for (const annotation of published.get(batch.key) ?? []) {
        const existing = result.get(annotation.threadId) ?? [];
        existing.push({
          ...annotation,
          viewId: threadViews.some(
            (view) =>
              view.pluginId === batch.slot.pluginId &&
              view.id === annotation.viewId,
          )
            ? annotation.viewId
            : null,
          pluginId: batch.slot.pluginId,
          registrationId: batch.slot.id,
        });
        result.set(annotation.threadId, existing);
      }
    }
    return result;
  }, [batches, published, threadViews]);
  return (
    <AnnotationContext.Provider value={resolved}>
      {children}
      {batches.map((batch) => (
        <PluginSlotMount
          key={batch.key}
          pluginId={batch.slot.pluginId}
          slotKind="threadListAnnotations"
          slotId={batch.slot.id}
          instanceId={batch.projectId}
          crashFallback={null}
        >
          <AnnotationPublisher batch={batch} publish={publish} />
        </PluginSlotMount>
      ))}
    </AnnotationContext.Provider>
  );
}

export function useThreadListAnnotation(
  threadId: string,
): readonly ResolvedThreadListAnnotation[] {
  return useContext(AnnotationContext).get(threadId) ?? emptyAnnotations;
}
