/**
 * The checks themselves.
 *
 * Two ideas decide almost every branch in this file.
 *
 * ABSENT IS NOT NOT-CAPTURED. A state that records `"ariaInvalid": null` says
 * the attribute was looked for and was not there; a state that omits the key
 * says nobody wrote it down. The first can fail a check. The second makes the
 * run incomplete. Collapsing them is how a tool reports a clean form on
 * evidence it never had.
 *
 * A NEGATIVE CONCLUSION NEEDS A COMPLETE INDEX. "Nothing in this document has
 * that id" is only a statement about the form when the document holds every id
 * the form has. When the exporter declares the id index partial, or lists a
 * subtree it could not traverse -- a shadow root, a cross-origin frame -- the
 * same unresolved reference becomes `reference-unresolved`, which marks the run
 * incomplete, instead of `reference-broken`, which fails it. Evidence dropped
 * while building an index makes the comparison incomplete; it does not make the
 * comparison clean.
 */

import {
  at,
  byCodeUnit,
  isRenderableString,
  makeFinding,
  msg,
  num,
} from './rules.mjs'
import { SUPPORTED_SOURCE, pointerFor, readField, readNode, readStateField, readSummary } from './snapshot.mjs'
import { parseInstant } from './policy.mjs'

const MAX_MESSAGE_TEXT = 500
const DAY_MS = 86400000

/**
 * Build the id index, and decide whether it can answer "no such id exists".
 *
 * `complete` is deliberately conservative and is the hinge of the whole tool: a
 * snapshot that declares `idIndex: "complete"` while also listing a shadow root
 * it could not traverse is contradicting itself, and the unreadable subtree
 * wins. Dropping a record -- a malformed field, an ambiguous duplicate id --
 * has the same effect, because the index no longer holds everything the form
 * holds.
 */
export function buildIndex(snapshot, file, findings) {
  const byId = new Map()
  const duplicated = new Set()
  const fields = []
  const nodes = []
  const reasons = []

  for (const [index, raw] of snapshot.rawFields.entries()) {
    const read = readField(raw)
    if (!read.ok) {
      findings.push(makeFinding(
        'field-invalid',
        msg`Field record ${num(index)} was not read: ${read.reason}. Nothing about that field was checked.`,
        at(file, pointerFor('fields', String(index))),
        { suggestion: 'Correct the field record, or leave it out of the snapshot deliberately.' },
      ))
      reasons.push('a field record could not be read')
      continue
    }
    fields.push(read.field)
  }

  for (const [index, raw] of snapshot.rawNodes.entries()) {
    const read = readNode(raw)
    if (!read.ok) {
      findings.push(makeFinding(
        'node-invalid',
        msg`Node record ${num(index)} was not read: ${read.reason}. Any reference to it was left unresolved.`,
        at(file, pointerFor('nodes', String(index))),
        { suggestion: 'Correct the node record, or leave it out of the snapshot deliberately.' },
      ))
      reasons.push('a node record could not be read')
      continue
    }
    nodes.push(read.node)
  }

  for (const entry of [
    ...fields.map((field) => ({ kind: 'field', id: field.id, value: field })),
    ...nodes.map((node) => ({ kind: 'node', id: node.id, value: node })),
  ]) {
    if (byId.has(entry.id) || duplicated.has(entry.id)) {
      duplicated.add(entry.id)
      byId.delete(entry.id)
      continue
    }
    byId.set(entry.id, entry)
  }

  for (const ambiguous of [...duplicated].sort(byCodeUnit)) {
    findings.push(makeFinding(
      'duplicate-node-id',
      msg`The id ${ambiguous} is declared more than once, so a reference to it names two different things and neither was used.`,
      at(file, pointerFor('nodes', ambiguous)),
      { suggestion: 'Give every element in the snapshot a unique id, as the document itself must.' },
    ))
    reasons.push('an id is declared more than once')
  }

  for (const region of [...snapshot.unreadableRegions].sort((a, b) => byCodeUnit(a.hostId, b.hostId))) {
    findings.push(makeFinding(
      'subtree-not-captured',
      msg`The subtree under ${region.hostId} was not captured (${region.reason}), so anything the form keeps in it is outside this evidence.`,
      at(file, pointerFor('unreadableRegions', region.hostId)),
      {
        evidence: `reason: ${region.reason}`,
        suggestion: 'Export the subtree as part of the snapshot, or accept that this run establishes nothing about it.',
      },
    ))
    reasons.push(`the subtree under ${region.hostId} was not captured`)
  }

  const declaredPartial = snapshot.capture.idIndex === 'partial'
  if (declaredPartial) reasons.push('the snapshot declares "idIndex": "partial"')
  const complete = !declaredPartial && reasons.length === 0

  if (!complete) {
    findings.push(makeFinding(
      'index-incomplete',
      msg`The id index does not hold every id this form has, so an id that is not in it was not treated as an id the form does not have.`,
      at(file, pointerFor('capture', 'idIndex')),
      {
        evidence: [...new Set(reasons)].sort(byCodeUnit).join('; '),
        suggestion: 'Export a snapshot whose id index is complete to have unresolved references judged as defects.',
      },
    ))
  }

  return { byId, fields, nodes, complete }
}

