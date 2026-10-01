---
"@ai-hero/sandcastle": patch
---

Stop `noSandbox()` runs from editing your real `~/.gitconfig`. Sandbox setup ran `git config --global` for `safe.directory`, `user.name` and `user.email`, which under `noSandbox()` hit the host's own config: every run added duplicate `safe.directory` entries, and parallel runs could fail with `could not lock config file ~/.gitconfig: File exists`. These steps are now skipped when the agent runs on the host, whose git config already trusts the worktree and has your identity.
