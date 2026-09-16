# UI Change Plan — DevX Desktop

> Dokumen ini **hanya rencana**. Tidak ada file di `apps/`, `crates/`,
> `design-system/`, `catalog/`, atau file konfigurasi yang diubah untuk
> menghasilkannya.
>
> Tanggal penyusunan: 2026-09-16
> Workspace: `devx-rewrite`, branch `main`

## Cara membaca dokumen ini

Setiap klaim kondisi UI dirujuk sebagai `path:line`. Setiap rujukan ke
dokumen desain memakai nomor bagian (`§`) dari dua sumber berbeda:

- **`DESIGN.md`** (root repo, 4618 baris, status git: untracked) — dokumen
  "DevBox UI Design System & Frontend Guidelines". Dirujuk sebagai `§N`.
- **`apps/desktop/DESIGN.md`** (62 baris, tracked) — identitas "warm
  utility" DevX. Karena tidak bernomor, dirujuk sebagai
  `apps/desktop/DESIGN.md:line`.
- **`design-system/devx/MASTER.md`** dan
  `design-system/devx/pages/dashboard.md` — hasil rekonsiliasi identitas
  tersebut. Dirujuk sebagai `MASTER.md:line`.

Klaim yang **tidak** terverifikasi ditandai eksplisit dengan
`[BELUM DIVERIFIKASI]`. Tidak ada angka yang dikarang; semua angka di
dokumen ini berasal dari file atau output perintah yang benar-benar
dijalankan.

Batasan penamaan: istilah teknis, nama file, nama komponen, dan nama token
ditulis dalam bahasa Inggris dan **tidak** diterjemahkan. Prosa penjelas
memakai bahasa Indonesia.

---

## 1. Ringkasan eksekutif

`DESIGN.md` di root meminta sebuah **"professional developer cockpit"** —
dark-first, aksen ungu elektrik `#7567FF` di atas navy `#070B14`, bahasa
visual "dark glass / soft glow", ambient particle field, hierarki lewat
glow, tipografi Inter + JetBrains Mono, radius besar (8/12/16, pill 999px),
dan sebuah application shell lengkap (topbar 64px, global search `Ctrl+K`,
command palette, modal system, toast, notification center, status strip,
bottom terminal drawer) di atas information architecture dengan 9 seksi
sidebar dan route `/runtimes`, `/servers`, `/containers`, `/environment`,
`/tools`, `/extensions`, `/projects` (`§3:129`, `§4:222`, `§6:345`,
`§8:426`, `§33:1571`, `§124:4115`). Kenyataannya, aplikasi di
`apps/desktop` adalah Tauri + React 19 yang sudah punya **identitas visual
yang berbeda dan matang**: "warm utility" — stone hangat, satu aksen amber,
Segoe UI + Cascadia Code, radius 2/4/6, dan larangan tegas atas gradient,
glass, serta glow (`apps/desktop/DESIGN.md:14`, `:45`, `:51`), yang
token-nya sudah diimplementasikan penuh di `apps/desktop/src/index.css` dan
sudah dipakai konsisten oleh 11 route. Jadi kesenjangannya **bukan** "UI
belum digarap", melainkan: (a) identitas visual yang aktif di kode
bertentangan frontal dengan `DESIGN.md`, dan (b) lapisan struktur yang
diminta `DESIGN.md` — application shell, topbar, command palette, dan
lapisan umpan-balik bersama (`dialog`, `toast`, `tooltip`) — memang **belum
ada sama sekali** di dependency maupun kode, sehingga setiap halaman
menyelesaikan masalah yang sama dengan caranya sendiri (bukti:
`window.confirm` mentah di tiga route, padding halaman yang tidak seragam,
dan kontrol Theme yang tersimpan ke backend tetapi tidak pernah
diterapkan).

---

## 2. Penilaian Redesign

> Catatan metodologi: tugas menyebut "REDESIGN.md Step 1". **Tidak ada file
> bernama `REDESIGN.md` di repo ini** (dicari dengan `find . -iname
> "REDESIGN.md"` di luar `node_modules` dan `target` — nol hasil). Struktur
> penilaian di bawah ini mengikuti nomenklatur Step 1 yang diminta di brief
> (pertahankan / restrukturisasi / sumber kemediokritasan / transformation
> mode / jumlah arah desain), bukan mengutip file yang tidak ada.
> `[BELUM DIVERIFIKASI]`: apakah `REDESIGN.md` ada di luar repo ini.

### 2a. Yang harus dipertahankan

**(i) Identitas produk "warm utility".**
`apps/desktop/DESIGN.md:7` mendefinisikan DevX sebagai "workshop panel for
Windows … a control surface that sits open next to an editor all day …
It should feel like an instrument, not a website." Identitas ini bukan
wacana — ia punya implementasi yang dapat ditunjuk:

- Token warna hangat: `apps/desktop/src/index.css:50` (`.dark`
  `--background: oklch(0.145 0.008 70)`, hue ~70) dan `:16` (light
  `oklch(0.972 0.006 80)`).
- Satu aksen amber sebagai "power lamp": `apps/desktop/src/index.css:56`
  (`--primary: oklch(0.78 0.14 70)`) dan `:22` untuk light.
- Radius mesin: `apps/desktop/src/index.css:109`–`:112`
  (`--radius-sm: 2px; --radius-md: 4px; --radius-lg: 6px; --radius-xl: 6px`).
- Larangan efek: `apps/desktop/DESIGN.md:51`
  ("No gradients, no glass, no glow, no background textures.").

**Pertahankan.** Ini adalah pilihan desain yang punya alasan tertulis dan
sudah konsisten di kode. Membuangnya berarti membuang pekerjaan yang sudah
selesai dan benar.

**(ii) Lapisan token kontrak shadcn/ui.**
`apps/desktop/src/index.css:7` menyatakan token mengikuti kontrak shadcn/ui
"so generated components work unchanged", dan `@theme inline` di `:80`–`:116`
memetakan seluruh token semantik ke utility Tailwind v4. Ini infrastruktur
yang membuat setiap perubahan visual berikutnya murah. **Pertahankan
sebagai satu-satunya jalur perubahan warna.**

**(iii) Pola "Real-Time Monitor" dan disiplin datanya.**
`MASTER.md:92` menetapkan setiap layar sebagai monitor yang dibangun di
sekitar satu keputusan. Ini sudah diimplementasikan dengan sengaja:
komentar `apps/desktop/src/routes/dashboard.tsx:21`–`:25` menyatakan
dashboard adalah monitor dengan failed service diurutkan lebih dulu, dan
`apps/desktop/src/components/status-dot.tsx:16`–`:20` menyatakan status =
dot + label + ikon alert untuk failed, bukan warna saja. **Pertahankan**;
ini justru bagian yang paling matang dari UI saat ini.

**(iv) Fungsi bisnis dan alur utama.**
11 route (`apps/desktop/src/App.tsx:25`–`:37`) dengan 63 test yang lulus
(lihat §5) mencakup fungsi nyata: install komponen
(`apps/desktop/src/routes/components.tsx`), supervise service termasuk PHP
pool/worker/scheduler (`apps/desktop/src/routes/services.tsx:56`), site +
HTTPS (`apps/desktop/src/routes/sites.tsx`), query database
(`apps/desktop/src/routes/databases.tsx:71`), mail catcher
(`apps/desktop/src/routes/mail.tsx:158`), tunnel `share`
(`apps/desktop/src/routes/share.tsx`), terminal (`apps/desktop/src/routes/terminal.tsx:190`),
diagnostics (`apps/desktop/src/routes/diagnostics.tsx`), settings
(`apps/desktop/src/routes/settings.tsx`). **Pertahankan seluruh perilaku.**

**(v) Kontrak Rust ↔ React.** `§131` Rule 8 ("Rust owns system truth").
`apps/desktop/src/bindings.ts` adalah file generated (`specta`), dan
`crates/devx-core/src/config.rs:50` mendefinisikan `General.theme` sebagai
tipe yang di-serialize lintas IPC. **Pertahankan batas ini utuh.**

### 2b. Yang boleh direstrukturisasi

**Layout.** Shell saat ini hanya dua kolom tanpa chrome:
`apps/desktop/src/components/app-shell.tsx:46` membungkus `<div
className="flex h-full">` dengan `<nav>` (baris `:47`) dan `<main>` (baris
`:89`). Tidak ada topbar, tidak ada baris status, tidak ada panel bawah.
`§4:222` meminta topbar + opsional bottom panel/terminal; ini murni
penambahan struktur, bukan penulisan ulang halaman.

