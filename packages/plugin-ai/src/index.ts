import { definePlugin } from '@asabot/core'
import { Audit, auditMigration } from './audit.ts'
import { Catalog, catalogMigration } from './catalog.ts'
import type { AiService } from './contracts.ts'
import { registerPanel } from './panel.ts'
import { Gateway } from './service.ts'
import { Vault } from './vault.ts'

export type {
  AiCallOptions,
  AiDecisionOptions,
  AiDecisionResult,
  AiGenerateOptions,
  AiGenerateResult,
  AiImageOptions,
  AiImagePart,
  AiImageResult,
  AiMedia,
  AiMessage,
  AiResult,
  AiService,
  AiSpeechOptions,
  AiSpeechResult,
  AiStreamEvent,
  AiToolCall,
  AiUsage,
  Capability,
  DecisionAnswer,
  DecisionQuestion,
  Feature,
  JsonObject,
  JsonValue,
  ModelInfo,
} from './contracts.ts'
export { AiError, type AiErrorCode } from './errors.ts'

declare module '@asabot/core' {
  interface Services {
    ai: AiService
  }
}

export default definePlugin({
  name: 'ai',
  description: '集中管理对话、生图、语音和结构化决策模型及用量',
  inject: ['http'],
  setup(ctx) {
    ctx.migrate([catalogMigration, auditMigration])
    const http = ctx.inject('http')
    const catalog = new Catalog(ctx.db, new Vault(ctx.dataDir))
    const audit = new Audit(ctx.db)
    const gateway = new Gateway(ctx, http, catalog, audit)
    audit.recover()
    audit.cleanup()
    ctx.interval('5m', () => audit.cleanup())
    ctx.provideScoped('ai', (consumer) => gateway.bind(consumer))
    registerPanel(ctx, catalog, audit, gateway, http)
  },
})
