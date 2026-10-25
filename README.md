# <img src=".img\favicon.png" alt="Logo" height="24"> Instalador ModPacks .mrpack MC

Una aplicación sencilla para instalar modpacks de Minecraft (`.mrpack`) de [Modrinth](https://modrinth.com) **sin tener que instalar la app de Modrinth**.

Descargas el `.mrpack` de la web, lo abres con el programa y él se encarga de bajar todos los mods y dejarlo todo listo.

---

## ⬇️ Descargar

👉 [mrpack.exe](https://github.com/MrSCR98/instalador-modpacks-mc/releases/download/Ejecutable/mrpack.exe)

---

## 🚀 ¿Qué hace este programa?

- Descarga todos los mods, resource packs y shaders del modpack
- Comprueba que los archivos no estén dañados ni manipulados
- Crea la carpeta del modpack con su nombre y versión
- Copia las configuraciones del pack
- Si algo falla, lo reintenta
- Si lo vuelves a ejecutar, repara solo lo que falte
- Te dice qué versión de Minecraft y de loader (Fabric, Forge, NeoForge o Quilt) necesitas

⚠️ **No instala Minecraft ni el loader.** Solo prepara la carpeta del modpack.

---

## 🧑‍💻 Uso para cualquier persona (paso a paso)

### 📥 1. Descarga el modpack

En la página del modpack en Modrinth, entra en **Versiones** y descarga el archivo `.mrpack` de la versión que quieras.

---

### 📁 2. Abre el programa

Haz doble clic en el `.exe`. No necesita instalación.

---

### 📂 3. Elige dónde guardar tus modpacks

El programa te pregunta la **carpeta base**, por ejemplo `C:\Users\TuUsuario\AppData\Roaming\.minecraft`.

💡 Puedes **arrastrar la carpeta a la ventana** y la ruta se escribe sola.

---

### 🎮 4. ¿Cliente o servidor?

Pulsa Enter para elegir **cliente** (lo normal, para jugar).

---

### 📦 5. Arrastra el `.mrpack`

Arrastra el archivo a la ventana y pulsa Enter.

El programa te enseña dónde lo va a instalar:

```text
Se instalara en: C:\Users\TuUsuario\AppData\Roaming\.minecraft versiones\MiModpack 1.2.3
```

Pulsa Enter para aceptar, o escribe otra ruta si prefieres otra carpeta.

---

### ⏳ 6. Espera

Verás cómo se descarga cada archivo y de dónde viene:

```text
[51/168]
    + mods/sodium-fabric-0.8.12+mc1.21.1.jar
    desde: https://cdn.modrinth.com/data/...
```

---

### ✅ 7. Prepara tu launcher

Al terminar, el programa te dice qué necesitas:

```text
Minecraft: 1.21.1
Fabric Loader: 0.18.4
```

Instala esa versión de Minecraft y ese loader, crea un perfil en tu launcher y apunta su **carpeta de juego** a la carpeta que creó el programa.

---

### 🔁 Si algo falla

Vuelve a ejecutar el programa con el mismo `.mrpack` y la misma carpeta. **Solo reintenta lo que falta.**

---

### ⚡ Atajo

También puedes **arrastrar el `.mrpack` directamente encima del `.exe`**. Te pregunta la carpeta base y lo instala. Puedes arrastrar varios a la vez.

---

## ⌨️ Para usuarios avanzados (comandos)

```bash
mrpack MiModpack.mrpack -o "C:\Users\TuUsuario\AppData\Roaming\.minecraft versiones\MiModpack"
mrpack MiModpack.mrpack -o ./servidor --side server
```

- `-o` → carpeta donde instalar
- `--side client` o `--side server` → versión de cliente (por defecto) o de servidor
- `--workers 8` → descargas a la vez (por defecto 8)

---

## 🛡️ Seguridad

- Solo descarga desde `cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com` y `gitlab.com`
- Comprueba los hashes de cada archivo (SHA-512 **y** SHA-1) antes de darlo por bueno: si falla cualquiera de los dos, lo descarta
- Un modpack no puede escribir fuera de su carpeta
- El programa nunca ejecuta nada del modpack

⚠️ Un hash correcto **no** significa que el mod sea seguro, solo que es el que el autor indicó. Instala únicamente modpacks de gente en la que confíes.

---

## 🚧 Limitaciones

- Solo funciona con `.mrpack` (no con modpacks de CurseForge)
- No actualiza modpacks ya instalados: cada versión se instala en una carpeta nueva y tus mundos no se copian solos
- Probado en Linux. En Windows y macOS todavía no

---

## ⚙️ Parte técnica (para desarrolladores)

La app está hecha con:

- Bun
- TypeScript (un solo archivo: `mrpack.ts`, sin dependencias)

---

## 📦 Requisitos

Antes de empezar necesitas tener instalado:

- 🥟 Bun → https://bun.com

---

## 📥 Instalar dependencias

```bash
bun install
```

(Solo instala los tipos de TypeScript para el editor.)

---

## 🧪 Ejecutar en desarrollo

```bash
bun run mrpack.ts
```

---

## ✅ Comprobar el código

```bash
bun check
```

Debe terminar con `No type errors`. Hazlo antes de subir cambios.

---

## 🏗️ Build de producción

```bash
bun run build
```

---

## ⚖️ Aviso

Proyecto no oficial. No está afiliado a Modrinth, Mojang ni Microsoft.
