#!/usr/bin/env bun
/**
 * Instalador de modpacks .mrpack (Modrinth) sin la app de Modrinth.
 *
 * Uso:
 *   bun run mrpack.ts <pack.mrpack> -o <carpeta> [--side client|server] [--workers 8]
 *   bun run mrpack.ts            (modo interactivo)
 */
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises'
import { freemem } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { crc32 } from 'node:zlib'

// ---------------------------------------------------------------- seguridad: listas y limites

/** Hosts desde los que se puede descargar (los mismos que valida Modrinth al subir un pack). */
const ALLOWED_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
])

/** Hosts extra permitidos SOLO como destino de una redireccion (GitHub sirve sus descargas desde aqui). */
const REDIRECT_HOSTS = new Set([
  'codeload.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

const MAX_REDIRECTS = 5
const MAX_ATTEMPTS = 3 // intentos por URL (red caida, error 5xx, hash corrupto...)
const CONNECT_TIMEOUT_MS = 30_000 // esperando la respuesta del servidor
const STALL_TIMEOUT_MS = 30_000 // sin recibir ni un byte
// Sin topes fijos de tamano: el .mrpack se lee del disco por trozos, y los unicos limites son la
// memoria libre (para el indice y el directorio del ZIP) y el espacio libre del disco.
const INDEX_NAME = 'modrinth.index.json'

const LOADER_NAMES: Record<string, string> = {
  'fabric-loader': 'Fabric Loader',
  'quilt-loader': 'Quilt Loader',
  forge: 'Forge',
  neoforge: 'NeoForge',
  minecraft: 'Minecraft',
}

type Side = 'client' | 'server'
type HashAlgo = 'sha1' | 'sha512'
type Expected = Partial<Record<HashAlgo, string>>

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
  files: unknown[] // cada entrada se valida al procesarla
  dependencies: Record<string, string>
}

/** Error que no tiene sentido reintentar (politica de seguridad, 404, ...). */
class FatalError extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Caracteres de control y de direccion de texto: con ellos un pack podria colorear o falsear la consola. */
const UNSAFE_CHARS =
  '\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff'
const clean = (s: string) =>
  s.replace(new RegExp(`[${UNSAFE_CHARS}]`, 'g'), '?')

/** Resuelve una ruta relativa dentro de `base`, rechazando rutas peligrosas. */
function safeTarget(base: string, rel: string): string {
  const norm = rel.replaceAll('\\', '/')
  // ":" cubre letras de unidad (C:) y flujos alternativos de NTFS (archivo:flujo)
  if (
    !norm ||
    norm.startsWith('/') ||
    norm.includes(':') ||
    norm.split('/').includes('..') ||
    new RegExp(`[${UNSAFE_CHARS}\\n]`).test(norm)
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

interface ZipEntry {
  size: number
  /** Devuelve el contenido por trozos. Al terminar ha comprobado tamano y CRC; si algo falla, lanza un error. */
  chunks(): AsyncGenerator<Uint8Array>
}

const u64 = (dv: DataView, o: number): number => {
  const v = dv.getBigUint64(o, true)
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('ZIP con valores fuera de rango')
  return Number(v)
}

/**
 * Lector de ZIP minimo (sin dependencias) que NO carga el archivo en memoria: lee del disco solo el
 * directorio y descomprime cada entrada por trozos. Soporta ZIP64 (archivos y entradas de mas de 4 GB).
 */
async function openZip(path: string): Promise<Record<string, ZipEntry>> {
  const file = Bun.file(path)
  const fsize = file.size
  const read = async (start: number, end: number) =>
    new Uint8Array(await file.slice(start, end).arrayBuffer())
  const view = (b: Uint8Array) =>
    new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (fsize < 22) throw new Error('no es un ZIP')

  // "End of Central Directory": dentro de los ultimos 22 + 65535 bytes (el comentario)
  const tailStart = Math.max(0, fsize - 22 - 65535)
  const tail = await read(tailStart, fsize)
  const tdv = view(tail)
  let i = tail.length - 22
  while (i >= 0 && tdv.getUint32(i, true) !== 0x06054b50) i--
  if (i < 0) throw new Error('no es un ZIP')
  const eocdPos = tailStart + i
  let total = tdv.getUint16(i + 10, true)
  let cdSize = tdv.getUint32(i + 12, true)
  let cdOff = tdv.getUint32(i + 16, true)

  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // ZIP64: los valores reales estan en un registro aparte, justo antes del EOCD
    if (eocdPos < 20) throw new Error('ZIP64 corrupto')
    const loc = view(await read(eocdPos - 20, eocdPos))
    if (loc.getUint32(0, true) !== 0x07064b50) throw new Error('ZIP64 corrupto')
    const recPos = u64(loc, 8)
    const rec = await read(recPos, recPos + 56)
    if (rec.length < 56 || view(rec).getUint32(0, true) !== 0x06064b50)
      throw new Error('ZIP64 corrupto')
    const rdv = view(rec)
    total = u64(rdv, 32)
    cdSize = u64(rdv, 40)
    cdOff = u64(rdv, 48)
  }
  if (cdOff + cdSize > eocdPos)
    throw new Error('directorio central fuera de rango')
  if (cdSize > freemem() / 4)
    throw new Error(
      'no hay memoria suficiente para leer el directorio del .mrpack'
    )

  const cd = await read(cdOff, cdOff + cdSize)
  const dv = view(cd)
  const dec = new TextDecoder()
  const out: Record<string, ZipEntry> = Object.create(null)
  let p = 0
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50)
      throw new Error('directorio central corrupto')
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    let compSize = dv.getUint32(p + 20, true)
    let size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    let localOff = dv.getUint32(p + 42, true)
    const nameEnd = p + 46 + nameLen
    const extraEnd = nameEnd + extraLen
    if (extraEnd + commentLen > cd.length)
      throw new Error('directorio central corrupto')
    const name = dec.decode(cd.subarray(p + 46, nameEnd))

    if (
      size === 0xffffffff ||
      compSize === 0xffffffff ||
      localOff === 0xffffffff
    ) {
      // ZIP64: los campos saturados vienen en el campo extra 0x0001, en este orden
      let q = nameEnd
      let found = false
      while (q + 4 <= extraEnd) {
        const id = dv.getUint16(q, true)
        const len = dv.getUint16(q + 2, true)
        if (id === 0x0001) {
          let o = q + 4
          if (size === 0xffffffff) ((size = u64(dv, o)), (o += 8))
          if (compSize === 0xffffffff) ((compSize = u64(dv, o)), (o += 8))
          if (localOff === 0xffffffff) ((localOff = u64(dv, o)), (o += 8))
          if (o > q + 4 + len) throw new Error(`ZIP64 corrupto en ${name}`)
          found = true
          break
        }
        q += 4 + len
      }
      if (!found) throw new Error(`ZIP64 corrupto en ${name}`)
    }
    p = extraEnd + commentLen

    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error(`ZIP cifrado no soportado (${name})`)
    if (method !== 0 && method !== 8)
      throw new Error(
        `metodo de compresion no soportado (${method}) en ${name}`
      )
    if (name in out) throw new Error(`entrada duplicada en el .mrpack: ${name}`)

    out[name] = {
      size,
      async *chunks() {
        // La cabecera local tiene su propia longitud de nombre/extra
        const lh = await read(localOff, localOff + 30)
        if (lh.length < 30 || view(lh).getUint32(0, true) !== 0x04034b50)
          throw new Error(`cabecera local corrupta en ${name}`)
        const start =
          localOff +
          30 +
          view(lh).getUint16(26, true) +
          view(lh).getUint16(28, true)
        if (start + compSize > cdOff)
          throw new Error(`datos truncados en ${name}`)

        let src: ReadableStream<Uint8Array> = file
          .slice(start, start + compSize)
          .stream()
        if (method === 8)
          src = src.pipeThrough(
            new DecompressionStream(
              'deflate-raw'
            ) as unknown as TransformStream<Uint8Array, Uint8Array>
          )
        const reader = src.getReader()
        let got = 0
        let sum = 0
        try {
          for (;;) {
            const r = await reader.read().catch((): never => {
              throw new Error(`datos corruptos en ${name}`)
            })
            if (r.done) break
            got += r.value.length
            // Una "bomba" que mienta sobre su tamano se corta en cuanto lo supera
            if (got > size)
              throw new Error(`datos mas grandes de lo declarado en ${name}`)
            sum = crc32(r.value, sum)
            yield r.value
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        if (got !== size) throw new Error(`tamano incorrecto en ${name}`)
        if (sum !== crc) throw new Error(`CRC incorrecto en ${name}`)
      },
    }
  }
  return out
}

/** Lee una entrada entera en memoria (solo se usa para modrinth.index.json). */
async function readAll(entry: ZipEntry): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let n = 0
  for await (const c of entry.chunks()) {
    parts.push(c)
    n += c.length
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const c of parts) (out.set(c, o), (o += c.length))
  return out
}

/** Espacio libre (bytes) del disco donde esta `dir`; undefined si no se puede saber. */
async function freeBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- hashes

const HASH_LENGTHS: Record<HashAlgo, number> = { sha1: 40, sha512: 128 }

/** Devuelve los hashes validos del pack. Rechaza si falta el SHA-512 o alguno esta mal formado. */
function requireHashes(h: unknown): Expected {
  const src = (typeof h === 'object' && h !== null ? h : {}) as Record<
    string,
    unknown
  >
  const out: Expected = {}
  for (const algo of ['sha512', 'sha1'] as const) {
    const v = src[algo]
    if (v === undefined) continue
    if (
      typeof v !== 'string' ||
      v.length !== HASH_LENGTHS[algo] ||
      !/^[0-9a-fA-F]+$/.test(v)
    ) {
      throw new FatalError(`hash ${algo} con formato invalido en el pack`)
    }
    out[algo] = v.toLowerCase()
  }
  // La especificacion obliga a incluir SHA-1 y SHA-512. SHA-1 por si solo es debil: se exige SHA-512.
  if (!out.sha512) {
    throw new FatalError(
      'el pack no incluye SHA-512 para este archivo (la especificacion lo exige): se rechaza por seguridad'
    )
  }
  return out
}

type Hashers = Partial<Record<HashAlgo, Bun.CryptoHasher>>

function newHashers(expected: Expected): Hashers {
  const h: Hashers = {}
  for (const algo of Object.keys(expected) as HashAlgo[])
    h[algo] = new Bun.CryptoHasher(algo)
  return h
}

function feed(h: Hashers, chunk: Uint8Array) {
  for (const algo of Object.keys(h) as HashAlgo[]) h[algo]?.update(chunk)
}

/** Se comprueban TODOS los hashes que traiga el pack (si hay SHA-512 y SHA-1, los dos). */
function matches(h: Hashers, expected: Expected): boolean {
  return (Object.keys(expected) as HashAlgo[]).every(
    (algo) => h[algo]?.digest('hex') === expected[algo]
  )
}

async function fileMatches(path: string, expected: Expected): Promise<boolean> {
  const hashers = newHashers(expected)
  for await (const chunk of Bun.file(path).stream()) feed(hashers, chunk)
  return matches(hashers, expected)
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

/** En Windows el antivirus puede bloquear un archivo recien escrito unos instantes: se reintenta. */
async function renameRetry(from: string, to: string) {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
        throw e
      await sleep(i * 300)
    }
  }
}

