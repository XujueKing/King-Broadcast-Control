# Allen & Heath Qu-16 官方资料缓存

资料于 2026-08-23 从 Allen & Heath 官方站点下载，用于实现和验证 Qu-16 型号包。

## 本地文件

- `Qu-Mixer-Reference-Guide-AP9372_10.pdf` - Qu Firmware V1.9 参考手册，92 页。
- `Qu_MIDI_Protocol_V1.9.pdf` - Qu MIDI/TCP 协议，13 页。
- `Qu_WindowsDriverHelpV5.72.0_Iss1.pdf` - Windows 驱动说明，2 页，从官方驱动 ZIP 中提取。
- `AllenHeath-Qu-Windows-Driver-v5.72.0.zip` - 官方 Windows 10/11 ASIO/WDM 驱动原包；SHA-256 `B157604767C2B59DCB88B2188A66D0A8897AF093CF37B32438C871A262A8C834`。

## 已落实的硬件规则

- 现场音频链路：电脑与 Qu-16 后面板 USB-B 2.0 连接；Qu-16 提供 24 路可配置 USB 输出，Windows 驱动提供 ASIO 2.2、WDM/MME/DirectSound/WASAPI。
- 现场控制链路：电脑与 Qu-16 Network 口使用以太网连接；控制为 MIDI over TCP，端口 51325，同一时刻只允许一个 TCP 客户端。
- 连接保活：Qu 约每 300ms 发送 Active Sense；建立需要保活的连接后，连续 12 秒没有有效数据会断开。
- Mute 关闭该通道发往 LR、Mix、FX 和监听的声音；Sel 把该通道的处理交给 SuperStrip/触屏；PAFL 把通道送入耳机监听和主表。
- Mix Select 一次只选择一个 Mix；所选 Mix 映射到独立 Master Strip，通道推子随之显示该 Mix 的发送电平。
- SuperStrip 按 Sel 通道工作，覆盖 Preamp、HPF、Gate、PEQ、Comp、GEQ 和 Pan；软件圆形旋钮支持拖动、键盘和鼠标滚轮调节。

## 官方来源

- https://www.allen-heath.com/hardware/qu/qu-classic/qu-16/resources/
- https://www.allen-heath.com/content/uploads/2023/06/Qu-Mixer-Reference-Guide-AP9372_10.pdf
- https://www.allen-heath.com/content/uploads/2023/06/Qu_MIDI_Protocol_V1.9.pdf
