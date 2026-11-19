import type { App } from '../core/app.ts'
import type { CommandDefinition, OptionDefinition } from '../core/command/builder.ts'
import { formatUsage } from '../core/command/parse.ts'
import { plainText } from '../core/message/index.ts'
import { definePlugin } from '../core/plugin/definition.ts'

const pageSize = 12

function optionText(option: OptionDefinition): string {
  const argument = option.argument
  const parameter = argument
    ? ` ${argument.required ? '<' : '['}${argument.name}:${argument.type}${argument.required ? '>' : ']'}`
    : ''
  const defaultValue =
    option.defaultValue === undefined ? '' : `，默认 ${JSON.stringify(option.defaultValue)}`
  const description = option.description ? `：${option.description}` : ''
  return `${option.flags.join(', ')}${parameter}${defaultValue}${description}`
}

function descendants(commands: CommandDefinition[], path: string): CommandDefinition[] {
  return commands.filter((command) => command.path.join(' ').startsWith(`${path} `))
}

export function createHelpPlugin(app: App) {
  return definePlugin({
    name: 'help',
    description: '查看当前会话可用的命令',
    defaultOnNewBots: true,
    setup(ctx) {
      ctx
        .command('help [path:rest]')
        .description('查看命令列表或某个命令的帮助')
        .option('page', '-p, --page <page:integer>', { default: 1, description: '命令列表页码' })
        .example('/help')
        .example('/help -p 2')
        .example('/help echo')
        .action(async ({ session, args, options }) => {
          const commands = await app.dispatcher.listCommands(session)
          const prefix = app.config.command.prefixes[0] ?? ''
          let path = args.path ? plainText(args.path).trim() : ''
          const suppliedPrefix = [...app.config.command.prefixes]
            .sort((a, b) => b.length - a.length)
            .find((item) => item.length > 0 && path.startsWith(item))
          if (suppliedPrefix) path = path.slice(suppliedPrefix.length).trim()
          path = path.split(/\s+/).filter(Boolean).join(' ')

          if (path) {
            const command = commands.find(
              (item) => item.path.join(' ') === path || app.dispatcher.aliases(item).includes(path),
            )
            const children = descendants(commands, command?.path.join(' ') ?? path)
            if (!command && children.length === 0) return `未找到可用命令：${path}`
            const lines = command
              ? [
                  `用法：${formatUsage(command, prefix)}`,
                  ...(command.description ? [`说明：${command.description}`] : []),
                  ...(command.arguments.some((arg) => arg.settings?.description)
                    ? [
                        '参数：',
                        ...command.arguments
                          .filter((arg) => arg.settings?.description)
                          .map((arg) => `  ${arg.name}：${arg.settings?.description}`),
                      ]
                    : []),
                  ...(app.dispatcher.aliases(command).length
                    ? [`别名：${app.dispatcher.aliases(command).join('、')}`]
                    : []),
                  ...(command.options.length
                    ? ['选项：', ...command.options.map((option) => `  ${optionText(option)}`)]
                    : []),
                  ...(command.examples.length
                    ? ['示例：', ...command.examples.map((example) => `  ${example}`)]
                    : []),
                ]
              : [`${prefix}${path} 的子命令：`]
            if (children.length > 0) {
              if (command) lines.push('子命令：')
              lines.push(
                ...children
                  .slice(0, pageSize)
                  .map((child) => `  ${formatUsage(child, prefix)} ${child.description}`.trimEnd()),
              )
              if (children.length > pageSize)
                lines.push(`  还有 ${children.length - pageSize} 条，使用 ${prefix}help 查看列表`)
            }
            return lines.join('\n')
          }

          if (options.page < 1) return '页码必须大于等于 1'
          const groups = new Map<string, CommandDefinition[]>()
          for (const command of commands) {
            const group = groups.get(command.owner) ?? []
            group.push(command)
            groups.set(command.owner, group)
          }
          // Shorter groups first keep the first page useful when one plugin has many commands.
          const sorted = [...groups].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
          const all = sorted.flatMap(([owner, items]) =>
            items
              .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
              .map((command) => ({ owner, command })),
          )
          const pages = Math.max(1, Math.ceil(all.length / pageSize))
          if (options.page > pages) return `没有第 ${options.page} 页，共 ${pages} 页`
          const lines = [`可用命令（${options.page}/${pages}）：`]
          let previous = ''
          for (const { owner, command } of all.slice(
            (options.page - 1) * pageSize,
            options.page * pageSize,
          )) {
            if (owner !== previous) lines.push(`【${owner}】`)
            lines.push(
              `${formatUsage(command, prefix)}${command.description ? ` - ${command.description}` : ''}`,
            )
            previous = owner
          }
          if (pages > 1) lines.push(`使用 ${prefix}help -p 页码 翻页`)
          else lines.push(`使用 ${prefix}help 命令 查看详情`)
          return lines.join('\n')
        })
    },
  })
}
