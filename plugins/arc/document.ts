import {
  agentMetadataSchema,
  MAX_AGENT_DOCUMENT_CHARS,
  type AgentMetadata,
} from "./contract.js";

export interface AgentDocument {
  metadata: AgentMetadata;
  body: string;
  document: string;
}

export function defaultAgentMetadata(name = "Untitled agent"): AgentMetadata {
  return {
    schemaVersion: 1,
    name,
    description: "",
    specialty: "",
    role: "",
    execution: {
      providerId: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    },
  };
}

export function serializeAgentDocument(
  metadata: AgentMetadata,
  body: string,
): string {
  const parsed = agentMetadataSchema.parse(metadata);
  const canonicalBody = body.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  const document = `---\n${JSON.stringify(parsed, null, 2)}\n---\n\n${canonicalBody}\n`;
  if (document.length > MAX_AGENT_DOCUMENT_CHARS)
    throw new Error(
      `Agent document exceeds ${MAX_AGENT_DOCUMENT_CHARS} characters`,
    );
  return document;
}

export function parseAgentDocument(input: string): AgentDocument {
  if (input.length > MAX_AGENT_DOCUMENT_CHARS)
    throw new Error(
      `Agent document exceeds ${MAX_AGENT_DOCUMENT_CHARS} characters`,
    );
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n"))
    throw new Error(
      "Agent documents must start with JSON metadata between --- delimiters",
    );
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1)
    throw new Error(
      "Agent metadata must end with a --- delimiter on its own line",
    );
  let value: unknown;
  try {
    value = JSON.parse(normalized.slice(4, end));
  } catch {
    throw new Error("Agent metadata must be valid JSON");
  }
  const metadata = agentMetadataSchema.parse(value);
  const body = normalized.slice(end + 5).replace(/^\n+|\n+$/g, "");
  return { metadata, body, document: serializeAgentDocument(metadata, body) };
}

export function describeAgentDocumentChanges(
  before: string,
  after: string,
): { changedFields: string[]; operationalChanges: string[] } {
  const previous = parseAgentDocument(before);
  const next = parseAgentDocument(after);
  const changedFields: string[] = [];
  for (const field of ["name", "description", "specialty", "role"] as const) {
    if (previous.metadata[field] !== next.metadata[field])
      changedFields.push(field);
  }
  if (previous.body !== next.body) changedFields.push("instructions");
  const operationalChanges: string[] = [];
  if (
    JSON.stringify(previous.metadata.skills ?? []) !==
    JSON.stringify(next.metadata.skills ?? [])
  ) {
    changedFields.push("skills");
    operationalChanges.push("skills");
  }
  for (const field of [
    "providerId",
    "model",
    "reasoningLevel",
    "serviceTier",
    "permissionMode",
  ] as const) {
    if (previous.metadata.execution[field] !== next.metadata.execution[field]) {
      operationalChanges.push(`execution.${field}`);
      changedFields.push(`execution.${field}`);
    }
  }
  return { changedFields, operationalChanges };
}