/**
 * Look one id up.
 *
 * Returns the entry when it is known, `undefined` when the index cannot say,
 * and `null` when the index is complete and the id genuinely is not there. The
 * three-way answer is the point: a caller that treats `undefined` as `null`
 * turns a gap in the evidence into an assertion about the form.
 */
export function resolveReference(index, ref, where, findings, what) {
  const hit = index.byId.get(ref)
  if (hit !== undefined) return hit
  if (!index.complete) {
    findings.push(makeFinding(
      'reference-unresolved',
      msg`${what} names ${ref}, which is not in the snapshot; because the id index is incomplete this was not treated as a broken reference, and the association was not established either way.`,
      where,
      { suggestion: 'Export a complete id index, or capture the subtree that holds this id.' },
    ))
    return undefined
  }
  findings.push(makeFinding(
    'reference-broken',
    msg`${what} names ${ref}, which the snapshot does not declare anywhere, so the reference points at nothing.`,
    where,
    { suggestion: 'Correct the id, or remove the reference.' },
  ))
  return null
}

/** Staleness of the snapshot itself. Both outcomes mark the run incomplete. */
export function ageChecks(snapshot, policy, file, now, findings) {
  if (policy.maxSnapshotAgeDays === null) return
  const where = at(file, pointerFor('capture', 'capturedAt'))
  const captured = parseInstant(snapshot.capture.capturedAt)
  if (!captured.ok) {
    findings.push(makeFinding(
      'snapshot-age-unknown',
      msg`The expectations set maxSnapshotAgeDays but the snapshot records no usable "capture.capturedAt", so its age could not be established.`,
      where,
      { suggestion: 'Record capturedAt as YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ, or drop maxSnapshotAgeDays.' },
    ))
    return
  }
  const ageDays = Math.floor((now - captured.ms) / DAY_MS)
  if (ageDays > policy.maxSnapshotAgeDays) {
    findings.push(makeFinding(
      'snapshot-stale',
      msg`The snapshot is ${num(ageDays)} day(s) old, past the ${num(policy.maxSnapshotAgeDays)} day(s) the expectations allow, so it may not describe the form as it is now.`,
      where,
      { suggestion: 'Export a current snapshot, or raise maxSnapshotAgeDays deliberately.' },
    ))
  }
}

function checkLabel(field, index, file, findings) {
  const where = at(file, pointerFor('fields', field.id))
  if (!field.labellingCaptured) {
    findings.push(makeFinding(
      'label-evidence-missing',
      msg`Field ${field.id} records no "labelling" object, so whether it has a label was not established. An unrecorded label is not an absent one.`,
      where,
      { suggestion: 'Record labelling with labelFor, ariaLabelledby, ariaLabel and wrappingLabel, using null where an attribute was absent.' },
    ))
    return
  }

  const labelling = field.labelling
  const refs = [...labelling.ariaLabelledby]
  if (labelling.labelFor !== null) refs.push(labelling.labelFor)

  let resolved = 0
  let unknown = 0
  for (const ref of [...new Set(refs)].sort(byCodeUnit)) {
    const hit = resolveReference(index, ref, where, findings, `The labelling of field ${field.id}`)
    if (hit === undefined) unknown += 1
    else if (hit !== null) resolved += 1
  }

  // `isRenderableString` rather than a length or a trim: an aria-label of
  // U+200E or U+0001 survives `trim()` and then says nothing at all.
  const named = labelling.wrappingLabel || resolved > 0 || isRenderableString(labelling.ariaLabel, MAX_MESSAGE_TEXT)
  if (named) return
  // A field whose only labelling references could not be resolved is not a
  // field with no label -- it is a field whose label was not established, and
  // `reference-unresolved` has already said so.
  if (unknown > 0) return
  findings.push(makeFinding(
    'field-not-labelled',
    msg`Field ${field.id} records no label at all: no wrapping label, no label element pointing at it, no resolved aria-labelledby and no aria-label that would show any text.`,
    where,
    { suggestion: 'Give the control a label element, an aria-labelledby that resolves, or a non-empty aria-label.' },
  ))
}

