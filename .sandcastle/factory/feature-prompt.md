# TASK

Implement task {{TASK_ID}}: {{TASK_TITLE}}

The task is one part of spec {{SPEC_ID}}: {{SPEC_TITLE}}. Other tasks of the same spec are built separately and merged next to yours.

You are on branch `{{SOURCE_BRANCH}}`, cut from the spec's integration branch `{{INTEGRATION_BRANCH}}`, which holds the spec's finished tasks so far. Commit your work on this branch.

<task>

{{TASK_BODY}}

</task>

The text above is the whole task. Do only what it asks.

The spec below is context: the requirements and design the task belongs to. Don't build the spec's other parts.

<spec>

{{SPEC_BODY}}

</spec>

# HOW TO WORK

Work test-first with the `tdd` skill.

The test boundaries (seams) are the ones agreed in the spec's Testing Decisions section. Treat them as already confirmed: don't stop to ask anyone, and test only at those seams. If the spec has no Testing Decisions section, or it is too vague to tell where this task's tests go, don't guess: make no changes and report `blocked`, saying what's missing.

Explore the code the task touches before you start, especially the tests next to it.

Before you finish, run the project's typecheck and tests yourself. The factory runs them again after you and only accepts your work if they pass.

# COMMIT

Commit when your work is done. Use a short message that says what changed and why. Leave no uncommitted changes.

# FINISH

The factory merges your branch into the integration branch, and a person reviews the whole spec through one pull request later. You don't merge, push, open pull requests, comment on, close or update any issue: the factory does all of that from your result.

End your final message with exactly one result block. Use `done` once your work is committed, or `blocked` if you couldn't do it, with a one- or two-sentence note saying what you did or what stopped you:

<factory-result>
{"status": "done", "note": "..."}
</factory-result>
