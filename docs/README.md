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
| drop the `!record.ariaInvalidCaptured` branch in the no-error path | a state that never recorded `aria-invalid` passes |
| swap `byCodeUnit` for a collator | ordering becomes machine-dependent |
| move the position branch ahead of the quoting branch in `parseFailureDetail` | a document reading `at position 1` is sliced back into the message |
