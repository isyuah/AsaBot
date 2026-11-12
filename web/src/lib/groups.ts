/** Panel route of a group's rules page. Group keys are `${platform}:${groupId}` and may contain any character. */
export function groupPath(groupKey: string): string {
  return `/groups/${encodeURIComponent(groupKey)}`
}

/** Splits a group key into its platform and the (opaque) group ID; the ID may itself contain colons. */
export function parseGroupKey(groupKey: string): { platform: string; groupId: string } {
  const index = groupKey.indexOf(':')
  return { platform: groupKey.slice(0, index), groupId: groupKey.slice(index + 1) }
}
