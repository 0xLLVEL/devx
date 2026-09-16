# Rencana: pergantian aksen & dark color — DevX

> Dokumen ini **hanya rencana**. Tidak ada berkas kode yang diubah untuk
> menghasilkannya. Otoritas desain tetap `DESIGN.md` di root repo.
>
> Disusun: 2026-09-16 · workspace `devx-rewrite`

## 0. Yang perlu diputuskan lebih dulu

Rencana ini sengaja berhenti di satu titik: **warna tujuan belum ditentukan.**
Angka di bawah dihitung deterministik (WCAG 2.1 relative luminance), jadi
pemilihan bisa dilakukan dengan bukti, bukan selera saja.

Dua keputusan:

1. **Aksen baru** — pilih dari §4, atau tentukan sendiri lalu hitung ulang.
2. **Base gelap baru** — pilih dari §5. Ini independen dari keputusan 1.

---

## 1. Peta permukaan perubahan

Semua warna aksen dan gelap hidup di **satu berkas**: `apps/desktop/src/index.css`.
Tidak ada komponen, hook, atau route yang menulis hex aksen sendiri
(diverifikasi: pencarian `7567ff|6256e8|897dff|117,103,255|98,86,232|070b14`
di seluruh `src/**` hanya menemukan `index.css`).

| Lokasi | Isi | Dampak bila aksen diganti |
|---|---|---|
| `index.css:43` | `--accent: #6256e8` (terang) | harus ikut — tema terang punya variannya sendiri |
| `index.css:44` | `--accent-hover: #5146d8` (terang) | harus ikut |
| `index.css:45` | `--accent-soft: rgba(98,86,232,.14)` (terang) | baris/kartu terpilih |
| `index.css:65` | `--glow-accent` (terang) | hover tombol primary (§87) |
| `index.css:120` | `--accent: #7567ff` (gelap) | inti |
| `index.css:121` | `--accent-hover: #897dff` (gelap) | harus ikut |
| `index.css:122` | `--accent-soft: rgba(117,103,255,.14)` (gelap) | baris/kartu terpilih |
| `index.css:138` | `--glow-accent: 0 0 24px rgba(117,103,255,.16)` (gelap) | §13 menulis nilai ini secara literal |
| `index.css:150,158` | `--primary-foreground` / `--destructive-foreground: #070b14` | **turunan base**, bukan turunan aksen — lihat §3 |
| `index.css:412` | `.ambient-orbs` radial pertama `rgba(117,103,255,.16)` | **literal, bukan token** |
| `index.css:437,442` | 2 dari 13 titik `.ambient-particles` `rgba(117,103,255,.24/.20)` | **literal, bukan token** |
| `index.css:103-118` | ramp base gelap: `--bg-app/surface/surface-2/elevated/hover` | inti pergantian dark color |
| `index.css:110-113` | border `subtle/default/strong` | di-tuning ke navy |
| `index.css:114-117` | teks `primary/secondary/muted/disabled` | di-tuning ke navy |
| `index.css:139-141` | `--glass-bg: rgba(13,20,34,.82)`, `--glass-border`, `--elevation-*` | `glass-bg` memakai RGB navy; shadow hitam murni |

**Temuan arsitektur.** Aksen **belum sepenuhnya ter-token**: tiga nilai ambient
di atas memakai literal RGB. Artinya hari ini "ganti aksen" berarti menyunting
5 definisi token **plus** 3 literal + 2 titik partikel. Rekomendasi: tokenkan
dulu (`--accent-rgb` sebagai channel triplet, lalu `rgba(var(--accent-rgb), .16)`),
supaya pergantian berikutnya benar-benar satu tempat. Ini pekerjaan kecil dan
tidak mengubah tampilan.

### Berkas otoritas yang ikut berubah

`DESIGN.md` memuat nilai yang sama, jadi ia **wajib** diperbarui bersamaan —
kalau tidak, kita mengulang persis masalah drift dokumen yang sudah dua kali
muncul di repo ini (`apps/desktop/DESIGN.md`, `design-system/devx/*`).

| Lokasi di `DESIGN.md` | Isi |
|---|---|
| `:435-441` (§8) | seluruh ramp base gelap |
| `:468-470` (§8) | `--accent`, `--accent-hover`, `--accent-soft` |
| `:476` (§8) | `--cyan` |
| `:533` (§9) | `--accent` tema terang |
| `:676` (§13) | glow `0 0 24px rgba(117,103,255,.16)` |
| `:2861-2871` (§73) | contoh token CSS |
| `:2902` (§74) | contoh nilai yang dilarang ditulis langsung |
| `:395-410` (§7) | kata kunci visual — memuat "electric violet" dan "cyan highlights" |
| `:715-753` (§15) | komposisi ambient: "purple glow top/right, cyan glow bottom/left" |

---

## 2. Batasan yang mengikat

1. **§55 + §8:** teks ≥4,5:1; komponen UI (border, ring) ≥3:1.
2. **`--primary-foreground` ditentukan oleh kontras, bukan suasana hati.**
   Hitungan menunjukkan **tidak ada** kandidat aksen yang aman dengan teks
   putih di tema gelap (terbaik 4,09 — gagal). Semua kandidat harus memakai
   ink gelap di atas fill aksen. Di tema terang kebalikannya: semua kandidat
   butuh teks putih.
