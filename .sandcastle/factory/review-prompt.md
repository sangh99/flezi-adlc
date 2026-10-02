# REVIEW

Review spec {{SPEC_ID}}: {{SPEC_TITLE}}

You are on branch `{{SOURCE_BRANCH}}`, the spec's integration branch. Every task of the spec below has been built and merged into it. Your job is to review the whole branch against `{{BASE_BRANCH}}`, fix what the review finds, and write the pull request body.

<spec>

{{SPEC_BODY}}

</spec>

The spec's tasks, all merged into this branch:

<tasks>

{{TASK_LIST}}

</tasks>

# REVIEW AND FIX

Use the `code-review` skill to review the changes since `{{BASE_BRANCH}}` (its merge-base with this branch). The spec above is the originating spec for the review's Spec axis.

Fix every finding that is a real problem: code that breaks the repo's standards or doesn't do what the spec asks. Keep fixes inside the spec's scope. Don't add features or refactor beyond what a finding needs. If a finding needs a decision from a person, don't fix it: put it in the pull request body under a heading that says it needs a decision.

Run the project's typecheck and tests after your fixes. The factory runs them again after you and opens the pull request only if they pass.

# COMMIT

Commit your fixes on this branch with short messages that say what changed and why. Leave no uncommitted changes. If the review found nothing to fix, make no commits.

# PULL REQUEST BODY

Use the `pr` skill to write the body of the pull request that will merge this branch into `{{BASE_BRANCH}}`. Write only the body, not the title. The factory adds the links to the spec and its tasks itself.

# FINISH

You don't push, open pull requests, comment on, close or update any issue: the factory does all of that from your result.

End your final message with exactly one result block. Use `done` once your fixes are committed (or there was nothing to fix), or `blocked` if you couldn't finish the review, with a one- or two-sentence note saying what you did or what stopped you. With `done`, put the whole pull request body in `prBody`, as a JSON string:

<factory-result>
{"status": "done", "note": "...", "prBody": "..."}
</factory-result>
