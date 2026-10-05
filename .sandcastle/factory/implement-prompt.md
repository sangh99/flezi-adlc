# TASK

Implement task {{TASK_ID}}: {{TASK_TITLE}}

You are on branch `{{SOURCE_BRANCH}}`, cut from `{{BASE_BRANCH}}`. Commit your work on this branch.

<task>

{{TASK_BODY}}

</task>

The text above is the whole task. Do only what it asks.

# HOW TO WORK

Work test-first with the `tdd` skill.

The task's testing note is its agreed list of test boundaries (seams). Treat it as already confirmed: don't stop to ask anyone. If the task gives no testing note, or the note is too vague to tell where the tests go, don't guess: make no changes and report `blocked`, saying what's missing.

Explore the code the task touches before you start, especially the tests next to it.

Before you finish, run the project's typecheck and tests yourself. The factory runs them again after you and only accepts your work if they pass.

# COMMIT

Commit when your work is done. Use a short message that says what changed and why. Leave no uncommitted changes.

# FINISH

Your work is reviewed by a person through a pull request that the factory opens. You don't open pull requests, comment on, close or update any issue: the factory does all of that from your result.

End your final message with exactly one result block. Use `done` once your work is committed, or `blocked` if you couldn't do it, with a one- or two-sentence note saying what you did or what stopped you:

<factory-result>
{"status": "done", "note": "..."}
</factory-result>
