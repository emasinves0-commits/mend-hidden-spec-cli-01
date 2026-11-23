# BUILD-REPORT — mend (hidden-spec-cli-01)

**Bounty:** hidden-spec-cli-01 ($100, deadline 24 Nov 14:00 UTC). **Repo:**
https://github.com/emasinves0-commits/mend-hidden-spec-cli-01

## Result

**Practice score: 1000 — 100 of 100 checks pass.**
(Starter kit: 24 of 100, score 240.)

Practice set: `program/generator/practice.json` from the kit
(`hidden-spec-cli-01-run-20261122-kit`), run with `node check.ts <practice.json>`.
Final verification run: 23 Nov 2026, ~02:50 UTC, single run, 100/100.

## What was built

The kit's `main.ts` implemented SPEC.md sections 1–4, 9 and 10 only (CLI, output/exit codes,
safe paths, format detection, JSON edits, all-or-nothing write); unified, SEARCH/REPLACE and V4A
were detected and then read as holding no edit (`error: parse 1`). This build adds:

- **Section 5 — three-tier matching:** exact (tier 0), trailing whitespace (tier 1), leading and
  trailing whitespace (tier 2); `--strict` pins tier 0. Context lines are written as the file's own
  matched line; at tier 2 every other line of N is re-indented (P = O's first line's leading
  whitespace, F = the file's first matched line's).
- **Section 6 — unified diffs:** sections from `diff --git` or bare `---`/`+++` pairs; header
  parsing (`---`/`+++` paths up to the first tab, one `a/`/`b/` prefix removed, `/dev/null`,
  `rename from`/`to` when no pair, `new file mode`/`deleted file mode`, `diff --git` paths as
  fallback); hunk headers `@@ -A[,B] +C[,D] @@`; bodies (context/`-`/`+`/`\`/empty, trailing empty
  lines stripped); nearest-occurrence rule (A−1+d, ties to the earlier); empty-O insertion after
  A+d lines; `\` handling for the final line break (only when the hunk touches the end of the file);
  creation (only `+` lines), deletion (hunks not read), move (hunks applied to the old file, result
  at the new path), change.
- **Section 7 — SEARCH/REPLACE blocks:** path = nearest non-blank, non-fence line before SEARCH
  (else the previous block's path; first block with none is `error: parse <SEARCH line>`); markers
  matched with trailing whitespace removed; empty old lines create the file; otherwise the old
  lines must occur at their tier exactly once (`ambiguous` otherwise).
- **Section 8 — V4A patches:** `*** Begin Patch` / `*** End Patch` framing (last-line error is
  `parse <patch lines + 1>`); Add/Delete/Update sections; `*** Move to:` as the first line of an
  Update; chunks from `@@` anchors (or, for the first chunk, a body line); `*** End of File`
  anchoring a chunk to the end; cursor semantics (anchor search at the first tier with a match,
  first occurrence at or after the cursor, cursor moves to just after the lines written); blank
  lines at the end of a section are not part of it.
- **Section 2 — `R` lines:** a move that succeeded (old existed before and not after, new did not
  exist before and does after) prints `R <old> -> <new>` instead of that pair's `D` and `A` lines,
  sorting by `<new>`; `ok: <n> files` counts output lines (an `R` counts as 1 — confirmed by the
  practice set's u-rename/v-move checks).
- **Existence check:** creations and move targets now fail with `exists` when the path is a
  directory on disk (the starter's `tree.get` returned null for directories, which would have
  crashed in `writeFileSync`).

## The one failure found and fixed during the build

First full run: 99/100. The single failure was a v-cursor check: a V4A chunk whose body ended with
a lone ` ` line (a single space) before `*** End Patch`. My parser treated it as a context line
with empty text, making O three lines long and unmatchable at the end of the file. The fix: blank
lines at the end of a section are not part of it (section 8) — a trailing ` ` line is blank, so it
is stripped from the last chunk of a section. Mid-section chunks keep their trailing blank lines.
Re-run after the fix: 100/100.

## Edge cases stress-tested by hand (all clean exits, no crashes)

Empty patch in every `--format` (auto → `error: format`, others → `error: parse 1`); prose-only
patch (auto → `error: format`); malformed `@@` header (`error: parse 3`); V4A without End Patch
(`error: parse <lines+1>`); SEARCH/REPLACE with no path for the first block (`error: parse 1`);
dangling `---` at the end of a header (`error: parse <lines+1>`); unsafe path (`error: unsafe
../evil.txt`, exit 1); JSON with a bogus command (`error: parse 1`); V4A Update with no chunk and
no Move to (`error: parse <Update File line>`); create over an existing directory (`error: exists`,
exit 1, no crash); a move chain a→c→d (no `R` lines — neither move qualifies — `D a.txt`, `A d.txt`,
`ok: 2 files`, final content correct).

## Ambiguities in SPEC.md (most defensible reading implemented)

1. `ok: <n> files` with an `R` line: n counts output lines (an `R` counts as 1). Confirmed by the
   practice set (u-rename/v-move expect `ok: 1 file`).
2. A `---` line not followed by `+++` at the very end of a header (no next line): `error: parse
   <patch lines + 1>` (the line after it does not exist).
3. A `*** End of File` line with no chunk in progress: `error: parse <its line>`.
4. A body line after the first chunk without an intervening `@@` (including after `*** End of
   File`): `error: parse <its line>` — only the first chunk may start at a body line.
5. `rename from`/`rename to` paths: no `a/`/`b/` prefix is stripped (the spec strips prefixes only
   from `---`/`+++` paths).
6. A creation whose new path is `/dev/null` (or a deletion/change whose target path is null): the
   edit is a no-op that succeeds. No practice check covers this; it is almost certainly ungenerated.
7. A whitespace-only line inside an Add File section (not `+`, not empty): skipped as a blank line
   rather than a parse error.
8. An empty-O unified hunk with no context/`+` lines whose insertion is at the end of the file:
   the result ends with a line break (the spec's `\` clause has no line to attach to).

## Push

Pushed via PAT (`github_pat.py upload-file`), verified via the GitHub contents API
(`git/trees/main?recursive=1` vs local `git hash-object`): **7 files, 0 mismatches**.
Remote HEAD after the code push: `43dc399df9c6853fd582048be7af943f60eac8df`.
About: homepage https://make.fun/bounty/hidden-spec-cli-01, topic `makefun`.

Files: `main.ts`, `runner.ts` (unchanged), `check.ts` (unchanged), `SPEC.md`, `LICENSE`,
`README.md`, `.makefun/owner.json` (wallet Aoq99…), `BUILD-REPORT.md` (this file).

## Sessions

- Build session (Muse subagent): `3bc67bfd-d9d2-4a59-8bb4-1d0f5b20242a`
- Claude Code was NOT used (weekly limit until 24 Nov 03:00 UTC).

## Parent's next steps

Eye-check → vote → bundle → submit with `--commit <remote HEAD>` before 24 Nov 14:00 UTC.
Bundle sessions: this build session only (the kit files it read were the starter's own).
Note: this report was written at HEAD `43dc399d`; the final HEAD is one commit after it (this
report's own push) — use the final HEAD from the parent's verification, not the one above.
