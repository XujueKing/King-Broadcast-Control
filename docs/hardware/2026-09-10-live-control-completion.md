# 2026-09-10 live control completion

## Shipped and verified on this computer

- Qu-16 firmware 1.90 at 192.168.1.60: originating-connection fader writes were left `sent-unconfirmed` indefinitely. The worker now requests authoritative System State once after an outstanding write and resynchronizes on bounded readback timeout, without replaying the write. Idle connections make no additional requests.
- Real singer-gateway tests: CH1 77 -> 76 -> 77; CH6 65 -> 64 -> 65; CH1 FX send 60 -> 59 -> 60. All six terminal receipts succeeded with hardware readback. Observed command/readback time, including receipt polling: 516-813 ms. These checks confirm control, not room acoustics or long-duration Wi-Fi acceptance.
- Tiger Touch II TT-00608, Titan 11.3.5, Show 2024.12.28: lower fifth physical button is cue `Macros[5]`, zero-based index 4, titanId 70207, user number 45. Added Macros to triggerable playback inventory. Stored verified binding in local `king.singer.frontLightBinding`. Singer API `front_light enabled=true` succeeded and readback remained enabled. This is a site-specific binding, not a portable default for another Show.
- Desktop release rebuilt through `npm run desktop:build`; MSI and NSIS completed before launch. Song restored paused at 261.572 seconds. Android APK unchanged; its existing gateway interface uses these backend fixes.
- Validation: 20 Qu-16 runtime unit tests and 9 singer audio/front-light tests passed; `git diff --check` passed.

## Still requires completion

- Electrical noise recurrence has no confirmed root cause. Existing playback log shows shared WASAPI 48 kHz and no corresponding decoder error. This does not prove clean physical output. Await the triggering operation/time and reproduce before changing the audio chain.
- DP448: AudioCore 8.91 initially opened an offline comparison project. Detected PL2303GT COM3; inspected 115200 baud and acknowledged commands. Used Just Connect (no historical settings download). Scan All IDs subsequently identified ID 1 as XTA DP448 V3.01 (IDs 2-32: no response). Device identity is now verified; Build System from Connected Units -> Get Current Settings Only completed. Saved `docs/hardware/DP448-LIVE-2026-09-10.xaa` (76180 bytes; SHA256 3CEB7AC2ED68A5EFDE3C15387FFA69E966B0EFFFB1411AADB59EACE7A7403F43). Native KINGCLUB DP448 protocol writes remain unimplemented.

Local detailed test receipts: `ui-prototype/artifacts/qu16-real-control-acceptance.json` (ignored diagnostic artifact; no credentials).

DP448 current UI readback: input FULL-L/FULL-R +2.3 dB, SUB 0.0 dB; OUT1/2 (M-F15+L/R) -9.0 dB; OUT3-6 -11.0 dB; OUT7/8 -7.0 dB. No output gain, mute, polarity, EQ or delay was changed. Output controls left open in AudioCore.

Protocol boundary: manufacturer Simple Remote Protocol is one-way and covers gains/mutes/memory recall, not readback or full EQ/delay editing. Full AudioCore-compatible two-way protocol is still needed for native processor workspace control. Reference: https://mc2-audio.co.uk/wp-content/uploads/Simple-Remote-Protocol-Update-DPA-Delta.pdf

## 面光按钮周期闪烁修复

- 复现：旧逻辑每5000ms获取一次Titan句柄，却在4000ms时将样本过期。实机网关12秒采样中有3个采样点错误显示不可用，而真实开关值始终为关。
- 修复：刷新间隔与失效窗口由同一模块定义，5000ms轮询、12000ms有效期；单次读取失败保留最后成功样本，超过窗口仍失效。主机、控制台身份或Show不符仍立即拒绝，执行指令前后仍主动回读。
- 回归：覆盖连续轮询边界、丢失一次回复、持续失联到期及已断开立即不可用；未改变灯光节目或DMX输出。
- 发布版重启后实机网关12秒/24次采样：24次均available=true，没有出现未连接；修复前同样采样为21次可用、3次不可用。该验收针对按钮状态，未触发灯具开关。
