#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

function toPosixPath(value) {
  return value.split(path.sep).join('/')
}

function printUsage() {
  console.error(
    'Usage: node scripts/nextjs-suite-status.mjs <nextjs-dir> [output-json-path]'
  )
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function walk(dir, matcher, results = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      await walk(entryPath, matcher, results)
      continue
    }

    if (entry.isFile() && matcher(entryPath)) {
      results.push(entryPath)
    }
  }

  return results
}

async function loadExistingSnapshot(outputPath) {
  if (!(await pathExists(outputPath))) {
    return {}
  }

  try {
    const existing = JSON.parse(await fs.readFile(outputPath, 'utf8'))
    return existing?.suites && typeof existing.suites === 'object' ? existing.suites : {}
  } catch {
    return {}
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Command failed with code ${code}: ${command} ${args.join(' ')}\n${stderr || stdout}`
          )
        )
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function parseSuiteList(stdout) {
  const lines = stdout.split(/\r?\n/)
  const startIndex = lines.findIndex((line) => line.trim() === 'Running tests:')

  if (startIndex === -1) {
    throw new Error('Could not find "Running tests:" in run-tests output')
  }

  const suites = []

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()

    if (!line) {
      continue
    }

    if (line.startsWith('total:')) {
      break
    }

    suites.push(line)
  }

  return suites
}

async function collectSuites(nextjsDir) {
  const { stdout } = await runCommand(
    'node',
    ['run-tests.js', '--type', 'e2e', '--dry', '--print-tests'],
    {
      cwd: nextjsDir,
      env: {
        ...process.env,
        NEXT_TEST_MODE: process.env.NEXT_TEST_MODE || 'deploy',
        NEXT_EXTERNAL_TESTS_FILTERS:
          process.env.NEXT_EXTERNAL_TESTS_FILTERS || 'test/deploy-tests-manifest.json',
        IS_TURBOPACK_TEST: process.env.IS_TURBOPACK_TEST || '1',
        NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED || '1',
      },
    }
  )

  return parseSuiteList(stdout)
}

async function collectResultFiles(nextjsDir) {
  const testDir = path.join(nextjsDir, 'test')
  return walk(testDir, (entryPath) => entryPath.endsWith('.results.json'))
}

async function buildSnapshot(nextjsDir, outputPath) {
  const orderedSuites = await collectSuites(nextjsDir)
  const existingSuites = await loadExistingSnapshot(outputPath)
  const resultFiles = await collectResultFiles(nextjsDir)
  const suites = {}

  for (const suite of orderedSuites) {
    suites[suite] = {
      status: 'unrun',
      ...(existingSuites[suite] ?? {}),
      suite,
    }
  }

  for (const resultFile of resultFiles) {
    const relativeResultPath = toPosixPath(path.relative(nextjsDir, resultFile))
    const suitePath = relativeResultPath.replace(/\.results\.json$/, '')

    if (!suites[suitePath]) {
      continue
    }

    let parsed

    try {
      parsed = JSON.parse(await fs.readFile(resultFile, 'utf8'))
    } catch {
      continue
    }

    const stats = await fs.stat(resultFile)

    suites[suitePath] = {
      ...suites[suitePath],
      status: parsed.success ? 'passed' : 'failed',
      success: Boolean(parsed.success),
      resultFile: relativeResultPath,
      resultUpdatedAt: stats.mtime.toISOString(),
      numPassedTests: parsed.numPassedTests ?? 0,
      numFailedTests: parsed.numFailedTests ?? 0,
      numPendingTests: parsed.numPendingTests ?? 0,
      numTotalTests: parsed.numTotalTests ?? 0,
      numFailedTestSuites: parsed.numFailedTestSuites ?? 0,
    }
  }

  for (const suite of orderedSuites) {
    const existingSuite = suites[suite]

    if (!existingSuite || existingSuite.status !== 'unrun') {
      continue
    }

    if (!existingSuite.lastFinishedAt || typeof existingSuite.exitCode !== 'number') {
      continue
    }

    suites[suite] = {
      ...existingSuite,
      status: existingSuite.exitCode === 0 ? 'passed' : 'failed',
      success: existingSuite.exitCode === 0,
    }
  }

  const counts = {
    total: orderedSuites.length,
    passed: 0,
    failed: 0,
    unrun: 0,
  }

  for (const suite of orderedSuites) {
    const status = suites[suite]?.status || 'unrun'
    counts[status] += 1
  }

  return {
    generatedAt: new Date().toISOString(),
    nextjsDir,
    counts,
    orderedSuites,
    suites,
  }
}

async function main() {
  const nextjsDirArg = process.argv[2]
  const outputPathArg = process.argv[3]

  if (!nextjsDirArg) {
    printUsage()
    process.exitCode = 1
    return
  }

  const nextjsDir = path.resolve(nextjsDirArg)
  const outputPath = path.resolve(
    outputPathArg || path.join(process.cwd(), 'reports', 'nextjs-adapter-suite-status.json')
  )

  if (!(await pathExists(path.join(nextjsDir, 'run-tests.js')))) {
    throw new Error(`Could not find run-tests.js in ${nextjsDir}`)
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const snapshot = await buildSnapshot(nextjsDir, outputPath)
  await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2) + '\n')

  console.log(`Wrote ${outputPath}`)
  console.log(
    JSON.stringify(
      {
        nextjsDir: snapshot.nextjsDir,
        counts: snapshot.counts,
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
