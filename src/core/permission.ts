import type { Session } from './event/index.ts'

export type Rule = (session: Session) => boolean | Promise<boolean>
export type Permission = Rule | 'superuser' | 'group.owner' | 'group.admin'

const superuser: Rule = (session) => session.isSuperuser
const groupOwner: Rule = (session) =>
  session.isSuperuser || (session.messageType === 'group' && session.sender.role === 'owner')
const groupAdmin: Rule = (session) =>
  session.isSuperuser ||
  (session.messageType === 'group' && (session.sender.role === 'owner' || session.sender.role === 'admin'))
const group: Rule = (session) => session.messageType === 'group'
const privateRule: Rule = (session) => session.messageType === 'private'

export const perm = {
  superuser,
  groupOwner,
  groupAdmin,
  group,
  private: privateRule,
  and:
    (...rules: Rule[]): Rule =>
    async (session) => {
      for (const rule of rules) if (!(await rule(session))) return false
      return true
    },
  or:
    (...rules: Rule[]): Rule =>
    async (session) => {
      for (const rule of rules) if (await rule(session)) return true
      return false
    },
  not:
    (rule: Rule): Rule =>
    async (session) =>
      !(await rule(session)),
}

export function resolvePermission(permission: Permission): Rule {
  if (typeof permission === 'function') return permission
  return { superuser, 'group.owner': groupOwner, 'group.admin': groupAdmin }[permission]
}
