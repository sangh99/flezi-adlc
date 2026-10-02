# The ADLC kit owns its copies of Matt's skills

The skills under `.agents/skills/` were installed from `mattpocock/skills`, and `skills-lock.json` records a hash for each one, which suggests they are untouched upstream copies. They aren't: the **ADLC kit** edits them in place to fit its workflows (Beads, **approval gates**, "task" instead of "ticket").

To keep taking upstream improvements, unmodified upstream copies live on a `vendor/skills` branch. Upstream updates are pulled there and merged into main, so git's three-way merge keeps our edits and only conflicts where upstream changed the same lines.

## Considered Options

- **Leave the vendored skills untouched and add kit-owned skills on top** - rejected in favour of editing in place.
- **Freeze, never update** - rejected. Upstream is changing too fast to give up its improvements.
- **Reapply edits by hand after each update** - rejected. It's error-prone and silently loses edits.

## Consequences

- `skills-lock.json` is informational only. Its hashes are expected to differ from the files and must not be enforced (no CI check, no "skills are out of sync" failure).
- The first vendored snapshot is `mattpocock/skills@d81f3a18` (v1.3). The lock file's `computedHash` scheme couldn't be reproduced, which is one more reason not to rely on it.
- Vendored files must stay byte-identical to upstream, so `.agents/skills/` and `skills-lock.json` are in `.prettierignore`. Commits on `vendor/skills` itself use `--no-verify`, because that branch doesn't carry the ignore file.
- `.agents/skills/` must be committed. `.claude/skills` is a symlink to it, so untracked skills leave the link broken in every worktree the **factory** creates.
