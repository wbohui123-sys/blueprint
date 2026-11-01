import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** 可选地把一次选择机原生调用写到外部目录；诊断写入失败不影响模型调用。 */
export async function 保存选择机请求(options) {
  const dir = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  if (!dir) return { enabled: false }

  const requestId = randomUUID(), version = 1
  let sha256
  try {
    const serializable = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'signal'))))
    const bytes = JSON.stringify(serializable)
    sha256 = createHash('sha256').update(bytes).digest('hex')
    if (!isAbsolute(dir)) throw new Error('BLUEPRINT_SELECTOR_TRACE_DIR must be an absolute path')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const directory = await lstat(dir)
    if (directory.isSymbolicLink() || !directory.isDirectory() || typeof process.getuid !== 'function'
        || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700)
      throw new Error('trace directory must be an owned private directory (0700)')
    const file = join(dir, `${requestId}.json`)
    await writeFile(file, JSON.stringify({ version, requestId, sha256, options: serializable }) + '\n', { flag: 'wx', mode: 0o600 })
    return { enabled: true, requestId, version, sha256, file }
  } catch (error) {
    return { enabled: true, requestId, version, ...(sha256 ? { sha256 } : {}), traceError: String(error?.message || error) }
  }
}
