import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Node loader hot reload', () => {
  it('reloads entry and relative modules, preserves the old instance on import error and discovers new plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-hot-output-'))
    try {
      const path = join(dir, 'result.txt')
      await new Promise<void>((resolveOutput, reject) => {
        const child = spawn(process.execPath, [resolve('test/fixtures/hot-reload-runner.ts'), path], {
          stdio: 'inherit',
        })
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Hot reload child timed out'))
        }, 20_000)
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('exit', (code) => {
          clearTimeout(timer)
          if (code === 0) resolveOutput()
          else reject(new Error(`Hot reload child exited ${code}`))
        })
      })
      expect(await readFile(path, 'utf8')).toContain(
        'HOT_RELOAD_OK first second second! retained fixed new deleted restored',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 25_000)
})
