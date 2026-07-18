# WEBUNIME

Website nonton bergaya Netflix — ringan & stabil.

## Tech stack

- **Vite** (dev server + build)
- **Vanilla HTML / CSS / JS** (tanpa framework berat)
- Data film dari `public/data/movies.json`

## Menjalankan

```bash
npm install
npm run dev
```

Buka http://localhost:5173

## Build production

```bash
npm run build
npm run preview
```

## Scrape daftar player

Ambil daftar server player (P2P, TurboVIP, Cast, Hydrax, dll) dari halaman film LK21:

```bash
npm run scrape -- double-occupancy-2026
# atau URL penuh:
npm run scrape -- https://tv12.lk21official.cc/double-occupancy-2026
# beberapa film sekaligus:
npm run scrape -- film-a-2026 film-b-2025
```

Hasilnya:

- `public/data/players.json` — peta `{ slug: { film, source, scraped_at, players[] } }`
- `public/data/movies.json` — field `slug` + `players` ikut ditambahkan bila slug film cocok

Di UI, film yang punya data `players` menampilkan pemilih server dan **memutar
video langsung di dalam WEBUNIME** lewat reverse-proxy lokal `/__px__/…`
(membuang CSP `frame-ancestors`, menjaga path/slug player, dan melewati
wrapper iklan `playeriframe`). Film tanpa data player memakai mode demo poster.

> Catatan: proxy embed aktif saat `npm run dev` dan `npm run preview`.
> Beberapa server provider bisa bermasalah / maintenance — ganti server di dropdown.
