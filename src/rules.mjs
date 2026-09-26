/**
 * The rule catalog, the severity table, and everything that turns findings into
 * a status.
 *
 * Five defences live here, and each one exists because its absence produced a
 * green build over a real failure somewhere in this catalog:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table, and an unknown rule id throws rather than
 *    defaulting to something harmless.
 * 2. `status` is derived from the findings, never from a mutable flag. A run
 *    that could not obtain the evidence a verdict needs is `incomplete`, and
 *    there is no single assignment whose deletion would let an unread snapshot
 *    report a pass. Several of the evidence-missing rules are `warning`
 *    severity on purpose: for those, membership of `EVIDENCE_MISSING_RULES` is
 *    the only thing standing between a gap in the evidence and a green run.
 * 3. A finding's message must be built with the `msg` tagged template. The
 *    template's own literals are checked against the words this tool is not
 *    entitled to use -- it reads a DOM snapshot somebody else exported, it does
 *    not emulate a screen reader and it never hears anything -- while the
 *    interpolated values, which come from untrusted documents, are sanitised.
 * 4. `sanitize` is the single boundary every untrusted string crosses, so it
 *    must survive a value that cannot be converted to a primitive at all.
 * 5. Ordering is by UTF-16 code unit. Collation is machine-dependent.
 */

