#!/usr/bin/env node

import { ConfigError, checkForm, exitCodeFor, formatSummary, parseInstant, renderReport, sanitize } from '../src/index.mjs'

const HELP = `accessible-form-error-checker

Check form labels, error associations, summary links, focus recovery and
asynchronous validation in an exported DOM snapshot, against an expectations
document.

This tool reads evidence. It opens no browser, resolves no host, submits no form
and writes no file. It does not emulate assistive technology and it computes no
accessible name: it reports the associations the exported markup records, and
what a person using a screen reader would actually be told is not established by
this run.

A reference the snapshot cannot resolve is judged a broken reference only when
the snapshot declares a complete id index and lists no subtree it failed to
capture. A shadow root or a cross-origin frame the exporter could not traverse
makes the same reference a gap, not a defect, and the run incomplete.

Usage:
  accessible-form-error-checker --snapshot FILE --expectations FILE [--now INSTANT] [--json]

Options:
  --snapshot FILE      DOM snapshot document to check (required)
  --expectations FILE  Expectations document: the policy (required)
  --now INSTANT        Treat this instant as the present when applying the
                       expectations' maxSnapshotAgeDays, as YYYY-MM-DD or
                       YYYY-MM-DDTHH:MM:SSZ. Defaults to the system clock.
                       Supply it to make a run that checks snapshot age
                       reproducible.
  --json               Suppress the human summary on stderr
  -h, --help           Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every declared field was checked in every state and the expectations held
  1  the check completed and the form broke an expectation
  2  invalid configuration, or evidence the check could not obtain. A label that
     was never captured, a reference into a subtree the exporter could not read,
     an asynchronous check whose outcome was not recorded, a state that says
     nothing about a declared field, a snapshot older than the expectations
     allow -- all land here, and none of them is ever reported as an absence of
     a problem.
     On a configuration error -- including any problem with the expectations
     document, which is the policy -- stdout stays EMPTY and the message goes to
     stderr. On unreadable or incomplete evidence stdout carries an "incomplete"
     report naming what was not established.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { snapshot: null, expectations: null, now: undefined, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--snapshot') options.snapshot = takeValue('--snapshot')
    else if (argument === '--expectations') options.expectations = takeValue('--expectations')
    else if (argument === '--now') {
      const raw = takeValue('--now')
      const instant = parseInstant(raw)
      if (!instant.ok) throw new Error('--now requires YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ')
      options.now = instant.ms
    // The option text is argv, which this tool did not write either: a newline
    // or a bidi control in it would forge lines in the diagnostic below just as
    // one in the expectations document would.
    } else throw new Error(`Unknown option "${sanitize(argument, 64)}"`)
  }

  if (options.snapshot === null) throw new Error('--snapshot is required')
  if (options.expectations === null) throw new Error('--expectations is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await checkForm({
      snapshot: options.snapshot,
      expectations: options.expectations,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  } catch (error) {
    // A ConfigError means the run never had a subject: stdout stays empty, by
    // the contract. Anything else escaping here is a defect in this tool, and
    // it is reported the same way rather than as a report about the form.
    process.stderr.write(`${error instanceof ConfigError ? error.message : `Execution failure: ${error.message}`}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