**Hierarki informasi.** `§89` (Information Hierarchy, 4 level) dan `§18`
(Summary Cards). Saat ini dashboard memakai `PageHeader` + grid 3 kolom
(`apps/desktop/src/routes/dashboard.tsx:55`, `:120`). Hierarki di dalam
halaman boleh ditata ulang tanpa mengubah data yang ditampilkan.

**Komponen & interaksi.** Ini area terbesar yang boleh berubah, karena
sebagian besar primitif `§125:4199` belum ada. Terverifikasi absen di
`apps/desktop/src` (pencarian dengan `command grep -rF`, lihat catatan
grep di §5): `Dialog`, `Modal`, `Toast`, `Tooltip`, `Popover`,
`DropdownMenu`, `Sheet`, `ContextMenu`, `CommandPalette`,
`Notification`, `Topbar`, `StatusStrip`, `Accordion`, `Portal` — semuanya
0 hasil. `node_modules` juga tidak memuat radix, cmdk, sonner, framer,
atau zustand (dicek lewat `ls node_modules` + `command grep -iE`).

**Bahasa visual.** Boleh direstrukturisasi **hanya sebatas token** di
`apps/desktop/src/index.css` (radius scale, font stack, shadow), tanpa
menyentuh markup halaman. Ini penting agar eksekusi perubahan warna tidak
menjadi 11 penulisan ulang halaman.

**Navigasi.** `§3:129` meminta 9 seksi + daftar PROJECTS + SYSTEM STATUS.
`apps/desktop/src/components/app-shell.tsx:25`–`:37` mendefinisikan 11 item
datar tanpa pengelompokan, tanpa hitungan, tanpa daftar project, dan tanpa
footer status. Grup, hitungan, collapse, dan footer boleh ditambahkan.

### 2c. Satu sumber utama kemediokritasan desain saat ini

**Tidak adanya satu application shell dan satu lapisan interaksi bersama;
sebagai akibatnya setiap route menyelesaikan masalah shell yang sama dengan
solusinya sendiri.**

Alasan berbasis kode:

1. **Shell tidak punya chrome.** `apps/desktop/src/components/app-shell.tsx`
   berakhir di baris `:92` dan seluruh isinya adalah `<nav>` + `<main>`.
   Tidak ada topbar (`§6:345`), tidak ada global search (`§57:2356`),
   tidak ada status strip (`§118:3939`). Setiap halaman karena itu dimulai
   langsung sebagai kolom konten penuh.
2. **Setiap route menegosiasikan ulang padding dan lebar sendiri.**
   `apps/desktop/src/routes/dashboard.tsx:55` (`space-y-5 p-5`),
   `sites.tsx:160` (`space-y-4 p-5`), `services.tsx:66`
   (`space-y-4 p-5`), tetapi `mail.tsx:115`
   (`mx-auto w-full max-w-5xl space-y-4 p-5`), `terminal.tsx:137`
   (`max-w-4xl`), `share.tsx:64` (`max-w-3xl … p-6`), `settings.tsx:226`
   dan `:237` (`p-6`). Tidak ada satu komponen page-shell; `p-5`/`p-6` dan
   empat `max-w-*` berbeda dipilih per halaman. Token `--spacing-app` yang
   dimaksudkan untuk ini didefinisikan di `index.css:115` dan **tidak
   dipakai di mana pun** (0 hasil pencarian `spacing-app` di `src/`).
3. **Ketiadaan primitif memaksa solusi mentah.** Karena tidak ada dialog
   dan toast, tiga route turun ke `window.confirm` bawaan browser:
   `databases.tsx:431`, `diagnostics.tsx:147`, `mail.tsx:158`. Ini melanggar
   `§35:1673` (konfirmasi destruktif harus menjelaskan akibatnya, bukan
   dialog native satu baris) dan `§34:1634` (satu primitif dialog bersama).
   Karena tidak ada toast, umpan balik sukses/gagal tidak seragam —
   dashboard bahkan membuat sendiri kartu error ad-hoc dengan `role="alert"`
   di `dashboard.tsx:95`–`:110`, sementara route lain memakai
   `Callout`/`EmptyState`.
