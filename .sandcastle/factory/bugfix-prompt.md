# TASK

Fix bug {{BUG_ID}}: {{BUG_TITLE}}

You are on branch `{{SOURCE_BRANCH}}`, cut from `{{BASE_BRANCH}}`. Commit your work on this branch.

<bug>

{{BUG_BODY}}

</bug>

The text above is the whole bug, with the diagnosis a person has already agreed: the failing command in Steps to Reproduce, the Root Cause, the Fix Approach and the seam for the regression test in Testing. Treat the diagnosis as confirmed: don't stop to ask anyone, and don't re-diagnose. Do only what it asks.

# HOW TO WORK

Work test-first with the `tdd` skill, in this order:

1. Run the failing command from Steps to Reproduce and confirm it fails as the bug describes.
2. Turn that failure into a regression test at the seam named in Testing. Run it and confirm it fails, for the reason in Root Cause, before you change any other code.
3. Fix the bug as Root Cause and Fix Approach describe.
4. Run the regression test and the command from Steps to Reproduce again, and confirm both pass.

If the bug has no failing command in Steps to Reproduce, or no seam in Testing (including "No correct seam"), or either is too vague to act on, don't guess: make no changes and report `blocked`, saying what's missing.

Explore the code the bug touches before you start, especially the tests next to it.

Before you finish, run the project's typecheck and tests yourself. The factory runs them again after you and only accepts your work if they pass.

# COMMIT

Commit when your work is done, with the regression test and the fix together. Use a short message that says what was broken and how it was fixed. Leave no uncommitted changes.

# FINISH

Your work is reviewed by a person through a pull request that the factory opens. You don't push, open pull requests, comment on, close or update any issue: the factory does all of that from your result.

End your final message with exactly one result block. Use `done` once your work is committed, or `blocked` if you couldn't do it, with a one- or two-sentence note saying what you did or what stopped you:

<factory-result>
{"status": "done", "note": "..."}
</factory-result>
