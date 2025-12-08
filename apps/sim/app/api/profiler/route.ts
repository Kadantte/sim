/**
 * Profiler endpoint for memory diagnostics
 * Protected by INTERNAL_API_SECRET
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkInternalApiKey } from '@/lib/copilot/utils'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('Profiler')

export const dynamic = 'force-dynamic'

/** Memory samples for growth tracking */
const memorySamples: Array<{
  timestamp: number
  heapUsed: number
  rss: number
  spaces: Record<string, number>
}> = []
const MAX_SAMPLES = 100

/**
 * Formats bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Formats uptime to human readable string
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (mins > 0) parts.push(`${mins}m`)
  parts.push(`${secs}s`)

  return parts.join(' ')
}

/**
 * Provides diagnosis based on memory stats
 */
function getDiagnosis(
  memUsage: NodeJS.MemoryUsage,
  heapStats: ReturnType<typeof import('v8').getHeapStatistics>,
  heapSpaces: ReturnType<typeof import('v8').getHeapSpaceStatistics>
): string[] {
  const diagnosis: string[] = []

  if (heapStats.number_of_detached_contexts > 0) {
    diagnosis.push(
      `⚠️ ${heapStats.number_of_detached_contexts} detached contexts - possible closure/callback leak`
    )
  }

  const oldSpace = heapSpaces.find((s) => s.space_name === 'old_space')
  const newSpace = heapSpaces.find((s) => s.space_name === 'new_space')
  if (oldSpace && newSpace && oldSpace.space_used_size > 10 * newSpace.space_used_size) {
    diagnosis.push(
      `⚠️ old_space (${formatBytes(oldSpace.space_used_size)}) >> new_space - objects not being GC'd`
    )
  }

  const largeSpace = heapSpaces.find((s) => s.space_name === 'large_object_space')
  if (largeSpace && largeSpace.space_used_size > 100 * 1024 * 1024) {
    diagnosis.push(`⚠️ large_object_space is ${formatBytes(largeSpace.space_used_size)} - large arrays or strings`)
  }

  if (memUsage.external > 500 * 1024 * 1024) {
    diagnosis.push(`⚠️ External memory is ${formatBytes(memUsage.external)} - native addons or Buffers`)
  }

  const nonHeapMem = memUsage.rss - memUsage.heapTotal
  if (nonHeapMem > 500 * 1024 * 1024) {
    diagnosis.push(`⚠️ ${formatBytes(nonHeapMem)} outside JS heap - native memory or file mappings`)
  }

  if (diagnosis.length === 0) {
    diagnosis.push('✓ No obvious issues detected')
  }

  return diagnosis
}

/**
 * GET /api/profiler - Returns memory breakdown with diagnosis
 */
export async function GET(req: NextRequest) {
  const authResult = checkInternalApiKey(req)
  if (!authResult.success) {
    return NextResponse.json({ error: authResult.error }, { status: 401 })
  }

  logger.info('Profiler GET request')

  const memUsage = process.memoryUsage()
  const v8 = await import('v8')

  const heapStats = v8.getHeapStatistics()
  const heapSpaces = v8.getHeapSpaceStatistics()

  const spacesMap: Record<string, number> = {}
  for (const space of heapSpaces) {
    spacesMap[space.space_name] = space.space_used_size
  }

  memorySamples.push({
    timestamp: Date.now(),
    heapUsed: memUsage.heapUsed,
    rss: memUsage.rss,
    spaces: spacesMap,
  })

  if (memorySamples.length > MAX_SAMPLES) {
    memorySamples.shift()
  }

  let growth = null
  if (memorySamples.length >= 2) {
    const first = memorySamples[0]
    const last = memorySamples[memorySamples.length - 1]
    const timeDiffMs = last.timestamp - first.timestamp
    const timeDiffMin = timeDiffMs / 60000

    const spaceGrowth: Record<string, string> = {}
    for (const spaceName of Object.keys(last.spaces)) {
      const diff = last.spaces[spaceName] - (first.spaces[spaceName] || 0)
      if (Math.abs(diff) > 1024 * 1024) {
        spaceGrowth[spaceName] = `${diff > 0 ? '+' : ''}${formatBytes(diff)}`
      }
    }

    growth = {
      samples: memorySamples.length,
      periodMinutes: Math.round(timeDiffMin * 10) / 10,
      heapGrowth: formatBytes(last.heapUsed - first.heapUsed),
      rssGrowth: formatBytes(last.rss - first.rss),
      spaceGrowth: Object.keys(spaceGrowth).length > 0 ? spaceGrowth : undefined,
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    uptime: formatUptime(process.uptime()),
    memory: {
      rss: formatBytes(memUsage.rss),
      heapUsed: formatBytes(memUsage.heapUsed),
      heapTotal: formatBytes(memUsage.heapTotal),
      external: formatBytes(memUsage.external),
      arrayBuffers: formatBytes(memUsage.arrayBuffers),
    },
    heap: {
      used: formatBytes(heapStats.used_heap_size),
      total: formatBytes(heapStats.total_heap_size),
      limit: formatBytes(heapStats.heap_size_limit),
      malloced: formatBytes(heapStats.malloced_memory),
      nativeContexts: heapStats.number_of_native_contexts,
      detachedContexts: heapStats.number_of_detached_contexts,
    },
    spaces: heapSpaces
      .filter((s) => s.space_used_size > 0)
      .sort((a, b) => b.space_used_size - a.space_used_size)
      .map((space) => ({
        name: space.space_name,
        used: formatBytes(space.space_used_size),
      })),
    growth,
    diagnosis: getDiagnosis(memUsage, heapStats, heapSpaces),
    actions: {
      snapshot: 'POST {"action":"snapshot"} - Create .heapsnapshot file',
      reset: 'POST {"action":"reset"} - Reset growth tracking',
    },
  })
}

/**
 * POST /api/profiler - Trigger profiling actions
 */
export async function POST(req: NextRequest) {
  const authResult = checkInternalApiKey(req)
  if (!authResult.success) {
    return NextResponse.json({ error: authResult.error }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const action = body.action || 'snapshot'

  logger.info(`Profiler POST request: ${action}`)

  if (action === 'snapshot') {
    try {
      const v8 = await import('v8')
      const { join } = await import('path')
      const { statSync } = await import('fs')

      const filename = `heap-${Date.now()}.heapsnapshot`
      const filepath = join(process.cwd(), filename)

      v8.writeHeapSnapshot(filepath)

      return NextResponse.json({
        success: true,
        file: filepath,
        fileSize: formatBytes(statSync(filepath).size),
        analyze: `bun scripts/analyze-heap.ts ${filename}`,
      })
    } catch (error) {
      return NextResponse.json({
        success: false,
        message: `Failed to create snapshot: ${error}`,
      })
    }
  }

  if (action === 'reset') {
    memorySamples.length = 0
    return NextResponse.json({
      success: true,
      message: 'Growth tracking reset',
    })
  }

  return NextResponse.json({ error: 'Unknown action. Use: snapshot, reset' }, { status: 400 })
}
