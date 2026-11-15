import type { App } from '../core/app.ts'
import { groupKeyOf } from '../core/dispatch/types.ts'
import type { Session } from '../core/event/index.ts'
import type { Message } from '../core/message/index.ts'
import { isSegment, plainText } from '../core/message/index.ts'
import { definePlugin } from '../core/plugin/definition.ts'
import type { PackageOperation } from '../core/plugin/packages.ts'
import type { AccessList, AccessSubject } from '../core/storage/index.ts'

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240)
}

function listPage(lines: string[], page: number, empty: string, command: string): string {
  if (page < 1) return '页码必须大于等于 1'
  const pages = Math.max(1, Math.ceil(lines.length / 30))
  if (page > pages) return `没有第 ${page} 页，共 ${pages} 页`
  const current = lines.slice((page - 1) * 30, page * 30)
  if (pages > 1) current.push(`第 ${page}/${pages} 页，使用 ${command} -p 页码 翻页`)
  return current.length ? current.join('\n') : empty
}

function targetFromRest(subject: AccessSubject, target: Message | undefined, session: Session): string {
  if (subject === 'group' && !target) {
    if (!session.groupId) throw new Error('请在群内使用，或指定群 ID')
    return session.groupId
  }
  if (!target) throw new Error('请指定目标用户')
  if (subject === 'user') {
    const mentions = target.filter((segment) => isSegment(segment, 'at'))
    const mention = mentions[0]
    if (
      mentions.length === 1 &&
      mention !== undefined &&
      target.every((segment) => segment.type === 'at' || segment.type === 'text')
    ) {
      const id = mention.data.id
      if (typeof id === 'string' && id.length > 0 && !plainText(target).trim()) return id
    }
    const id = plainText(target).trim()
    if (target.every((segment) => segment.type === 'text') && id && !/\s/.test(id)) return id
    throw new Error('用户必须是单个用户 ID 或 @用户')
  }
  const id = plainText(target).trim()
  if (!id || /\s/.test(id) || target.some((segment) => segment.type !== 'text')) {
    throw new Error('请指定有效的群 ID')
  }
  return id
}

