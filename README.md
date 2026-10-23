# ChatVI 💬

Web chat pribadi, khusus buat berdua. Dibuat ringan supaya tetap lancar di browser HP lama (Android 7) yang sudah tidak bisa menjalankan aplikasi chat modern.

**Live:** https://chatvi.pages.dev

## Fitur

- Buat room sendiri — klik **Buat Room Baru**, dapat link + kode room unik
- Gabung room pakai kode / link room
- Masuk cukup pakai nama (sekali saja), tanpa password & tanpa daftar
- Tampilan gaya sketsa neo-brutalist (bubble putih tepian hitam + bayangan keras, avatar bulat, kolom selebar layar HP) — bukan ala WhatsApp
- Pesan terkirim **real-time** (WebSocket, tanpa polling)
- Balas pesan (reply) — tap bubble pesan
- Kirim foto — dikompres otomatis di browser, lalu di-upload ke [Litterbox](https://litterbox.catbox.moe) (filehoster sementara — foto otomatis terhapus setelah 12 jam)
- Status online / terakhir dilihat + indikator "sedang mengetik..."
- Centang dua (biru = sudah dilihat pasangan online)
- Riwayat chat tersimpan di database (Postgres) + salinan lokal di browser masing-masing (localStorage)

## Cara Pakai

1. Buka webnya, klik **Buat Room Baru**
2. Bagikan link room yang muncul **hanya** ke satu orang yang mau diajak chat
3. Masing-masing isi nama sekali, langsung bisa chat
4. Kalau mau gabung dari perangkat lain: tempel kode / link room di kolom **Gabung Room**

> Siapa pun yang memegang link/kode room bisa membaca & ikut menulis di room itu. Jangan disebar.

## Teknologi

- Vanilla HTML + CSS + JavaScript, tanpa framework & tanpa build step (sengaja, biar ringan di browser lama dan gampang diedit)
- Hosting statis: Cloudflare Pages (atau hosting statis apa pun)
- Database: [Supabase](https://supabase.com) (PostgreSQL) — tabel `messages`, 1 baris per pesan, difilter per `room` (= kode room dari link)
- Ambil riwayat: fungsi database `get_messages` (hanya bisa dipanggil dengan kode room); kirim pesan: REST insert; pesan masuk real-time + status online & "sedang mengetik...": Supabase Realtime Broadcast per room
- Keamanan: tabel `messages` TIDAK bisa dibaca langsung pakai anon key (tidak ada policy select) — jadi isi room lain tidak bisa diintip/didump orang asing; satu-satunya jalan membaca adalah tahu kode room-nya
- Skema database: lihat `src/supabase-schema.sql`

## Struktur File

- `index.html` — struktur halaman (lobi + ruang chat)
- `style.css` — semua tampilan / tema
- `app.js` — semua logika chat (kirim/terima pesan, realtime, online/typing, reply)
- `assets/` — logo Chat6: `wordmark.svg` (tulisan Chat6 transparan, dipakai di halaman depan) & `logo.svg` (ikon bundar) — format SVG berisi gambar PNG supaya tetap ringan & utuh di repo
- Ikon tab browser (favicon) = logo bundar Chat6, tertanam langsung di `index.html` sebagai data URI
- `config.example.js` — contoh konfigurasi Supabase; salin jadi `config.js` untuk menjalankan
- `src/supabase-schema.sql` — skema database yang perlu dijalankan sekali di Supabase

> **Deploy otomatis:** repo ini tersambung ke Cloudflare Pages — setiap push ke branch `main` langsung ter-deploy ke situs live.

## Jalankan Sendiri (Fork)

1. Fork repo ini, lalu clone.
2. Buat project gratis di [Supabase](https://supabase.com) (tanpa kartu kredit).
3. Di Supabase project kamu: buka **SQL Editor**, jalankan isi `src/supabase-schema.sql`.
4. Ambil **Project URL** dan **anon public key** dari **Project Settings → API**.
5. Salin `config.example.js` menjadi `config.js`, isi kedua nilainya dengan kredensial Supabase kamu.
6. Deploy folder ini sebagai situs statis (mis. Cloudflare Pages) — atau buka `index.html` lewat server lokal apa pun.

Catatan: `config.js` masuk `.gitignore` supaya kredensial tiap orang tidak ikut ter-commit. Anon key memang dirancang untuk publik; keamanan room bertumpu pada kode room yang rahasia.

## Kontribusi

Kontribusi fitur & perbaikan sangat diterima! Silakan fork repo ini, buat perubahan di branch kamu, lalu buka **Pull Request**. Ide yang kepakai: kirim foto, notifikasi, tema baru, dll.

## Lisensi

MIT — lihat file `LICENSE`. Bebas dipakai, diubah, dan disebarluaskan.
