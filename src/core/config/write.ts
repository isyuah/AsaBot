import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type Document, isMap, isSeq, parseDocument } from 'yaml'
import { ConfigError } from '../errors.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function update(document: Document, path: (string | number)[], value: unknown, previous: unknown): void {
  if (isDeepStrictEqual(value, previous)) return
  const node = document.getIn(path, true)
  if (isMap(node) && record(value) && record(previous)) {
    for (const key of Object.keys(previous)) {
      if (!(key in value)) document.deleteIn([...path, key])
    }
    for (const [key, item] of Object.entries(value)) {
      update(document, [...path, key], item, previous[key])
    }
  } else if (isSeq(node) && Array.isArray(value) && Array.isArray(previous)) {
    for (let index = previous.length - 1; index >= value.length; index--) document.deleteIn([...path, index])
    for (let index = 0; index < value.length; index++)
      update(document, [...path, index], value[index], previous[index])
  } else document.setIn(path, value)
}

export async function writeConfigValue(
  path: string,
  keyPath: string[],
  value: unknown,
  options?: { previousValue: unknown },
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    const source = await readFile(path, 'utf8')
    const document = parseDocument(source, { uniqueKeys: true })
    if (document.errors.length) throw document.errors[0]
    if (options) update(document, keyPath, value, options.previousValue)
    else document.setIn(keyPath, value)
    await writeFile(temporary, document.toString({ flowCollectionPadding: false }), {
      encoding: 'utf8',
      flag: 'wx',
    })
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ConfigError(`Unable to write configuration file "${path}"; temporary file cleanup failed`, {
          cause: cleanupError,
        })
      }
    }
    throw new ConfigError(`Unable to write configuration file "${path}"`, { cause: error })
  }
}