3. **Jangan bertabrakan dengan warna status.** `--success`, `--warning`,
   `--danger`, `--info`, `--cyan` sudah memakai lima hue. Aksen baru yang
   berdekatan <45° membuat "warna merek" dan "warna makna" tidak lagi bisa
   dibedakan — dan §8 menyatakan warna status tidak boleh jadi dekorasi.
4. **Tema terang wajib ikut** (§9, §131 Rule 15). Tiap aksen butuh varian
   gelapnya sendiri, dan `--primary-foreground`-nya dibalik.
5. **Ramp, bukan cuma base.** Mengganti `--bg-app` saja akan meninggalkan
   border, teks, hover, glass, dan shadow yang masih bernuansa navy.
6. **`--accent-soft` harus tetap bisa dibedakan dari `--bg-hover`.** Keduanya
   dipakai untuk "terpilih" dan "disorot" di tabel yang sama.

---

## 3. Angka: kondisi sekarang

Dihitung pada base gelap `#070B14`, ambang 4,5.

| Pasangan | Rasio | Status |
|---|---|---|
| `text-primary` `#F5F7FB` di atas base | 18,35 | lulus |
| `text-secondary` `#A8B3C5` di atas base | 9,30 | lulus |
| `text-muted` `#6F7D91` di atas base | 4,70 | lulus (sempit) |
| `text-disabled` `#465267` di atas base | 2,50 | **gagal** — disengaja untuk elemen nonaktif |
| aksen `#7567FF` sebagai teks di `bg-app` | 4,82 | lulus (sempit) |
| aksen sebagai teks di **`--bg-surface`** (card) | 4,51 | lulus (sangat sempit) |
| aksen sebagai teks di **`--bg-elevated`** (popover/menu) | **4,04** | **gagal** |
| aksen sebagai teks di **`--bg-hover`** (baris disorot) | **3,79** | **gagal** |
| teks putih di atas fill aksen | 4,09 | gagal — karena itu kode memakai `#070b14` |

**Defect yang sudah ada, terlepas dari pergantian warna:** aksen sebagai teks
hanya lulus di `bg-app`. Di permukaan naik — popover, menu, baris yang
disorot — ia di bawah 4,5. Ini tidak terlihat selama aksen hanya dipakai
sebagai *fill* dan *marker*, dan baru menjadi masalah begitu ada label atau
tautan berwarna aksen di dalam menu/popover. Memilih aksen dengan headroom
lebih besar menyelesaikan ini sekaligus.

---

## 4. Kandidat aksen

Diranking dari yang paling aman. "Kolisi" = jarak sudut hue ke warna status
terdekat; <45° berarti perlu menata ulang warna status itu.

| Kandidat | Gelap | Terang | Teks di `bg-app` | Teks di `bg-hover` | Teks putih di fill | Kolisi | Catatan |
|---|---|---|---|---|---|---|---|
| **Fuchsia** | `#D946EF` | `#A21CAF` | 5,69 | 4,48 | 3,46 gagal → pakai ink | **aman** | paling aman dari sisi makna; headroom cukup; hover marginal |
| Violet (sekarang) | `#7567FF` | `#6256E8` | 4,82 | **3,79 gagal** | 4,09 gagal → pakai ink | `info` 34° | mempertahankan identitas; membawa defect §3 |
| Coral | `#FF6B5A` | `#C2410C` | 7,03 | 5,54 | gagal → ink | `danger` 14°, `warning` 34° | kontras bagus, bentrok dua status |
| Emerald | `#10B981` | `#047857` | 7,76 | 6,11 | gagal → ink | `success` 10°, `cyan` 37° | bentrok arti "sehat/berjalan" |
| Sky | `#38BDF8` | `#0369A1` | 9,19 | 7,24 | gagal → ink | `cyan` **1°**, `info` 13° | kontras terbaik, bentrok paling parah |
| Lime | `#A3E635` | `#4D7C0F` | 13,05 | 10,28 | gagal → ink | `warning` 43° | kontras tertinggi; kesan "terminal" |
| Amber | `#F5B942` | `#96650A` | 11,15 | 8,78 | gagal → ink | `warning` **0°** | identik dengan warna peringatan |

**Rekomendasi.** Fuchsia `#D946EF` adalah satu-satunya yang menyelesaikan
defect kontras §3 **tanpa** memaksa penataan ulang warna status, dan tetap
terasa "electric" seperti arah §7. Pilihan lain sah, tetapi harganya eksplisit:
memilih sky berarti `--cyan`/`--info` harus digeser; memilih emerald berarti
`--success`; memilih amber berarti `--warning`; memilih coral berarti
`--danger`.

Semua kandidat butuh `--primary-foreground` ink gelap di tema gelap dan putih
di tema terang — silang, seperti sekarang.

---

## 5. Kandidat base gelap

Kontras teks hampir tidak terpengaruh — keempatnya di dalam 0,2 poin satu sama
lain. Jadi keputusan ini **estetis**, bukan soal keterbacaan.

