#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

function printUsage() {
  console.error(
    'Usage: node scripts/nextjs-suite-batch.mjs <nextjs-dir> [status-json-path] [max-suites] [concurrency]'
  )
}

function sanitizeSuitePath(suitePath) {
  return suitePath.replaceAll('/', '__').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}

function runCommand(command, args, options = {}) {
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

function runSuiteToLog(command, args, { cwd, env, logPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', async (code) => {
      try {
        await fs.writeFile(logPath, output)
      } catch (error) {
        reject(error)
        return
      }

      resolve(code ?? 1)
    })
  })
}

async function updateSuiteMetadata(statusPath, suitePath, patch) {
  const status = JSON.parse(await fs.readFile(statusPath, 'utf8'))

  if (!status.suites?.[suitePath]) {
    return
  }

  status.generatedAt = new Date().toISOString()
  status.suites[suitePath] = {
    ...status.suites[suitePath],
    ...patch,
  }

  await fs.writeFile(statusPath, JSON.stringify(status, null, 2) + '\n')
}

async function readStatus(statusPath) {
  return JSON.parse(await fs.readFile(statusPath, 'utf8'))
}

function getPendingSuites(status, maxSuites) {
  const suites = status.orderedSuites.filter((suite) => status.suites?.[suite]?.status === 'unrun')

  if (!Number.isFinite(maxSuites)) {
    return suites
  }

  return suites.slice(0, maxSuites)
}

async function main() {
  const nextjsDirArg = process.argv[2]
  const statusPathArg = process.argv[3]
  const maxSuitesArg = process.argv[4]
  const concurrencyArg = process.argv[5]

  if (!nextjsDirArg) {
    printUsage()
    process.exitCode = 1
    return
  }

  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const repoDir = path.resolve(scriptDir, '..')
  const nextjsDir = path.resolve(nextjsDirArg)
  const statusPath = path.resolve(
    statusPathArg || path.join(repoDir, 'reports', 'nextjs-adapter-suite-status.json')
  )
  const maxSuites = maxSuitesArg
    ? Number.parseInt(maxSuitesArg, 10)
    : Number.POSITIVE_INFINITY
  const concurrency = concurrencyArg
    ? Number.parseInt(concurrencyArg, 10)
    : Number.parseInt(process.env.NEXTJS_SUITE_BATCH_CONCURRENCY || '3', 10)

  if ((maxSuitesArg && !Number.isFinite(maxSuites)) || maxSuites <= 0) {
    throw new Error(`Invalid max-suites value: ${maxSuitesArg}`)
  }

  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid concurrency value: ${concurrencyArg || process.env.NEXTJS_SUITE_BATCH_CONCURRENCY}`)
  }

  const initialStatus = await readStatus(statusPath)
  const pendingSuites = getPendingSuites(initialStatus, maxSuites)

  if (pendingSuites.length === 0) {
    console.log('All suites have already been attempted.')
    return
  }

  const logDir = path.join(repoDir, 'reports', 'nextjs-suite-logs')
  await fs.mkdir(logDir, { recursive: true })

  let nextIndex = 0
  let completed = 0
  let statusUpdateQueue = Promise.resolve()

  const runSuite = async (workerId) => {
    while (true) {
      const suiteIndex = nextIndex
      const suitePath = pendingSuites[suiteIndex]

      if (!suitePath) {
        return
      }

      nextIndex += 1

      const startedAt = new Date()
      const logPath = path.join(
        logDir,
        `${String(suiteIndex + 1).padStart(4, '0')}-${sanitizeSuitePath(suitePath)}.log`
      )

      console.log(
        `[${startedAt.toISOString()}] worker-${workerId} starting ${suiteIndex + 1}/${pendingSuites.length}: ${suitePath}`
      )

      const exitCode = await runSuiteToLog(
        'npm',
        ['run', 'test:nextjs:local', '--', nextjsDir, suitePath],
        {
          cwd: repoDir,
          env: process.env,
          logPath,
        }
      )

      completed += 1

      const finishedAt = new Date()
      const durationSeconds = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)

      console.log(
        `[${finishedAt.toISOString()}] worker-${workerId} finished ${suitePath} with exit ${exitCode} in ${durationSeconds}s`
      )

      if (exitCode !== 0) {
        console.log(`  log: ${logPath}`)
      }

      statusUpdateQueue = statusUpdateQueue.then(async () => {
        await updateSuiteMetadata(statusPath, suitePath, {
          lastStartedAt: startedAt.toISOString(),
          lastFinishedAt: finishedAt.toISOString(),
          durationSeconds,
          exitCode,
          logFile: path.relative(repoDir, logPath),
        })

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
          throw new Error(`Status refresh failed with code ${statusExitCode}`)
        }

        const refreshedStatus = await readStatus(statusPath)
        console.log(
          `[${new Date().toISOString()}] counts after ${completed}/${pendingSuites.length}: ${JSON.stringify(
            refreshedStatus.counts
          )}`
        )
      })

      await statusUpdateQueue
    }
  }

  const workerCount = Math.min(concurrency, pendingSuites.length)
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => runSuite(index + 1))
  )

  console.log('Batch complete.')
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
