/**
 * Reading the DOM snapshot document.
 *
 * The snapshot is EVIDENCE, not policy, so nothing here throws. A document that
 * could not be read produces findings inside an `incomplete` report, because a
 * consumer needs to know which part of the form was not established.
 *
 * One distinction runs through the whole schema and is the reason the checks
 * can be honest: ABSENT IS NOT THE SAME AS NOT CAPTURED.
 *
 *   "ariaInvalid": null   the exporter looked, and the attribute was not there
 *   key omitted           the exporter did not record it
 *
 * The first is evidence and can fail a check. The second is a gap and makes the
 * run incomplete. Collapsing them -- treating a key nobody wrote down as an
 * attribute nobody set -- is how a tool reports a clean run on evidence it
 * never had.
 */

import { MAX_ID_LENGTH, isRenderableString, pointerToken } from './rules.mjs'
import { isRecord } from './policy.mjs'

export const SNAPSHOT_SCHEMA_VERSION = '1'

/**
 * The only evidence kind this tool reads.
 *
 * Its rules are written about DOM attributes and the relationships between
 * elements. A screenshot, a recorded session or an assistive-technology
 * transcript is a different kind of evidence and reinterpreting one as the
 * other is exactly the overclaim this tool exists not to make, so an unexpected
 * source is refused rather than treated as a snapshot.
 */
export const SUPPORTED_SOURCE = 'dom-snapshot'

export const NODE_KINDS = Object.freeze(['label', 'message', 'summary', 'other'])
export const INDEX_STATES = Object.freeze(['complete', 'partial'])

/**
 * The `aria-invalid` values that expose a control as invalid.
 *
 * ARIA 1.2 gives the state four token values: `false`, which is the default,
 * `true`, `grammar` and `spelling`. `grammar` and `spelling` are not a milder
 * kind of valid -- each says an error was detected and names what kind -- so a
 * control carrying one is exposed as invalid exactly as `true` is.
 *
 * Asking for the literal `true` was wrong in both directions at once, which is
 * why this is one predicate rather than two comparisons. A spell-checked field
 * in error carrying `aria-invalid="spelling"` -- markup ARIA describes and a
 * specialist would call right -- was reported as `invalid-not-exposed`, at error
 * severity, exit 1. The same comparison on the other side let a corrected field
 * keep `aria-invalid="spelling"` without being reported as stale. The two sides
 * are the same question and now they cannot drift apart.
 *
 * A value outside the token set is not in this list on purpose: ARIA says an
 * unrecognised token takes the attribute's default, and the default here is
 * `false`, so `aria-invalid="tru"` exposes nothing as invalid.
 */
export const INVALID_TOKENS = Object.freeze(['grammar', 'spelling', 'true'])

export function marksInvalid(value) {
  return INVALID_TOKENS.includes(value)
}

/** Reasons an exporter may give for a subtree it could not serialise. */
export const UNREADABLE_REASONS = Object.freeze([
  'shadow-root',
  'closed-shadow-root',
  'cross-origin-iframe',
  'not-serialisable',
  'access-denied',
])

export function pointerFor(...segments) {
  return segments.length === 0 ? '' : `/${segments.map((segment) => pointerToken(segment)).join('/')}`
}

function id(value) {
  return isRenderableString(value, MAX_ID_LENGTH) ? value : null
}

function stringArray(value, limit) {
  if (!Array.isArray(value) || value.length > limit) return null
  const out = []
  for (const entry of value) {
    const name = id(entry)
    if (name === null) return null
    out.push(name)
  }
  return out
}

/**
 * Validate one field declaration.
 *
 * `labelling` omitted is a gap, not an unlabelled field: the caller turns it
 * into `label-evidence-missing` rather than `field-not-labelled`. Present but
 * hollow is a real defect, and "hollow" is decided by what the value would
 * render as -- an `aria-label` of U+200E passes `trim()` and says nothing.
 */
