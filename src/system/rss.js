import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Resident memory of this process and of the SDK's model worker. The models
// run in a child `bare` process, not in node, so node's own RSS says nothing
// about them; this reads the direct children with one `ps` call. Windows has
// no `ps`; the eval sampler covers it and the product reports null there.
export const treeRss = async (pid = process.pid) => {
  const node = process.memoryUsage().rss
  if (process.platform === 'win32') return { node, bare: null }
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,comm='])
    let bare = 0
    for (const line of stdout.split('\n')) {
      const [, ppid, rss, comm] = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)?.slice(1) ?? []
      // `ps` reports rss in KiB. Only the worker counts, not, say, a shell.
      if (Number(ppid) === pid && /bare/i.test(comm ?? '')) bare += Number(rss) * 1024
    }
    return { node, bare }
  } catch {
    return { node, bare: null }
  }
}