/** Deterministic order: UTF-16 code unit, never locale collation. */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** The one place a severity is written down. */
export const RULE_SEVERITY = Object.freeze({
  'aria-invalid-not-captured': 'warning',
  'async-busy-not-captured': 'warning',
  'async-outcome-not-captured': 'warning',
  'async-pending-not-exposed': 'error',
  'async-states-not-captured': 'warning',
  'capture-source-unsupported': 'error',
  'duplicate-node-id': 'error',
  'error-association-wrong': 'error',
  'error-message-empty': 'error',
  'error-message-not-visible': 'error',
  'error-not-associated': 'error',
  'field-invalid': 'error',
  'field-limit-exceeded': 'error',
  'field-not-labelled': 'error',
  'focus-not-captured': 'warning',
  'focus-not-recovered': 'error',
  'index-incomplete': 'warning',
  'invalid-not-exposed': 'error',
  'label-evidence-missing': 'warning',
  'message-text-not-captured': 'warning',
  'no-fields-checked': 'error',
  'node-invalid': 'error',
  'node-limit-exceeded': 'error',
  'reference-broken': 'error',
  'reference-unresolved': 'warning',
  'snapshot-age-unknown': 'warning',
  'snapshot-invalid': 'error',
  'snapshot-not-utf8': 'error',
  'snapshot-stale': 'warning',
  'snapshot-too-large': 'error',
  'snapshot-unparsable': 'error',
  'snapshot-unreadable': 'error',
  'stale-error-message': 'error',
  'stale-error-state': 'error',
  'stale-summary-link': 'error',
  'state-field-not-recorded': 'warning',
  'state-invalid': 'error',
  'state-limit-exceeded': 'error',
  'subtree-not-captured': 'warning',
  'summary-absent': 'error',
  'summary-link-not-a-field': 'error',
  'summary-missing-error': 'error',
  'summary-not-captured': 'warning',
  'visible-messages-not-captured': 'warning',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the tool did not obtain the evidence a verdict would need.
 * Any one of them makes the whole report `incomplete` and the process exit 2,
 * whatever the rule's own severity happens to be.
 *
 * Fifteen of these are `warning` severity, because a gap in the evidence is not
 * a defect in the form being checked. For those fifteen, membership of this list
 * is the ONLY thing preventing a green run over a field whose label was never
 * captured, a reference into a shadow root the exporter could not traverse, an
 * asynchronous validation whose outcome was never recorded, or a focus target
 * nobody wrote down. Deleting an entry here is a silent mutation that turns
 * exit 2 into exit 0, so every entry has a test that fails without it.
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'aria-invalid-not-captured',
  'async-busy-not-captured',
  'async-outcome-not-captured',
  'async-states-not-captured',
  'capture-source-unsupported',
  'duplicate-node-id',
  'field-invalid',
  'field-limit-exceeded',
  'focus-not-captured',
  'index-incomplete',
  'label-evidence-missing',
  'message-text-not-captured',
  'no-fields-checked',
  'node-invalid',
  'node-limit-exceeded',
  'reference-unresolved',
  'snapshot-age-unknown',
  'snapshot-invalid',
  'snapshot-not-utf8',
  'snapshot-stale',
  'snapshot-too-large',
  'snapshot-unparsable',
  'snapshot-unreadable',
  'state-field-not-recorded',
  'state-invalid',
  'state-limit-exceeded',
  'subtree-not-captured',
  'summary-not-captured',
  'visible-messages-not-captured',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200
export const MAX_ID_LENGTH = 128

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

/**
 * Words this tool is not entitled to use about its own work.
 *
 * It reads a DOM snapshot document that somebody else exported. It opens no
 * browser, resolves no host, computes no accessible name and runs no assistive
 * technology: it does not emulate a screen reader and it cannot know what one
 * would say. A finding phrased as though it had listened to a form would
 * describe a capability this tool does not have, so the phrasing is refused at
 * construction time rather than at review time.
 *
 * Only the tool's OWN literals are scanned. A field literally named
 * `screen-reader-hint` is data and must not stop the run.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'screen reader', 'screen readers', 'screenreader', 'screenreaders',
  'assistive technology', 'voiceover', 'talkback', 'nvda', 'jaws', 'narrator',
  'announce', 'announced', 'announces', 'announcement', 'announcements',
  'spoken', 'speaks', 'speech', 'said aloud', 'read aloud', 'audible', 'heard',
  'accessible name computation', 'we computed the accessible name',
  'browser', 'browsers', 'rendered', 'rendering', 'screenshot', 'screenshots',
  'navigate', 'navigated', 'visited', 'crawled', 'fetched',
  'we opened the form', 'this tool submitted', 'emulate', 'emulated', 'emulates',
])

const FORBIDDEN_PATTERN = new RegExp(
  `\\b(?:${FORBIDDEN_CLAIMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
  'iu',
)

export function findForbiddenClaim(text) {
  const match = FORBIDDEN_PATTERN.exec(describeValue(text))
  return match === null ? null : match[0]
}

export function assertNoForbiddenClaim(text, what) {
  const term = findForbiddenClaim(text)
  if (term !== null) {
    throw new Error(
      `${what} may not claim this tool observed a form directly or emulated assistive `
      + `technology: "${term}". It reads a DOM snapshot document and nothing else.`,
    )
  }
}

/**
 * U+2028 and U+2029, written as escape text so that no editor, transfer or
 * copy-paste can quietly turn the escape into the character it names.
 */
export const LINE_SEPARATORS = '\u2028\u2029'

/**
 * Everything stripped from an untrusted string before it reaches output.
 *
 * `\p{Cc}` is C0, DEL and C1 -- U+0085 and U+009B forge lines in a human report
 * just as a newline does. `\p{Cf}` is the bidi controls and the other invisible
 * format characters, which reorder or hide displayed text. The two separators
 * are neither class and have to be named.
 */
const UNSAFE_CHARACTERS = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'gu')

/**
 * Describe any value as a string without ever letting it stop the run.
 *
 * `String({ toString: {} })` throws `Cannot convert object to primitive value`,
 * and a snapshot is JSON this tool did not write: `{"id": {"toString": {}}}`
 * parses into exactly that. A value that will not convert is described by its
 * shape and never reproduced.
 */
export function describeValue(value) {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '[array]'
  try {
    return String(value)
  } catch {
    return typeof value === 'function' ? '[function]' : '[object]'
  }
}

/**
 * A bounded, control-character-free rendering of an untrusted string.
 *
 * Field ids, node ids, state names, link text and message text all arrive from
 * the snapshot and all reach the report and the human summary, so every one of
 * them passes through here -- not only an `evidence` field. A shipped tool in
 * this catalog sanitised its evidence carefully and let an identifier carrying
 * a newline forge whole lines in the report.
 */
export function sanitize(value, limit = EVIDENCE_LIMIT) {
  const flat = describeValue(value)
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/**
 * Whether a value is a string that still says something once rendered.
 *
 * `value.trim().length > 0` is the wrong question and has shipped as a bug:
 * `trim` removes ECMAScript whitespace only, so an `aria-label` of U+0001 or
 * U+200E passes it and then renders as nothing at all. A label that renders
 * empty is not a label, so this asks about the rendered form.
 */
export function isRenderableString(value, limit = MAX_ID_LENGTH) {
  return typeof value === 'string' && value.length <= limit && sanitize(value, limit) !== ''
}

/**
 * Whether a string would show anything at all once the unsafe characters are
 * removed, with no opinion about its length.
 *
 * This is deliberately separate from `isRenderableString`. That one answers a
 * question about an IDENTIFIER, where a length cap is part of what makes the
 * value usable. Asking it about prose conflates two different failures: a
 * message longer than the cap is not a message that shows nothing, and
 * reporting it as one is a confident false accusation about the interface.
 * Length here is bounded by the document size limit and by nothing else.
 */
export function showsSomething(value) {
  return typeof value === 'string' && sanitize(value, Number.MAX_SAFE_INTEGER) !== ''
}

/** A number as a report prints it. */
export function num(value) {
  if (!Number.isFinite(value)) return describeValue(value)
  const rounded = Math.round(value * 10000) / 10000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/u

/**
 * The shape that quotes the input. Recognised FIRST, and the order is the whole
 * guard: a document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too -- the quoted span can carry a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it is
 * there to catch. A leading `...` means the quoted run came from the middle of
 * the document rather than its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a `JSON.parse` failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A document
 * short enough to be only a credential is therefore reproduced in full by its
 * own error message, and `sanitize` does not stop that -- it strips control
 * characters and cuts from the end, while the quoted input sits at the front.
 *
 * The closing guard is deliberate belt and braces and is why this function is
 * safe against wordings it has never seen: across the measured corpus of V8
 * parse messages, every message carrying no quoted snippet carries no double
 * quote at all, because V8 quotes JSON punctuation with apostrophes. A double
 * quote surviving to the end therefore means a snippet survived, whatever the
 * branches above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = describeValue(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/** A message whose literals have been checked and whose values are sanitised. */
export class SafeMessage {
  constructor(text) {
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }
}

/**
 * Build a finding message.
 *
 * The tagged-template split is the point: `strings` is this tool's own voice
 * and is checked for claims it is not entitled to make, while `values` come
 * from input documents and are only sanitised. A field literally named
 * `announcement-region` must not stop the run, and a sentence this tool wrote
 * claiming a screen reader said something must not ship.
 */
export function msg(strings, ...values) {
  let out = ''
  for (let index = 0; index < strings.length; index += 1) {
    // Runs of whitespace in the tool's own literals collapse to one space, so a
    // sentence may be wrapped across source lines without wrapping the report,
    // and so a phrase this tool may not use cannot be hidden by a line break.
    const literal = strings[index].replace(/\s+/gu, ' ')
    assertNoForbiddenClaim(literal, 'A finding message')
    out += literal
    if (index < values.length) out += sanitize(values[index])
  }
  return new SafeMessage(out)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

/** JSON Pointer escaping, applied to an already sanitised token. */
export function pointerToken(value) {
  return sanitize(value, MAX_ID_LENGTH).replace(/~/gu, '~0').replace(/\//gu, '~1')
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoForbiddenClaim(extra.suggestion, 'A finding suggestion')
    // The suggestion crosses the same boundary as everything else that reaches
    // output. Every call site builds it from this tool's own literals today, so
    // sanitising changes no byte of any current report -- which is exactly why
    // it was the one string that skipped the boundary, and exactly the shape of
    // an invariant that is true only by accident.
    finding.suggestion = sanitize(extra.suggestion)
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings alone.
 *
 * Missing evidence outranks everything, including an error: a run that could
 * not read half the form has not established that the half it read is the whole
 * story. There is no flag to delete.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
