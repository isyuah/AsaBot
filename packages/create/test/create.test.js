import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../bin/create.js'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }))

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
let temporary

function create(...args) {
  return main(args, temporary)
}

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const file = join(path, entry.name)
    return entry.isDirectory() ? files(file) : [file]
  })
}

describe('create-asabot', () => {
  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'asabot-create-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(temporary, { recursive: true, force: true })
  })

  it('生成默认 bot，并替换名称和框架版本', async () => {
    await create('--yes')
    const project = join(temporary, 'asabot-bot')
    expect(readdirSync(project).sort()).toEqual([
      '.gitignore',
      'README.md',
      'package.json',
      'plugins',
      'tsconfig.json',
    ])
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('asabot-bot')
    expect(pkg.dependencies['@asabot/core']).toBe(`^${version}`)
    expect(readFileSync(join(project, 'plugins/hello.ts'), 'utf8')).toContain('definePlugin')
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toContain('asabot.config.yaml')
    expect(files(project).every((file) => !/\{\{\w+\}\}/.test(readFileSync(file, 'utf8')))).toBe(true)
  })

  it('生成指定名称的 plugin，包含构建配置和命令测试', async () => {
    await create('my-project', '--template', 'plugin', '--name', 'weather', '--yes')
    const project = join(temporary, 'my-project')
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('asabot-plugin-weather')
    expect(pkg.keywords).toContain('asabot-plugin')
    expect(pkg.peerDependencies['@asabot/core']).toBe(`^${version}`)
    expect(pkg.devDependencies['@asabot/core']).toBe(`^${version}`)
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' })
    expect(readdirSync(join(project, 'src')).sort()).toEqual(['index.test.ts', 'index.ts'])
    expect(readFileSync(join(project, 'src/index.test.ts'), 'utf8')).toContain("t.say('/weather')")
    expect(readFileSync(join(project, 'tsconfig.build.json'), 'utf8')).toContain(
      'rewriteRelativeImportExtensions',
    )
    expect(files(project).every((file) => !/\{\{\w+\}\}/.test(readFileSync(file, 'utf8')))).toBe(true)
  })

  it('拒绝非空目录并保留其中的文件', async () => {
    const project = join(temporary, 'existing')
    mkdirSync(project)
    writeFileSync(join(project, 'keep.txt'), '保留')
    await expect(create('existing', '--yes')).rejects.toThrow('目标目录非空')
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('保留')
    expect(readdirSync(project)).toEqual(['keep.txt'])
  })

  it('接受空目录并拒绝无效模板和名称', async () => {
    mkdirSync(join(temporary, 'empty'))
    await create('empty', '--yes')
    await expect(create('bad-template', '--template', 'other', '--yes')).rejects.toThrow('模板必须')
    await expect(create('bad-name', '--name', '../invalid', '--yes')).rejects.toThrow('名称须')
  })

  it.each(['npm', 'pnpm', 'yarn', 'bun'])('使用 %s 安装依赖', async (manager) => {
    vi.stubEnv('npm_config_user_agent', `${manager}/1.0.0 node/v24`)
    await create('installed', '--yes', '--install')
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : manager
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', `${manager} install`] : ['install']
    expect(spawnSync).toHaveBeenCalledWith(command, args, {
      cwd: join(temporary, 'installed'),
      stdio: 'inherit',
    })
  })
})

import { spawnSync } from 'node:child_process'
