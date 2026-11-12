import { z } from 'zod'

const mediaTypes = new Set(['image', 'audio', 'video', 'file'])
/** `file:` URLs and absolute paths (POSIX, Windows drive, UNC / root-relative). */
const localFile = /^(?:file:|[\\/]|[a-z]:[\\/])/i

const segment = z
  .object({ type: z.string().min(1), data: z.record(z.string(), z.unknown()) })
  .superRefine((value, context) => {
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
    }
    const field = required[value.type]
    if (field && typeof value.data[field] !== 'string') {
      context.addIssue({ code: 'custom', path: ['data', field], message: 'Expected string' })
      return
    }
    // HTTP callers must not make the adapter (or the OneBot implementation's host) read local files.
    if (mediaTypes.has(value.type) && localFile.test(value.data.file as string)) {
      context.addIssue({
        code: 'custom',
        path: ['data', 'file'],
        message: 'Local files are not allowed; use http(s):// or base64://',
      })
    }
  })

export const sendSchema = z.object({
  platform: z.string().min(1).optional(),
  selfId: z.string().min(1).optional(),
  target: z.object({ type: z.enum(['group', 'private']), id: z.string().min(1) }),
  message: z.union([z.string(), z.array(segment)]),
})

export const playgroundSchema = z
  .object({
    text: z.string().optional(),
    message: z.array(segment).optional(),
    user: z.object({
      id: z.string().min(1),
      nickname: z.string().optional(),
      role: z.enum(['owner', 'admin', 'member']).optional(),
      superuser: z.boolean().optional(),
    }),
    group: z.string().min(1).nullable().optional(),
  })
  .refine((value) => value.text !== undefined || value.message !== undefined, {
    message: 'text or message is required',
  })

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
export const packageInstallSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  force: z.boolean().optional(),
})
export const packageNameSchema = z.object({ name: z.string() })
export const packageUninstallSchema = z.object({ name: z.string(), purge: z.boolean() })