| Kandidat | Nilai | `text-primary` | `text-secondary` | `text-muted` | Kesan |
|---|---|---|---|---|---|
| Navy (sekarang) | `#070B14` | 18,35 | 9,30 | 4,70 | biru teknologi, agak dingin |
| Graphite netral | `#0C0C0E` | 18,22 | 9,23 | 4,67 | netral, hampir tanpa hue — paling "instrumen" |
| Ink kebiruan | `#090E14` | 18,05 | 9,15 | 4,63 | navy yang diredam |
| Ink kehijauan | `#080F0E` | 18,05 | 9,14 | 4,63 | gelap dengan cast hijau |

Yang benar-benar berubah adalah **ramp**, bukan base: `--bg-surface/-2/-elevated/-hover`,
tiga border, empat tingkat teks, `--glass-bg` (memakai RGB navy literal),
`--glass-border`, dan `--elevation-*`. Base netral seperti graphite misalnya
tidak cocok lagi dengan border yang bernuansa biru; shadow hitam murni perlu
diuji ulang di atas base yang lebih terang.

---

## 6. Urutan eksekusi (setelah warna diputuskan)

1. **Tokenkan dulu** — tambah `--accent-rgb` dan pakai `rgba(var(--accent-rgb), α)`
   untuk `--accent-soft`, `--glow-accent`, `.ambient-orbs`, dan titik partikel.
   Tidak ada perubahan tampilan; ini yang membuat langkah 2–5 jadi satu tempat.
2. **Token tema gelap** — `--accent`, `--accent-hover`, base + ramp (§5),
   `--primary-foreground`, `--glass-bg`, shadow.
3. **Token tema terang** — pasangan `--accent`/`--accent-hover` tema terang dan
   `--primary-foreground: #ffffff`. Tema terang bukan turunan otomatis.
4. **Ambient** — warna orb dan titik partikel. Ingat §15/§86: opacity 0,05–0,18.
5. **Perbarui `DESIGN.md`** pada sembilan lokasi di §1 tabel kedua, plus kata
   kunci §7 kalau bahasanya ikut berubah.
6. **Perbarui komentar** di `index.css` yang menyebut "violet" dan alasan
   pemilihan warna, supaya alasan tertulis tetap ada (itu konvensi repo ini).

---

## 7. Verifikasi

**Otomatis / deterministik**

- Skrip kontras WCAG yang sudah dipakai menyusun rencana ini (`contrast.mjs`,
  `contrast-light.mjs`) dijalankan ulang dengan nilai final. Ambang: teks
  ≥4,5 di **setiap** permukaan tempat ia benar-benar dirender (`bg-app`,
  `bg-surface`, `bg-elevated`, `bg-hover`) — inilah bagian yang gagal hari ini.
- `npm run typecheck`, `npm test` (28 berkas, 301 test), `npm run build`.
  Suite saat ini tidak mengunci nilai warna, jadi ia menjaga agar penggantian
  tidak merusak perilaku — bukan agar warnanya benar.
- Cek bahwa `--accent-soft` tetap terbedakan dari `--bg-hover` pada tabel yang
  sama (bandingkan setelah fill).

**Manual — tidak bisa diotomatiskan**

- Dua tema di aplikasi sungguhan (`npm run tauri dev`), termasuk tema terang
  yang belum pernah dinilai mata manusia sejak Phase 1.
- Focus ring 2px aksen di atas semua permukaan (§55) — pastikan masih terlihat
  di `bg-elevated` dan di dalam dialog.
- Ambient §15/§86: apakah glow baru enak dilihat, tidak mendominasi, dan mati
  saat `prefers-reduced-motion`.
- Hover/pressed tombol primary, badge status, dan baris terpilih pada tabel.
- Konsistensi dengan ikon Lucide dan status dot — aksen baru tidak boleh
  membuat dot "running" atau badge gagal kehilangan makna.

---

## 8. Risiko

| Risiko | Mitigasi |
|---|---|
| Aksen baru bertabrakan dengan warna status | Sudah dihitung di §4; pilihan yang berkolisi butuh keputusan terpisah untuk menggeser status |
| Tema terang terlupakan | §6 langkah 3 memisahkannya; §7 memverifikasi keduanya |
| `DESIGN.md` kembali tertinggal dari kode | §6 langkah 5; ini penyebab drift yang sudah dua kali terjadi |
| Ambient jadi terlalu kuat | §15 membatasi opacity 0,05–0,18; diperiksa manual |
| Perubahan warna menyamarkan defect lama | Defect aksen-di-atas-permukaan-naik (§3) dicatat sebagai temuan tersendiri, bukan diperbaiki diam-diam |

---

## 9. Yang tidak termasuk rencana ini

- Warna status (`success`/`warning`/`danger`/`info`/`cyan`) — hanya ikut
  berubah bila kandidat aksen yang dipilih memang memaksa.
- Radius, tipografi, spacing, motion — sudah final di §10–§13.
- IA/route, layout halaman, dan isi `apps/desktop/DESIGN.md` serta
  `design-system/devx/*` (keduanya masih perlu keputusan tersendiri).
