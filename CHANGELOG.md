# Changelog

All notable changes to this project are documented here. Rule ids are part of
the public surface: renaming one is a breaking change and is recorded here.

## 0.1.0 — 2026-09-18

First working version.

### Added

- Association checks over a declared error state: the error a state declares for
  a field must be a message node written about that field, the field must
  actually reference it, the message must show some text, and it must be
  recorded as present.
- Stale-state checks: a field a state declares no error for may not still carry
  an `aria-invalid` value that exposes it as invalid, a message written about
  it, or a summary link.
- One list of the `aria-invalid` token values that expose a control as invalid —
  `true`, `spelling` and `grammar`, per ARIA 1.2 — used by both the check that a
  field in error is marked and the check that a corrected field is not.
- Error summary checks: every field in error linked, nothing else linked, and
  each link pointing at a field rather than at some other element.
- Focus recovery checks against `focusAfterSubmit`, for a state recorded as
  submitted with at least one field in error.
- Asynchronous validation coverage: a field declared asynchronously validated
  must be recorded while the check is in flight and after it settles, and a
  pending record must expose `aria-busy="true"`.
- Label evidence checks, with `aria-label` judged by what it would show rather
  than by `trim()`.
- A 44-rule catalog with one frozen severity table, and an evidence-missing list
  that makes any gap in the evidence an `incomplete` report and exit 2.
- Expectations document with `requireErrorSummary`, `requireAriaInvalid`,
  `focusAfterSubmit`, `maxSnapshotAgeDays` and four size limits. Unknown keys
  are refused.
- Refusal of any expectation about spoken or screen-reader output: exit 2 with
  empty stdout, because a DOM snapshot cannot settle it.
- `--now` so an age-checking run is reproducible.

### Notes

- The tool writes no file, opens no browser and touches no network.
- It does not emulate assistive technology; what a person using one is told is
  not established by any run and needs separate manual evidence.
