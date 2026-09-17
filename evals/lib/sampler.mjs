import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Memory, CPU and GPU of the machine and of the server's process tree, one
// row per tick into hardware.jsonl, labelled with the phase and the turn the
// runner is in. One `sample()` interface, one adapter per platform, one OS
// command per source per tick plus a regex. Where a platform has no built-in
// source the field is null; nothing is installed.

// Process table as { pid, ppid, rss (bytes), cpu (%), comm } rows.
const psTable = async () => {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='])
  return stdout.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, cpu: Number(m[4]), comm: m[5] }))
}

// The server's tree: the pid, its children, their children. The SDK's model
// worker is a `bare` child of node, so it is where the weights show up.
const treeOf = (rows, root) => {
  const tree = []
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift()
    for (const row of rows) if (row.ppid === pid) { tree.push(row); queue.push(row.pid) }
  }
  const self = rows.find((row) => row.pid === root)
  return self ? [self, ...tree] : tree
}

const summarizeTree = (rows) => ({
  rss_tree: rows.reduce((sum, row) => sum + row.rss, 0),
  rss_node: rows.filter((row) => /node/i.test(row.comm)).reduce((sum, row) => sum + row.rss, 0),
  rss_bare: rows.filter((row) => /bare/i.test(row.comm)).reduce((sum, row) => sum + row.rss, 0),
  cpu: Number(rows.reduce((sum, row) => sum + row.cpu, 0).toFixed(1)),
})

const darwin = {
  async system() {
    const { stdout } = await run('vm_stat')
    const page = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 16384)
    const pages = (name) => Number(stdout.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0)
    // active + wired + compressed is what Activity Monitor calls memory used.
    return (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page
  },
  async gpu() {
    const { stdout } = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'])
    const values = [...stdout.matchAll(/"Device Utilization %"=(\d+)/g)].map((m) => Number(m[1]))
    return values.length ? Math.max(...values) : null
  },
  tree: async (pid) => summarizeTree(treeOf(await psTable(), pid)),
}

const linux = {
  async system() {
    const text = await readFile('/proc/meminfo', 'utf8')
    const kib = (name) => Number(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0)
    return (kib('MemTotal') - kib('MemAvailable')) * 1024
  },
  async gpu() {
    // amdgpu and some Intel drivers expose gpu_busy_percent; where absent the field stays null.
    for (const card of readdirSync('/sys/class/drm').filter((name) => /^card\d+$/.test(name))) {
      const value = await readFile(`/sys/class/drm/${card}/device/gpu_busy_percent`, 'utf8').catch(() => null)
      if (value !== null) return Number(value.trim())
    }
    return null
  },
  tree: async (pid) => summarizeTree(treeOf(await psTable(), pid)),
}

const win32 = {
  // One PowerShell call per tick: processes, memory and GPU engines together.
  async all(pid) {
    const script = [
      '$p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,CreatingProcessID,WorkingSetPrivate,PercentProcessorTime,Name',
      '$os = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory',
      '$gpu = (Get-Counter "\\GPU Engine(*)\\Utilization Percentage" -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum',
      '@{ procs = $p; os = $os; gpu = $gpu.Sum } | ConvertTo-Json -Depth 3 -Compress',
    ].join('; ')
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script])
    const data = JSON.parse(stdout)
    const rows = (Array.isArray(data.procs) ? data.procs : [data.procs]).map((p) => ({ pid: p.IDProcess, ppid: p.CreatingProcessID, rss: Number(p.WorkingSetPrivate), cpu: Number(p.PercentProcessorTime), comm: p.Name }))
    return {
      tree: summarizeTree(treeOf(rows, pid)),
      system: (Number(data.os.TotalVisibleMemorySize) - Number(data.os.FreePhysicalMemory)) * 1024,
      gpu: data.gpu === null || data.gpu === undefined ? null : Math.min(100, Number(data.gpu)),
    }
  },
}

const safe = (promise, fallback) => promise.catch(() => fallback)

export const sample = async (pid) => {
  if (process.platform === 'win32') {
    const all = await safe(win32.all(pid), { tree: {}, system: null, gpu: null })
    return { ...all.tree, system_used: all.system, gpu_util: all.gpu }
  }
  const os = process.platform === 'darwin' ? darwin : linux
  const [tree, system, gpu] = await Promise.all([
    pid ? safe(os.tree(pid), {}) : {},
    safe(os.system(), null),
    safe(os.gpu(), null),
  ])
  return { ...tree, system_used: system, gpu_util: gpu }
}

export const createSampler = ({ intervalMs = 500, out }) => {
  let pid = null
  let labels = { phase: 'before_load' }
  let timer = null
  let busy = false
  let pending = Promise.resolve()

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const row = { t: Date.now(), ...labels, ...(await sample(pid)) }
      pending = pending.then(() => appendFile(out, `${JSON.stringify(row)}\n`))
    } finally {
      busy = false
    }
  }

  return {
    start() { timer = setInterval(tick, intervalMs); return tick() },
    watch(serverPid) { pid = serverPid },
    mark(next) { labels = { ...next } },
    async stop() { clearInterval(timer); await tick(); await pending },
  }
}