4. **Kontrol yang tampak berfungsi tetapi tidak melakukan apa pun.** Ini
   gejala paling tajam dari akar yang sama. `settings.tsx:419`–`:433`
   merender `<Select id="theme">` dengan pilihan "Follow Windows", "Dark",
   "Light", dan menulisnya ke config backend
   (`crates/devx-core/src/config.rs:50` `pub theme: Theme`, default
   `Theme::System` di `:64`) — tetapi **tidak ada satu baris pun di
   frontend yang membaca nilai itu untuk mengubah theme**. Theme
   di-hardcode di `apps/desktop/index.html:2` (`<html lang="en"
   class="dark">`). Pengguna memilih "Light", nilai tersimpan, dan UI tidak
   berubah. Ini melanggar `§9:510` (light theme wajib didukung), `§74:2895`
   (theme ditangani secara terpusat), dan `§131` Rule 7 ("Never let a click
   appear to do nothing").

Poin 4 sengaja diletakkan di bawah akar yang sama, bukan sebagai akar
terpisah: theme tidak diterapkan justru karena tidak ada lapisan
cross-cutting tempat hal seperti itu tinggal. Memperbaiki shell dan
lapisan primitif akan memberi tempat bagi perbaikan theme; memperbaiki
theme sendirian tidak menyelesaikan 3 masalah lain di atas.

### 2d. Transformation mode

**Rekomendasi: `Layout Restructure`.**

Alasan memilih mode ini, dan bukan yang lebih ringan atau lebih berat:

- **Bukan `Refinement`.** Refinement menyempurnakan bahasa visual yang ada
  tanpa mengubah struktur. Itu tidak cukup, karena tiga hal yang paling
  kritis bersifat struktural, bukan kosmetik: (a) topbar, status strip, dan
  bottom terminal adalah **penambahan region layout** yang mengubah
  `apps/desktop/src/components/app-shell.tsx:46`–`:90` dari dua kolom
  menjadi shell berlapis; (b) command palette adalah **overlay global**
  yang butuh provider di atas router di `apps/desktop/src/main.tsx:26`–`:33`;
  (c) theme butuh **pembacaan config di root** dan penghapusan
  `class="dark"` hardcoded di `index.html:2`. Tidak satu pun bisa dicapai
  dengan memoles.
- **Bukan `Full Redesign`.** Bahasa visual, token, 11 route, 63 test, dan
  batas IPC sudah ada dan saling konsisten. `MASTER.md:7`–`:13` bahkan
  mencatat bahwa konflik palet sudah pernah direkonsiliasi secara sadar
  ("the conflict is resolved in favor of brand"). Menulis ulang dari nol
  akan membuang pekerjaan yang sudah benar dan tidak menyelesaikan masalah
  inti, yaitu ketiadaan shell.
- **Syarat eskalasi (penting).** Mode ini berlaku **hanya jika** keputusan
  C-01 di §3 diambil ke arah mempertahankan identitas hangat. Jika pengguna
  memutuskan `DESIGN.md` §8/§9 menang atas `apps/desktop/DESIGN.md`
  (navy + ungu + glass + glow), maka mode otomatis naik menjadi
  **`Full Redesign`** — karena saat itu token, seluruh halaman, dan
  larangan di `apps/desktop/DESIGN.md:51` harus ditulis ulang, bukan
  direstrukturisasi.

### 2e. Jumlah arah desain yang disarankan

**Satu arah desain.**

Alasan: identitas visual sudah diputuskan dan sudah dikodekan, dan
`MASTER.md:7`–`:13` mencatat rekonsiliasi eksplisit antara rekomendasi
database dan identitas tulisan tangan. Mengeksplorasi tiga arah visual akan
meminta pengguna memilih di antara opsi yang dua di antaranya sudah jelas
akan ditolak oleh larangan di `apps/desktop/DESIGN.md:51`, dan akan
menghabiskan anggaran pada sumbu (warna) yang bukan sumbu masalah (struktur,
lihat §2c).

Pengecualian: bila pengguna membuka kembali konflik palet di C-01 dan
memilih `DESIGN.md`, maka tiga arah menjadi masuk akal — tetapi itu adalah
proyek yang berbeda (`Full Redesign`, lihat §2d), bukan varian dari rencana
ini. Arah tunggal yang disarankan: **"instrument panel" hangat yang
dilengkapi chrome** — token dan bahasa visual sekarang dipertahankan, lalu
ditambahkan topbar, sidebar berstruktur, status strip, command palette, dan
lapisan `dialog`/`toast`/`tooltip` bersama.

---

## 3. Register konflik & keputusan pengguna

Kolom **"apa kata DESIGN.md"** merujuk nomor bagian dari `DESIGN.md` root
(satu-satunya dokumen yang bernomor). Kolom **"kondisi saat ini"** merujuk
`path:line`. Baris C-01…C-07 adalah tujuh item wajib yang disebut di brief;
C-08…C-13 adalah temuan tambahan yang juga memerlukan keputusan.

| ID | Item | Apa kata DESIGN.md (nomor bagian) | Kondisi saat ini di repo (path:line) | Dampak | Keputusan yang perlu diambil user |
|---|---|---|---|---|---|
| **C-01** | Palet / accent | `§8:426`, accent primary `--accent: #7567FF` (`§8:468`) + accent light `#6256E8` (`§9:533`); `§8:506` "Purple is the primary product accent"; background navy `#070B14`; token `§73:2853` | Warm stone + amber tunggal: `apps/desktop/src/index.css:22` (`--primary: oklch(0.62 0.14 65)`) dan `:56` (`oklch(0.78 0.14 70)`); background `:16`, `:50`; alasan tertulis di `apps/desktop/DESIGN.md:14`–`:25` ("one amber power lamp", "An accent everywhere is no accent") | **Tertinggi.** Menentukan warna seluruh 11 route. Ini juga penentu apakah mode di §2d tetap `Layout Restructure` atau naik ke `Full Redesign` | Pilih satu otoritas visual: (a) pertahankan warm + amber dan turunkan `DESIGN.md` jadi referensi struktur saja, atau (b) adopsi navy + ungu `DESIGN.md` dan tulis ulang `index.css` + `apps/desktop/DESIGN.md`. Tidak ada opsi campuran: `apps/desktop/DESIGN.md:51` melarang efek yang `DESIGN.md` wajibkan |
| **C-02** | Surface & efek (glass/glow/gradient/particle) | `§13:658` glow aksen `0 0 24px rgba(117,103,255,.16)` (`§13:676`); `§14:692` glass `rgba(13,20,34,.82)` + `backdrop-filter: blur(14px)` (`§14:704`); `§15:715` ambient particle field (`§15:731`); `§86:3183` radial gradient/orb/particle; `§87:3204` glow pada CTA/nav aktif | Larangan tegas dan eksplisit: `apps/desktop/DESIGN.md:51` "No gradients, no glass, no glow, no background textures. Flat color and borders carry hierarchy"; shadow hanya elevasi popover/dialog (`:49`); di kode, `Card` hanya `shadow-sm` (`apps/desktop/src/components/ui/card.tsx:10`) | **Tinggi.** Glass/glow adalah bahasa visual lintas-aplikasi, bukan detail; mengadopsinya menyentuh setiap surface. Berbeda dari C-01, ini tidak bisa diselesaikan lewat token saja | Pilih: (a) pertahankan flat (disarankan, konsisten dengan C-01a), atau (b) adopsi glass + glow + particle dan hapus larangan `apps/desktop/DESIGN.md:51`. Bila (b), keputusan harus mencakup `prefers-reduced-motion` untuk particle (`§15:754`) |
| **C-03** | Tipografi | `§10:544` UI face `Inter` (`:549`), mono `JetBrains Mono` (`:561`), type scale Display 32 → Code 12, maksimal 4 weight | UI face Segoe UI stack + mono Cascadia Code: `apps/desktop/src/index.css:113` (`--font-mono: "Cascadia Code", "JetBrains Mono", ui-monospace, monospace`); alasan di `apps/desktop/DESIGN.md:29`–`:31`. Catatan: mono sudah menyertakan JetBrains Mono sebagai fallback; sebaliknya **tidak ada** `--font-sans` yang dideklarasikan (0 hasil pencarian `font-sans` di `index.css`) sehingga UI face mengandalkan default Tailwind/system | Sedang–tinggi. Menambah `Inter` berarti menambah webfont — `apps/desktop/DESIGN.md:29` menyebut ini "decoration" untuk aplikasi Windows-only. Skala type `§10` juga belum dipetakan ke utility Tailwind | Pilih: (a) pertahankan Segoe UI + Cascadia Code dan deklarasikan eksplisit `--font-sans`, atau (b) adopsi Inter + JetBrains Mono sebagai bundle font. Terpisah: apakah type scale `§10` diadopsi sebagai token |
| **C-04** | Radius & skala | `§12:632` radius-xs 4 / sm 6 / md 8 / lg 12 / xl 16 / 2xl 20; guideline inputs 8, buttons 8, cards 12, dialogs 16, palette 14, pills 999; token `§73:2877` (`--radius-md: 8px`) | Radius mesin 2/4/6: `apps/desktop/src/index.css:109`–`:112` (`sm 2px, md 4px, lg 6px, xl 6px`) + `--radius: 0.375rem` (`:15`); alasan di `apps/desktop/DESIGN.md:47`–`:48` ("Machined edges, not pills"). **Konflik internal yang sudah ada:** `apps/desktop/DESIGN.md:47` menyebut badge 2px, tetapi `Badge` memakai `rounded-full` (`apps/desktop/src/components/ui/badge.tsx:7`) — yaitu pill 999px, yang justru cocok dengan `§12` | Sedang. Perubahan radius adalah perubahan token terpusat, jadi biayanya rendah; tetapi arahnya berlawanan (2/4/6 mesin vs 8/12/16 lembut) dan persepsi produk berubah nyata | Putuskan skala radius final. Sekalian putuskan kontradiksi badge: `apps/desktop/DESIGN.md:47` (2px, bukan pill) vs `badge.tsx:7` (`rounded-full`) vs `§12` (pill 999px). Perlu ditetapkan mana yang benar sebelum badge disentuh |
| **C-05** | Nama produk | Judul dokumen `DevBox UI Design System` (`DESIGN.md:1`); `§5` sidebar menampilkan "DevBox v2.1.0" | Aplikasi bernama **DevX**: `apps/desktop/src-tauri/tauri.conf.json:2` (`"productName": "DevX"`), `:14` (`"title": "DevX"`), `:4` (`identifier: dev.devx.desktop`), `:41` (`externalBin: binaries/devx-helper`, `binaries/devx`); wordmark UI di `apps/desktop/src/components/app-shell.tsx:53`; `apps/desktop/index.html:6`. Pencarian `DevBox` di seluruh repo (`.ts/.tsx/.rs/.json/.md`, di luar `node_modules`/`target`) hanya menemukan **satu** file: `DESIGN.md` sendiri | Rendah secara teknis, tinggi secara kebingungan. Tidak ada kode yang perlu diubah untuk tetap "DevX" | Konfirmasi bahwa "DevX" adalah nama final dan `DESIGN.md` sekadar memakai nama lama. Jika ya, tidak ada aksi. Jika tidak, ini menjadi pekerjaan rebrand terpisah yang menyentuh bundle, binary, icon, dan installer — **di luar** rencana ini |
| **C-06** | Information Architecture | `§3:129` sidebar: HOME, RUNTIMES, SERVERS, SITES, DATABASES, CONTAINERS, ENVIRONMENT, TOOLS, EXTENSIONS, lalu PROJECTS + daftar project, lalu SYSTEM STATUS; route `§3:156` mencakup `/runtimes`, `/servers`, `/containers`, `/environment`, `/tools`, `/extensions`, `/projects` | Route aktual di `apps/desktop/src/App.tsx:25`–`:37`: `/`, `/components`, `/services`, `/sites`, `/logs`, `/terminal`, `/share`, `/databases`, `/mail`, `/diagnostics`, `/settings`. Nav datar tanpa grup di `apps/desktop/src/components/app-shell.tsx:25`–`:37`. Tidak ada `/runtimes`, `/servers`, `/containers`, `/environment`, `/tools`, `/extensions`, `/projects`. Sebaliknya `/mail`, `/share`, `/logs`, `/components` tidak ada di IA `§3` | **Tinggi.** Rename route menyentuh `App.tsx`, `app-shell.tsx`, setiap `NavLink`, `Link` (mis. `apps/desktop/src/routes/dashboard.tsx:110` menuju `/services`), dan 9 file test | Putuskan: (a) **pertahankan route sekarang** sebagai IA final dan turunkan `§3` menjadi referensi (disarankan — IA aktual lebih dekat ke produk nyata: mail catcher dan share tunnel memang fitur DevX), atau (b) tambah route `§3` yang belum ada (`/runtimes`, `/containers`, `/environment`, `/tools`, `/extensions`, `/projects`) sebagai halaman baru, atau (c) rename penuh ke skema `§3` termasuk memindahkan `/components` → `/runtimes`+`/tools` dan `/mail`+`/share`+`/logs`+`/diagnostics` → `/tools`. Opsi (c) adalah `Full Redesign` dari sisi navigasi |
| **C-07** | Shell & fitur (topbar, palette, dialog, toast, tooltip, notification, status strip, bottom terminal, context menu) | `§6:345` topbar 64px + global search; `§57:2356` search global + ranking; `§33:1571` command palette `Ctrl+K`; `§92:3352`/`§93:3376` palette sebagai power layer; `§34:1634` modal system; `§35:1673` confirmation dialog; `§36:1699` toast bottom-right 320–420px; `§94:3399` tooltip delay 350–500ms; `§98:3468` notification center; `§118:3939`/`§119:3962` system status; `§31:1485` bottom terminal 280px; `§47:2051` context menu | **Belum ada:** topbar, global search, `CommandPalette`, `Toast`, `Tooltip`, `Dialog`/`Modal`, `ContextMenu`, `Notification`, `StatusStrip` — semuanya 0 hasil di `apps/desktop/src`; tidak ada dependency pendukung di `node_modules` (radix/cmdk/sonner absen). Bottom terminal drawer belum ada sebagai drawer. **Sudah ada:** Tabs (`§64:2561`) sebagai `TabBar` di `apps/desktop/src/routes/services.tsx:119`; Terminal (`§31`) sebagai route penuh di `apps/desktop/src/routes/terminal.tsx:137`; state loading/empty/error parsial lewat `EmptyState`/`Callout`/`Progress`; fokus ring (`apps/desktop/src/components/ui/button.tsx:7`, `apps/desktop/src/components/ui/input.tsx:11`); reduced-motion (`apps/desktop/src/index.css:161`); sidebar dasar (`apps/desktop/src/components/app-shell.tsx:47`) | **Tinggi**, tetapi terkonsentrasi di Phase 1–2 `§124` dan tidak menyentuh logika bisnis. Setengah item adalah "menambah", bukan "mengubah" | Prioritisasi bertahap. Keputusan per item: (a) setujui urutan di §4; (b) putuskan apakah command palette dibangun tangan (tanpa dependency, sesuai `§131` Rule 9) atau menambah dependency; (c) putuskan apakah `window.confirm` di `databases.tsx:431`, `diagnostics.tsx:147`, `mail.tsx:158` diganti dialog `§35` (disarankan) atau dibiarkan; (d) putuskan apakah notification center `§98` dan context menu `§47` masuk scope atau ditunda |
| **C-08** | Theme runtime (dead control) | `§9:510` light theme wajib didukung; `§74:2895` theme ditangani terpusat; `§131:4411` Rule 7 "Never let a click appear to do nothing" | Theme di-hardcode: `apps/desktop/index.html:2` (`<html lang="en" class="dark">`); kontrol Theme di `apps/desktop/src/routes/settings.tsx:419`–`:433` (opsi `system`/`dark`/`light`) menulis ke config backend (`crates/devx-core/src/config.rs:50` `pub theme: Theme`, default `Theme::System` di `:64`) tetapi **tidak ada** kode frontend yang membaca nilai itu dan menerapkannya (0 hasil pencarian `classList`/`documentElement` di `apps/desktop/src`) | **Tinggi (bug fungsional).** Pengguna memilih "Light" → nilai tersimpan di config tetapi UI tidak berubah. Token light sudah ada dan lengkap (`apps/desktop/src/index.css:14`–`:44`) namun tidak pernah aktif | Putuskan apakah theme switching masuk scope sekarang. Jika ya, ini P1 dan sekaligus menghidupkan token light yang sudah ditulis. Jika tidak, keputusan harus mencakup: hapus/disable kontrol theme di `settings.tsx:419` agar tidak menipu pengguna, atau beri label "belum diterapkan" |
| **C-09** | Desktop baseline (ukuran window) | `§4:241` minimum width 1100px, minimum height 700px, ideal canvas 1536×960; `§4` juga menyebut sidebar collapse, panel resizing, dense mode | Jendela aktual: `apps/desktop/src-tauri/tauri.conf.json:15`–`:18` (width 1180, height 780, minWidth 940, minHeight 600). Tidak ada sidebar collapse maupun dense mode di `apps/desktop/src/components/app-shell.tsx` | Rendah–sedang. `§4` adalah target desain, bukan batasan keras; tetapi `minWidth: 940` berarti tata letak yang butuh ≥1100px akan pecah di ukuran minimum yang diizinkan aplikasi sendiri | Putuskan apakah `minWidth`/`minHeight` dinaikkan ke baseline `§4` (1100×700), atau baseline `§4` diturunkan agar sesuai jendela aktual. Sekalian: apakah sidebar collapse (`§5`, width 68px) masuk scope |
| **C-10** | Sidebar: ukuran, struktur, status | `§5:265` expanded 232px (`:272`), collapsed 68px (`:278`), transisi 220ms `cubic-bezier(0.22,1,0.36,1)`; struktur dengan hitungan per item, blok PROJECTS, dan footer "● System Ready" (`§118:3939`) | Lebar tetap `w-52` = 208px (`apps/desktop/src/components/app-shell.tsx:49`), 11 item datar tanpa grup/hitungan (`:25`–`:37`), tanpa collapse, tanpa daftar project, tanpa footer status. Marker aktif berupa bar tipis amber (`:76`–`:79`) yang sudah sesuai `§5` ("Thin left accent line") | Sedang. Ditambah sebagai struktur, bukan diubah; tidak menyentuh logika | Setujui 232px + mode collapsed 68px, dan putuskan sumber data hitungan/status: **wajib** dari IPC yang ada (`§131` Rule 8 "Rust owns system truth") — jangan menghitung atau mengarang di React |
| **C-11** | Konfirmasi destruktif & umpan balik async | `§35:1673` dialog destruktif harus menjelaskan akibat ("Never use 'Are you sure?' by itself"); `§36:1699` toast untuk hasil operasi; `§131:4411` Rule 7 setiap operasi async butuh umpan balik; `§120:3979` anti-pattern #9 "Modal for every action" | Tiga route memakai `window.confirm` native: `apps/desktop/src/routes/databases.tsx:431`, `apps/desktop/src/routes/diagnostics.tsx:147`, `apps/desktop/src/routes/mail.tsx:158`. Tidak ada toast; umpan balik salah satu dibuat ad-hoc sebagai `Card` + `role="alert"` di `apps/desktop/src/routes/dashboard.tsx:95`–`:110` | Sedang–tinggi (konsistensi + UX). `window.confirm` diblokir secara modal oleh webview dan tidak bisa diberi gaya, sehingga tidak mungkin memenuhi `§35` | Setujui pembuatan `Dialog` dan `Toast` di Phase 1, dan ganti tiga `window.confirm` tersebut. Perlu dicatat: `§120` anti-pattern #9 melarang modal untuk *segala* hal — jadi pemetaannya harus eksplisit: hanya aksi destruktif yang dapat dialog |
| **C-12** | Kanvas jendela: warna luar & titlebar | `§100:3519` window controls (dibahas `DESIGN.md`); `§4:222` shell | `apps/desktop/src-tauri/tauri.conf.json:21` (`"decorations": true`) — memakai dekorasi window bawaan OS. Tidak ada custom titlebar atau window controls di `apps/desktop/src` (0 hasil `Topbar`) | Rendah. Dekorasi bawaan OS justru konsisten dengan `§99`/`§100` (tray + jendela native) dan dengan identitas "workshop panel for Windows" (`apps/desktop/DESIGN.md:9`) | Konfirmasi: pertahankan `decorations: true` dan lewati `§100` (disarankan), atau bangun custom titlebar |
| **C-13** | Preferensi dependency untuk primitif baru | `§125:4199` merekomendasikan daftar primitif (Button, Tooltip, Popover, DropdownMenu, Dialog, Drawer, Toast, Skeleton, Table, DataList, CommandPalette, dll.); `§131:4411` Rule 9 "Avoid unnecessary dependencies — Only introduce a UI library when it solves a real problem and fits the visual system" | Yang sudah ada: 10 primitif di `apps/desktop/src/components/ui/` (`badge`, `button`, `callout`, `card`, `empty-state`, `input`, `label`, `progress`, `select`, `switch`) + `page-header`, `status-dot`, `app-shell`. Yang diminta `§125` tetapi belum ada: `Tooltip`, `Popover`, `DropdownMenu`, `Dialog`, `Drawer`, `Toast`, `Skeleton`, `Table`, `DataList`, `CommandPalette`, `Breadcrumb`, `Combobox`, `Checkbox`, `Radio`, `SearchInput`, `IconButton`. Tersedia di `node_modules`: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` | **Tinggi (menentukan bentuk seluruh Phase 1).** `apps/desktop/src/components/ui/select.tsx:9` menunjukkan preseden yang jelas: "A native control is deliberate: it gets keyboard behaviour, screen reader…" — artinya proyek ini cenderung memilih elemen native daripada library | Ambil satu kebijakan untuk semua primitif baru: (a) **native HTML + Tailwind tanpa dependency** (konsisten dengan `select.tsx:9` dan Rule 9; `<dialog>` untuk Dialog, `<table>` untuk Table, CSS untuk Tooltip), atau (b) tambah library headless (radix/cmdk) yang harus dibungkus token hangat, atau (c) campuran. Ini harus diputuskan sekali di awal, karena setiap primitif berikutnya bergantung padanya |

---

## 4. Rencana perubahan UI bertahap

Pengelompokan mengikuti `§124:4115` (Phase 1 Design foundation → Phase 6
Polish). Kolom **Dampak/Biaya** menentukan urutan; item diurutkan dari
dampak tertinggi per biaya terendah **di dalam** fase, dan fase dijalankan
berurutan karena `§124` menyatakan "Build in this order".

Prioritas: **P1** = memblokir atau memperbaiki pelanggaran aturan yang
sudah ada; **P2** = dibutuhkan untuk paritas dengan `§124`; **P3** =
penyempurnaan.

Setiap item bergantung pada **C-13** (kebijakan dependency) dan, untuk
semua item visual, pada **C-01** (otoritas palet).

### Phase 1 — Design foundation (`§124:4119`)

| ID | Tujuan | File target (path + area) | Perubahan konkret | Rujukan | Dependensi / urutan | Risiko | Verifikasi | Prio |
|---|---|---|---|---|---|---|---|---|
| **F-01** | Menghidupkan theme runtime sehingga kontrol Theme benar-benar bekerja, dan menghapus theme hardcode | `apps/desktop/index.html:2`; hook baru `apps/desktop/src/lib/use-theme.ts`; di-wire di `apps/desktop/src/App.tsx:18`–`:21` atau `main.tsx:26` | Baca `general.theme` dari config yang sudah ada, terapkan `document.documentElement.classList.toggle("dark", …)`, tangani `Theme::System` lewat `matchMedia("(prefers-color-scheme: dark)")`, hapus `class="dark"` statis di `index.html:2` | `§9:510`, `§74:2895`, `§131` Rule 7 (C-08) | Bebas; sebaiknya pertama karena membuka jalan verifikasi visual light/dark untuk semua item lain | Goresan warna singkat saat hidrasi (FOUC) karena config datang lewat IPC asinkron; perlu nilai default sebelum config tiba | Test baru: theme `light`/`dark`/`system` menghasilkan class yang benar. Manual: ubah Theme di Settings, UI berubah tanpa reload | **P1** |
| **F-02** | Primitif `Dialog` bersama, menggantikan `window.confirm` | Baru: `apps/desktop/src/components/ui/dialog.tsx`; pemakaian di `apps/desktop/src/routes/databases.tsx:431`, `apps/desktop/src/routes/diagnostics.tsx:147`, `apps/desktop/src/routes/mail.tsx:158` | Satu primitif (lihat C-13 untuk pilihan native `<dialog>` vs library): title + description + content + footer Cancel/Confirm, overlay sesuai `§34:1634`; teks `§35:1673` menyebut akibat konkret, bukan "Are you sure?" | `§34:1634`, `§35:1673`, `§120` anti-pattern #9 (C-11) | C-13; setelah F-01 agar bisa diverifikasi di dua theme | Mengubah alur konfirmasi menyentuh test yang ada pada tiga route tersebut — test harus diperbarui, dan itu perubahan test, bukan logika | `npm test` (test route terkait harus diubah agar mencari elemen dialog, bukan `window.confirm`); manual: aksi destruktif menampilkan dialog bertema | **P1** |
| **F-03** | Primitif `Toast` + provider untuk umpan balik async | Baru: `apps/desktop/src/components/ui/toast.tsx` (+ provider); di-wire di `apps/desktop/src/main.tsx:26`–`:33`; pemakaian awal di `apps/desktop/src/routes/dashboard.tsx:39`–`:49` (mutasi `startAll`/`stopAll`) | Toast bottom-right, lebar 320–420px, durasi per tipe (success 4s, info 5s, warning 6s, error persisten/8s), aksi "View Details" untuk error | `§36:1699`, `§131` Rule 7, `§77` notifikasi/error (C-11) | C-13; F-01 (dua theme) | Provider menambah satu lapisan di pohon komponen; test yang me-render route tunggal harus ikut membungkus provider — berpotensi menyentuh `apps/desktop/src/test/render.tsx` | `npm test`; tambah assertion bahwa mutasi memunculkan toast. Manual: start/stop service memunculkan toast | **P1** |
| **F-04** | Primitif `Tooltip` untuk aksi ikon-saja | Baru: `apps/desktop/src/components/ui/tooltip.tsx`; pemakaian pertama di tombol ikon yang ada | Tooltip dengan delay 350–500ms, untuk tombol ikon-saja dan path terpotong; **tidak** untuk tombol teks | `§94:3399`, `§123:4091` ("Tooltips exist for icon-only actions") | C-13; F-01 | Delay berbasis timer mudah bocor saat `unmount`; aksesibilitas (harus muncul saat fokus keyboard, bukan hanya hover) | Manual + keyboard: Tab ke tombol ikon → tooltip muncul. `npm run typecheck` untuk tipe | **P2** |
| **F-05** | Primitif `DropdownMenu` | Baru: `apps/desktop/src/components/ui/dropdown-menu.tsx` | Menu ringkas untuk aksi per-baris tabel dan untuk panel topbar; fondasi bagi `§47` di Phase 5 | `§125:4199`, prasyarat `§47:2051` | C-13; F-01 | Fokus trap dan penutupan via Esc/klik-luar mudah salah; harus diuji keyboard | Manual keyboard: buka dengan `Enter`, navigasi `↑`/`↓`, tutup `Esc` | **P2** |
| **F-06** | Skala tipografi & token font eksplisit | `apps/desktop/src/index.css:80`–`:116` (`@theme inline`), `:113` | Deklarasikan `--font-sans` eksplisit (saat ini tidak ada — lihat C-03) dan, bila C-03 memilih opsi (a), dokumentasikan Segoe UI sebagai pilihan; petakan type scale `§10:570` ke token/utility | `§10:544`, `§11:597` (C-03, C-04) | C-01, C-03, C-04 (keputusan dulu, baru tulis token) | Menyentuh token yang dipakai seluruh halaman; salah petakan = regresi tipografi global | Manual + `npm run build`; bandingkan beberapa halaman di dua theme | **P2** |
| **F-07** | Higiene token (hapus token mati, satukan padding halaman) | `apps/desktop/src/index.css:115` (`--spacing-app`, tidak dipakai); `apps/desktop/src/routes/{dashboard,services,sites,logs,diagnostics}.tsx` (`p-5`), `mail.tsx:115`/`terminal.tsx:137`/`share.tsx:64` (`max-w-*`, `p-6`), `settings.tsx:226`,`:237` (`p-6`) | Hapus atau pakai `--spacing-app`; tetapkan satu nilai padding page-shell (MASTER.md:74 menetapkan 20px) dan satu perlakuan lebar maksimum, lalu terapkan ke semua route | `§11:597`, `§123:4091`, `MASTER.md:62`, `MASTER.md:74` (C-04) | Setelah F-01; menyentuh hampir semua route sehingga paling baik dikerjakan sebagai satu sapuan | Menyentuh 11 file sekaligus; risiko konflik dengan pekerjaan lain. Tidak mengubah perilaku, hanya kelas layout | `npm test` (snapshot/DOM test mungkin sensitif kelas), `npm run typecheck`; manual: bandingkan padding antar halaman | **P2** |
| **F-08** | Primitif `Table`/`DataList` | Baru: `apps/desktop/src/components/ui/table.tsx`; pemakaian di tabel yang kini ditulis tangan (mis. `apps/desktop/src/routes/sites.tsx:595`, `apps/desktop/src/routes/databases.tsx`) | Satu primitif tabel dengan spesifikasi MASTER (`MASTER.md:79`: cell padding 8px, baris dipisah border, kolom penentu lebih dulu, hover menaikkan bg satu langkah, aksi sebagai tombol ikon ≥32×32 + tooltip) | `§60:2455`, `§125:4199`, `MASTER.md:79` | F-04 (tooltip), F-05 (menu baris) | Tabel saat ini punya markup dan test spesifik; menggantinya menyentuh test `sites.test.tsx` (12 test) dan `databases.test.tsx` (6 test) | `npm test` untuk dua file test tersebut; manual: kolom penentu terbaca lebih dulu, hover baris terlihat | **P2** |
| **F-09** | Skeleton untuk loading | Baru: `apps/desktop/src/components/ui/skeleton.tsx`; ganti spinner di `apps/desktop/src/routes/services.tsx:74`, `apps/desktop/src/routes/dashboard.tsx:79` | `§37:1751` meminta skeleton alih-alih spinner generik bila memungkinkan | `§37:1751`, `§123:4091` | F-01 | Skeleton yang salah ukuran justru membuat layout melompat lebih buruk daripada spinner | Manual: muat halaman dengan data lambat, amati tidak ada lompatan layout | **P3** |

### Phase 2 — Application shell (`§124:4137`)

| ID | Tujuan | File target (path + area) | Perubahan konkret | Rujukan | Dependensi / urutan | Risiko | Verifikasi | Prio |
|---|---|---|---|---|---|---|---|---|
| **S-01** | Menambahkan topbar | Baru: `apps/desktop/src/components/topbar.tsx`; perubahan struktur di `apps/desktop/src/components/app-shell.tsx:44`–`:91` | Topbar setinggi 64px berisi konteks halaman, pemicu global search, dan slot notifikasi/settings/theme; `app-shell.tsx` berubah dari `flex` dua kolom menjadi kolom (topbar di atas, lalu baris sidebar+main) | `§4:222`, `§6:345` (C-07) | F-01 (tombol theme), S-03 (slot search) | Mengubah komponen yang membungkus **setiap** route; kesalahan di sini berdampak ke seluruh aplikasi. Perlu memastikan `height: 100%` di `apps/desktop/src/index.css:123`–`:127` tetap bekerja | `npm test` (semua 9 file test me-render lewat shell); manual: semua 11 route tetap dapat digulir penuh | **P1** |
| **S-02** | Merestrukturisasi sidebar | `apps/desktop/src/components/app-shell.tsx:25`–`:37` (data nav) dan `:47`–`:87` (markup) | Kelompokkan item, tambahkan hitungan per item dari IPC, tambahkan blok PROJECTS dan footer SYSTEM STATUS; lebar 232px; sediakan mode collapsed 68px | `§5:265`, `§118:3939`, `§103` sidebar behavior, (C-10) | S-01 (urutan region); sumber data project/status harus dari IPC yang ada | Hitungan dan status **wajib** berasal dari backend (`§131` Rule 8). Menghitung atau menampilkan angka palsu di React akan melanggar aturan inti. Juga: collapse menambah state UI dan transisi 220ms | `npm test`; manual: ciutkan/lebarkan, pastikan tidak ada layout shift pada konten | **P1** |
| **S-03** | Command palette + global search | Baru: `apps/desktop/src/components/command-palette.tsx`; binding keyboard di `apps/desktop/src/App.tsx:18`; provider di `apps/desktop/src/main.tsx:26`–`:33`; slot pemicu di topbar (S-01) | Overlay `Ctrl+K`, fuzzy search, grup Recent/Navigation/Commands, navigasi `↑↓`/`Enter`/`Esc`; konteks halaman mengangkat perintah relevan lebih dulu | `§33:1571`, `§92:3352`, `§93:3376`, `§57:2356` (C-07, C-13) | C-13 (dependency: cmdk atau tanpa dependency), S-01 | Binding `Ctrl+K` global harus tidak mencuri fokus saat pengguna sedang mengetik di input/terminal (`apps/desktop/src/routes/terminal.tsx:190` sudah menangani `onKeyDown`) | Test baru untuk binding dan filter; manual: `Ctrl+K` di setiap route, termasuk saat fokus di terminal dan di form Settings | **P1** |
| **S-04** | Status strip & global status model | Baru: `apps/desktop/src/components/status-strip.tsx`; pemakaian awal di `apps/desktop/src/routes/services.tsx:66`–`:100` dan `apps/desktop/src/routes/dashboard.tsx:55` | Band horizontal di bawah page header untuk state latar (MASTER.md:82: dot + label + action link); model status global yang tidak menumpuk makna | `§118:3939`, `§119:3962`, `MASTER.md:82`, `MASTER.md:92` | S-01, S-02 | Harus memakai kosakata status yang sudah ada (`apps/desktop/src/components/status-dot.tsx:6` `ServiceUiState`) dan tidak menciptakan state baru yang tidak ada di backend | `npm test`; manual: aksi dari strip mengarah ke halaman yang benar | **P2** |
| **S-05** | Selaraskan batasan jendela & dukungan resize | `apps/desktop/src-tauri/tauri.conf.json:15`–`:18` | Ubah `minWidth`/`minHeight` agar cocok dengan baseline `§4` (1100×700), atau sebaliknya selaraskan `§4` dengan jendela aktual | `§4:241`, `§58:2394` (C-09) | Keputusan C-09 | Perubahan `tauri.conf.json` menyentuh konfigurasi build/packaging; **bukan** perubahan UI murni dan harus disetujui eksplisit | Manual: jalankan app, kecilkan ke ukuran minimum, pastikan tidak ada konten terpotong; `npm run build` untuk memastikan konfigurasi tetap valid | **P3** |

### Phase 3 — Dashboard (`§124:4148`)

| ID | Tujuan | File target (path + area) | Perubahan konkret | Rujukan | Dependensi / urutan | Risiko | Verifikasi | Prio |
|---|---|---|---|---|---|---|---|---|
| **D-01** | Hierarki dashboard | `apps/desktop/src/routes/dashboard.tsx:55`–`:528` | Susun ulang per `§16:771`/`§17:816`/`§18:883`: header status, ringkasan, lalu panel; pertahankan urutan "failed first" yang sudah ada | `§16:771`, `§17:816`, `§18:883`, `§89:3256` | S-01…S-04, F-07 | Dashboard punya 5 test (`apps/desktop/src/routes/dashboard.test.tsx`) yang menguji verdict dan pengurutan; restrukturisasi tidak boleh mengubah perilaku itu | `npm test` (5 test dashboard harus tetap lulus tanpa diubah — bila harus diubah, berarti perilaku ikut berubah) | **P2** |
| **D-02** | Hapus kartu error ad-hoc | `apps/desktop/src/routes/dashboard.tsx:95`–`:110` | Ganti `Card` + `role="alert"` buatan sendiri dengan `Callout`/`StatusStrip` bersama | `§39:1811`, `§131` Rule 2, `§131` Rule 10 | S-04, F-03 | Rendah; tapi `dashboard.test.tsx` mengassert verdict failed sehingga `role="alert"` perlu dipertahankan atau test disesuaikan | `npm test` | **P3** |

### Phase 4 — Core management (`§124:4162`)

| ID | Tujuan | File target (path + area) | Perubahan konkret | Rujukan | Dependensi / urutan | Risiko | Verifikasi | Prio |
|---|---|---|---|---|---|---|---|---|
| **C-14** | Dialog pembuatan entitas (site/database) | `apps/desktop/src/routes/sites.tsx` (form tambah site), `apps/desktop/src/routes/databases.tsx` | Pindahkan form buat ke `Dialog` `§24:1132`/`§34` | `§24:1132`, `§34:1634` | F-02, C-06 | `sites.test.tsx` berisi 12 test yang berinteraksi dengan form inline; memindahkannya ke dialog akan mengubah cara test berinteraksi — perubahan besar pada test, bukan logika | `npm test` (`sites.test.tsx`, `databases.test.tsx`); manual: buat site, HTTPS default tetap off seperti perilaku sekarang | **P2** |
| **C-15** | Penyelarasan IA / route | `apps/desktop/src/App.tsx:25`–`:37`, `apps/desktop/src/components/app-shell.tsx:25`–`:37` | Sesuai keputusan C-06: tambah route baru, atau rename | `§3:129`, `§3:156` (C-06) | Keputusan C-06 **wajib lebih dulu** | Rename route menyentuh `Link` di banyak halaman (contoh `apps/desktop/src/routes/dashboard.tsx:110`) dan 9 file test. Ini perubahan dengan blast radius terbesar di seluruh rencana | `npm test` (semua 9 file); manual: setiap item sidebar membuka halaman yang benar | **P2** |
| **C-16** | Koreksi kontradiksi badge (pill vs 2px) | `apps/desktop/src/components/ui/badge.tsx:7` | Setelah C-04 diputuskan, selaraskan `rounded-full` dengan keputusan | `§12:632`, `apps/desktop/DESIGN.md:47` (C-04) | Keputusan C-04 | Rendah (satu kelas), tetapi menyentuh badge yang dipakai di banyak halaman | `npm test`; manual: badge tetap terbaca di dua theme | **P3** |

### Phase 5 — Power features (`§124:4173`)

| ID | Tujuan | File target (path + area) | Perubahan konkret | Rujukan | Dependensi / urutan | Risiko | Verifikasi | Prio |
|---|---|---|---|---|---|---|---|---|
| **P-01** | Bottom terminal drawer | `apps/desktop/src/components/app-shell.tsx` (region bawah), `apps/desktop/src/routes/terminal.tsx:137` | Jadikan terminal yang sudah ada dapat muncul sebagai panel bawah 280px, resizable 180px→70vh, plus opsi full-screen, tanpa menduplikasi logika PTY | `§31:1485`, `§32:1536`, `§103` terminal performance | S-01, S-02 | **Risiko tinggi.** Logika PTY ada di Rust; React hanya merender. Menampilkan komponen yang sama di dua tempat (route dan drawer) berisiko menggandakan state terminal/socket. Harus satu instance yang di-mount sekali | `npm test`; manual: buka terminal sebagai route dan sebagai drawer, pastikan tidak ada dua sesi shell; resize drawer | **P2** |
| **P-02** | Context menu | Baru: komponen context menu; pemakaian pada baris tabel | Menu ringkas dengan item destruktif di bawah bergaya danger | `§47:2051`, `§91:3321` | F-05, F-08 | Bergantung pada library/native; perlu penanganan posisi agar tidak keluar jendela | Manual: klik kanan di dekat tepi jendela | **P3** |
| **P-03** | Notification center | Baru: komponen notification panel; slot di topbar (S-01) | Panel notifikasi dengan Mark all read/Clear; error penting tetap terlihat sampai diakui | `§98:3468` | S-01, F-03, F-05 | `§107`/`§108` menyiratkan ini dekat dengan tray dan update; perlu dipastikan sumber notifikasi nyata (bukan feed karangan) — `§131` Rule 17 melarang data palsu | Manual: picu kegagalan service sungguhan, pastikan notifikasi muncul dan bisa diakui | **P3** |
| **P-04** | Port inspector / Hosts / Certificates | Route dan halaman baru | Fitur baru sesuai `§110`/`§111`/`§112` | `§110:3724`, `§111:3750`, `§112:3775` | C-15 (C-06), backend Rust yang sesuai | **Di luar cakupan UI murni** — tiap item butuh command Rust baru. Tidak boleh dikerjakan sebagai pekerjaan UI saja | Bukan verifikasi UI; butuh kontrak IPC baru lebih dulu | **P3** |

### Phase 6 — Polish (`§124:4186`)

| ID | Tujuan | File target (path + area) | Perubahan konkret | Rujukan | Dependensi / urutan | Risiko | Verifikasi | Prio |
|---|---|---|---|---|---|---|---|---|
| **L-01** | Audit state lengkap per halaman | Semua `apps/desktop/src/routes/*.tsx` | Checklist `§121:4025` dan `§123:4091`: typography, spacing, token, hover, focus, loading, empty, error, success, keyboard, tooltip, path panjang, resize, reduced motion | `§121:4025`, `§123:4091`, `§132:4529` | Semua fase sebelumnya | Audit luas; mudah berubah jadi pekerjaan tanpa ujung bila tidak dibatasi per halaman | Manual per halaman memakai checklist `§121`/`§123` | **P2** |
| **L-02** | Keyboard shortcuts | Handler global | Shortcut daftar `§56:2326`; jangan bentrok dengan input/terminal | `§56:2326`, `§131` Rule 12 | S-03 | Bentrok dengan `Ctrl+K` (palette) dan penanganan `onKeyDown` terminal; perlu satu peta shortcut tunggal | Manual: setiap shortcut di setiap route, termasuk saat fokus di input | **P2** |
| **L-03** | Micro-interaction & motion | `apps/desktop/src/index.css:161` dan kelas transisi di komponen | Transisi hover/state 150–200ms, konsisten; hanya pulse starting/stopping dan indeterminate progress yang boleh loop | `§51:2162`, `§52:2225`, `§53:2256`, `apps/desktop/DESIGN.md:41` (`MOTION = 1`) | F-01 | Menambah animasi berisiko melanggar MOTION=1. Blok reduced-motion sudah ada di `apps/desktop/src/index.css:161`–`:169` dan harus tetap menang | Manual dengan `prefers-reduced-motion` diaktifkan di OS: tidak ada loop/transisi | **P3** |
| **L-04** | Background effects | — | **Hanya** jika C-02 dibalik ke opsi (b) | `§15:715`, `§86:3183` | Keputusan C-02 | Bila dijalankan, ia membatalkan `apps/desktop/DESIGN.md:51` dan menaikkan mode ke `Full Redesign` | Manual: jalankan dengan reduced motion aktif dan nonaktif | **P3** |

---

## 5. Rencana verifikasi

### 5a. Baseline repo (terverifikasi, dijalankan 2026-09-16)

Perintah dijalankan di `apps/desktop`.

| Perintah | Exit code | Ringkasan output | Status |
|---|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **0** | Tidak ada diagnosa TypeScript. Output hanya header npm. | **Hijau** |
| `npm test` (`vitest run`) | **0** | `Test Files 9 passed (9)`, `Tests 63 passed (63)`, durasi 7.43s | **Hijau** |

**Baseline: HIJAU.** 9 file test, 63 test, seluruhnya lulus, dan typecheck
bersih. 9 file test tersebut:
`routes/components.test.tsx`, `routes/dashboard.test.tsx`,
`routes/databases.test.tsx`, `routes/diagnostics.test.tsx`,
`routes/mail.test.tsx`, `routes/services.test.tsx`,
`routes/settings.test.tsx`, `routes/share.test.tsx`,
`routes/sites.test.tsx`.

Catatan penting untuk pekerjaan berikutnya: `stderr` pada test run berisi
peringatan berulang yang **bukan kegagalan**, tetapi perlu diketahui karena
akan membanjiri output saat menambah test:

- `No queryFn was passed as an option…` untuk query key `["disk-usage"]`,
  `["port-map"]`, `["profiles"]` pada `dashboard.test.tsx` dan
  `settings.test.tsx`.
- `Query data cannot be undefined…` untuk query key
  `["php-pool-status","8.4.25"]` pada `services.test.tsx`.

Dua route **tidak punya test**: `routes/logs.tsx` dan
`routes/terminal.tsx` (tidak ada `logs.test.tsx`/`terminal.test.tsx`).
Perubahan pada Phase 5 P-01 (bottom terminal) karena itu **tidak akan
tertangkap** oleh test suite dan harus diverifikasi manual.

### 5b. Perintah yang tersedia di repo

Dari `apps/desktop/package.json:6`–`:14`:

| Perintah | Kegunaan dalam rencana ini |
|---|---|
| `npm run typecheck` | Gate utama setelah setiap item yang menyentuh tipe/props komponen |
| `npm test` | Gate utama setelah setiap item; perhatikan bahwa item F-02, C-14, C-15, F-08 akan **mengubah test** — perubahan test harus disengaja dan dijelaskan, bukan sekadar "diperbaiki agar lulus" |
| `npm run build` | `typecheck && vite build` (`package.json:8`). **Tidak dijalankan** dalam penyusunan rencana ini karena menulis ke `apps/desktop/dist/` dan dianggap mengubah state. `[BELUM DIVERIFIKASI]` — jalankan sebagai gate terakhir setiap fase |
| `npm run test:watch` | Loop pengembangan, bukan gate |
| `npm run dev` | `vite` — untuk verifikasi manual di browser |
| `npm run tauri` | `tauri` — untuk menjalankan aplikasi desktop nyata |

### 5c. Yang tidak bisa diverifikasi otomatis

Semua hal berikut **tidak** tertangkap `npm test`/`typecheck` (jsdom tidak
melakukan layout, dan tidak ada test visual). Cantumkan sebagai langkah
manual wajib, bukan opsional:

| Aspek | Mengapa tidak otomatis | Cara memeriksa manual |
|---|---|---|
| Kontras ≥ 4.5:1 | Test DOM tidak menghitung kontras; `MASTER.md:46` mensyaratkannya di **kedua** theme | Ukur tiap pasangan foreground/background dengan color picker atau DevTools, di dark **dan** light. Perhatikan khusus `--muted-foreground` (`apps/desktop/src/index.css:61` dark, `:27` light) |
| Light theme benar-benar berjalan | Belum pernah aktif (C-08); token light di `index.css:14`–`:44` belum pernah dirender | Setelah F-01, jalankan `npm run dev`, pilih Theme = Light di Settings, telusuri seluruh 11 route |
| Efek glass/glow/particle (bila C-02 membalik keputusan) | Tidak ada snapshot visual | Tangkapan layar dan perbandingan manual; ukur opacity `§86:3183` (0.05–0.18) |
| Animasi & `prefers-reduced-motion` | jsdom tidak menjalankan animasi | Aktifkan reduced motion di Windows, lalu verifikasi blok `apps/desktop/src/index.css:161` benar-benar membuat semua transisi instan; pastikan tidak ada loop selain starting/stopping (`apps/desktop/DESIGN.md:41`) |
| Perilaku resize jendela | Butuh jendela nyata | `npm run tauri`, uji pada `minWidth`/`minHeight` (`apps/desktop/src-tauri/tauri.conf.json:17`–`:18`) dan pada baseline `§4` 1100×700 / 1536×960 |
| Ikatan keyboard nyata (`Ctrl+K`, shortcut `§56`) | jsdom tidak mereproduksi accelerator webview sepenuhnya | `npm run tauri`, uji di setiap route termasuk saat fokus di terminal (`apps/desktop/src/routes/terminal.tsx:190`) dan di form `settings.tsx` |
| Focus order & screen reader | Butuh navigasi keyboard nyata | Tab melalui setiap halaman; pastikan cincin fokus terlihat (`apps/desktop/src/components/ui/button.tsx:7`) dan urutan masuk akal |
| Umpan balik operasi async nyata | Test memakai mock IPC | Jalankan aplikasi sungguhan, start/stop service, install komponen, dan amati toast/dialog serta state transisi (`idle`→`starting`→`running`, `§2:107`) |
| Scrollbar & overflow | jsdom tidak menghitung overflow | Manual: `§58:2394` melarang konten kritis jadi terlalu sempit; tabel/log/terminal boleh menggulir horizontal |

### 5d. Aturan verifikasi untuk perubahan test

Beberapa item (F-02, F-08, C-14, C-15) **memang** mengharuskan test diubah.
Aturan yang diusulkan: setiap perubahan pada file test harus disertai
penjelasan mengapa perilaku yang diuji berubah, dan assertion tentang
perilaku bisnis (mis. `sites.test.tsx` "adds a site with hostname, docroot,
PHP version and HTTPS off by default") **tetap** dipertahankan. Bila sebuah
perilaku bisnis tidak lagi punya test setelah perubahan, itu tanda
restrukturisasi keluar batas (lihat §6).

---

## 6. Batas kerja

Hal-hal berikut **tidak boleh diubah** tanpa izin eksplisit pengguna,
meskipun tampak diperlukan oleh rencana di §4:

1. **Logika bisnis.** Semua pemanggilan di `apps/desktop/src/lib/ipc.ts`
   dan `apps/desktop/src/lib/queries.ts`, seluruh `queryFn`/`mutationFn`,
   dan aturan turunan data (mis. `summarizeMetrics` yang dipakai
   `apps/desktop/src/routes/dashboard.tsx:49`). Item UI hanya boleh
   mengubah **presentasi** dari data tersebut.
2. **Kontrak IPC / Tauri command.** `apps/desktop/src/bindings.ts` adalah
   file generated; `crates/devx-core/src/config.rs` menetapkan skema
   konfigurasi yang dipersistensikan. Menambah command atau field baru
   (yang dibutuhkan P-04, dan mungkin S-02/S-04) adalah perubahan backend,
   bukan UI, dan harus disetujui terpisah.
3. **Route.** Sesuai C-06, daftar route di `apps/desktop/src/App.tsx:25`–`:37`
   tidak diubah sebelum keputusan diambil, karena rename menyentuh `Link`
   lintas halaman dan 9 file test.
4. **Data persisten & nilai default.** Nilai default di
   `crates/devx-core/src/config.rs:64` (`Theme::System`,
   `start_with_windows: false`, `close_to_tray: true`, dst.) mengubah
   perilaku nyata mesin pengguna. Tidak boleh diubah sebagai efek samping
   pekerjaan UI.
5. **Arti copy inti.** `apps/desktop/DESIGN.md:57`–`:62` menyatakan setiap
   layar dibangun di sekitar satu keputusan, dan `§84:3126` mengatur gaya
   penulisan. Verdict dashboard (`apps/desktop/src/routes/dashboard.tsx:57`–`:66`:
   "Your environment is waiting.", "Everything is running.", "N service(s)
   failed.") adalah keputusan produk berbasis data nyata — **jangan**
   diganti dengan teks generik demi tampilan.
6. **Brand asset.** `apps/desktop/src-tauri/icons/*`, `productName`,
   `identifier` (`dev.devx.desktop`), nama binary (`binaries/devx`,
   `binaries/devx-helper`), dan `publisher` di
   `apps/desktop/src-tauri/tauri.conf.json:2`–`:41`. Ini wilayah rebrand
   (C-05), bukan redesign UI.
7. **Larangan efek di `apps/desktop/DESIGN.md:51`.** Tidak boleh dihapus
   atau dilanggar sebagai "konsekuensi teknis" dari pekerjaan lain. Bila
   C-02 memilih glass/glow, itu keputusan eksplisit pengguna, bukan izin
   implisit.
8. **File `apps/desktop/src/routes/placeholder.tsx`.** Terverifikasi
   **tidak dirujuk** oleh `App.tsx` maupun route lain (pencarian
   `placeholder` hanya menemukan kecocokan tak terkait di
   `apps/desktop/src/routes/share.test.tsx:112`). Ini kandidat dead code,
   tetapi **jangan dihapus** dalam pekerjaan ini — hapus file adalah
   tindakan yang tidak dapat dibalik dan di luar cakupan rencana UI.

---

## 7. Estimasi kasar per fase

Bersifat kualitatif, berdasarkan jumlah file yang terlihat akan tersentuh.
Tidak ada angka yang dikarang.

| Fase (`§124`) | Sifat perubahan | Perkiraan file tersentuh | Catatan |
|---|---|---|---|
| **Phase 1 — Design foundation** | Aditif di `components/ui/` + perubahan terpusat di `index.css`, ditambah penggantian pemakaian di beberapa route | **Sedang–luas.** Sekitar 5–7 file baru (dialog, toast, tooltip, dropdown-menu, skeleton, mungkin hook theme) berukuran kecil, 1 file token (`index.css`), 1 file entry (`main.tsx`/`index.html`), dan sentuhan kecil di ~4–5 route untuk mengganti `window.confirm` dan spinner. Penyesuaian test di 3 file test | Ini fase dengan **penambahan kode terbanyak** tetapi risiko per file terendah, karena file baru tidak menyentuh halaman yang ada. Kecuali F-01 yang menyentuh akar rendering |
| **Phase 2 — Application shell** | Struktural: mengubah komponen yang membungkus seluruh aplikasi | **Sempit tetapi berdampak penuh.** File utama hanya 2–3 (`app-shell.tsx`, `topbar.tsx` baru, `command-palette.tsx` baru) plus `main.tsx`; dampaknya menyentuh **semua** route karena `AppShell` membungkus `Routes` (`apps/desktop/src/App.tsx:24`) | Risiko tertinggi per baris. Setiap kesalahan muncul di 11 route sekaligus. S-05 menyentuh file konfigurasi dan harus disetujui terpisah |
| **Phase 3 — Dashboard** | Restrukturisasi satu halaman | **Sempit.** 1 file (`dashboard.tsx`, 528 baris) dan kemungkinan 1 file test | Terkonsentrasi; dashboard adalah halaman terpadat |
| **Phase 4 — Core management** | Penambahan dialog + penyelarasan route | **Luas bila C-06 memilih rename, sempit bila tidak.** Rename route menyentuh `App.tsx`, `app-shell.tsx`, `Link` di beberapa halaman, dan hingga 9 file test. Bila IA dipertahankan, sisanya terbatas pada `sites.tsx`, `databases.tsx`, dan test keduanya | Varians biaya terbesar di seluruh rencana, sepenuhnya ditentukan keputusan C-06 |
| **Phase 5 — Power features** | Fitur baru di atas shell | **Luas, dan sebagian bukan pekerjaan UI.** P-01 menyentuh `app-shell.tsx` + `terminal.tsx`; P-02/P-03 menambah komponen baru; P-04 memerlukan command Rust baru sehingga di luar cakupan | P-01 berisiko tinggi karena menyentuh terminal/PTY yang dimiliki Rust (`§32:1536`, `§128:4337`) |
| **Phase 6 — Polish** | Audit dan penyesuaian tersebar | **Paling luas tetapi paling dangkal.** Checklist `§121`/`§123` berpotensi menyentuh setiap route | Mudah melebar tanpa batas; sebaiknya dibatasi per halaman dan diverifikasi manual, bukan otomatis |

Catatan penutup mengenai bukti: selama penyusunan dokumen ini ditemukan
bahwa `grep` di shell sesi ini di-*override* oleh sebuah shell function
yang meneruskan ke pencarian internal dan keluar dengan exit code 2 tanpa
mencetak hasil. Seluruh klaim "fitur X tidak ada" di dokumen ini
diverifikasi ulang memakai `command grep` (yang memakai `/usr/bin/grep`
sungguhan) dengan uji kewajaran (`Button` → 14 file) untuk memastikan
pencarian benar-benar bekerja. Klaim "absen" yang dibuat sebelum koreksi
ini tidak dapat dipercaya dan sudah diganti.
