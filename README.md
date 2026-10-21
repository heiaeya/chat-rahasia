# Chat Berdua 💬

Web chat pribadi ala WhatsApp, khusus buat berdua. Dibuat ringan supaya tetap lancar di browser HP lama (Android 7) yang sudah tidak bisa menjalankan aplikasi chat modern.

**Live:** https://chat-berdua.pages.dev

## Fitur

- Buat room sendiri — klik **Buat Room Baru**, dapat link + kode room unik
- Gabung room pakai kode / link room
- Masuk cukup pakai nama (sekali saja), tanpa password & tanpa daftar
- Bubble chat ala WhatsApp, kirim pesan dengan polling ±3 detik
- Balas pesan (reply) — tap bubble pesan
- Status online / terakhir dilihat + indikator "sedang mengetik..."
- Centang dua (biru = sudah dilihat pasangan online)
- Riwayat chat tersimpan di browser masing-masing (localStorage)

## Cara Pakai

1. Buka webnya, klik **Buat Room Baru**
2. Bagikan link room yang muncul **hanya** ke satu orang yang mau diajak chat
3. Masing-masing isi nama sekali, langsung bisa chat
4. Kalau mau gabung dari perangkat lain: tempel kode / link room di kolom **Gabung Room**

> Siapa pun yang memegang link/kode room bisa membaca & ikut menulis di room itu. Jangan disebar.

## Teknologi

- 1 file `index.html` — HTML + CSS + vanilla JavaScript, tanpa framework (sengaja, biar ringan di browser lama)
- Hosting statis: Cloudflare Pages
- Penyimpanan pesan bersama: [restful-api.dev](https://restful-api.dev) (objek JSON per room; ID objek = kode room)
- Sinkronisasi: client melakukan fetch-merge-put + polling, gabungan pesan lokal & server berdasarkan ID pesan

## Pengembangan

Edit `index.html`, lalu deploy ulang folder yang berisi file tersebut sebagai situs statis (mis. Cloudflare Pages).

Terinspirasi dari arsitektur chat real-time di [And-Learning-path](https://github.com/Mipan-Zuzu/And-Learning-path) (fitur online/typing/reply), disederhanakan untuk 2 orang dan browser lawas.
