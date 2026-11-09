# StudioPulse

Dasbor lokal untuk mengelola beberapa channel YouTube sekaligus: statistik, performa konten, jadwal,
komentar, kuota API, dan login. Semuanya berjalan di komputer Anda sendiri (http://127.0.0.1:8765).

## Yang dibutuhkan

- Windows 10/11
- Python 3.10 atau lebih baru (https://www.python.org/downloads/, centang "Add python.exe to PATH")
- Google Chrome
- Akun Google pemilik channel YouTube

## Cara mulai

1. Ekstrak zip ini ke folder mana saja, misalnya `Documents\StudioPulse`.
2. Klik dua kali `StudioPulse.cmd`. Saat pertama kali, file ini menyiapkan Python dan memasang
   dependensi (butuh internet, 1-3 menit). Setelah itu dasbor langsung terbuka di browser.
3. Di layar sambutan, klik **Tambah Channel**, lalu ikuti **Panduan Google Cloud** di Informasi akun:
   buat project, aktifkan YouTube Data API v3 dan YouTube Analytics API, tambahkan email Anda sebagai
   Test user, lalu buat OAuth client jenis "Desktop app". File `client_secret_....json` yang Anda unduh
   diambil otomatis dari folder Downloads.
4. Klik **Login Google**, pilih akun pemilik channel, lalu klik **Izinkan**.

Biarkan jendela hitam StudioPulse terbuka selama memakai dasbor. Tutup jendela itu untuk menghentikannya.
Panduan lengkap dan FAQ ada di menu **Panduan** di dalam dasbor.

## Data Anda

- File OAuth client disimpan di folder `Secrets\`; token login dan API key dienkripsi Windows (DPAPI),
  sehingga hanya bisa dibuka oleh akun Windows Anda.
- Statistik kuota dan catatan audit ada di `Data\`, folder video tiap channel di `Channels\`.
- Sesi Chrome tiap channel ada di `%LOCALAPPDATA%\StudioPulse\chrome\`.
- Jangan membagikan folder `Secrets\` dan `Data\` ke orang lain.

## Masalah umum

- **"Access blocked" saat login**: email Google Anda belum ada di daftar Test users project Google Cloud.
- **"Google hasn't verified this app"**: normal untuk app milik Anda sendiri; klik Continue.
- **Harus login ulang tiap 7 hari**: app Google Cloud masih mode Testing. Ubah ke In production di
  Google Auth Platform -> Audience.
- **Dependensi gagal terpasang**: hapus folder `Tools\youtube\.venv`, lalu jalankan `StudioPulse.cmd` lagi.

## Untuk developer

```
Tools/dashboard/server.py      server HTTP lokal (stdlib, hanya 127.0.0.1) + API JSON
Tools/dashboard/accounts.py    tambah/hapus channel, kredensial tersamar, log audit
Tools/dashboard/launcher.py    membuka YouTube Studio di sesi Chrome khusus tiap channel
Tools/dashboard/static/        frontend plain JS/CSS, tanpa build step
Tools/youtube/yt.py            YouTube Data/Analytics API + CLI (yt.cmd --ch KUNCI ...)
Tools/youtube/vault.py         penyimpanan token terenkripsi DPAPI
```

- Tes: `Tools\youtube\.venv\Scripts\python.exe -I Tools\dashboard\test_release.py`
  (juga `Tools\dashboard\test_accounts.py` dan `Tools\youtube\test_vault.py`).
- Zip rilis: `Tools\youtube\.venv\Scripts\python.exe -I Tools\dashboard\build_release.py` (hasil di `dist\`).
  Build otomatis gagal kalau ada file atau pola kredensial yang ikut.
- `channels.json`, `Secrets\`, `Data\`, dan `Channels\` adalah data pengguna dan sudah masuk `.gitignore`.
- Port bisa diganti lewat variabel lingkungan `STUDIOPULSE_PORT`.

## Lisensi

Copyright (C) 2026 FenomanSKY.

StudioPulse adalah perangkat lunak bebas di bawah **GNU General Public License v3** (atau versi yang lebih baru);
teks lengkapnya ada di file `LICENSE`. Anda boleh memakai, mengubah, dan membagikan ulang kode ini, termasuk untuk
keperluan komersial, asalkan versi yang Anda bagikan (asli atau hasil ubahan) juga dibuka kodenya dengan lisensi GPL
yang sama dan tetap mencantumkan pembuat aslinya. Program ini diberikan apa adanya, TANPA JAMINAN apa pun.
