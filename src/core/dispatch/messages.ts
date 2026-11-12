export const messages = {
  denied: '权限不足',
  cooldown: (milliseconds: number) => `冷却中，剩余 ${Math.ceil(milliseconds / 1000)}s`,
  commandError: '命令执行出错，请稍后重试',
  argumentError: (reason: string, usage: string) => `${reason}。用法：${usage}`,
  missing: (name: string) => `缺少参数 <${name}>`,
  invalid: (name: string, expected: string) => `参数 <${name}> 应为${expected}`,
  unknownOption: (name: string) => `未知选项 ${name}`,
  missingOption: (name: string) => `选项 ${name} 需要参数`,
  optionTakesNoValue: (name: string) => `选项 ${name} 不接受参数`,
  extraArgument: '参数过多',
  unmatchedQuote: '引号未闭合',
  subcommands: (names: string[]) => `子命令：${names.join('、')}`,
}
