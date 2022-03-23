# Accessible Form Error Checker documentation

The user-facing documentation is the [README](../README.md): input shapes, the
rule table, exit codes, limits and non-goals all live there so that there is one
place to keep true.

This file records the design decisions that are easy to undo by accident.

## Why the evidence is JSON and not HTML

Reading HTML would mean writing a parser, and a parser that handles a bounded
subset of markup optimistically is the same defect class this tool exists to
avoid: a construct it does not understand becoming a clean result. The snapshot
is JSON with an explicit shape, and everything the checks need — which element
is a message, which field it is written about, which messages were present, what
held focus — is something the exporter states rather than something this tool
infers.

That pushes work onto whoever exports the snapshot. It is the right place for
it: they are the only party that can see the document.

## Why `belongsTo` is required on a message node

"An error linked to the wrong field" is only checkable if something says which
field a message is about. Inferring it from proximity, id prefixes or wording
would be a guess, and a guess that produced `error-association-wrong` would be
this tool asserting a defect it cannot see. So the exporter states it, and a
message node without it is a record that could not be read.

## Why `ariaInvalid` is asked about in both branches

`requireAriaInvalid` decides whether a field in error must expose itself as
invalid. It says nothing about a field that is not in error still being marked
as one — that is the "was the stale error state cleared" question, and it is
always asked.

An earlier build asked it only when the key was present, which meant a state
that recorded no `ariaInvalid` reported `pass`. That is the tool narrowing what
it checked rather than saying it could not check it, and the acceptance test for
corrected input caught it. Both branches now report the gap.

## Why `aria-invalid` is a list and not a comparison

ARIA 1.2 gives the state four token values: `false`, which is the default,
`true`, `grammar` and `spelling`. `grammar` and `spelling` are not a milder kind
of valid -- each says an error was detected and names what kind -- so a control
carrying one is exposed as invalid exactly as `true` is.

Asking `=== 'true'` was wrong in both directions at once, which is why it is one
predicate now rather than two comparisons. A spell-checked field in error
carrying `aria-invalid="spelling"` was reported as `invalid-not-exposed`, at
error severity, exit 1, on markup the specification describes; and a corrected
field left carrying `aria-invalid="spelling"` was not reported as stale at all.
Both sides of the question take their answer from `INVALID_TOKENS`, so they
cannot drift apart again.

A value outside the token set stays out of the list on purpose. ARIA says an
unrecognised token takes the attribute's default, and the default here is
`false`, so `aria-invalid="tru"` exposes nothing as invalid -- which means a typo
fails a field in error rather than passing it.

## Why every id goes through one gate, including the summary block's own

`states[].summary.id` was the one id the snapshot states that never went through
`resolveReference`, and the README claimed the gate list was the whole of them.
With a COMPLETE index holding no such element, a state could name a summary
block the snapshot never declares, record focus on it, and the run reported
`pass` at exit 0 -- while the identical dangling id in `describedby` was
`reference-broken` at exit 1. Unknown is never a pass, on both sides of a
comparison, and this was the side nobody looked at.

`states[].focus` is compared rather than resolved: it is matched against the
targets `focusAfterSubmit` permits. That is safe only because every permitted
target is now an id the index confirmed -- and when the index cannot say,
`focus-not-recovered` is suppressed rather than asserted, because saying focus
went elsewhere would be a positive conclusion about a node the run has just
reported it could not find.

## Why an unresolved id is sometimes a defect and sometimes not

An id that is not in the index is only evidence about the form when the index
holds every id the form has. `capture.idIndex` and `unreadableRegions` are how
the exporter says otherwise, and when either says so the same unresolved id
becomes `reference-unresolved` instead of `reference-broken`, and the run is
incomplete.

The same gate applies to the label check: a field whose only labelling reference
could not be looked up is not a field with no label.

## Why there is no `--out`

The tool is read-only. Adding a destination would bring the three data-loss
holes — a symlinked destination, a symlinked parent, a hard link to an input —
and the guard for them, for the sake of something `> report.json` already does.
The report contract says read-only by default, and this tool has no reason to be
otherwise.

## Mutations to watch

Each of these is a single edit that changes real output. Each has a test that
fails when it is made:

| Edit | What it would do |
| --- | --- |
| delete `unreadableRegions.length === 0` from `complete` in `buildIndex` | an unreadable shadow root would stop downgrading a broken reference; exit 2 becomes exit 1 |
| remove a rule from `EVIDENCE_MISSING_RULES` | a gap in the evidence becomes a pass; exit 2 becomes exit 0 for the fifteen warning rules |
| return `null` instead of `undefined` from `resolveReference` when the index is incomplete | an unresolved id would be asserted absent |
| drop the `!record.ariaInvalidCaptured` branch in either path | a state that never recorded `aria-invalid` passes |
| narrow `marksInvalid` back to `=== 'true'` | `aria-invalid="spelling"` on a field in error is reported as a defect, and on a corrected field is not reported as stale |
| delete the `resolveReference` on `state.summary.id` | a summary block naming an element the snapshot never declares passes at exit 0 |
| offer a permitted focus target the index could not confirm | focus is said to have landed on a node the run could not find |
| swap `byCodeUnit` for a collator | ordering becomes machine-dependent |
| move the position branch ahead of the quoting branch in `parseFailureDetail` | a document reading `at position 1` is sliced back into the message |
| give `showsSomething` a length cap again | a message or an `aria-label` longer than the cap is reported as showing nothing |
| replace any one of the four sort keys with `0` | ordering stops being what the README documents |
| drop the `UNREADABLE_REASONS` or `INDEX_STATES` check | a typo is accepted as a documented value, and a partial index reads as complete |

## What the sweep is, and what it found

The sweep is mechanical, and the enumeration rather than the adjective is what
is worth reporting. Four categories, derived from the source text rather than
from a list somebody thought of:

- every entry in `EVIDENCE_MISSING_RULES`, deleted (29)
- every severity in `RULE_SEVERITY`, flipped one step (44)
- every named guard, refusal or validation in `src/`, neutered (56)
- the ordering primitive given a collator, and each sort key dropped (6)

The first run over this tree was 124 mutations with 117 caught. All seven
survivors were missing tests rather than equivalent mutants, and each now has
one. A second run over the final tree, widened to 135 mutations, left four
survivors -- the four sort keys and the unreadable-reason guard -- which are also
now pinned.