function checkStateField({ state, field, record, index, policy, file, findings }) {
  const where = at(file, pointerFor('states', state.name, 'fields', field.id))
  const referenced = new Set(record.describedby)
  if (record.errormessage !== null) referenced.add(record.errormessage)

  const considered = new Set(referenced)
  if (record.declaredError !== null) considered.add(record.declaredError)

  const resolved = new Map()
  for (const ref of [...considered].sort(byCodeUnit)) {
    resolved.set(ref, resolveReference(index, ref, where, findings, `Field ${field.id} in state ${state.name}`))
  }

  for (const ref of [...considered].sort(byCodeUnit)) {
    const hit = resolved.get(ref)
    if (hit === undefined || hit === null) continue
    if (hit.kind !== 'node' || hit.value.kind !== 'message') {
      if (ref === record.declaredError) {
        findings.push(makeFinding(
          'error-association-wrong',
          msg`State ${state.name} declares ${ref} as the error for field ${field.id}, but the snapshot records that id as a ${hit.kind === 'field' ? 'form field' : hit.value.kind} rather than a message.`,
          where,
          { suggestion: 'Point declaredError at the message node that carries the error text.' },
        ))
      }
      continue
    }
    if (hit.value.belongsTo !== field.id) {
      findings.push(makeFinding(
        'error-association-wrong',
        msg`Field ${field.id} is associated in state ${state.name} with the message ${ref}, which the snapshot records as belonging to field ${hit.value.belongsTo}.`,
        where,
        {
          evidence: `belongsTo: ${hit.value.belongsTo}`,
          suggestion: 'Associate each field with the message written about that field.',
        },
      ))
    }
  }

  if (record.declaredError !== null) {
    if (!referenced.has(record.declaredError)) {
      findings.push(makeFinding(
        'error-not-associated',
        msg`State ${state.name} declares the error ${record.declaredError} for field ${field.id}, but neither aria-describedby nor aria-errormessage on that field names it.`,
        where,
        { suggestion: 'Add the message id to aria-describedby, or to aria-errormessage alongside aria-invalid.' },
      ))
    }
    const hit = resolved.get(record.declaredError)
    if (hit !== undefined && hit !== null && hit.kind === 'node' && hit.value.kind === 'message') {
      const node = hit.value
      if (!node.textCaptured) {
        findings.push(makeFinding(
          'message-text-not-captured',
          msg`The message ${node.id} records no "text", so whether it would show anything was not established.`,
          at(file, pointerFor('nodes', node.id)),
          { suggestion: 'Record the message text, using null when the element was empty.' },
        ))
      } else if (!isRenderableString(node.text, MAX_MESSAGE_TEXT)) {
        // Not a length check: a message of bidi controls or C1 characters has a
        // non-zero length, survives trim(), and shows nothing.
        findings.push(makeFinding(
          'error-message-empty',
          msg`The message ${node.id}, declared as the error for field ${field.id} in state ${state.name}, would show no text at all.`,
          at(file, pointerFor('nodes', node.id)),
          { suggestion: 'Put the error text in the message element, or stop pointing at it as the error.' },
        ))
      }
    }
    if (state.visible !== null && !state.visible.has(record.declaredError)) {
      findings.push(makeFinding(
        'error-message-not-visible',
        msg`State ${state.name} declares the error ${record.declaredError} for field ${field.id}, but that message is not among the messages the state records as present.`,
        where,
        { suggestion: 'Record the message in visibleMessages, or stop declaring an error that is not shown.' },
      ))
    }
    if (policy.requireAriaInvalid) {
      if (!record.ariaInvalidCaptured) {
        findings.push(makeFinding(
          'aria-invalid-not-captured',
          msg`State ${state.name} declares an error for field ${field.id} but records no "ariaInvalid" key, so whether the field was marked invalid was not established.`,
          where,
          { suggestion: 'Record ariaInvalid, using null when the attribute was absent.' },
        ))
      } else if (record.ariaInvalid !== 'true') {
        findings.push(makeFinding(
          'invalid-not-exposed',
          msg`State ${state.name} declares an error for field ${field.id}, but the field records aria-invalid as ${record.ariaInvalid === null ? 'absent' : record.ariaInvalid}.`,
          where,
          { suggestion: 'Set aria-invalid="true" on the control while the error stands.' },
        ))
      }
    }
    return
  }

  // No error is declared for this field in this state, so nothing left over
  // from an earlier one may still be marking it.
  //
  // Whether the key was recorded is asked FIRST, and it is not governed by
  // `requireAriaInvalid`. That flag decides whether a field in error has to
  // expose itself as invalid; it says nothing about whether a field NOT in
  // error may still be marked as one. Skipping the question when the key is
  // absent was a real defect here: a state that recorded no `ariaInvalid`
  // reported `pass`, which is the tool narrowing what it checked rather than
  // saying it could not check it.
  if (!record.ariaInvalidCaptured) {
    findings.push(makeFinding(
      'aria-invalid-not-captured',
      msg`State ${state.name} declares no error for field ${field.id} but records no "ariaInvalid" key, so whether an earlier error state was cleared from the field was not established.`,
      where,
      { suggestion: 'Record ariaInvalid in every state, using null when the attribute was absent.' },
    ))
  } else if (record.ariaInvalid === 'true') {
    findings.push(makeFinding(
      'stale-error-state',
      msg`State ${state.name} declares no error for field ${field.id}, but the field is still marked aria-invalid="true".`,
      where,
      { suggestion: 'Clear aria-invalid when the value becomes acceptable.' },
    ))
  }
  if (state.visible !== null) {
    for (const nodeId of [...state.visible].sort(byCodeUnit)) {
      const hit = index.byId.get(nodeId)
      if (hit === undefined || hit.kind !== 'node') continue
      if (hit.value.kind !== 'message' || hit.value.belongsTo !== field.id) continue
      findings.push(makeFinding(
        'stale-error-message',
        msg`State ${state.name} declares no error for field ${field.id}, but the message ${nodeId} written about that field is still recorded as present.`,
        where,
        {
          evidence: `belongsTo: ${field.id}`,
          suggestion: 'Remove or hide the error message when the value becomes acceptable.',
        },
      ))
    }
  }
}