export function createAdminPlugin(app: App) {
  async function waitForOperation(operation: PackageOperation): Promise<PackageOperation> {
    return new Promise((resolve) => {
      const check = (current: PackageOperation): void => {
        if (current.id !== operation.id || (current.status !== 'succeeded' && current.status !== 'failed'))
          return
        unsubscribe()
        resolve(current)
      }
      const unsubscribe = app.plugins.packages.subscribe(check)
      const current = app.plugins.packages.list().find((item) => item.id === operation.id)
      if (current) check(current)
    })
  }

  function changeAccess(list: AccessList, subject: AccessSubject, id: string, session: Session): string {
    if (
      list === 'block' &&
      subject === 'user' &&
      app.isSuperuser({ platform: session.platform, selfId: session.selfId, userId: id })
    )
      return '不能屏蔽超管'
    const key = `${session.platform}:${id}`
    try {
      app.storage.access.add(list, subject, key)
      return `已添加 ${list} ${subject} ${key}`
    } catch (error) {
      return `访问控制操作失败：${reason(error)}`
    }
  }

  return definePlugin({
    name: 'admin',
    description: '管理插件与访问控制',
    setup(ctx) {
      const log = ctx.logger
      ctx
        .command('plugin scan')
        .description('重新扫描插件目录')
        .permission('superuser')
        .action(async () => {
          try {
            const result = await app.plugins.rescan()
            return `扫描完成：新增 ${result.added.join('、') || '无'}；移除 ${result.removed.join('、') || '无'}`
          } catch (error) {
            return `扫描失败：${reason(error)}`
          }
        })

      ctx
        .command('plugin install <package>')
        .description('安装插件包')
        .option('force', '-f, --force')
        .permission('superuser')
        .action(async ({ session, args, options }) => {
          await session.send(`开始安装插件包 ${args.package}`)
          void (async () => {
            try {
              const operation = await app.plugins.packages.install(args.package, undefined, options.force)
              const result = await waitForOperation(operation)
              await session.send(
                result.status === 'succeeded'
                  ? `已安装插件包 ${args.package}`
                  : `安装 ${args.package} 失败：${result.error}`,
              )
            } catch (error) {
              await session.send(`安装 ${args.package} 失败：${reason(error)}`)
            }
          })().catch((error: unknown) =>
            log.error({ err: error, package: args.package }, 'Failed to send package operation result'),
          )
        })

      ctx
        .command('plugin update <package>')
        .description('升级插件包')
        .permission('superuser')
        .action(async ({ session, args }) => {
          await session.send(`开始升级插件包 ${args.package}`)
          void (async () => {
            try {
              const operation = await app.plugins.packages.update(args.package)
              const result = await waitForOperation(operation)
              await session.send(
                result.status === 'succeeded'
                  ? `已升级插件包 ${args.package}`
                  : `升级 ${args.package} 失败：${result.error}`,
              )
            } catch (error) {
              await session.send(`升级 ${args.package} 失败：${reason(error)}`)
            }
          })().catch((error: unknown) =>
            log.error({ err: error, package: args.package }, 'Failed to send package operation result'),
          )
        })

      ctx
        .command('plugin uninstall <name>')
        .description('卸载插件')
        .option('purge', '--purge')
        .permission('superuser')
        .action(async ({ args, options }) => {
          try {
            await app.plugins.uninstall(args.name, options.purge)
            return `已卸载插件 ${args.name}`
          } catch (error) {
            return `卸载 ${args.name} 失败：${reason(error)}`
          }
        })

      ctx
        .command('plugin list')
        .description('查看插件状态')
        .option('page', '-p, --page <page:integer>', { default: 1, description: '页码' })
        .permission('superuser')
        .action(({ options }) => {
          const plugins = app.plugins.list()
          const lines = plugins.map(
            (plugin) =>
              `${plugin.name}: ${plugin.state}${plugin.state === 'failed' && plugin.error ? ` - ${reason(plugin.error)}` : ''}`,
          )
          return listPage(
            lines,
            options.page,
            '没有插件',
            `${app.config.command.prefixes[0] ?? ''}plugin list`,
          )
        })

      for (const operation of ['enable', 'disable', 'reload'] as const) {
        const label = { enable: '启用', disable: '停用', reload: '重载' }[operation]
        ctx
          .command(`plugin ${operation} <name>`)
          .description(`${label}全局插件`)
          .permission('superuser')
          .action(async ({ session, args }) => {
            // Disabling admin from chat would remove the only chat command able to re-enable it.
            if (operation === 'disable' && args.name === 'admin')
              return '不能在聊天中停用 admin 插件；如确需停用，请修改配置文件 plugins.admin.enabled'
            let result: string
            try {
              await app.plugins[operation](args.name)
              const state = app.plugins.get(args.name)
              if (operation === 'reload' && state?.state === 'disabled') {
                result = `已重载插件 ${args.name}（当前全局停用）`
              } else if (operation !== 'disable' && state?.state !== 'active') {
                result = `${label} ${args.name} 失败：${state?.error ? reason(state.error) : `状态为 ${state?.state ?? '未知'}`}`
              } else {
                result = `已${label}插件 ${args.name}`
              }
            } catch (error) {
              result = `${label} ${args.name} 失败：${reason(error)}`
            }
            // Sending explicitly also reports the result when admin itself is reloaded or disabled.
            await session.send(result)
          })
      }

      for (const enabled of [true, false]) {
        const operation = enabled ? 'on' : 'off'
        ctx
          .command(`plugin ${operation} <name>`)
          .description(`${enabled ? '开启' : '关闭'}当前群的插件`)
          .permission('group.admin')
          .action(({ session, args }) => {
            if (!session.groupId) return '只能在群里管理群插件'
            if (!enabled && args.name === 'admin') return '不能在群里关闭 admin 插件'
            try {
              app.plugins.setGroupEnabled(
                args.name,
                groupKeyOf({ ...session, groupId: session.groupId }),
                enabled,
              )
              return `已在本群${enabled ? '开启' : '关闭'}插件 ${args.name}`
            } catch (error) {
              return `群插件操作失败：${reason(error)}`
            }
          })
      }

      for (const enabled of [true, false]) {
        ctx
          .command(`bot plugin ${enabled ? 'on' : 'off'} <name>`)
          .description(`${enabled ? '开启' : '关闭'}当前机器人的插件`)
          .permission('bot.admin')
          .action(({ session, args }) => {
            if (!enabled && args.name === 'admin') return '不能在聊天中关闭 admin 插件'
            app.plugins.setBotEnabled(args.name, session, enabled)
            return `已在本机器人${enabled ? '开启' : '关闭'}插件 ${args.name}`
          })
      }

      ctx
        .command('acl list')
        .description('查看访问控制列表')
        .option('page', '-p, --page <page:integer>', { default: 1, description: '页码' })
        .permission('superuser')
        .action(({ options }) => {
          try {
            const entries = app.storage.access.list()
            const lines = entries.map((entry) => `${entry.list} ${entry.subject} ${entry.key}`)
            return listPage(
              lines,
              options.page,
              '访问控制列表为空',
              `${app.config.command.prefixes[0] ?? ''}acl list`,
            )
          } catch (error) {
            return `读取访问控制列表失败：${reason(error)}`
          }
        })

      for (const list of ['block', 'allow'] as const) {
        ctx
          .command(`acl ${list} user <user:user>`)
          .description(`${list === 'block' ? '屏蔽' : '允许'}用户`)
          .permission('superuser')
          .action(({ session, args }) => changeAccess(list, 'user', args.user, session))
        ctx
          .command(`acl ${list} group [group]`)
          .description(`${list === 'block' ? '屏蔽' : '允许'}群`)
          .permission('superuser')
          .action(({ session, args }) => {
            const id = args.group ?? session.groupId
            if (!id) return '请在群内使用，或指定群 ID'
            if (/\s/.test(id)) return '请指定有效的群 ID'
            return changeAccess(list, 'group', id, session)
          })
      }

      ctx
        .command('acl remove <list> <subject> [target:rest]')
        .description('移除访问控制条目')
        .permission('superuser')
        .example('/acl remove block user 12345')
        .action(({ session, args }) => {
          if (args.list !== 'block' && args.list !== 'allow') return '列表类型必须是 block 或 allow'
          if (args.subject !== 'user' && args.subject !== 'group') return '对象类型必须是 user 或 group'
          try {
            const id = targetFromRest(args.subject, args.target, session)
            const key = `${session.platform}:${id}`
            const found = app.storage.access.list(args.list, args.subject).some((entry) => entry.key === key)
            if (!found) return `没有找到 ${args.list} ${args.subject} ${key}`
            app.storage.access.remove(args.list, args.subject, key)
            return `已移除 ${args.list} ${args.subject} ${key}`
          } catch (error) {
            return `访问控制操作失败：${reason(error)}`
          }
        })
    },
  })
}
