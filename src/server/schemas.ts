import { z } from 'zod'
import { credentialGroupId } from '../core/plugin/credentials.ts'
import { targetSchema } from '../core/target.ts'

const mediaTypes = new Set(['image', 'audio', 'video', 'file'])
/** `file:` URLs and absolute paths (POSIX, Windows drive, UNC / root-relative). */
const localFile = /^(?:file:|[\\/]|[a-z]:[\\/])/i

const segment = z
  .object({ type: z.string().min(1), data: z.record(z.string(), z.unknown()) })
  .superRefine((value, context) => {
    const rawType = value.type.includes(':') ? value.type.slice(value.type.indexOf(':') + 1) : value.type
    const type = rawType === 'record' ? 'audio' : rawType
    const required: Record<string, string> = {
      text: 'text',
      at: 'id',
      face: 'id',
      image: 'file',
      audio: 'file',
      video: 'file',
      reply: 'id',
      file: 'file',
      forward: 'id',
      markdown: 'content',
      button: 'label',
    }
    const field = required[type]
    if (field && typeof value.data[field] !== 'string') {
      context.addIssue({ code: 'custom', path: ['data', field], message: 'Expected string' })
      return
    }
    if (
      type === 'button' &&
      ((value.data.kind !== 'link' && value.data.kind !== 'command') || typeof value.data.value !== 'string')
    ) {
      context.addIssue({ code: 'custom', path: ['data'], message: 'Invalid button' })
    }
    if (
      type === 'text' &&
      value.data.style !== undefined &&
      (!Array.isArray(value.data.style) ||
        value.data.style.some(
          (style: unknown) =>
            typeof style !== 'string' ||
            !['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'].includes(style),
        ))
    ) {
      context.addIssue({ code: 'custom', path: ['data', 'style'], message: 'Invalid text style' })
    }
    // HTTP callers must not make the adapter (or the OneBot implementation's host) read local files.
    if (mediaTypes.has(type) && localFile.test(value.data.file as string)) {
      context.addIssue({
        code: 'custom',
        path: ['data', 'file'],
        message: 'Local files are not allowed; use http(s):// or base64://',
      })
    }
  })

export const sendSchema = z
  .object({
    target: targetSchema,
    message: z.union([z.string(), z.array(segment)]),
  })
  .strict()

const credentialFields = { group: credentialGroupId, label: z.string().trim().min(1).max(80) }
export const pluginCredentialInput = z
  .discriminatedUnion('mode', [
    z.object({ ...credentialFields, mode: z.literal('generate') }),
    z.object({
      ...credentialFields,
      mode: z.literal('import'),
      value: z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (value) => value.trim() && value.isWellFormed() && !/[\r\n]/.test(value),
          '请输入单行凭据原值',
        ),
    }),
  ])
  .refine((input) => input.mode === 'generate' || !input.label.includes(input.value), {
    path: ['label'],
    message: '凭据名称不能包含凭据原值',
  })

const playgroundUser = z.object({
  id: z.string().min(1),
  nickname: z.string().optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  superuser: z.boolean().optional(),
})

const capabilities = z
  .object({
    segments: z.array(z.string()).optional(),
    textStyles: z.array(z.enum(['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'])).optional(),
    actions: z.array(z.string()).optional(),
  })
  .strict()

export const playgroundSchema = z
  .object({
    text: z.string().optional(),
    message: z.array(segment).optional(),
    user: playgroundUser,
    group: z.string().min(1).nullable().optional(),
    capabilities: capabilities.optional(),
  })
  .refine((value) => value.text !== undefined || value.message !== undefined, {
    message: 'text or message is required',
  })

export const playgroundEventSchema = z
  .object({
    name: z.enum([
      'notice.member.join',
      'notice.member.leave',
      'notice.member.mute',
      'notice.poke',
      'notice.message.recall',
      'request.friend',
      'request.group.join',
      'request.group.invite',
    ]),
    user: playgroundUser,
    group: z.string().min(1).nullable().optional(),
    fields: z
      .object({
        userId: z.string().min(1).optional(),
        groupId: z.string().min(1).optional(),
        operatorId: z.string().min(1).optional(),
        joinType: z.string().optional(),
        reason: z.string().optional(),
        duration: z.number().nonnegative().optional(),
        targetId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        comment: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const accessSchema = z.object({
  list: z.enum(['block', 'allow']),
  subject: z.enum(['user', 'group']),
  key: z.string().regex(/^[^:\s]+:[^\s]+$/, 'Expected platform:id'),
})

export const uploadSchema = z.object({
  filename: z.string(),
  content: z.string(),
  overwrite: z.boolean().optional(),
})
export const purgeSchema = z.object({ purge: z.boolean() })
export const botAliasSchema = z.strictObject({
  alias: z
    .string()
    .trim()
    .min(1)
    .max(80, '别名最多 80 个字符')
    .refine(
      (value) => value.isWellFormed() && !value.includes('\0') && !/[\r\n\u2028\u2029]/.test(value),
      '请输入单行别名',
    )
    .nullable(),
})
export const packageInstallSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  force: z.boolean().optional(),
})
export const packageNameSchema = z.object({ name: z.string() })
export const packageUninstallSchema = z.object({ name: z.string(), purge: z.boolean() })
