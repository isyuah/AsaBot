import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'

describe('plugin management with the Node loader and real npm', () => {
  it('installs, upgrades and removes packages and manages file plugins', async () => {
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(process.execPath, [resolve('test/fixtures/plugin-management-runner.ts')], {
        stdio: 'inherit',
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Plugin management child timed out'))
      }, 120_000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolveRun()
        else reject(new Error(`Plugin management child exited ${code}`))
      })
    })
  }, 130_000)
})