/** Muestra el contador en una linea y el detalle debajo, con sangria (un solo console.log: no se mezcla en paralelo). */
function logProgress(n: number, total: number, detail: string) {
  const body = detail
    .split('\n')
    .map((line) => '    ' + clean(line))
    .join('\n')
  console.log(`[${n}/${total}]\n${body}`)
}

// ---------------------------------------------------------------- descarga

function parseUrl(s: string, base?: URL): URL {
  try {
    return new URL(s, base)
  } catch {
    throw new FatalError(`URL invalida: ${s}`)
  }
}

/** Comprueba una URL (la inicial o cada salto de redireccion). */
function checkUrl(u: URL, isRedirect: boolean) {
  if (u.protocol !== 'https:')
    throw new FatalError(`solo se permite https (${u.protocol})`)
  if (u.username || u.password)
    throw new FatalError('la URL lleva usuario/contrasena')
  if (u.port && u.port !== '443')
    throw new FatalError(`puerto no permitido: ${u.port}`)
  const ok =
    ALLOWED_HOSTS.has(u.hostname) ||
    (isRedirect && REDIRECT_HOSTS.has(u.hostname))
  if (!ok) {
    throw new FatalError(
      isRedirect
        ? `redireccion a host no permitido: ${u.hostname}`
        : `host no permitido: ${u.hostname}`
    )
  }
}

