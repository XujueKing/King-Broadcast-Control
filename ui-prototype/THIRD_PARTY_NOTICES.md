# Third-party runtime notices

## mpv

KING CLUB Broadcast Control uses an external `mpv` process for the production media engine.

- Project: https://mpv.io/
- Source: https://github.com/mpv-player/mpv
- Windows build source: https://github.com/shinchiro/mpv-winbuild-cmake
- Pinned development build: `20260814`, mpv commit `7b8915bc1d`
- Development CPU baseline: `x86-64-v3`

The downloaded source archive is intentionally cached outside version control. Run `scripts/setup-mpv.ps1` to download the pinned archive and verify its SHA-256 before use. Windows release builds bundle the verified `mpv.exe` and this notice. Commercial distribution still requires a final review of the licenses and corresponding-source obligations of mpv and every library enabled in the selected Windows build.

## kugou-kgm-decoder

KING CLUB Broadcast Control uses the unmodified Windows binary of `kugou-kgm-decoder` as an isolated local importer for user-provided KGM/KGMA/VPR files. It is never used as the MPV playback layer and never uploads music.

- Project: https://github.com/ghtz08/kugou-kgm-decoder
- Pinned release: `v0.1.2`
- Windows asset SHA-256: `8fd50c8f995d327c16755fd4d355143524cc9eacb6d52cd4e43f633e150da7aa`
- License: Anti 996 License Version 1.0 (Draft), bundled at `licenses/kgm-decoder-LICENSE.txt`

Use this importer only for music files you are legally entitled to access and convert. Public performance rights remain separate from file-format compatibility.

## Atmosphere sound pad

Bundled CC0 recordings from BigSoundBank: Joseph SARDIN (applause, 2479), DenisChardonnet (cheers/shouts, 0237 and 0236). Sources: https://bigsoundbank.com/applaudissements-concert-bar-1-s2479.html , https://bigsoundbank.com/shouts-and-applauses-of-teens-2-s0237.html , https://bigsoundbank.com/cris-et-applaudissements-d-ados-1-s0236.html . License: https://creativecommons.org/publicdomain/zero/1.0/ .
