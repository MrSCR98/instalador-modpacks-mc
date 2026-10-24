#!/usr/bin/env bun
/**
 * Instalador de modpacks .mrpack (Modrinth) sin la app de Modrinth.
 *
 * Uso:
 *   bun run mrpack.ts <pack.mrpack> -o <carpeta> [--side client|server] [--workers 8]
 *   bun run mrpack.ts            (modo interactivo)
 */
import { mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { inflateRawSync } from 'node:zlib'

const ALLOWED_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
])

const LOADER_NAMES: Record<string, string> = {
  'fabric-loader': 'Fabric Loader',
  'quilt-loader': 'Quilt Loader',
  forge: 'Forge',
  neoforge: 'NeoForge',
  minecraft: 'Minecraft',
}

type Side = 'client' | 'server'

interface PackFile {
  path: string
  hashes: { sha1?: string; sha512?: string }
  env?: { client?: string; server?: string }
  downloads: string[]
  fileSize?: number
}

interface PackIndex {
  name?: string
  versionId?: string
  files: PackFile[]
  dependencies: Record<string, string>
}

/** Resuelve una ruta relativa dentro de `base`, rechazando rutas peligrosas. */
function safeTarget(base: string, rel: string): string {
  const norm = rel.replaceAll('\\', '/')
  if (
    norm.startsWith('/') ||
    /^[a-zA-Z]:/.test(norm) ||
    norm.split('/').includes('..')
  ) {
    throw new Error(`Ruta no permitida en el pack: ${rel}`)
  }
  const root = resolve(base)
  const target = resolve(root, norm)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Ruta fuera de la carpeta destino: ${rel}`)
  }
  return target
}

/** Lector de ZIP minimo (sin dependencias): soporta archivos "stored" y "deflate". */
function unzip(buf: Uint8Array): Record<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const dec = new TextDecoder()

  // Buscar el "End of Central Directory" desde el final
  let eocd = -1
  for (
    let i = buf.length - 22;
    i >= Math.max(0, buf.length - 22 - 65535);
    i--
  ) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('no es un ZIP')

  const total = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  if (total === 0xffff || p === 0xffffffff)
    throw new Error('ZIP64 no soportado')

  const out: Record<string, Uint8Array> = {}
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50)
      throw new Error('directorio central corrupto')
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue

    // La cabecera local tiene su propia longitud de nombre/extra
    const dataStart =
      localOff +
      30 +
      dv.getUint16(localOff + 26, true) +
      dv.getUint16(localOff + 28, true)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) out[name] = raw
    else if (method === 8) out[name] = new Uint8Array(inflateRawSync(raw))
    else
      throw new Error(
        `metodo de compresion no soportado (${method}) en ${name}`
      )
  }
  return out
}

function hashBytes(data: Uint8Array, algo: 'sha1' | 'sha512'): string {
  return new Bun.CryptoHasher(algo).update(data).digest('hex')
}

function verify(data: Uint8Array, hashes: PackFile['hashes']): boolean {
  for (const algo of ['sha512', 'sha1'] as const) {
    const expected = hashes[algo]
    if (expected) return hashBytes(data, algo) === expected.toLowerCase()
  }
  return true
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

async function downloadFile(entry: PackFile, base: string): Promise<string> {
  const target = safeTarget(base, entry.path)

  if (await exists(target)) {
    const current = new Uint8Array(await Bun.file(target).arrayBuffer())
    if (verify(current, entry.hashes)) return `= (ya existe) ${entry.path}`
  }

  let lastError = 'sin URLs de descarga'
  for (const url of entry.downloads ?? []) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      lastError = `URL invalida: ${url}`
      continue
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
      lastError = `host no permitido: ${parsed.hostname}`
      continue
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'mrpack-installer/1.0' },
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) {
        lastError = `HTTP ${res.status}`
        continue
      }
      const data = new Uint8Array(await res.arrayBuffer())
      if (!verify(data, entry.hashes)) {
        lastError = 'el hash no coincide'
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      const tmp = target + '.part'
      await Bun.write(tmp, data)
      await rename(tmp, target)
      return `+ ${entry.path}\n      desde: ${url}`
    } catch (e) {
      lastError = (e as Error).message
    }
  }
  throw new Error(`${entry.path}: ${lastError}`)
}

/** Ejecuta tareas con un maximo de `limit` en paralelo. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>
) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
}

async function extractOverrides(
  zip: Record<string, Uint8Array>,
  prefix: string,
  base: string
): Promise<number> {
  let count = 0
  for (const [name, data] of Object.entries(zip)) {
    if (name.endsWith('/') || !name.startsWith(prefix + '/')) continue
    const target = safeTarget(base, name.slice(prefix.length + 1))
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, data)
    count++
  }
  return count
}

interface Pack {
  zip: Record<string, Uint8Array>
  index: PackIndex
}

/** Lee el .mrpack y devuelve su contenido, o null (mostrando el error) si no es valido. */
async function readPack(mrpackPath: string): Promise<Pack | null> {
  const file = Bun.file(mrpackPath)
  if (!(await file.exists())) {
    console.error(`Error: no existe el archivo ${mrpackPath}`)
    return null
  }
  let zip: Record<string, Uint8Array>
  try {
    zip = unzip(new Uint8Array(await file.arrayBuffer()))
  } catch {
    console.error('Error: el archivo no es un .mrpack valido (no es un ZIP).')
    return null
  }
  const rawIndex = zip['modrinth.index.json']
  if (!rawIndex) {
    console.error('Error: falta modrinth.index.json dentro del .mrpack.')
    return null
  }
  return { zip, index: JSON.parse(new TextDecoder().decode(rawIndex)) }
}

async function install(
  pack: Pack,
  dest: string,
  side: Side,
  workers: number
): Promise<number> {
  const { zip, index } = pack
  await mkdir(dest, { recursive: true })
  console.log(`\nModpack: ${index.name ?? 'modpack'} ${index.versionId ?? ''}`)
  console.log(`Destino: ${resolve(dest)}`)
  console.log(`Lado:    ${side}`)

  const files = (index.files ?? []).filter(
    (f) => f.env?.[side] !== 'unsupported'
  )
  console.log(`Descargando ${files.length} archivos...\n`)

  const errors: string[] = []
  let done = 0
  await pool(files, workers, async (entry) => {
    try {
      const msg = await downloadFile(entry, dest)
      console.log(`[${++done}/${files.length}] ${msg}`)
    } catch (e) {
      errors.push((e as Error).message)
      console.log(`[${++done}/${files.length}] ERROR ${(e as Error).message}`)
    }
  })

  let n = await extractOverrides(zip, 'overrides', dest)
  n += await extractOverrides(zip, `${side}-overrides`, dest)
  console.log(`\nOverrides copiados: ${n} archivos`)

  console.log(
    '\n=== Necesitas instalar manualmente (el .mrpack no lo incluye) ==='
  )
  for (const [k, v] of Object.entries(index.dependencies ?? {})) {
    console.log(`  ${LOADER_NAMES[k] ?? k}: ${v}`)
  }

  if (errors.length) {
    console.log(`\n${errors.length} descargas fallaron:`)
    for (const e of errors) console.log('  -', e)
    return 2
  }
  console.log('\nListo.')
  return 0
}

// ---------------------------------------------------------------- utilidades

const stdinLines = console[Symbol.asyncIterator]()

/** Pregunta algo por consola. Devuelve "" si pulsas Enter, y null si ya no hay entrada (stdin cerrado). */
async function ask(question: string): Promise<string | null> {
  process.stdout.write(question)
  const r = await stdinLines.next()
  if (r.done) return null
  return String(r.value)
    .trim()
    .replace(/^["']|["']$/g, '')
}

/** Nombre de carpeta valido en Windows/Linux/macOS. */
function folderName(pack: Pack, mrpackPath: string): string {
  const name = pack.index.name || basename(mrpackPath).replace(/\.mrpack$/i, '')
  const raw = pack.index.versionId ? `${name} ${pack.index.versionId}` : name
  const clean = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
  return clean || 'modpack'
}

const CONFIG_PATH = join(homedir(), '.mrpack-installer.json')

async function loadBaseDir(): Promise<string | undefined> {
  try {
    return JSON.parse(await Bun.file(CONFIG_PATH).text()).baseDir
  } catch {
    return undefined
  }
}

async function saveBaseDir(baseDir: string) {
  try {
    await Bun.write(CONFIG_PATH, JSON.stringify({ baseDir }, null, 2))
  } catch {
    /* no es critico */
  }
}

async function pause() {
  await ask('\nPulsa Enter para salir...')
}

/** Pregunta/confirma la carpeta base. Enter = mantener la recordada. */
async function chooseBaseDir(): Promise<string | null> {
  const saved = await loadBaseDir()
  const hint = saved ? ` [${saved}]` : ''
  while (true) {
    const answer = await ask(
      `Carpeta base donde instalar los modpacks${hint}\n> `
    )
    if (answer === null) return null
    const chosen = answer || saved
    if (chosen) {
      await saveBaseDir(chosen)
      return chosen
    }
    console.log('Debes indicar una carpeta.')
  }
}

/** Instala un .mrpack dentro de baseDir/<nombre del pack>, dejando cambiar la ruta final. */
async function installInteractive(
  mrpackPath: string,
  baseDir: string,
  side: Side,
  workers: number,
  confirm: boolean
) {
  const pack = await readPack(mrpackPath)
  if (!pack) return
  let dest = join(baseDir, folderName(pack, mrpackPath))
  if (confirm) {
    const override = await ask(
      `Se instalara en: ${resolve(dest)}\nEnter para aceptar, o escribe otra ruta exacta:\n> `
    )
    if (override === null) return
    if (override) dest = override
  }
  await install(pack, dest, side, workers)
}

// ---------------------------------------------------------------- main

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    side: { type: 'string', default: 'client' },
    workers: { type: 'string', default: '8' },
  },
})

let side = values.side as Side
if (side !== 'client' && side !== 'server') {
  console.error("--side debe ser 'client' o 'server'")
  process.exit(1)
}
const workers = Math.max(1, Number(values.workers) || 8)

// Modo comando: un solo .mrpack con -o => se usa EXACTAMENTE esa carpeta (sin interaccion)
if (values.output && positionals.length === 1) {
  const pack = await readPack(positionals[0])
  process.exit(pack ? await install(pack, values.output, side, workers) : 1)
}

// Modo interactivo / arrastrar archivos sobre el .exe
console.log('=== Instalador de modpacks .mrpack ===\n')
let baseDir = values.output ?? (await chooseBaseDir())
if (!baseDir) process.exit(0)

if (positionals.length === 0 && !Bun.argv.includes('--side')) {
  const s = await ask(
    'Instalar para [C]liente o [S]ervidor? (Enter = cliente)\n> '
  )
  if (s?.toLowerCase().startsWith('s')) side = 'server'
}

if (positionals.length > 0) {
  // Archivos arrastrados: se instalan todos sin preguntar mas
  for (const f of positionals)
    await installInteractive(f, baseDir, side, workers, false)
  await pause()
} else {
  while (true) {
    const f = await ask(
      '\nArchivo .mrpack (arrastralo aqui, o Enter vacio para salir)\n> '
    )
    if (!f) break
    await installInteractive(f, baseDir, side, workers, true)
    const change = await ask(
      `\nCarpeta base actual: ${baseDir}\nEnter = mantener, o escribe otra carpeta base:\n> `
    )
    if (change === null) break
    if (change) {
      baseDir = change
      await saveBaseDir(baseDir)
    }
  }
}
