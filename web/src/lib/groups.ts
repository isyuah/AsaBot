export function groupPath(groupKey: string): string {
  return `/groups/${encodeURIComponent(groupKey)}`
}

export function parseGroupKey(groupKey: string): { platform: string; selfId: string; groupId: string } {
  const [platform, selfId, _kind, ...id] = groupKey.split(':') as [string, string, string, ...string[]]
  return { platform, selfId, groupId: id.join(':') }
}
