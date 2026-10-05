---
"@ai-hero/sandcastle": minor
---

Remove the built-in Vercel and Daytona sandbox providers. The `@ai-hero/sandcastle/sandboxes/vercel` and `@ai-hero/sandcastle/sandboxes/daytona` entry points are gone, along with the optional `@vercel/sandbox` and `@daytona/sdk` peer dependencies. Isolated sandboxes are still supported via `createIsolatedSandboxProvider`.