function checkSummary({ state, errored, index, policy, file, findings }) {
  const where = at(file, pointerFor('states', state.name, 'summary'))

  if (!state.summaryCaptured) {
    if (policy.requireErrorSummary && errored.length > 0) {
      findings.push(makeFinding(
        'summary-not-captured',
        msg`State ${state.name} holds ${num(errored.length)} field(s) in error and records no "summary" key, so whether an error summary exists was not established. Use null to record that there is none.`,
        where,
        { suggestion: 'Record summary as null when the state has no summary block, or as the block that was there.' },
      ))
    }
    return
  }

  if (state.summary === null) {
    if (policy.requireErrorSummary && errored.length > 0) {
      findings.push(makeFinding(
        'summary-absent',
        msg`State ${state.name} holds ${num(errored.length)} field(s) in error and records no error summary, which these expectations require.`,
        where,
        { suggestion: 'Add an error summary listing each field in error, or set requireErrorSummary to false deliberately.' },
      ))
    }
    return
  }

  // The summary key was present but the block could not be read; `state-invalid`
  // has already said so, and nothing is concluded from a block nobody parsed.
  if (state.summary === undefined) return

  const erroredIds = new Set(errored.map((entry) => entry.id))
  const recordedIds = new Set(state.records.keys())
  const targets = [...new Set(state.summary.links.map((link) => link.target))].sort(byCodeUnit)

  for (const target of targets) {
    const hit = resolveReference(index, target, where, findings, `The summary in state ${state.name}`)
    if (hit !== undefined && hit !== null && hit.kind !== 'field') {
      findings.push(makeFinding(
        'summary-link-not-a-field',
        msg`The summary in state ${state.name} links to ${target}, which the snapshot records as a ${hit.value.kind} node rather than a form field.`,
        where,
        { suggestion: 'Point each summary link at the control the reader has to correct.' },
      ))
      continue
    }
    if (erroredIds.has(target) || !recordedIds.has(target)) continue
    findings.push(makeFinding(
      'stale-summary-link',
      msg`The summary in state ${state.name} still links to field ${target}, which that state declares no error for.`,
      where,
      { suggestion: 'Rebuild the summary from the errors that remain after each submission.' },
    ))
  }

  const linked = new Set(targets)
  for (const entry of errored) {
    if (linked.has(entry.id)) continue
    findings.push(makeFinding(
      'summary-missing-error',
      msg`Field ${entry.id} is in error in state ${state.name}, but the summary links to ${num(targets.length)} target(s) and none of them is that field.`,
      where,
      { suggestion: 'List every field in error in the summary.' },
    ))
  }
}

