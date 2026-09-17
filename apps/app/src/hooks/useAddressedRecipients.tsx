import { useCallback, useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  experimentalAddressedRecipientSchema,
  type ExperimentalAddressedRecipient,
  type ExperimentalAddressing,
  type PromptInput,
  type PromptTextMention,
} from "@bb/domain";

const storedSchema = z.object({
  recipients: z.array(experimentalAddressedRecipientSchema).max(12),
  pending: z
    .object({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      operationId: z.string().uuid(),
    })
    .nullable(),
});
type Stored = z.infer<typeof storedSchema>;
const empty: Stored = { recipients: [], pending: null };
const cache = new Map<string, Stored>();
const listeners = new Set<() => void>();
const keyFor = (projectId: string, threadId: string | null) =>
  `arc.recipients.v1:${encodeURIComponent(projectId)}:${threadId ?? "new"}`;
const identity = (recipient: ExperimentalAddressedRecipient) =>
  `${recipient.pluginId}:${recipient.kind}:${recipient.entityId}`;

function read(key: string): Stored {
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? storedSchema.safeParse(JSON.parse(raw)) : null;
    const value = parsed?.success ? parsed.data : empty;
    cache.set(key, value);
    return value;
  } catch {
    return empty;
  }
}

function write(key: string, value: Stored) {
  cache.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function transferAddressedRecipients(
  projectId: string,
  threadId: string,
  recipients: ExperimentalAddressedRecipient[],
) {
  write(keyFor(projectId, threadId), { recipients, pending: null });
}

function mentionedRecipients(
  mentions: readonly PromptTextMention[],
): ExperimentalAddressedRecipient[] {
  return mentions.flatMap(({ resource }) =>
    resource.kind === "plugin" && resource.experimental_recipient
      ? [
          {
            ...resource.experimental_recipient,
            pluginId: resource.pluginId,
            label: resource.label,
          },
        ]
      : [],
  );
}

export function useAddressedRecipients(args: {
  projectId: string;
  threadId: string | null;
  mentions: readonly PromptTextMention[];
  removeMention: (recipient: ExperimentalAddressedRecipient) => void;
}) {
  const key = keyFor(args.projectId, args.threadId);
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const state = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => empty,
  );
  useEffect(() => {
    const current = read(key);
    const merged = new Map(
      current.recipients.map((recipient) => [identity(recipient), recipient]),
    );
    for (const recipient of mentionedRecipients(args.mentions))
      merged.set(identity(recipient), recipient);
    const recipients = [...merged.values()].slice(0, 12);
    if (JSON.stringify(recipients) !== JSON.stringify(current.recipients))
      write(key, { recipients, pending: null });
  }, [args.mentions, key]);
  const forSend = useCallback(
    async (
      input: readonly PromptInput[],
    ): Promise<ExperimentalAddressing | undefined> => {
      const current = read(key);
      const merged = new Map(
        current.recipients.map((recipient) => [identity(recipient), recipient]),
      );
      for (const block of input)
        if (block.type === "text")
          for (const recipient of mentionedRecipients(block.mentions))
            merged.set(identity(recipient), recipient);
      const recipients = [...merged.values()];
      if (recipients.length === 0) return undefined;
      const fingerprint = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify({ input, recipients })),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const latest = read(key);
      if (
        JSON.stringify(latest.recipients) !== JSON.stringify(current.recipients)
      )
        throw new Error(
          "The work recipients changed while preparing this message. Send it again with the selected recipients.",
        );
      const operationId =
        latest.pending?.fingerprint === fingerprint
          ? latest.pending.operationId
          : crypto.randomUUID();
      write(key, { recipients, pending: { fingerprint, operationId } });
      return { operationId, recipients };
    },
    [key],
  );
  const acknowledge = useCallback(
    (operationId: string | undefined) => {
      const current = read(key);
      if (current.pending?.operationId === operationId)
        write(key, { ...current, pending: null });
    },
    [key],
  );
  const remove = (recipient: ExperimentalAddressedRecipient) => {
    args.removeMention(recipient);
    write(key, {
      recipients: read(key).recipients.filter(
        (entry) => identity(entry) !== identity(recipient),
      ),
      pending: null,
    });
  };
  const chips = state.recipients.length ? (
    <div
      className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-caption"
      aria-label="Work recipients"
    >
      <span className="text-muted-foreground">Send work to</span>
      {state.recipients.map((recipient) => (
        <Tooltip key={identity(recipient)}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => remove(recipient)}
              className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-accent focus-visible:outline-2"
              aria-label={`Remove ${recipient.label} recipient`}
            >
              @{recipient.label}{" "}
              <span className="text-muted-foreground">
                v{recipient.versionId} ×
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{`${recipient.kind} · ${recipient.scopeKey} · published v${recipient.versionId}. Click to remove.`}</TooltipContent>
        </Tooltip>
      ))}
      <span className="text-muted-foreground">
        {state.recipients.length > 1
          ? "One lead coordinates the result"
          : "Runs when you send"}
      </span>
    </div>
  ) : null;
  return { recipients: state.recipients, forSend, acknowledge, chips };
}
