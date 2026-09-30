---
"@ai-hero/sandcastle": minor
---

Add a `remoteDocker()` isolated sandbox provider (`@ai-hero/sandcastle/sandboxes/remote-docker`) that runs the sandbox container on a remote Docker daemon, such as a Linux server reached over SSH. Pass `host` (e.g. `"ssh://user@server"`) or `context`; the repo is synced in with `docker cp` and changes are synced back, so no bind mounts are required.
