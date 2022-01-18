/**
 * The expectations document: the policy this tool checks a snapshot against.
 *
 * The policy is not evidence. A problem with it means the run never had a
 * subject, so it throws `ConfigError`, stdout stays empty and the process exits
 * 2 -- the shape the report contract reserves for a configuration error.
 *
 * Every threshold this tool applies comes from here. There is no built-in
 * expectation about focus, about summaries or about `aria-invalid` anywhere in
 * the source, so a team that deliberately does not use an error summary is not
 * argued with by a linter's opinion, and a policy that omits a key it needs is
 * refused rather than quietly defaulted to something this tool invented.
 */

import { isRenderableString } from './rules.mjs'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const POLICY_SCHEMA_VERSION = '1'

/** The policy document is small; a megabyte of it is a mistake, not a policy. */
export const MAX_POLICY_BYTES = 262144

export const DEFAULT_LIMITS = Object.freeze({
  maxSnapshotBytes: 4194304,
  maxFields: 200,
  maxStates: 100,
  maxNodes: 4000,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS).sort())

/** Where focus is allowed to be after a submission that produced errors. */
export const FOCUS_TARGETS = Object.freeze(['summary', 'first-invalid-field', 'first-error-message'])

/**
 * Keys this tool refuses rather than evaluates.
 *
 * Each names an outcome that only a person listening to assistive technology
 * can establish. This tool reads a DOM snapshot: it can say that a message node
 * is associated with a field, and it cannot say what was conveyed to anyone. A
 * policy that asks it to judge that is a configuration error -- refusing is the
 * behaviour, because silently ignoring the key would let a team believe an
 * expectation was checked when nothing checked it.
 */
export const REFUSED_POLICY_KEYS = Object.freeze([
  'announcedText',
  'expectAnnouncement',
  'expectSpoken',
  'screenReader',
  'screenReaderOutput',
  'spokenText',
])

const KNOWN_KEYS = Object.freeze([
  'schemaVersion',
  'requireErrorSummary',
  'requireAriaInvalid',
  'focusAfterSubmit',
  'maxSnapshotAgeDays',
  'limits',
])

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireBoolean(value, key) {
  if (typeof value !== 'boolean') throw new ConfigError(`"${key}" must be true or false.`)
  return value
}

function requireInteger(value, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`"${key}" must be a whole number between ${min} and ${max}.`)
  }
  return value
}

/**
 * Validate the expectations document.
 *
 * Unknown keys are rejected. A one-character typo in `requireErrorSummary` must
 * not turn a real failure into a green run, which is exactly what an ignored
 * key does.
 */
export function validatePolicy(document) {
  if (!isRecord(document)) throw new ConfigError('The expectations document must be a JSON object.')
  if (document.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new ConfigError(`The expectations document must declare "schemaVersion": "${POLICY_SCHEMA_VERSION}".`)
  }

  for (const key of REFUSED_POLICY_KEYS) {
    if (Object.hasOwn(document, key)) {
      throw new ConfigError(
        `"${key}" cannot be checked from a DOM snapshot. This tool reads exported markup: it can `
        + `establish which message node a field is associated with, and it cannot establish what `
        + `assistive technology conveyed to a person. That needs separate manual evidence, `
        + `recorded by somebody who listened. Remove the key.`,
      )
    }
  }

  const unknown = Object.keys(document).filter((key) => !KNOWN_KEYS.includes(key)).sort()
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown expectation key(s): ${unknown.join(', ')}. Known keys: ${[...KNOWN_KEYS].sort().join(', ')}.`,
    )
  }

  const requireErrorSummary = requireBoolean(document.requireErrorSummary, 'requireErrorSummary')
  const requireAriaInvalid = requireBoolean(document.requireAriaInvalid, 'requireAriaInvalid')

  if (!Array.isArray(document.focusAfterSubmit) || document.focusAfterSubmit.length === 0) {
    throw new ConfigError(
      `"focusAfterSubmit" must be a non-empty array of: ${FOCUS_TARGETS.join(', ')}.`,
    )
  }
  const focusAfterSubmit = []
  for (const target of document.focusAfterSubmit) {
    if (!FOCUS_TARGETS.includes(target)) {
      throw new ConfigError(
        `"focusAfterSubmit" holds an unknown target. Allowed: ${FOCUS_TARGETS.join(', ')}.`,
      )
    }
    if (focusAfterSubmit.includes(target)) {
      throw new ConfigError(`"focusAfterSubmit" lists ${target} more than once.`)
    }
    focusAfterSubmit.push(target)
  }

  let maxSnapshotAgeDays = null
  if (document.maxSnapshotAgeDays !== undefined) {
    maxSnapshotAgeDays = requireInteger(document.maxSnapshotAgeDays, 'maxSnapshotAgeDays', { max: 36500 })
  }

  const limits = { ...DEFAULT_LIMITS }
  if (document.limits !== undefined) {
    if (!isRecord(document.limits)) throw new ConfigError('"limits" must be a JSON object.')
    const unknownLimits = Object.keys(document.limits).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key)).sort()
    if (unknownLimits.length > 0) {
      throw new ConfigError(
        `Unknown limit(s): ${unknownLimits.join(', ')}. Known limits: ${LIMIT_NAMES.join(', ')}.`,
      )
    }
    for (const key of LIMIT_NAMES) {
      if (document.limits[key] === undefined) continue
      limits[key] = requireInteger(document.limits[key], `limits.${key}`, { max: 1073741824 })
    }
  }

  return Object.freeze({
    requireErrorSummary,
    requireAriaInvalid,
    focusAfterSubmit: Object.freeze(focusAfterSubmit),
    maxSnapshotAgeDays,
    limits: Object.freeze(limits),
  })
}

/**
 * A strict instant parser, so `--now` and `capturedAt` mean the same thing.
 *
 * `Date.parse` accepts implementation-defined formats and silently reinterprets
 * others, which makes a staleness verdict depend on the Node build. Two
 * explicit shapes are accepted and everything else is refused.
 */
export function parseInstant(value) {
  if (!isRenderableString(value, 40)) return { ok: false, ms: null }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value)
  const parts = full ?? dateOnly
  if (parts === null) return { ok: false, ms: null }
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const [hour, minute, second] = full === null
    ? [0, 0, 0]
    : [Number(parts[4]), Number(parts[5]), Number(parts[6])]
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, ms: null }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, ms: null }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return { ok: false, ms: null }
  }
  return { ok: true, ms }
}
