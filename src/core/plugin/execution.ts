import { AsyncLocalStorage } from 'node:async_hooks'

/** 让后台任务和保留的 Bot 引用同样受插件的机器人开关约束。 */
export const pluginExecution = new AsyncLocalStorage<string>()
