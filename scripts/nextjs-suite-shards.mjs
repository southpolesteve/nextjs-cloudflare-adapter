#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

function printUsage() {
  console.error(
    'Usage: node scripts/nextjs-suite-shards.mjs <status-json-path> [output-json-path] [shard-count]'
  )
}

function median(values) {
  if (values.length === 0) {
    return 30
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2)
  }

  return sorted[middle]
}

function getSuiteDuration(suiteStatus, fallbackDurationSeconds) {
  if (Number.isFinite(suiteStatus?.durationSeconds) && suiteStatus.durationSeconds > 0) {
    return suiteStatus.durationSeconds
  }

  return fallbackDurationSeconds
}

async function main() {
  const statusPathArg = process.argv[2]
  const outputPathArg = process.argv[3]
  const shardCountArg = process.argv[4]

  if (!statusPathArg) {
    printUsage()
    process.exitCode = 1
    return
  }

  const statusPath = path.resolve(statusPathArg)
  const outputPath = path.resolve(
    outputPathArg || path.join(process.cwd(), 'reports', 'nextjs-adapter-suite-shards.json')
  )
  const shardCount = shardCountArg ? Number.parseInt(shardCountArg, 10) : 32

  if (!Number.isFinite(shardCount) || shardCount <= 0) {
    throw new Error(`Invalid shard count: ${shardCountArg}`)
  }

  const status = JSON.parse(await fs.readFile(statusPath, 'utf8'))
  const orderedSuites = status.orderedSuites || []
  const suites = status.suites || {}

  const measuredDurations = orderedSuites
    .map((suite) => suites[suite]?.durationSeconds)
    .filter((value) => Number.isFinite(value) && value > 0)
  const fallbackDurationSeconds = median(measuredDurations)

  const plannedSuites = orderedSuites.map((suite) => {
    const suiteStatus = suites[suite] || {}
    return {
      suite,
      status: suiteStatus.status || 'unrun',
      durationSeconds: getSuiteDuration(suiteStatus, fallbackDurationSeconds),
      measuredDurationSeconds:
        Number.isFinite(suiteStatus.durationSeconds) && suiteStatus.durationSeconds > 0
          ? suiteStatus.durationSeconds
          : null,
    }
  })

  plannedSuites.sort((left, right) => {
    if (right.durationSeconds !== left.durationSeconds) {
      return right.durationSeconds - left.durationSeconds
    }

    return left.suite.localeCompare(right.suite)
  })

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    shardId: `${index + 1}/${shardCount}`,
    index: index + 1,
    totalEstimatedDurationSeconds: 0,
    suiteCount: 0,
    measuredSuiteCount: 0,
    suites: [],
  }))

  for (const plannedSuite of plannedSuites) {
    shards.sort((left, right) => {
      if (left.totalEstimatedDurationSeconds !== right.totalEstimatedDurationSeconds) {
        return left.totalEstimatedDurationSeconds - right.totalEstimatedDurationSeconds
      }

      return left.index - right.index
    })

    const targetShard = shards[0]
    targetShard.suites.push(plannedSuite.suite)
    targetShard.suiteCount += 1
    targetShard.totalEstimatedDurationSeconds += plannedSuite.durationSeconds

    if (plannedSuite.measuredDurationSeconds !== null) {
      targetShard.measuredSuiteCount += 1
    }
  }

  shards.sort((left, right) => left.index - right.index)

  const snapshot = {
    generatedAt: new Date().toISOString(),
    sourceStatusPath: statusPath,
    shardCount,
    totalSuites: orderedSuites.length,
    measuredSuites: measuredDurations.length,
    fallbackDurationSeconds,
    shards,
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2) + '\n')

  console.log(`Wrote ${outputPath}`)
  console.log(
    JSON.stringify(
      {
        shardCount: snapshot.shardCount,
        totalSuites: snapshot.totalSuites,
        measuredSuites: snapshot.measuredSuites,
        fallbackDurationSeconds: snapshot.fallbackDurationSeconds,
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
