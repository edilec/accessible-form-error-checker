# Accessible Form Error Checker

Check form labels, error associations, summary links, focus recovery and
asynchronous validation in an exported DOM snapshot, against an expectations
document.

- **Repository:** [edilec/accessible-form-error-checker](https://github.com/edilec/accessible-form-error-checker)
- **Area:** Accessibility
- **License:** MIT

## What it does

It reads two documents and compares them:

- a **DOM snapshot** (`--snapshot`), exported by somebody else: the fields of one
  form, the elements those fields can point at, and the form in a sequence of
  declared states — after a failed submission, while an asynchronous check is in
  flight, after the check settles, after the reader corrects the value;
- an **expectations document** (`--expectations`), which supplies every rule it
  applies: whether an error summary is required, whether a field in error must
  expose `aria-invalid`, where focus is allowed to be after a failed submission,
  how old a snapshot may be, and the size limits.

For every field, in every state, it checks that the error the state declares is
the message written **about that field**, that the field actually references it,
that the message would show some text and is recorded as present, that a field
the state declares no error for carries no error state left over from an earlier
one, that the summary links to every field in error and to nothing else, that
focus after a failed submission landed somewhere the expectations permit, and
that an asynchronous check was recorded both while it ran and after it settled.

It writes the result as JSON on stdout and a human summary on stderr.

## Why it exists

Error handling is where forms fail people, and it fails them in ways a snapshot
can actually show: the message for the postcode wired to the email field, the
red outline still on a field the reader has already fixed, a summary that lists
an error that is gone, focus left on the submit button so a reader using the
keyboard has to hunt for what went wrong, an asynchronous check that shows a
spinner and says nothing in the markup.

Those are association and state questions, which is exactly what an exported DOM
snapshot can answer. What it cannot answer is what any of it sounds like. Both
halves of that sentence are built into this tool.

## The snapshot is an input, and here is what that rules out

This tool opens no browser, resolves no host, submits no form, drives nothing
and writes no file — in normal use and in its tests. It has no network access at
any point.

It also **does not emulate a screen reader**. It runs no accessible-name
computation and no accessibility-tree calculation; it reports the attributes and
relationships the exported markup records. A message being associated with a
field is evidence about the markup. Whether a person using assistive technology
is told anything useful, in a useful order, is a different question, and this
tool will not answer it. Ask a policy about spoken output — `spokenText`,
`announcedText`, `screenReader`, `expectSpoken`, `expectAnnouncement`,
`screenReaderOutput` — and the run is refused with exit 2 rather than answered
from markup. That refusal is the behaviour; the paragraph is just the
explanation.

Every report repeats this in `disclaimer` and lists, in `notEstablished`, the
questions this evidence cannot settle.

### Non-goals

- **Not an HTML parser.** It does not read `.html` files, markup fragments or
  anything it would have to parse. The snapshot is JSON with the documented
  shape, produced by whatever exports it.
- **Not a screen-reader emulator.** No accessible name is computed and none is
  reported. Actual spoken output requires separate manual evidence.
- **Not a browser driver.** It cannot take a snapshot; producing one is your
  side of the contract.
- **Not a judge of wording.** Whether an error message is understandable,
  accurate or actionable is outside this evidence.
- **Not a writer.** It has no `--out`, creates no directory and modifies
  nothing. Redirect stdout if you want the report in a file.
- **Not interested in what people typed.** The snapshot shape has no place to
  put a field value, and the tool never asks for one or reproduces one.

## Quick start

```sh
# a form whose error handling holds up
node bin/accessible-form-error-checker.mjs \
  --snapshot examples/clean/snapshot.json \
  --expectations examples/clean/expectations.json \
  --now 2026-09-18
echo $?   # 0

# the same form with the email error wired to the postcode message, focus left
# on a hint, an unexposed asynchronous wait and a corrected field still in error
node bin/accessible-form-error-checker.mjs \
  --snapshot examples/broken/snapshot.json \
  --expectations examples/broken/expectations.json \
  --now 2026-09-18
echo $?   # 1
```

`npm run example` runs the first of those and `npm run example:broken` the
second. `--now` is passed so the verdict does not depend on the day it is run;
see [The clock](#the-clock).

## The snapshot

```json
{
  "schemaVersion": "1",
  "capture": {
    "id": "checkout-details",
    "source": "dom-snapshot",
    "capturedAt": "2026-09-10",
    "idIndex": "complete"
  },
  "unreadableRegions": [{ "hostId": "address-widget", "reason": "shadow-root" }],
  "fields": [{
    "id": "email",
    "asyncValidated": true,
    "labelling": {
      "labelFor": "email-label",
      "ariaLabelledby": null,
      "ariaLabel": null,
      "wrappingLabel": false
    }
  }],
  "nodes": [
    { "id": "email-label", "kind": "label", "text": "Email address" },
    { "id": "email-error", "kind": "message", "belongsTo": "email", "text": "Enter your email address" }
  ],
  "states": [{
    "name": "01-submitted-empty",
    "submitted": true,
    "focus": "error-summary",
    "visibleMessages": ["email-error"],
    "summary": { "id": "error-summary", "links": [{ "target": "email" }] },
    "fields": [{
      "id": "email",
      "declaredError": "email-error",
      "describedby": ["email-error"],
      "errormessage": null,
      "ariaInvalid": "true",
      "pending": false,
      "ariaBusy": null
    }]
  }]
}
```

- `capture.source` must be `"dom-snapshot"`. Anything else is refused rather
  than reinterpreted — see [the rule table](#rules).
- `capture.idIndex` is `"complete"` or `"partial"` and decides whether an
  unresolved id is a defect or a gap.
- `nodes[].kind` is `label`, `message`, `summary` or `other`. A `message` node
  must record `belongsTo`: the id of the field it is written about. That single
  field is what makes "this error is attached to the wrong control" checkable.
- `states[].fields` must record **every** field the snapshot declares. A state
  that says nothing about a field establishes nothing about it, including
  whether an earlier error was cleared, so it is reported rather than skipped.
- `declaredError` is the state's own statement of which message is the error for
  that field, and `null` when the state declares none. It is the ground truth
  the association checks compare the attributes against.
- `pending` marks a state recorded while an asynchronous check was in flight.

### Absent is not the same as not captured

This distinction runs through the whole schema and is what lets the tool be
honest about what it saw:

| In the snapshot | Means | Effect |
| --- | --- | --- |
| `"ariaInvalid": null` | the exporter looked, the attribute was not there | evidence; can fail a check |
| key omitted | nobody recorded it | a gap; makes the run incomplete |

`declaredError`, `describedby` and `errormessage` are required in every state
field record for this reason — use `null` where the attribute was absent.
`ariaInvalid`, `ariaBusy`, `labelling`, `visibleMessages`, `summary`, `focus`
and `nodes[].text` may be omitted, and omitting one is reported as a gap
whenever a check would have needed it. `"summary": null` says the state had no
summary block; omitting `summary` says nobody looked.

### What an unreadable subtree does

`unreadableRegions` is how an exporter says it could not serialise part of the
document — a closed shadow root, a cross-origin frame, an element that would not
serialise. Each region named there is reported with its reason, and the run is
incomplete.

It also changes what an unresolved id means. With a complete index and no
unreadable region, an id that is not in the snapshot is a **broken reference**
and the run fails. With a partial index, or with any unreadable region listed,
the same id is **unresolved**: the tool does not claim the reference is broken,
does not claim the association is right, and marks the run incomplete. A field
whose only labelling reference cannot be resolved is likewise not called
unlabelled.

The rule behind that: evidence dropped while building an index makes the
comparison incomplete — it does not make the comparison clean. A snapshot that
declares `idIndex: "complete"` while also listing an unreadable region is
contradicting itself, and the unreadable region wins.

## The expectations

```json
{
  "schemaVersion": "1",
  "requireErrorSummary": true,
  "requireAriaInvalid": true,
  "focusAfterSubmit": ["summary", "first-invalid-field"],
  "maxSnapshotAgeDays": 90,
  "limits": {
    "maxSnapshotBytes": 4194304,
    "maxFields": 200,
    "maxStates": 100,
    "maxNodes": 4000
  }
}
```

`schemaVersion`, `requireErrorSummary`, `requireAriaInvalid` and
`focusAfterSubmit` are required. `maxSnapshotAgeDays` and `limits` are optional;
the limits above are the defaults. Unknown keys — including a one-character typo
of a known one — are refused, because an accepted key that is silently ignored
turns a real failure into a green run.

`focusAfterSubmit` is a non-empty list drawn from `summary`,
`first-invalid-field` and `first-error-message`, each at most once. It is
checked only for a state recorded as `submitted` that holds at least one field
in error.

`requireAriaInvalid` governs whether a field **in error** must expose
`aria-invalid="true"`. It does not govern whether a field that is **not** in
error may still be marked as one: that is always checked, because it is the
question "was the stale error state cleared".

## Rules

`evidence?` marks a rule that says the tool did not obtain evidence a verdict
would need. Any one of those makes the whole report `incomplete` and the process
exit 2, whatever the rule's own severity is.

| Rule | Severity | Evidence missing |
| --- | --- | --- |
| `aria-invalid-not-captured` | warning | yes |
| `async-busy-not-captured` | warning | yes |
| `async-outcome-not-captured` | warning | yes |
| `async-pending-not-exposed` | error | no |
| `async-states-not-captured` | warning | yes |
| `capture-source-unsupported` | error | yes |
| `duplicate-node-id` | error | yes |
| `error-association-wrong` | error | no |
| `error-message-empty` | error | no |
| `error-message-not-visible` | error | no |
| `error-not-associated` | error | no |
| `field-invalid` | error | yes |
| `field-limit-exceeded` | error | yes |
| `field-not-labelled` | error | no |
| `focus-not-captured` | warning | yes |
| `focus-not-recovered` | error | no |
| `index-incomplete` | warning | yes |
| `invalid-not-exposed` | error | no |
| `label-evidence-missing` | warning | yes |
| `message-text-not-captured` | warning | yes |
| `no-fields-checked` | error | yes |
| `node-invalid` | error | yes |
| `node-limit-exceeded` | error | yes |
| `reference-broken` | error | no |
| `reference-unresolved` | warning | yes |
| `snapshot-age-unknown` | warning | yes |
| `snapshot-invalid` | error | yes |
| `snapshot-not-utf8` | error | yes |
| `snapshot-stale` | warning | yes |
| `snapshot-too-large` | error | yes |
| `snapshot-unparsable` | error | yes |
| `snapshot-unreadable` | error | yes |
| `stale-error-message` | error | no |
| `stale-error-state` | error | no |
| `stale-summary-link` | error | no |
| `state-field-not-recorded` | warning | yes |
| `state-invalid` | error | yes |
| `state-limit-exceeded` | error | yes |
| `subtree-not-captured` | warning | yes |
| `summary-absent` | error | no |
| `summary-link-not-a-field` | error | no |
| `summary-missing-error` | error | no |
| `summary-not-captured` | warning | yes |
| `visible-messages-not-captured` | warning | yes |

The fifteen `warning` rules marked `yes` are the ones where that marking is the
only thing preventing a green run, so each has a test that drives it from a real
snapshot and asserts `incomplete` with no error-severity finding present.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every declared field was checked in every state and the expectations held |
| `1` | the check completed and the form broke an expectation |
| `2` | invalid configuration, or evidence the check could not obtain |

Exit 2 has two shapes, and the difference matters to anything piping stdout:

| Situation | stdout | stderr | `status` |
| --- | --- | --- | --- |
| invalid configuration, unknown option, any problem with the expectations document | **empty** | the message | no report |
| input that could not be read, decoded or parsed, or evidence that was not obtained | a report | diagnostics | `incomplete` |

A configuration error means the run never had a subject, so there is nothing to
report about. Unobtained evidence means the run had a subject and failed to
learn something about it, which is what `incomplete` exists to say.

## The report

```json
{
  "schemaVersion": "1",
  "tool": "accessible-form-error-checker",
  "status": "pass",
  "evidenceBasis": "dom-snapshot",
  "disclaimer": "…",
  "notEstablished": ["…"],
  "summary": { "checked": 8, "errors": 0, "warnings": 0, "info": 0, "fields": 2, "states": 4, "nodes": 7 },
  "findings": []
}
```

`summary.checked` counts field-state pairs, not fields. `location.file` is the
snapshot's base name, never an absolute host path, and `location.pointer` is a
JSON Pointer into the snapshot.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by **UTF-16 code unit**. No locale collation is used anywhere:
`localeCompare` and `Intl.Collator` depend on ICU data that differs between Node
builds, and that has produced real ordering differences in this catalog. Two
runs over identical inputs produce byte-identical stdout.

## The clock

Nothing here reads the wall clock on its own behalf. `maxSnapshotAgeDays` is
compared against `--now`, which defaults to the system clock and takes
`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`. Passing it makes an age-checking run
reproducible; the examples pass it for that reason.

## Limits

| Limit | Default | Exceeding it |
| --- | ---: | --- |
| `maxSnapshotBytes` | 4194304 | `snapshot-too-large`, nothing checked |
| `maxFields` | 200 | `field-limit-exceeded`, nothing checked |
| `maxStates` | 100 | `state-limit-exceeded`, nothing checked |
| `maxNodes` | 4000 | `node-limit-exceeded`, nothing checked |

Exceeding a limit is an incomplete result naming the limit. It is never a silent
truncation and never a pass. Bounds that are not configurable: an id or state
name is at most 128 characters, an `aria-describedby` or `aria-labelledby` list
at most 32 entries, a summary at most 500 links, `unreadableRegions` at most 200
entries, and the expectations document itself at most 262144 bytes.

## Safety of the report

Every untrusted string — ids, state names, reasons, message excerpts, file names
— is stripped of C0, DEL, C1, `U+2028`, `U+2029` and the bidi controls before it
reaches the report or the summary, then bounded to 200 characters. A field id
carrying a newline cannot forge a line in the report.

A `JSON.parse` failure is described without reproducing the document: V8 quotes
the offending input back in some of its messages, so a short document that is
only a credential would otherwise be echoed by its own error message.

## Verification

```sh
npm run check     # lint, tests, both examples, and a packaging dry run
```

`npm test` runs the suite alone. The tests cover each acceptance criterion by
name, drive every rule in the table above from a real snapshot, and assert exit
codes from the real CLI rather than asserting about severity tables.

## License

MIT. See [LICENSE](./LICENSE).
