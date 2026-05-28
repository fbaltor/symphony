import type { Blocker, Issue } from "../types.js";

/**
 * Spec §11.3 — normalize a Linear API issue payload to Symphony's stable
 * `Issue` shape.
 */

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state?: { name?: string | null } | null;
  branchName?: string | null;
  url?: string | null;
  labels?: { nodes?: Array<{ name: string }> } | null;
  inverseRelations?: {
    nodes?: Array<{
      type?: string | null;
      issue?: { id?: string; identifier?: string; state?: { name?: string | null } | null } | null;
    }>;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export function normalizeIssue(node: LinearIssueNode): Issue {
  const labels = (node.labels?.nodes ?? [])
    .map((l) => (l.name ?? "").toLowerCase())
    .filter(Boolean);
  const blockedBy: Blocker[] = (node.inverseRelations?.nodes ?? [])
    .filter((rel) => (rel.type ?? "").toLowerCase() === "blocks")
    .map((rel) => ({
      id: rel.issue?.id ?? null,
      identifier: rel.issue?.identifier ?? null,
      state: rel.issue?.state?.name ?? null,
    }));

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority:
      typeof node.priority === "number" && Number.isFinite(node.priority)
        ? Math.trunc(node.priority)
        : null,
    state: node.state?.name ?? "",
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels,
    blockedBy,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
  };
}
