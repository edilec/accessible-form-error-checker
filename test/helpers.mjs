import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { checkForm } from '../src/index.mjs'

const run = promisify(execFile)

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const BIN = join(ROOT, 'bin', 'accessible-form-error-checker.mjs')
export const NOW = Date.UTC(2026, 8, 18)

/**
 * The clean example is the base fixture for almost every test.
 *
 * Reading it rather than repeating it here means every test also proves the
 * shipped example still parses, and a change to the documented shape cannot
 * leave the example behind.
 */
export async function cleanSnapshot() {
  return JSON.parse(await readFile(join(ROOT, 'examples', 'clean', 'snapshot.json'), 'utf8'))
}

export async function cleanExpectations() {
  return JSON.parse(await readFile(join(ROOT, 'examples', 'clean', 'expectations.json'), 'utf8'))
}

export function stateNamed(snapshot, name) {
  const state = snapshot.states.find((entry) => entry.name === name)
  if (state === undefined) throw new Error(`no state named ${name}`)
  return state
}

export function fieldIn(state, id) {
  const record = state.fields.find((entry) => entry.id === id)
  if (record === undefined) throw new Error(`no field ${id} in state ${state.name}`)
  return record
}

async function writeInputs(snapshot, expectations) {
  const directory = await mkdtemp(join(tmpdir(), 'afec-'))
  const snapshotPath = join(directory, 'snapshot.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(
    snapshotPath,
    typeof snapshot === 'string' ? snapshot : `${JSON.stringify(snapshot, null, 2)}\n`,
  )
  await writeFile(
    expectationsPath,
    typeof expectations === 'string' ? expectations : `${JSON.stringify(expectations, null, 2)}\n`,
  )
  return { directory, snapshotPath, expectationsPath }
}

/** Build a snapshot from the clean example with `mutate` applied, then check it. */
export async function checkMutated(mutate, { expectations: mutateExpectations = null, now = NOW } = {}) {
  const snapshot = await cleanSnapshot()
  const expectations = await cleanExpectations()
  if (mutate !== null) mutate(snapshot)
  if (mutateExpectations !== null) mutateExpectations(expectations)
  const { snapshotPath, expectationsPath } = await writeInputs(snapshot, expectations)
  return checkForm({ snapshot: snapshotPath, expectations: expectationsPath, now })
}

/** Run the real CLI, so exit codes and stream discipline are observed, not asserted about. */
export async function runCli(snapshot, expectations, extra = ['--now', '2026-09-18']) {
  const { snapshotPath, expectationsPath } = await writeInputs(snapshot, expectations)
  const argv = ['--snapshot', snapshotPath, '--expectations', expectationsPath, ...extra]
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...argv], { encoding: 'utf8' })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

export async function runCliRaw(argv) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...argv], { encoding: 'utf8' })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}
