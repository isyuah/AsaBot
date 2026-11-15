import { z } from 'zod'
import type { BotCapabilities } from './bot.ts'

export const capabilitySchema = z
  .object({
    segments: z.array(z.string()),
    textStyles: z.array(z.enum(['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'])),
    actions: z.array(z.string()),
  })
  .strict()
export const requirementsSchema = z
  .object({
    required: capabilitySchema.partial().optional(),
    optional: capabilitySchema.partial().optional(),
  })
  .strict()

export interface CapabilityRequirements {
  required?: Partial<BotCapabilities>
  optional?: Partial<BotCapabilities>
}
export interface CapabilityGap {
  kind: keyof BotCapabilities
  name: string
}
export interface Compatibility {
  declared: boolean
  required: CapabilityGap[]
  optional: CapabilityGap[]
}
export function compatibility(
  requirements: CapabilityRequirements | undefined,
  actual: BotCapabilities,
): Compatibility {
  const missing = (wanted: Partial<BotCapabilities> | undefined): CapabilityGap[] =>
    (['segments', 'textStyles', 'actions'] as const).flatMap((kind) =>
      (wanted?.[kind] ?? [])
        .filter(
          (name) =>
            !actual[kind].some(
              (value) =>
                value === name ||
                (kind === 'segments' && value.endsWith(':*') && name.startsWith(value.slice(0, -1))),
            ),
        )
        .map((name) => ({ kind, name })),
    )
  return {
    declared: requirements !== undefined,
    required: missing(requirements?.required),
    optional: missing(requirements?.optional),
  }
}
