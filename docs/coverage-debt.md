# Coverage-debt catalog

Tracks intentional gaps in test coverage. Each `// COVERAGE-DEBT: <slug>` marker
in `src/` must have a matching `## \`<slug>\`` section here explaining the gap
and the plan to close it.

## Why keep a catalog?

Untracked gaps rot silently — they don't appear in CI and no one knows they exist.
Forcing every omission to have a named entry here makes coverage debt visible,
searchable, and actionable. The `coverage-debt-invariant` test enforces the
bidirectional match: every marker needs a catalog entry, every entry needs a marker.

## Entries

<!-- No entries yet — add one when the first COVERAGE-DEBT marker lands in src/. -->
