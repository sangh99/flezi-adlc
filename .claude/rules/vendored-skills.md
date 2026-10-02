---
paths:
  - ".agents/skills/**"
  - ".claude/skills/**"
  - "skills-lock.json"
---

# Vendored skills

Every skill in `.agents/skills/` is a vendored copy of `mattpocock/skills`. Git tracks it byte for byte against the pristine copy on the `vendor/skills` branch, and upstream updates arrive by merging that branch ([ADR-0021](../../docs/adr/0021-kit-owns-its-copies-of-matt-skills.md)). Each line you change here is a line that can conflict on the next upstream merge.

- Keep each edit minimal and confined to what the kit must change: the tracker (Beads instead of GitHub issues, `bd` commands), the **approval gates**, `CONTEXT.md` instead of `GLOSSARY.md`, and "task" instead of "ticket". Leave wording, structure and formatting as upstream wrote them.
- Put a skill the kit writes from scratch in its own new directory under `.agents/skills/`.
- Edit with exact replacements. Prettier must not touch these files: they are in `.prettierignore` and the pre-commit hook respects it. Don't pass them to `prettier` by hand.
- `skills-lock.json` is informational. Its hashes are expected to differ from the files, so leave it as it is.
- `.claude/skills` is a symlink to `.agents/skills`. Edit the real path under `.agents/skills/`.