export function readField(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the field record is not a JSON object' }
  const fieldId = id(raw.id)
  if (fieldId === null) return { ok: false, reason: 'the field has no usable "id"' }

  let labelling = null
  if (Object.hasOwn(raw, 'labelling')) {
    const source = raw.labelling
    if (!isRecord(source)) return { ok: false, reason: '"labelling" is not a JSON object' }
    for (const key of ['labelFor', 'ariaLabelledby', 'ariaLabel', 'wrappingLabel']) {
      if (!Object.hasOwn(source, key)) {
        return { ok: false, reason: `"labelling" must record "${key}"; use null when the attribute was absent` }
      }
    }
    const labelledby = source.ariaLabelledby === null ? [] : stringArray(source.ariaLabelledby, 32)
    if (labelledby === null) return { ok: false, reason: '"labelling.ariaLabelledby" must be null or an array of ids' }
    if (source.labelFor !== null && id(source.labelFor) === null) {
      return { ok: false, reason: '"labelling.labelFor" must be null or an id' }
    }
    if (source.ariaLabel !== null && typeof source.ariaLabel !== 'string') {
      return { ok: false, reason: '"labelling.ariaLabel" must be null or a string' }
    }
    if (typeof source.wrappingLabel !== 'boolean') {
      return { ok: false, reason: '"labelling.wrappingLabel" must be true or false' }
    }
    labelling = {
      labelFor: source.labelFor === null ? null : source.labelFor,
      ariaLabelledby: labelledby,
      ariaLabel: source.ariaLabel,
      wrappingLabel: source.wrappingLabel,
    }
  }

  if (Object.hasOwn(raw, 'asyncValidated') && typeof raw.asyncValidated !== 'boolean') {
    return { ok: false, reason: '"asyncValidated" must be true or false' }
  }

  return {
    ok: true,
    field: {
      id: fieldId,
      labelling,
      labellingCaptured: labelling !== null,
      asyncValidated: raw.asyncValidated === true,
    },
  }
}

export function readNode(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the node record is not a JSON object' }
  const nodeId = id(raw.id)
  if (nodeId === null) return { ok: false, reason: 'the node has no usable "id"' }
  if (!NODE_KINDS.includes(raw.kind)) {
    return { ok: false, reason: `"kind" must be one of: ${NODE_KINDS.join(', ')}` }
  }
  const node = { id: nodeId, kind: raw.kind, textCaptured: Object.hasOwn(raw, 'text'), text: null, belongsTo: null }
  if (node.textCaptured) {
    if (raw.text !== null && typeof raw.text !== 'string') {
      return { ok: false, reason: '"text" must be null or a string' }
    }
    node.text = raw.text
  }
  if (raw.kind === 'message') {
    const owner = id(raw.belongsTo)
    if (owner === null) {
      return { ok: false, reason: 'a "message" node must record "belongsTo": the id of the field it is about' }
    }
    node.belongsTo = owner
  }
  return { ok: true, node }
}

/** One field's record inside one state. */
export function readStateField(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the state field record is not a JSON object' }
  const fieldId = id(raw.id)
  if (fieldId === null) return { ok: false, reason: 'the state field record has no usable "id"' }

  if (!Object.hasOwn(raw, 'declaredError')) {
    return { ok: false, reason: '"declaredError" is required; use null when the state declares no error for the field' }
  }
  if (raw.declaredError !== null && id(raw.declaredError) === null) {
    return { ok: false, reason: '"declaredError" must be null or the id of a message node' }
  }
  if (!Object.hasOwn(raw, 'describedby')) {
    return { ok: false, reason: '"describedby" is required; use null when the attribute was absent' }
  }
  const describedby = raw.describedby === null ? [] : stringArray(raw.describedby, 32)
  if (describedby === null) return { ok: false, reason: '"describedby" must be null or an array of ids' }
  if (!Object.hasOwn(raw, 'errormessage')) {
    return { ok: false, reason: '"errormessage" is required; use null when the attribute was absent' }
  }
  if (raw.errormessage !== null && id(raw.errormessage) === null) {
    return { ok: false, reason: '"errormessage" must be null or an id' }
  }
  if (Object.hasOwn(raw, 'pending') && typeof raw.pending !== 'boolean') {
    return { ok: false, reason: '"pending" must be true or false' }
  }
  if (Object.hasOwn(raw, 'ariaInvalid') && raw.ariaInvalid !== null && typeof raw.ariaInvalid !== 'string') {
    return { ok: false, reason: '"ariaInvalid" must be null or a string' }
  }
  if (Object.hasOwn(raw, 'ariaBusy') && raw.ariaBusy !== null && typeof raw.ariaBusy !== 'string') {
    return { ok: false, reason: '"ariaBusy" must be null or a string' }
  }

  return {
    ok: true,
    record: {
      id: fieldId,
      declaredError: raw.declaredError,
      describedby,
      errormessage: raw.errormessage,
      pending: raw.pending === true,
      ariaInvalidCaptured: Object.hasOwn(raw, 'ariaInvalid'),
      ariaInvalid: Object.hasOwn(raw, 'ariaInvalid') ? raw.ariaInvalid : null,
      ariaBusyCaptured: Object.hasOwn(raw, 'ariaBusy'),
      ariaBusy: Object.hasOwn(raw, 'ariaBusy') ? raw.ariaBusy : null,
    },
  }
}

