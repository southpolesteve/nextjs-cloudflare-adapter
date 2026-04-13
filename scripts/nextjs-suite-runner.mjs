#!/usr/bin/env node

import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'

function printUsage() {
  console.error(
    'Usage: node scripts/nextjs-suite-runner.mjs <nextjs-dir> [status-json-path] [suite-path]'
  )
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio || 'inherit',
    })

    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function main() {
  const nextjsDirArg = process.argv[2]
  const statusPathArg = process.argv[3]
  const suitePathArg = process.argv[4]

  if (!nextjsDirArg) {
    printUsage()
    process.exitCode = 1
    return
  }

  const repoDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const nextjsDir = path.resolve(nextjsDirArg)
  const statusPath = path.resolve(
    statusPathArg || path.join(repoDir, 'reports', 'nextjs-adapter-suite-status.json')
  )

  const status = JSON.parse(await fs.readFile(statusPath, 'utf8'))
  const suitePath =
    suitePathArg ||
    status.orderedSuites.find((suite) => status.suites?.[suite]?.status === 'unrun')

  if (!suitePath) {
    console.log('No unrun suites remain in the status file.')
    return
  }

  console.log(`Running suite: ${suitePath}`)

  const testExitCode = await runCommand(
    'npm',
    ['run', 'test:nextjs:local', '--', nextjsDir, suitePath],
    {
      cwd: repoDir,
      env: process.env,
      stdio: 'inherit',
    }
  )

  const statusExitCode = await runCommand(
    'npm',
    ['run', 'test:nextjs:status', '--', nextjsDir, statusPath],
    {
      cwd: repoDir,
      env: process.env,
      stdio: 'inherit',
    }
  )

  if (statusExitCode !== 0) {
    process.exitCode = statusExitCode
    return
  }

  process.exitCode = testExitCode
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
