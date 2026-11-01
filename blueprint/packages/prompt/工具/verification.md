# Verification receipts

The `verification` tool records an asynchronous native Bash run against an explicit project input manifest. It reports what the native job and declared inputs show; it never skips a check, marks acceptance complete, or returns a reusable decision.

## When to use

Use a receipt when a long check needs to be handed off or revisited. Existing checked summaries, logs, and CI results remain valid evidence; do not rerun a finished check just to create a receipt. Keep the returned job id and pending receipt while it runs, then collect the final receipt once.

The node actually integrating the result compares it only when freshness needs checking, records the applicable scope and outstanding gaps in its existing checked handoff, and passes that conclusion onward. Later layers reuse that conclusion unless relevant inputs, commands, environment or integration conditions change; another handoff alone is not a reason to repeat compare, read full logs or rerun tests. Each compare fingerprints the declared inputs, so repeatedly calling it has real cost. Required project checks and user acceptance criteria still apply.

## Actions

- `begin` requires the exact command and a non-empty `inputs` array. `workdir` resolves from the native current working directory (omitting it preserves that directory); every input resolves from the session project root; absolute paths are accepted only inside that root. Inputs may be files or directories. Symlink paths, explicit `.git` paths, and machine evidence inputs are rejected. Recursive directory fingerprints include names, contents, and executable bits; `.git` entries and the project-root `.blueprint-evidence` machine namespace are not traversed; other generated or untracked files remain inputs. Optional `environmentObservations` is a string map whose values are hashed and never stored in receipts.
- `begin` launches `bash` through the native tool pipeline with `run_in_background: true`. It returns a pending receipt and `{type: "job", id}` wait condition. An identical command with the same owner, directory, input fingerprint and observations reuses its uncollected job; after collection, an explicit begin starts a fresh check. Do independent work while the job runs.
- `collect` is restricted to the agent that began the command. If the job is running or stopping, it returns pending with the same wait condition and does not poll or wait. Call it after the job event. Terminal collection archives non-consuming job output and fingerprints the original manifest again. Pass the returned receipt path to later actions.
- `compare` uses the manifest frozen by `begin`; callers cannot shrink it. Supply the same command and, when used at `begin`, the same observation names and values. Other same-project agents may compare completed receipts, but cannot collect them.

## Result meaning

`state` is `pending`, `completed`, `failed`, or `unknown`. A native run is successful only when the job reports `status === "completed"` and the exact detail `"exit code: 0"`; stdout text is not evidence of success. A missing job, incomplete output, corrupt or missing output archive, unavailable observation, or unavailable input fingerprint yields `unknown`. Changed declared inputs or observations yield `match: "stale"`.

`match: "matched"` means only that the exact command, currently readable declared inputs, recorded stability, declared observations, successful native result, and complete archived output still agree. Its scope is always `declared-inputs-only`; it cannot establish that undeclared files, network services, devices, or other environment state are unchanged. It is not permission to omit or skip any verification action and does not mean project or user acceptance is complete.
