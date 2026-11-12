#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

const options = {
  template: { type: 'string' },
  name: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  install: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

function packageManager() {
  const agent = process.env.npm_config_user_agent ?? ''
  return /(?:^|\s)(pnpm|yarn|bun)\//.exec(agent)?.[1] ?? 'npm'
}

function install(manager, cwd) {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : manager
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `${manager} install`] : ['install']
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${manager} install 失败，请在项目目录手动安装依赖`)
}

async function copyTemplate(source, target, replacements) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name === '_gitignore' ? '.gitignore' : entry.name)
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      await copyTemplate(from, to, replacements)
    } else {
      const content = (await readFile(from, 'utf8')).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!Object.hasOwn(replacements, key)) throw new Error(`未知的模板占位符：${match}`)
        return replacements[key]
      })
      await writeFile(to, content, { flag: 'wx' })
    }
  }
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true })
  if (values.help) {
    console.log(
      '用法：npm create @asabot@latest [dir] -- [--template bot|plugin] [--name <name>] [--yes] [--install]',
    )
    return
  }
  if (positionals.length > 1) throw new Error('只能指定一个目标目录')

  let template = values.template
  let directory = positionals[0]
  let name = values.name
  const prompt = !values.yes && (!template || !directory || !name)
  if (prompt && !process.stdin.isTTY) throw new Error('缺少参数；请在终端交互运行或使用 --yes')
  const rl = prompt ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  try {
    if (!template) template = (await rl?.question('模板（bot/plugin）[bot]：'))?.trim() || 'bot'
    if (template !== 'bot' && template !== 'plugin') throw new Error('模板必须是 bot 或 plugin')
    const defaultDirectory = template === 'bot' ? 'asabot-bot' : `asabot-plugin-${name || 'example'}`
    if (!directory)
      directory = (await rl?.question(`目标目录 [${defaultDirectory}]：`))?.trim() || defaultDirectory
    const defaultName = basename(resolve(cwd, directory)).replace(/^asabot-plugin-/, '')
    if (!name) name = (await rl?.question(`项目名称 [${defaultName}]：`))?.trim() || defaultName
  } finally {
    rl?.close()
  }
  const validName = template === 'bot' ? /^[a-z0-9][a-z0-9._-]*$/ : /^[a-z0-9][a-z0-9_-]*$/
  if (
    !validName.test(name) ||
    name === 'node_modules' ||
    name === 'favicon.ico' ||
    (template === 'plugin' && name === 'core')
  )
    throw new Error('名称须以小写字母或数字开头，且不能使用保留名称；bot 名称可包含 .，插件名称不能为 core')
  if ((template === 'plugin' ? `asabot-plugin-${name}` : name).length > 214) throw new Error('项目名称过长')

  const target = resolve(cwd, directory)
  await mkdir(target, { recursive: true })
  if ((await readdir(target)).length > 0) throw new Error(`目标目录非空：${target}`)
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, '../package.json'), 'utf8'))
  const templateDir = resolve(import.meta.dirname, '../templates', template)
  await copyTemplate(templateDir, target, { name, coreVersion: `^${pkg.version}` })

  const manager = packageManager()
  console.log(`\n已创建 ${template === 'bot' ? '机器人' : '插件'}项目：${target}`)
  if (values.install) install(manager, target)
  console.log(`\n下一步：\n  cd "${directory.replaceAll('"', '\\"')}"`)
  if (!values.install) console.log(`  ${manager} install`)
  if (template === 'bot') {
    console.log(`  ${manager === 'npm' ? 'npm run dev' : `${manager} run dev`}`)
    console.log('  打开 http://127.0.0.1:5140，使用启动时显示的设置码完成首次设置。')
  } else {
    console.log(`  ${manager} run test\n  ${manager} run build`)
  }
}

if (process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(`创建失败：${error.message}`)
    process.exitCode = 1
  })
}
