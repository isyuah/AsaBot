import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('@fontsource/noto-sans-sc/package.json'))
const destination = fileURLToPath(new URL('../fonts/', import.meta.url))
await mkdir(destination, { recursive: true })
const files = (await readdir(join(source, 'files'))).filter((name) => /-(400|700)-normal\.woff$/.test(name))
await Promise.all(files.map((name) => copyFile(join(source, 'files', name), join(destination, name))))
await copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE'))