function checkFocus({ state, errored, policy, file, findings }) {
  if (!state.submitted || errored.length === 0) return
  const where = at(file, pointerFor('states', state.name, 'focus'))

  if (!state.focusCaptured) {
    findings.push(makeFinding(
      'focus-not-captured',
      msg`State ${state.name} is recorded as submitted with ${num(errored.length)} field(s) in error but records no "focus" key, so where focus went was not established.`,
      where,
      { suggestion: 'Record focus as the id that held focus after the submission, or null when nothing did.' },
    ))
    return
  }

  const allowed = new Map()
  for (const target of policy.focusAfterSubmit) {
    if (target === 'summary' && state.summary !== null && state.summary !== undefined) {
      allowed.set(state.summary.id, 'summary')
    }
    if (target === 'first-invalid-field') allowed.set(errored[0].id, 'first-invalid-field')
    if (target === 'first-error-message' && errored[0].declaredError !== null) {
      allowed.set(errored[0].declaredError, 'first-error-message')
    }
  }

  if (allowed.size === 0) {
    findings.push(makeFinding(
      'focus-not-captured',
      msg`State ${state.name} records focus, but none of the targets these expectations permit could be identified in this state, so focus recovery was not established.`,
      where,
      {
        evidence: `permitted: ${policy.focusAfterSubmit.join(', ')}`,
        suggestion: 'Record the summary block for this state, or permit a focus target the state identifies.',
      },
    ))
    return
  }

  if (state.focus !== null && allowed.has(state.focus)) return
  findings.push(makeFinding(
    'focus-not-recovered',
    msg`State ${state.name} records focus on ${state.focus === null ? 'nothing' : state.focus} after a submission that produced ${num(errored.length)} error(s).`,
    where,
    {
      evidence: `permitted ids: ${[...allowed.keys()].sort(byCodeUnit).join(', ')}`,
      suggestion: 'Move focus to one of the permitted targets when a submission fails.',
    },
  ))
}

/**
 * Asynchronous validation.
 *
 * A field the snapshot declares asynchronously validated has to be recorded
 * both while the check is in flight and after it settles. A snapshot that stops
 * at the pending state establishes nothing about the error that followed, so it
 * makes the run incomplete rather than passing on the half it holds.
 */
