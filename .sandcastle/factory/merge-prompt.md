# MERGE

Resolve the merge conflicts of task {{TASK_ID}}: {{TASK_TITLE}}

The task is one part of spec {{SPEC_ID}}: {{SPEC_TITLE}}. Its work is finished and committed on your branch `{{SOURCE_BRANCH}}`. Since the branch was cut, other tasks of the spec were merged into the spec's integration branch `{{INTEGRATION_BRANCH}}`, and your branch no longer merges into it cleanly. These files conflict:

{{CONFLICTS}}

Your job is to merge the integration branch into your branch and resolve the conflicts, so that the factory can merge your branch back cleanly.

<task>

{{TASK_BODY}}

</task>

The task above is what your branch implements. Don't add to it.

# HOW TO WORK

Merge the integration branch at the commit the factory last saw:

```
git merge --no-ff {{INTEGRATION_COMMIT}}
```

Resolve every conflict so the result keeps both sides: the task's work and the work already on the integration branch. Read the commits on both sides to see what each change was for. Don't drop either side's change to make a conflict go away. If you can't tell how to combine them, make no merge commit (`git merge --abort`) and report `blocked`, saying what's unclear.

Run the project's typecheck and tests after the merge. The factory runs them again after you and merges your branch only if they pass.

# COMMIT

Conclude the merge with a merge commit (`git commit --no-edit` once every conflict is resolved and staged). Don't rebase, squash or rewrite the branch's earlier commits. Leave no uncommitted changes.

# FINISH

You don't push, merge into the integration branch, open pull requests, comment on, close or update any issue: the factory does all of that from your result.

End your final message with exactly one result block. Use `done` once the merge commit is made, or `blocked` if you couldn't resolve the conflicts, with a one- or two-sentence note saying how you resolved them or what stopped you:

<factory-result>
{"status": "done", "note": "..."}
</factory-result>