/**
 * Descarga una URL a `target` (via un .part). Las redirecciones se siguen a mano y CADA salto se
 * valida. El archivo se escribe a disco mientras llega (no se carga entero en memoria) y solo se
 * deja en su sitio si TODOS los hashes coinciden al releerlo del disco. Devuelve el host final.
 */
async function attemptDownload(
  startUrl: string,
  target: string,
  expected: Expected,
  maxBytes: number
): Promise<string> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(), ms)
  }
  const tmp = target + '.part'

  try {
    let current = parseUrl(startUrl)
    checkUrl(current, false)

    const get = (u: URL) => {
      touch(CONNECT_TIMEOUT_MS)
      return fetch(u, {
        redirect: 'manual',
        headers: { 'User-Agent': 'mrpack-installer/1.0' },
        signal: ctl.signal,
      })
    }

    let res = await get(current)
    for (let hop = 0; [301, 302, 303, 307, 308].includes(res.status); hop++) {
      await res.body?.cancel()
      if (hop >= MAX_REDIRECTS) throw new FatalError('demasiadas redirecciones')
      const loc = res.headers.get('location')
      if (!loc) throw new FatalError('redireccion sin destino')
      current = parseUrl(loc, current)
      checkUrl(current, true)
      res = await get(current)
    }

    if (!res.ok) {
      await res.body?.cancel()
      const transient =
        res.status >= 500 || res.status === 408 || res.status === 429
      throw transient
        ? new Error(`HTTP ${res.status}`)
        : new FatalError(`HTTP ${res.status}`)
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel()
      throw new FatalError(
        `el servidor anuncia un archivo mas grande de lo esperado (${declared} bytes)`
      )
    }
    if (!res.body) throw new Error('respuesta sin contenido')

    await mkdir(dirname(target), { recursive: true })
    const fh = await open(tmp, 'w')
    let received = 0
    try {
      touch(STALL_TIMEOUT_MS)
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (received > maxBytes)
          throw new FatalError(
            `el archivo supera el tamano esperado (>${maxBytes} bytes)`
          )
        await fh.write(value)
        touch(STALL_TIMEOUT_MS)
      }
    } finally {
      await fh.close()
    }

    // El hash se comprueba sobre lo que realmente quedo en el DISCO, no sobre lo que llego por la red
    if (!(await fileMatches(tmp, expected)))
      throw new Error('el hash no coincide')
    await renameRetry(tmp, target)
    return current.hostname
  } catch (e) {
    await rm(tmp, { force: true })
    if (ctl.signal.aborted)
      throw new Error('el servidor no responde (tiempo agotado)')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function validateEntry(e: unknown): PackFile {
  const f = e as Partial<PackFile> | null
  if (
    !f ||
    typeof f !== 'object' ||
    typeof f.path !== 'string' ||
    !f.path ||
    !Array.isArray(f.downloads) ||
    !f.downloads.every((u) => typeof u === 'string')
  ) {
    throw new FatalError(
      `entrada invalida en modrinth.index.json: ${String(JSON.stringify(e)).slice(0, 100)}`
    )
  }
  return f as PackFile
}

async function downloadFile(raw: unknown, base: string): Promise<string> {
  const entry = validateEntry(raw)
  const target = safeTarget(base, entry.path)
  let expected: Expected
  try {
    expected = requireHashes(entry.hashes)
  } catch (e) {
    throw new Error(`${entry.path}: ${(e as Error).message}`)
  }

  // Si ya existe y su contenido coincide con los hashes, no se descarga otra vez
  if ((await exists(target)) && (await fileMatches(target, expected)))
    return `= (ya existe) ${entry.path}`

  // Tope de la descarga: el doble del tamano declarado por el pack o, si no lo trae, el disco libre
  const size = entry.fileSize
  const maxBytes =
    typeof size === 'number' && Number.isFinite(size) && size > 0
      ? size * 2 + 16 * 1024 ** 2
      : ((await freeBytes(base)) ?? Number.MAX_SAFE_INTEGER)

  let lastError = 'sin URLs de descarga'
  for (const url of entry.downloads) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const host = await attemptDownload(url, target, expected, maxBytes)
        const via = host !== new URL(url).hostname ? `\nvia: ${host}` : ''
        return `+ ${entry.path}\ndesde: ${url}${via}`
      } catch (e) {
        lastError = (e as Error).message
        if (e instanceof FatalError) break // no tiene sentido reintentar: siguiente URL
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1500)
      }
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
  zip: Record<string, ZipEntry>,
  prefix: string,
  base: string
): Promise<{ count: number; errors: string[] }> {
  let count = 0
  const errors: string[] = []
  for (const [name, entry] of Object.entries(zip)) {
    if (!name.startsWith(prefix + '/')) continue
    let tmp = ''
    try {
      const target = safeTarget(base, name.slice(prefix.length + 1))
      await mkdir(dirname(target), { recursive: true })
      tmp = target + '.part'
      const fh = await open(tmp, 'w')
      try {
        for await (const chunk of entry.chunks()) await fh.write(chunk)
      } finally {
        await fh.close()
      }
      await renameRetry(tmp, target)
      count++
    } catch (e) {
      if (tmp) await rm(tmp, { force: true })
      errors.push(`override ${name}: ${(e as Error).message}`)
    }
  }
  return { count, errors }
}

