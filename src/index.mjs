/**
 * accessible-form-error-checker
 *
 * Read a DOM snapshot that somebody else exported -- a form in a set of
 * declared error states -- and an expectations document, then check that every
 * declared error is associated with the field it is about, that a corrected
 * field is left with no error state still on it, that the error summary links
 * where it should, that focus went somewhere a person can recover from, and
 * that asynchronous validation was recorded from the wait through to the
 * outcome.
 *
 * Three rules govern the design, and they matter more than the checks:
 *
 * 1. THE SNAPSHOT IS AN INPUT. This tool opens no browser, resolves no host,
 *    submits nothing and computes no accessible name. It does not emulate a
 *    screen reader and it cannot say what one would convey; it reports what the
 *    exported markup records. A finding may not phrase itself otherwise, and
 *    the phrasing is refused at construction time rather than at review time.
 * 2. ABSENT IS NOT NOT-CAPTURED. `"ariaInvalid": null` says the exporter looked
 *    and the attribute was not there. An omitted key says nobody wrote it down.
 *    The first can fail a check; the second makes the run incomplete.
 * 3. UNKNOWN IS NEVER A PASS, ON BOTH SIDES. A reference the id index cannot
 *    resolve is a broken reference only when the index holds every id the form
 *    has. When a subtree was not captured -- a shadow root, a cross-origin
 *    frame -- or the exporter declares the index partial, the same reference
 *    becomes a gap that marks the run incomplete. Evidence dropped while
 *    building an index makes the comparison incomplete, not clean.
 *
 * The expectations document is the policy: a problem with it means the run
 * never had a subject, so stdout stays empty and the process exits 2. The
 * snapshot is the evidence: a problem with it is a finding inside an
 * `incomplete` report, because a consumer needs to know which part of the form
 * was not established.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { ageChecks, buildIndex, checkSnapshot, resolveReference } from './checks.mjs'
import {
  ConfigError,
  DEFAULT_LIMITS,
  FOCUS_TARGETS,
  LIMIT_NAMES,
  MAX_POLICY_BYTES,
  POLICY_SCHEMA_VERSION,
  REFUSED_POLICY_KEYS,
  isRecord,
  parseInstant,
  validatePolicy,
} from './policy.mjs'
import {
  EVIDENCE_MISSING_RULES,
  LINE_SEPARATORS,
  RULE_IDS,
  RULE_SEVERITY,
  at,
  makeFinding,
  marksEvidenceMissing,
  msg,
  parseFailureDetail,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'
import {
  INDEX_STATES,
  INVALID_TOKENS,
  NODE_KINDS,
  SNAPSHOT_SCHEMA_VERSION,
  SUPPORTED_SOURCE,
  UNREADABLE_REASONS,
  pointerFor,
  readSnapshot,
} from './snapshot.mjs'

export { ageChecks, buildIndex, checkSnapshot, resolveReference } from './checks.mjs'
export {
  ConfigError,
  DEFAULT_LIMITS,
  FOCUS_TARGETS,
  LIMIT_NAMES,
  MAX_POLICY_BYTES,
  POLICY_SCHEMA_VERSION,
  REFUSED_POLICY_KEYS,
  isRecord,
  parseInstant,
  validatePolicy,
} from './policy.mjs'
export {
  EVIDENCE_LIMIT,
  EVIDENCE_MISSING_RULES,
  FORBIDDEN_CLAIMS,
  LINE_SEPARATORS,
  MAX_ID_LENGTH,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  SafeMessage,
  assertNoForbiddenClaim,
  at,
  byCodeUnit,
  compareFindings,
  describeValue,
  findForbiddenClaim,
  isRenderableString,
  makeFinding,
  marksEvidenceMissing,
  msg,
  num,
  parseFailureDetail,
  pointerToken,
  sanitize,
  severityFor,
  showsSomething,
  sortFindings,
  statusFor,
} from './rules.mjs'
export {
  INDEX_STATES,
  INVALID_TOKENS,
  NODE_KINDS,
  SNAPSHOT_SCHEMA_VERSION,
  SUPPORTED_SOURCE,
  UNREADABLE_REASONS,
  marksInvalid,
  pointerFor,
  readField,
  readNode,
  readSnapshot,
  readStateField,
  readSummary,
} from './snapshot.mjs'

export const TOOL_ID = 'accessible-form-error-checker'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Printed in every report, whatever the verdict.
 *
 * It is a top-level string rather than a finding because it is true of the run
 * as a whole. A consumer reading only the findings should still be told what
 * kind of evidence produced them, and what no amount of this evidence can
 * settle.
 */
export const DISCLAIMER =
  'This report describes a DOM snapshot document that was supplied to it. The tool opens no browser, resolves no '
  + 'host, submits no form and computes no accessible name: every result here is markup evidence about associations '
  + 'recorded in that document. It does not emulate assistive technology, and what a person using one would be told '
  + 'is not established by this run and needs separate manual evidence.'

/** The questions this evidence cannot settle, named in the report itself. */
export const NOT_ESTABLISHED = Object.freeze([
  'what assistive technology conveys to a person, in what order, or whether it interrupts',
  'whether an error message is understandable, accurate or actionable',
  'anything inside a subtree the snapshot records as not captured',
  'anything that happens only at a moment between the states the snapshot records',
])

/**
 * Read a file as UTF-8, strictly.
 *
 * `fatal: true` is the point: a file whose bytes are not UTF-8 is reported as
 * undecodable, and encoding validity is never inferred from decoded text. A
 * document that legitimately contains U+FFFD is evidence of nothing. The
 * expectations document goes through the same path, because a policy file that
 * quietly accepts broken bytes is the same defect one directory over.
 */
