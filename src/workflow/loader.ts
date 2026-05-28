import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/**
 * Spec §5.1 / §5.2 — load and parse `WORKFLOW.md`.
 *
 * File format: optional YAML front matter delimited by `---` lines, followed by
 * a Markdown body. If the file does not start with `---`, the entire file is
 * the prompt body and config is `{}`.
 */
export interface RawWorkflow {
  config: Record<string, unknown>;
  promptTemplate: string;
}

/** Spec §5.5 typed error classes. */
export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkflowError";
  }
}

const FRONT_MATTER_DELIMITER = "---";

export async function loadWorkflow(path: string): Promise<RawWorkflow> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new WorkflowError("missing_workflow_file", `WORKFLOW.md not found at ${path}`);
    }
    throw new WorkflowError(
      "workflow_parse_error",
      `failed to read WORKFLOW.md at ${path}: ${(err as Error).message}`,
    );
  }

  return parseWorkflow(raw);
}

/** Pure parser — extracted so tests can drive it without filesystem. */
export function parseWorkflow(raw: string): RawWorkflow {
  const lines = raw.split(/\r?\n/);

  // No front matter: entire file is the prompt body.
  if (lines[0]?.trim() !== FRONT_MATTER_DELIMITER) {
    return { config: {}, promptTemplate: raw.trim() };
  }

  // Find closing `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONT_MATTER_DELIMITER) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "WORKFLOW.md opens with `---` but never closes it",
    );
  }

  const yamlText = lines.slice(1, closeIdx).join("\n");
  const bodyText = lines
    .slice(closeIdx + 1)
    .join("\n")
    .trim();

  let parsed: unknown;
  try {
    parsed = yamlText.trim().length === 0 ? {} : parseYaml(yamlText);
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `invalid YAML front matter: ${(err as Error).message}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    return { config: {}, promptTemplate: bodyText };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "WORKFLOW.md front matter must be a YAML map/object",
    );
  }

  return {
    config: parsed as Record<string, unknown>,
    promptTemplate: bodyText,
  };
}