interface Pack {
  zip: Record<string, ZipEntry>
  index: PackIndex
}

function parseIndex(raw: Uint8Array): PackIndex {
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new Error('modrinth.index.json no es un JSON valido')
  }
  if (typeof data !== 'object' || data === null)
    throw new Error('modrinth.index.json tiene un formato incorrecto')
  const d = data as Record<string, unknown>
  if (d.formatVersion !== 1) {
    throw new Error(
      `formatVersion no soportado: ${String(d.formatVersion)} (este programa entiende la 1)`
    )
  }
  if (d.game !== undefined && d.game !== 'minecraft')
    throw new Error(`juego no soportado: ${String(d.game)}`)
  if (!Array.isArray(d.files))
    throw new Error("modrinth.index.json no tiene la lista 'files'")

  const dependencies: Record<string, string> = {}
  if (typeof d.dependencies === 'object' && d.dependencies !== null) {
    for (const [k, v] of Object.entries(d.dependencies))
      if (typeof v === 'string') dependencies[k] = v
  }
  return {
    name: typeof d.name === 'string' ? d.name : undefined,
    versionId: typeof d.versionId === 'string' ? d.versionId : undefined,
    files: d.files,
    dependencies,
  }
}

/** Lee el .mrpack y devuelve su contenido, o null (mostrando el error) si no es valido. */
async function readPack(mrpackPath: string): Promise<Pack | null> {
  if (!(await Bun.file(mrpackPath).exists())) {
    console.error(`Error: no existe el archivo ${clean(mrpackPath)}`)
    return null
  }
  let zip: Record<string, ZipEntry>
  try {
    zip = await openZip(mrpackPath)
    // Se descomprime y verifica TODO ahora (por trozos, sin guardarlo) para fallar antes de descargar nada
    for (const entry of Object.values(zip))
      for await (const _chunk of entry.chunks());
  } catch (e) {
    console.error(
      `Error: el archivo no es un .mrpack valido (${clean((e as Error).message)}).`
    )
    return null
  }
  const idx = zip[INDEX_NAME]
  if (!idx) {
    console.error(`Error: falta ${INDEX_NAME} dentro del .mrpack.`)
    return null
  }
  // El indice se carga entero en memoria y al leerlo como JSON ocupa bastante mas que su tamano
  if (idx.size > freemem() / 8) {
    console.error(
      `Error: no hay memoria libre suficiente para leer ${INDEX_NAME} (${Math.round(idx.size / 1024 ** 2)} MB).`
    )
    return null
  }
  try {
    return { zip, index: parseIndex(await readAll(idx)) }
  } catch (e) {
    console.error(`Error: ${clean((e as Error).message)}.`)
    return null
  }
}