export async function readTextBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', text: null }
  if (info.size > maxBytes) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds the ${maxBytes} byte limit`, text: null }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8', text: null }
  }
  return { status: 'ok', reason: null, text }
}

/** Load and validate the expectations document. Every failure is a ConfigError. */
export async function loadPolicy(expectationsPath) {
  const absolute = resolve(process.cwd(), expectationsPath)
  const read = await readTextBounded(absolute, MAX_POLICY_BYTES)
  if (read.status !== 'ok') throw new ConfigError(`Could not load the expectations document: ${read.reason}`)
  let document
  try {
    document = JSON.parse(read.text)
  } catch (error) {
    // V8 quotes the document it choked on -- the whole file when the file is
    // short -- so the expectations document would reach stderr through its own
    // error message. `parseFailureDetail` keeps the position and discards the
    // quote; the sanitising pass stays, because every untrusted string gets one.
    throw new ConfigError(`The expectations document is not valid JSON: ${sanitize(parseFailureDetail(error), 200)}`)
  }
  return validatePolicy(document)
}

const EMPTY_COUNTS = Object.freeze({ checked: 0, fields: 0, states: 0, nodes: 0 })

export function buildReport(findings, counts) {
  const sorted = sortFindings(findings)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    evidenceBasis: SUPPORTED_SOURCE,
    disclaimer: DISCLAIMER,
    notEstablished: [...NOT_ESTABLISHED],
    summary: {
      checked: counts.checked,
      errors: sorted.filter((finding) => finding.severity === 'error').length,
      warnings: sorted.filter((finding) => finding.severity === 'warning').length,
      info: sorted.filter((finding) => finding.severity === 'info').length,
      fields: counts.fields,
      states: counts.states,
      nodes: counts.nodes,
    },
    findings: sorted,
  }
}

/**
 * Run one check.
 *
 * Throws `ConfigError` when the run never had a subject. Everything that went
 * wrong with the evidence comes back inside the report.
 */
export async function checkForm({ snapshot, expectations, now = Date.now() }) {
  const policy = await loadPolicy(expectations)
  const snapshotPath = resolve(process.cwd(), snapshot)
  const file = sanitize(basename(snapshotPath), 200)

  const read = await readTextBounded(snapshotPath, policy.limits.maxSnapshotBytes)
  if (read.status !== 'ok') {
    const ruleId = read.status === 'too-large'
      ? 'snapshot-too-large'
      : read.status === 'not-utf8' ? 'snapshot-not-utf8' : 'snapshot-unreadable'
    return buildReport([makeFinding(
      ruleId,
      msg`The snapshot was not read: ${read.reason}.`,
      at(file, null),
      {
        suggestion: read.status === 'too-large'
          ? 'Raise limits.maxSnapshotBytes deliberately, or split the snapshot.'
          : 'Export the snapshot as UTF-8 JSON at the path given to --snapshot.',
      },
    )], EMPTY_COUNTS)
  }

  let document
  try {
    document = JSON.parse(read.text)
  } catch (error) {
    return buildReport([makeFinding(
      'snapshot-unparsable',
      msg`The snapshot is not valid JSON: ${parseFailureDetail(error)}.`,
      at(file, null),
      { suggestion: 'Correct the JSON. Nothing was read from this file.' },
    )], EMPTY_COUNTS)
  }

  const structure = readSnapshot(document)
  if (!structure.ok) {
    return buildReport([makeFinding(
      'snapshot-invalid',
      msg`The snapshot was not usable: ${structure.reason}. Nothing was checked.`,
      at(file, pointerFor()),
      { suggestion: 'Correct the snapshot against the shape the README documents.' },
    )], EMPTY_COUNTS)
  }

  const { findings, counts } = checkSnapshot({ snapshot: structure.snapshot, policy, file, now })
  return buildReport(findings, counts)
}

const SEPARATOR_PATTERN = new RegExp(`[${LINE_SEPARATORS}]`, 'gu')
const SEPARATOR_ESCAPES = new Map(
  [...LINE_SEPARATORS].map((character) => [
    character,
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  ]),
)

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and inside a JavaScript string
 * literal those two are line terminators. The payload parses as JSON either
 * way, but an identifier carrying one would break a consumer that evaluates the
 * payload as JavaScript, so both are escaped here as well as stripped upstream.
 */
export function renderReport(report) {
  const json = JSON.stringify(report, null, 2)
  return `${json.replace(SEPARATOR_PATTERN, (character) => SEPARATOR_ESCAPES.get(character))}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer]
      .filter((part) => part !== undefined && part !== '')
      .map((part) => sanitize(part, 200))
      .join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${sanitize(finding.ruleId, 40).padEnd(30)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.fields} field(s) and ${report.summary.nodes} node(s) across `
    + `${report.summary.states} state(s); ${report.summary.checked} field-state pair(s) checked.`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  lines.push(report.disclaimer)
  return `${lines.join('\n')}\n`
}

/** Exported so the rule catalog and the limits can be asserted against the docs. */
export const CATALOG = Object.freeze({
  ruleIds: RULE_IDS,
  severity: RULE_SEVERITY,
  evidenceMissing: EVIDENCE_MISSING_RULES,
  limits: DEFAULT_LIMITS,
  limitNames: LIMIT_NAMES,
  focusTargets: FOCUS_TARGETS,
  nodeKinds: NODE_KINDS,
  indexStates: INDEX_STATES,
  invalidTokens: INVALID_TOKENS,
  unreadableReasons: UNREADABLE_REASONS,
  refusedPolicyKeys: REFUSED_POLICY_KEYS,
  supportedSource: SUPPORTED_SOURCE,
  severityFor,
  marksEvidenceMissing,
  snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
  policySchemaVersion: POLICY_SCHEMA_VERSION,
  reportSchemaVersion: REPORT_SCHEMA_VERSION,
})