function checkAsync({ field, states, file, findings }) {
  const where = at(file, pointerFor('fields', field.id))
  const pendingAt = []
  const settledAt = []
  for (const state of states) {
    const record = state.records.get(field.id)
    if (record === undefined) continue
    if (record.pending) pendingAt.push(state.index)
    else settledAt.push(state.index)
  }

  if (field.asyncValidated) {
    if (pendingAt.length === 0) {
      findings.push(makeFinding(
        'async-states-not-captured',
        msg`Field ${field.id} is declared asynchronously validated, but no state records it as pending, so the in-flight behaviour was not established.`,
        where,
        { suggestion: 'Record a state while the asynchronous check is in flight, or drop asyncValidated.' },
      ))
    } else {
      const last = pendingAt[pendingAt.length - 1]
      if (!settledAt.some((index) => index > last)) {
        findings.push(makeFinding(
          'async-outcome-not-captured',
          msg`Field ${field.id} is recorded as pending in state ${states[last].name} and no later state records it settled, so the outcome of the asynchronous check was not established.`,
          where,
          { suggestion: 'Record the state after the asynchronous check settles, whatever it decided.' },
        ))
      }
    }
  }

  for (const state of states) {
    const record = state.records.get(field.id)
    if (record === undefined || !record.pending) continue
    const stateWhere = at(file, pointerFor('states', state.name, 'fields', field.id))
    if (!record.ariaBusyCaptured) {
      findings.push(makeFinding(
        'async-busy-not-captured',
        msg`Field ${field.id} is pending in state ${state.name} but the state records no "ariaBusy" key, so whether the wait was exposed at all was not established.`,
        stateWhere,
        { suggestion: 'Record ariaBusy, using null when the attribute was absent.' },
      ))
    } else if (record.ariaBusy !== 'true') {
      findings.push(makeFinding(
        'async-pending-not-exposed',
        msg`Field ${field.id} is pending in state ${state.name} but records aria-busy as ${record.ariaBusy === null ? 'absent' : record.ariaBusy}, so nothing in the markup says a check is still running.`,
        stateWhere,
        { suggestion: 'Set aria-busy="true" on the control, or its wrapper, while the asynchronous check runs.' },
      ))
    }
  }
}

/**
 * Check one snapshot against one set of expectations.
 *
 * `now` is a parameter. A verdict that depends on an unrecorded clock reading
 * is not reproducible, and a staleness limit that no test can reach is a
 * documented limit that is never enforced.
 */
