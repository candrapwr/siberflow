# Build Siberflow Desktop untuk Windows

Panduan lengkap build installer Windows (`.exe`) dari fresh clone. Ikuti urutan ini persis.

## Prasyarat

### 1. Install Node.js
Download dari https://nodejs.org/ (versi 20 LTS atau 22). Saat install, biarkan default (termasuk "Add to PATH").

### 2. Install Git
Download dari https://git-scm.com/download/win.

### 3. Install Python (untuk compile native modules)
1. Download dari https://www.python.org/downloads/ (Python 3.11 atau 3.12)
2. **PENTING:** saat installer muncul, centang **"Add Python to PATH"** di bagian bawah window installer
3. Klik "Install Now"

Verifikasi:
```powershell
python --version
```
Harus muncul `Python 3.x.x`.

### 4. Install Visual Studio Build Tools (C++ compiler)
Native modules (`ssh2`, `sqlite3`, `cpu-features`) butuh compiler C++ untuk Windows.

1. Download dari https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. Jalankan installer
3. Centang **"Desktop development with C++"** (workload pertama di list)
4. Klik Install (besar, ~6GB — sabar)

Komponen yang harus tercentang otomatis: MSVC v143, Windows 11 SDK, C++ CMake tools.

---

## Langkah Build

### 1. Clone repo
```powershell
git clone <repo-url> siberflow
cd siberflow
```

### 2. Build core package (prasyarat desktop)
```powershell
npm run build:core
```

### 3. Install dependencies desktop
```powershell
npm install
```
Tidak ada lagi `postinstall` yang rekursif — install bersih.

### 4. Build + package installer Windows
```powershell
npm run package:win
```

Script ini menjalankan 3 langkah otomatis:
1. `electron-vite build` — bundle main + preload + renderer
2. `electron-builder install-app-deps` — rebuild native modules untuk Windows/Electron
3. `electron-builder --win` — package jadi installer `.exe`

Output: `packages\desktop\dist\Siberflow-Setup-<version>.exe`

---

## Troubleshooting

### Error: `Could not find any Python installation to use`
Python belum ter-install atau belum ada di PATH.
- Jalankan `python --version` — kalau "not recognized", install ulang Python dan centang "Add to PATH"
- Atau set manual: `npm config set python "C:\Path\To\python.exe"`

### Error: `MSBuild.exe not found` / `gyp ERR! find VS`
Visual Studio Build Tools belum ter-install atau tidak lengkap.
- Pastikan ter-install dengan workload **"Desktop development with C++"**
- Restart komputer setelah install
- Verifikasi: jalankan `npm config set msvs_version 2022`

### Error: `app-builder.exe ENOENT`
`app-builder-bin` tidak download binary Windows (biasanya karena lock file dari platform lain).
```powershell
cd D:\siberflow
del package-lock.json
rmdir /s /q node_modules
npm install
```

### Error: `electron-builder is not recognized`
Happens kalau `postinstall` rekursif. Sudah di-fix di repo terbaru — pastikan pull kode terbaru. Kalau masih ada, hapus manual:
```powershell
npm pkg delete scripts.postinstall -w siberflow-desktop
```

### Native module tetap Mach-O (macOS binary) setelah build
Ini berarti `install-app-deps` tidak jalan. Jalankan manual:
```powershell
cd packages\desktop
npx electron-builder install-app-deps
```

---

## Catatan

- Installer yang dihasilkan **unsigned** — user akan lihat SmartScreen warning "Windows protected your PC". Klik "More info" → "Run anyway" untuk tetap install. Untuk signed installer butuh code signing certificate Windows.
- Build **harus di Windows** — tidak bisa cross-compile dari Mac/Linux untuk Windows (native modules machine-code spesifik platform).
- Native modules yang di-compile: `ssh2` (SSH tools), `sqlite3` (db_query SQLite), `cpu-features` (optimisasi crypto).
