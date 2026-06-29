# Siberflow for VSCode

Siberflow adalah extension chat AI untuk VSCode yang dirancang untuk membantu pekerjaan langsung dari dalam workspace. Extension ini bisa dipakai untuk membaca struktur project, membantu perubahan kode, menjalankan perintah shell, dan menangani pekerjaan bertahap tanpa perlu pindah ke tool lain.

Siberflow dikembangkan oleh **DataSiberLab**. Untuk pertanyaan, kerja sama, atau dukungan teknis, hubungi **candrapwr@datasiber.com**.

## Tampilan

**Panel chat Siberflow di VSCode.** Gambar ini menunjukkan extension berjalan di sidebar editor, memakai konteks workspace yang sedang dibuka untuk membantu pekerjaan coding.

![Siberflow VSCode Extension](../../ss_vscode.png)

## Apa yang bisa dilakukan

- Chat AI langsung dari sidebar VSCode
- Membantu baca, ubah, dan menulis file di project
- Menjalankan perintah shell dari konteks workspace
- Membantu query database saat dibutuhkan
- Menyimpan histori session per project
- Melanjutkan percakapan lama tanpa mulai dari nol

## Cocok dipakai untuk

- Menjelaskan file atau bagian kode tertentu
- Membantu refactor kecil sampai menengah
- Membuat atau merapikan file konfigurasi
- Membantu debugging dari output command
- Membantu langkah kerja yang butuh beberapa tahap

## Cara pakai

1. Buka folder project di VSCode.
2. Klik icon Siberflow di sidebar kiri.
3. Saat pertama kali dipakai, isi provider dan API key.
4. Mulai chat seperti biasa dari panel extension.

## Custom provider

Selain provider bawaan, Siberflow bisa memakai provider sendiri selama kompatibel dengan OpenAI `/chat/completions`.

Di panel settings, pilih `custom (OpenAI-compatible)`, lalu isi:

- **Custom provider name** — nama provider yang ingin ditampilkan
- **Base URL** — root API, contoh `https://api.example.com/v1`
- **Default model** — model yang dipakai kalau model override dikosongkan
- **API key** — disimpan encrypted di VSCode SecretStorage

Base URL jangan diisi sampai `/chat/completions`; Siberflow otomatis menambahkan path itu saat request.

## Ringkas fitur utama

- Mendukung beberapa provider AI, termasuk custom OpenAI-compatible provider
- Response tampil streaming di panel chat
- Punya tool untuk file, shell, dan database
- Session tersimpan per project
- Bisa dipakai untuk pekerjaan coding yang berulang atau bertahap

## Catatan

- Extension ini bekerja dari konteks folder workspace yang sedang dibuka
- Beberapa fitur bergantung pada provider/model yang Anda pilih
- Untuk penggunaan yang lebih lanjut, Anda bisa menyesuaikan setting langsung dari panel extension atau Settings VSCode

## Detail lebih lanjut

Untuk dokumentasi teknis, struktur project, build, packaging, dan detail implementasi:

- GitHub / repository utama: [Siberflow](https://github.com/candrapwr/siberflow)
- README root repo: [../../README.md](../../README.md)
- Developer reference: [../../DEVELOPMENT.md](../../DEVELOPMENT.md)