export function readSummary(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the summary is not a JSON object' }
  const summaryId = id(raw.id)
  if (summaryId === null) return { ok: false, reason: 'the summary has no usable "id"' }
  if (!Array.isArray(raw.links) || raw.links.length > 500) {
    return { ok: false, reason: 'the summary must record a "links" array of at most 500 entries' }
  }
  const links = []
  for (const entry of raw.links) {
    if (!isRecord(entry)) return { ok: false, reason: 'a summary link is not a JSON object' }
    const target = id(entry.target)
    if (target === null) return { ok: false, reason: 'a summary link has no usable "target"' }
    links.push({ target })
  }
  return { ok: true, summary: { id: summaryId, links } }
}

/**
 * Read the top-level document.
 *
 * Returns `{ ok: false, findings }` when the document cannot be used at all,
 * and otherwise the parsed shape plus every record that could not be read, so
 * the caller can report each gap rather than dropping it.
 */
export function readSnapshot(document) {
  if (!isRecord(document)) return { ok: false, reason: 'the snapshot is not a JSON object' }
  if (document.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, reason: `the snapshot must declare "schemaVersion": "${SNAPSHOT_SCHEMA_VERSION}"` }
  }
  if (!isRecord(document.capture)) return { ok: false, reason: 'the snapshot must record a "capture" object' }
  const captureId = id(document.capture.id)
  if (captureId === null) return { ok: false, reason: '"capture.id" is missing or unusable' }
  if (!INDEX_STATES.includes(document.capture.idIndex)) {
    return { ok: false, reason: `"capture.idIndex" must be one of: ${INDEX_STATES.join(', ')}` }
  }
  if (!Array.isArray(document.fields)) return { ok: false, reason: '"fields" must be an array' }
  if (!Array.isArray(document.nodes)) return { ok: false, reason: '"nodes" must be an array' }
  if (!Array.isArray(document.states)) return { ok: false, reason: '"states" must be an array' }

  const regions = []
  if (Object.hasOwn(document, 'unreadableRegions')) {
    if (!Array.isArray(document.unreadableRegions) || document.unreadableRegions.length > 200) {
      return { ok: false, reason: '"unreadableRegions" must be an array of at most 200 entries' }
    }
    for (const entry of document.unreadableRegions) {
      if (!isRecord(entry)) return { ok: false, reason: 'an unreadable region is not a JSON object' }
      const hostId = id(entry.hostId)
      if (hostId === null) return { ok: false, reason: 'an unreadable region has no usable "hostId"' }
      if (!UNREADABLE_REASONS.includes(entry.reason)) {
        return { ok: false, reason: `an unreadable region must give a "reason" from: ${UNREADABLE_REASONS.join(', ')}` }
      }
      regions.push({ hostId, reason: entry.reason })
    }
  }

  const states = []
  for (const [index, raw] of document.states.entries()) {
    if (!isRecord(raw)) return { ok: false, reason: `state ${index} is not a JSON object` }
    const name = id(raw.name)
    if (name === null) return { ok: false, reason: `state ${index} has no usable "name"` }
    if (!Array.isArray(raw.fields)) return { ok: false, reason: `state "${name}" must record a "fields" array` }
    if (Object.hasOwn(raw, 'submitted') && typeof raw.submitted !== 'boolean') {
      return { ok: false, reason: `state "${name}" must record "submitted" as true or false` }
    }
    states.push({
      name,
      index,
      rawFields: raw.fields,
      submitted: raw.submitted === true,
      visibleCaptured: Object.hasOwn(raw, 'visibleMessages'),
      rawVisible: Object.hasOwn(raw, 'visibleMessages') ? raw.visibleMessages : null,
      summaryCaptured: Object.hasOwn(raw, 'summary'),
      rawSummary: Object.hasOwn(raw, 'summary') ? raw.summary : undefined,
      focusCaptured: Object.hasOwn(raw, 'focus'),
      focus: Object.hasOwn(raw, 'focus') ? raw.focus : undefined,
    })
  }

  return {
    ok: true,
    snapshot: {
      capture: {
        id: captureId,
        source: document.capture.source,
        idIndex: document.capture.idIndex,
        capturedAt: Object.hasOwn(document.capture, 'capturedAt') ? document.capture.capturedAt : null,
      },
      unreadableRegions: regions,
      rawFields: document.fields,
      rawNodes: document.nodes,
      states,
    },
  }
}
