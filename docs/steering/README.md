# Steering

Persistent, agent-neutral project context, modelled on Kiro's steering files:

- [`product.md`](product.md) covers what we build and for whom, and the principles that decide scope.
- [`tech.md`](tech.md) covers the stack, commands, Effect conventions and testing.
- [`structure.md`](structure.md) covers where each kind of thing lives.

## Why `AGENTS.md` links these docs instead of `@`-importing them

Checked 2026-10-02:

- Claude Code expands `@path` imports inside an `AGENTS.md` it reads natively. That native reading needs v2.1.277 or later and applies when no `CLAUDE.md` / `CLAUDE.local.md` exists ([memory docs, "AGENTS.md"](https://code.claude.com/docs/en/memory#when-claude-code-reads-agents-md); [changelog 2.1.277](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- Imported files load at launch in full, so an import doesn't reduce context cost ([memory docs, "Import additional files"](https://code.claude.com/docs/en/memory#import-additional-files)).
- OpenCode states that it "doesn't automatically parse file references in `AGENTS.md`" ([OpenCode rules](https://opencode.ai/docs/rules/)). Codex documents no import syntax ([Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)), and pi documents none either. For those agents, an `@path` is plain text.

Imports would put all three docs into every Claude session, including each factory iteration, while other agents would see only an unexpanded `@path`. Plain Markdown links behave the same for every agent: each agent opens a doc when the pointer's condition fires. Keep them as links. If a doc must always be in context, inline its content in `AGENTS.md` instead.