async function install(
  pack: Pack,
  dest: string,
  side: Side,
  workers: number
): Promise<number> {
  const { zip, index } = pack
  await mkdir(dest, { recursive: true })
  console.log(
    `\nModpack: ${clean(index.name ?? 'modpack')} ${clean(index.versionId ?? '')}`
  )
  console.log(`Destino: ${resolve(dest)}`)
  console.log(`Lado:    ${side}`)

  const files = index.files.filter(
    (f) => (f as PackFile | null)?.env?.[side] !== 'unsupported'
  )

  // Antes de descargar nada: comprobar que cabe en el disco (se cuenta solo lo que aun no esta)
  const free = await freeBytes(dest)
  if (free !== undefined) {
    let needed = 0
    for (const f of files as Partial<PackFile>[]) {
      if (typeof f?.path !== 'string' || typeof f.fileSize !== 'number')
        continue
      try {
        if (!(await exists(safeTarget(dest, f.path)))) needed += f.fileSize
      } catch {
        /* ruta invalida: se informara al procesarla */
      }
    }
    for (const [name, e] of Object.entries(zip)) {
      if (
        name.startsWith('overrides/') ||
        name.startsWith(`${side}-overrides/`)
      )
        needed += e.size
    }
    if (needed > free) {
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + ' GB'
      console.error(
        `\nNo hay espacio suficiente en el disco: se necesitan unos ${gb(needed)} y hay ${gb(free)} libres.`
      )
      return 1
    }
  }
  console.log(`Descargando ${files.length} archivos...\n`)

  const errors: string[] = []
  let done = 0
  await pool(files, workers, async (entry) => {
    try {
      const msg = await downloadFile(entry, dest)
      logProgress(++done, files.length, msg)
    } catch (e) {
      errors.push((e as Error).message)
      logProgress(++done, files.length, `ERROR ${(e as Error).message}`)
    }
  })

  const general = await extractOverrides(zip, 'overrides', dest)
  const specific = await extractOverrides(zip, `${side}-overrides`, dest)
  errors.push(...general.errors, ...specific.errors)
  console.log(
    `\nOverrides copiados: ${general.count + specific.count} archivos`
  )

  const deps = Object.entries(index.dependencies)
  if (deps.length) {
    console.log(
      '\n=== Necesitas instalar manualmente (el .mrpack no lo incluye) ==='
    )
    for (const [k, v] of deps)
      console.log(`  ${LOADER_NAMES[k] ?? clean(k)}: ${clean(v)}`)
  }

  if (errors.length) {
    console.log(`\n${errors.length} problemas:`)
    for (const e of errors) console.log('  -', clean(e))
    console.log(
      '\nVuelve a ejecutar el programa con el mismo pack y carpeta: solo reintentara lo que falta.'
    )
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
    .replace(new RegExp(`[<>:"/\\\\|?*${UNSAFE_CHARS}\\n]`, 'g'), '')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '')
  return clean || 'modpack'
}

async function pause() {
  await ask('\nPulsa Enter para salir...')
}

/** Pregunta la carpeta base. No se guarda en disco: solo se recuerda mientras el programa esta abierto. */
async function chooseBaseDir(): Promise<string | null> {
  while (true) {
    const answer = await ask('Carpeta base donde instalar los modpacks\n> ')
    if (answer === null) return null
    if (answer) return answer
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
  try {
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
  } catch (e) {
    console.error(`\nError inesperado: ${clean((e as Error).message)}`)
  }
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
  try {
    const pack = await readPack(positionals[0])
    process.exit(pack ? await install(pack, values.output, side, workers) : 1)
  } catch (e) {
    console.error(`Error inesperado: ${clean((e as Error).message)}`)
    process.exit(1)
  }
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
    if (change) baseDir = change
  }
}
