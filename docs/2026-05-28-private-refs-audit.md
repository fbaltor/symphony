# Symphony — Private Reference Audit
Date: 2026-05-28
Repo: https://github.com/fbaltor/symphony

## Status: OPEN — 10 blockers

---

## BLOCKERS

### B1 — `scripts/migrate.sh:13` — internal monorepo path
```
SCHEMA="${REPO_ROOT}/independent/symphony/src/audit/schema.sql"
```
Fix: change to `"${REPO_ROOT}/src/audit/schema.sql"`

---

### B2 — `tests/unit/can-use-tool.test.ts:57` — internal monorepo path
```
file_path: `${WS}/independent/symphony/src/orchestrator/orchestrator.ts`,
```
Fix: drop `independent/symphony/` prefix

---

### B3 — `src/webhook/linear-receiver.ts:3` — monorepo path + internal doc
```
* `independent/IMPROVEMENTS.md` §8).
```
Fix: replace with `README.md` reference or remove

---

### B4 — `src/lib/markers.ts:16–17` — "cerebro" written into Linear issue bodies (HIGHEST SEVERITY)
```ts
/** Substring marker for any Cerebro-emitted comment (legacy interop). */
export const CEREBRO_LIFECYCLE_MARKER_PREFIX = "<!-- cerebro:specialist=";
```
The string value `<!-- cerebro:specialist=` is written to Linear issue bodies as HTML comments — visible to any Linear user.
Also leaks via exported symbol name.
Fix:
- Rename export → `LEGACY_LIFECYCLE_MARKER_PREFIX`
- Update all import/use sites: `src/tracker/linear.ts:5`, `src/tracker/linear.ts:1231`, `tests/unit/conversation-history-trim.test.ts:32,34`
- Update jsdoc comment above constant
- Leave the literal VALUE unchanged (it must match existing content in the wild)

---

### B5 — AGENT-xxx ticket IDs in source comments
Private Linear workspace revealed. All occurrences:

| File | Lines | Tickets |
|---|---|---|
| `scripts/patch-claude-sdk.mjs` | 20–21 | AGENT-441, AGENT-447, AGENT-439 |
| `src/agent/claude-adapter.ts` | 32, 89, 109, 332, 334, 373, 385, 395 | AGENT-529, AGENT-447, AGENT-489, AGENT-496 |
| `src/agent/linear-mcp.ts` | 16 | AGENT-485 |
| `src/audit/schema.sql` | 149, 180, 185 | AGENT-521, AGENT-520 |
| `src/audit/writer.ts` | 12 | AGENT-521 |
| `src/lib/github.ts` | 14 | AGENT-441, AGENT-439 |
| `src/lib/redact.ts` | 87 | AGENT-503 |
| `src/main.ts` | 143, 163, 179 | AGENT-520, AGENT-521 |
| `docs/backlog.md` | 80–81 | AGENT-520 |

Fix: replace each `AGENT-xxx` ref with inline description of what was observed/fixed. Drop the ticket ID.

---

### B6 — `src/lib/github.ts:168` — STG-17 private ticket
```
// marking the sub Done with PR still open. Real symptom on STG-17.
```
Fix: drop `. Real symptom on STG-17`

---

### B7 — `src/audit/schema.sql:32` and `src/audit/writer.ts:172` — TL-2 private ticket
```
-- before TL-2 (prompts-in-code) lands; ...
```
Fix: inline description, drop `TL-2`

---

### B8 — `src/lib/section-manager.ts:265` — T-NEW-5 private ticket
```
// Bounce path. T-NEW-5 surfaced an LLM-phrasing miss:
```
Fix: drop `T-NEW-5 surfaced an` → `// Bounce path: LLM-phrasing miss:`

---

### B9 — IMPROVEMENTS.md cross-references throughout src/
~20 comment sites referencing the internal private design doc. Most affected:

- `src/agents/prioritized/index.ts:2`, `src/agents/prioritized/prompt.ts:2`
- `src/agents/pr-validation/index.ts:11`, `src/agents/pr-validation/prompt.ts:4,41`
- `src/agents/release/index.ts:2`, `src/agents/release/prompt.ts:2`
- `src/agents/technical-plan/prompt.ts:4`
- `src/agents/index.ts:2,13`
- `src/agents/types.ts:2,13,54`
- `src/lib/markers.ts:9,34`
- `src/lib/section-manager.ts:4`
- `src/lib/shell.ts:7`
- `src/orchestrator/cascade.ts:2`
- `src/workflow/config.ts:233`
- `src/agent/events.ts:10`
- `src/webhook/linear-receiver.ts:3` (overlap with B3)

Fix: replace `IMPROVEMENTS.md §X / E-YY` citations with inline rationale or ADR reference.

---

### B10 — WORKFLOW.staging.md references in src/
Internal staging config referenced in:

- `src/agents/index.ts:13`
- `src/agents/prioritized/index.ts:40`
- `src/agents/pr-validation/prompt.ts:4,41`
- `src/agents/types.ts:13,54`
- `src/orchestrator/cascade.ts:38`
- `src/orchestrator/orchestrator.ts:640,663,1177`

Fix: replace with `WORKFLOW.example.md` reference or inline explanation.
