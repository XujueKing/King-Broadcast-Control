# Third-party runtime notices

## mpv

KING CLUB Broadcast Control uses an external `mpv` process for the production media engine.

- Project: https://mpv.io/
- Source: https://github.com/mpv-player/mpv
- Windows build source: https://github.com/shinchiro/mpv-winbuild-cmake
- Pinned development build: `20260814`, mpv commit `7b8915bc1d`
- Development CPU baseline: `x86-64-v3`

The downloaded source archive is intentionally cached outside version control. Run `scripts/setup-mpv.ps1` to download the pinned archive and verify its SHA-256 before use. Windows release builds bundle the verified `mpv.exe` and this notice. Commercial distribution still requires a final review of the licenses and corresponding-source obligations of mpv and every library enabled in the selected Windows build.