export function checkSnapshot({ snapshot, policy, file, now }) {
  const findings = []
  const counts = { checked: 0, fields: 0, states: 0, nodes: 0 }

  if (snapshot.capture.source !== SUPPORTED_SOURCE) {
    findings.push(makeFinding(
      'capture-source-unsupported',
      msg`The capture declares its source as ${snapshot.capture.source === undefined ? 'nothing at all' : snapshot.capture.source}. The rules here are written about markup attributes and the relationships between elements, so only a ${SUPPORTED_SOURCE} is checked; other evidence was not reinterpreted as one.`,
      at(file, pointerFor('capture', 'source')),
      { suggestion: `Export the evidence as a "${SUPPORTED_SOURCE}", or check it with a tool written for the evidence you have.` },
    ))
    return { findings, counts }
  }

  ageChecks(snapshot, policy, file, now, findings)

  const over = [
    ['field-limit-exceeded', snapshot.rawFields.length, policy.limits.maxFields, 'field', 'maxFields'],
    ['node-limit-exceeded', snapshot.rawNodes.length, policy.limits.maxNodes, 'node', 'maxNodes'],
    ['state-limit-exceeded', snapshot.states.length, policy.limits.maxStates, 'state', 'maxStates'],
  ].find(([, seen, limit]) => seen > limit)
  if (over !== undefined) {
    const [ruleId, seen, limit, what, limitName] = over
    findings.push(makeFinding(
      ruleId,
      msg`The snapshot holds ${num(seen)} ${what} record(s), over the limit of ${num(limit)}; nothing was checked.`,
      at(file, pointerFor(`${what}s`)),
      { suggestion: `Raise limits.${limitName} deliberately, or split the snapshot.` },
    ))
    return { findings, counts }
  }

  const index = buildIndex(snapshot, file, findings)
  counts.fields = index.fields.length
  counts.nodes = index.nodes.length
  counts.states = snapshot.states.length

  for (const field of index.fields) checkLabel(field, index, file, findings)

  for (const state of snapshot.states) {
    state.records = new Map()
    state.ambiguous = new Set()
    state.visible = null
    state.summary = undefined

    if (!state.visibleCaptured) {
      findings.push(makeFinding(
        'visible-messages-not-captured',
        msg`State ${state.name} records no "visibleMessages" key, so which messages were present in it was not established.`,
        at(file, pointerFor('states', state.name)),
        { suggestion: 'Record visibleMessages as the ids of the message elements present, using [] when there were none.' },
      ))
    } else if (!Array.isArray(state.rawVisible) || state.rawVisible.some((entry) => typeof entry !== 'string')) {
      findings.push(makeFinding(
        'state-invalid',
        msg`State ${state.name} records "visibleMessages" as something other than an array of ids, so which messages were present was not established.`,
        at(file, pointerFor('states', state.name)),
        { suggestion: 'Record visibleMessages as an array of element ids.' },
      ))
    } else {
      state.visible = new Set(state.rawVisible)
    }

    if (state.focusCaptured && state.focus !== null && typeof state.focus !== 'string') {
      findings.push(makeFinding(
        'state-invalid',
        msg`State ${state.name} records "focus" as something other than an id or null.`,
        at(file, pointerFor('states', state.name, 'focus')),
        { suggestion: 'Record focus as the id that held focus, or null when nothing did.' },
      ))
      state.focusCaptured = false
    }

    const declaredIds = new Set(index.fields.map((field) => field.id))
    for (const [position, raw] of state.rawFields.entries()) {
      const read = readStateField(raw)
      if (!read.ok) {
        findings.push(makeFinding(
          'field-invalid',
          msg`State ${state.name} record ${num(position)} was not read: ${read.reason}. Nothing about that field was checked in this state.`,
          at(file, pointerFor('states', state.name, 'fields', String(position))),
          { suggestion: 'Correct the record. Every documented key is required; use null for an attribute that was absent.' },
        ))
        continue
      }
      if (!declaredIds.has(read.record.id)) {
        findings.push(makeFinding(
          'field-invalid',
          msg`State ${state.name} records a field ${read.record.id} that the snapshot does not declare in "fields", so there is nothing to check it against.`,
          at(file, pointerFor('states', state.name, 'fields', read.record.id)),
          { suggestion: 'Declare every field the states record, or remove the stray record.' },
        ))
        continue
      }
      if (state.ambiguous.has(read.record.id)) continue
      if (state.records.has(read.record.id)) {
        findings.push(makeFinding(
          'duplicate-node-id',
          msg`State ${state.name} records field ${read.record.id} more than once, so which record describes it is ambiguous and neither was used.`,
          at(file, pointerFor('states', state.name, 'fields', read.record.id)),
          { suggestion: 'Record each field once per state.' },
        ))
        state.records.delete(read.record.id)
        state.ambiguous.add(read.record.id)
        continue
      }
      state.records.set(read.record.id, read.record)
    }

    if (state.summaryCaptured) {
      if (state.rawSummary === null) {
        state.summary = null
      } else {
        const read = readSummary(state.rawSummary)
        if (!read.ok) {
          findings.push(makeFinding(
            'state-invalid',
            msg`The summary in state ${state.name} was not read: ${read.reason}.`,
            at(file, pointerFor('states', state.name, 'summary')),
            { suggestion: 'Record the summary as an object with an id and a links array, or as null when there is none.' },
          ))
        } else {
          state.summary = read.summary
        }
      }
    }
  }

  for (const state of snapshot.states) {
    for (const field of index.fields) {
      const record = state.records.get(field.id)
      if (record === undefined) {
        findings.push(makeFinding(
          'state-field-not-recorded',
          msg`State ${state.name} records nothing about field ${field.id}, so that state establishes nothing about it -- including whether an earlier error was cleared.`,
          at(file, pointerFor('states', state.name, 'fields', field.id)),
          { suggestion: 'Record every declared field in every state, even when nothing about it changed.' },
        ))
        continue
      }
      checkStateField({ state, field, record, index, policy, file, findings })
      counts.checked += 1
    }

    const errored = index.fields
      .map((field) => state.records.get(field.id))
      .filter((record) => record !== undefined && record.declaredError !== null)
    checkSummary({ state, errored, index, policy, file, findings })
    checkFocus({ state, errored, policy, file, findings })
  }

  for (const field of index.fields) checkAsync({ field, states: snapshot.states, file, findings })

  if (counts.checked === 0) {
    findings.push(makeFinding(
      'no-fields-checked',
      msg`No field was checked in any state, so there is no evidence to pass or fail on.`,
      at(file, pointerFor('states')),
      { suggestion: 'Supply a snapshot that declares at least one field and records it in at least one state.' },
    ))
  }

  return { findings, counts }
}
