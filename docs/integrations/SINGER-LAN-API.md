# 主唱平板局域网接口 v1

范围：主唱从中控本地曲库选歌、看同步歌词、原唱/伴唱、重唱、切歌，以及必要的播放/暂停。平板程序在后续独立项目开发。本项目提供中控 API、设置入口和可复用客户端。

## 连接

在 Windows 中控「设置 → 主唱平板连接」选择演唱 Deck，保存并开启接口。默认端口 `4865`，默认关闭；启用状态与连接密钥保存在应用数据目录 `singer-gateway.json`，重启后恢复服务但不自动开始播放。首次选歌/播放将该 Deck 设为单曲播放，曲终暂停。

平板连接与中控互通的员工局域网，把设置页显示的局域网地址和连接密钥保存到平板应用私有存储。更换密钥会解除所有旧连接。电脑推荐有线接入，并在路由器给电脑保留固定 DHCP 地址。Windows 防火墙只需按实际程序路径为专用网络/本地子网放行这个 TCP 端口；访客 Wi-Fi 的客户端隔离可能阻止访问。没有额外硬件网关或云服务依赖。

v1 是原生平板程序使用的 HTTP + Bearer API，限制私有 IPv4/回环来源；所有路由都需要 `Authorization: Bearer <连接密钥>`。HTTP 不加密，只用于受信任员工网络，不能端口映射到公网。未来若采用浏览器/PWA 前端，应增加可信 HTTPS 和明确的同源托管/Origin 白名单；当前服务明确拒绝带 `Origin` 的浏览器跨源请求，不配置通配 CORS。不要把 Tauri 调用接口、媒体文件夹或任意本地文件暴露给平板。

## 路由

统一前缀 `/api/singer/v1`；返回 JSON，禁止缓存。

| 方法/路径 | 用途 |
| --- | --- |
| `GET /state` | 中控会话、修订号、当前歌曲、真实 mpv 进度、原伴唱、是否就绪/忙碌 |
| `GET /songs?q=晴天&offset=0&limit=50` | 按歌名/歌手搜索本地曲库，最多每页 100 首 |
| `GET /songs/{songId}/lyrics` | 行级时间轴 `{atSeconds,text}`，与中控同一 LRC 解析结果 |
| `POST /commands` | 提交一条主唱操作，HTTP 202 表示已受理，尚不表示执行成功 |
| `GET /commands/{id}` | 查询实际执行回执 |

歌曲 ID 是中控按本地稳定身份生成的不可读标识，不是路径。移动文件可能改变 ID；平板应刷新搜索结果，不能推算 Windows 路径。曲库列表不传音视频，不启动 AI，不重复扫描/分析文件。没有歌词时 `lyricsAvailable=false`、`lines=[]`；没有伴奏时禁用伴唱按钮。

`GET /state` 示例（示意值）：

```json
{
  "apiVersion": 1,
  "sessionId": "本次中控连接会话",
  "revision": 25,
  "serverTimeUnixMs": 1800000000000,
  "controllerOnline": true,
  "deck": 1,
  "song": {"id":"歌曲标识","title":"歌曲名","artist":"歌手","durationSeconds":180,"lyricsAvailable":true,"accompanimentAvailable":true},
  "playback": {"loaded":true,"paused":false,"positionSeconds":32.5,"sampledAtUnixMs":1800000000000,"clockFresh":true,"vocalMode":"accompaniment","playbackMode":"single","volume":66},
  "cueActive": false,
  "transitionBusy": false,
  "busy": false
}
```

`song` 和 `playback` 可为 null。建议平板前台每 250ms 拉一次状态；后台停止轮询。中控桥接周期 200ms，播放器采样复用已有约 160ms 轮询。`sampledAtUnixMs` 是读取 mpv 进度时的中控时间；平板可用请求往返中点估算时差，在短间隔内插值，并持续用真实采样校正。暂停时不得推进进度；`clockFresh=false`、`controllerOnline=false` 或连接中断时冻结歌词并显示状态。不要拿平板本地计时器独立累计整首歌曲。歌词提前量只作用于平板显示，不能改中控播放位置。

## 操作和回执

每次点击生成唯一 `id`（UUID）。先读最新状态，提交该状态的会话、修订号和中控时间，避免要求两台设备的系统时钟完全一致：

```json
{
  "id": "d56e371e-bbeb-464d-8445-7d8dff963cd9",
  "sessionId": "从 state 取得",
  "expectedRevision": 25,
  "issuedAtUnixMs": 1800000000000,
  "operation": {"type":"select","songId":"从 songs 取得"}
}
```

| operation | 行为 |
| --- | --- |
| `{"type":"select","songId":"…"}` | 明确接管背景音乐，停止两路 Deck、取消自动接歌，再装载指定歌曲；从头待唱，默认原唱，单曲播放，保持暂停 |
| `{"type":"next","songId":"…"}` | 同样接管背景音乐，切到明确指定的下一首，从头暂停；必须给歌曲 ID，重试不会连续跳两首 |
| `{"type":"play"}` | 开始/继续当前歌；另一 Deck 暂停时将 Crossfader 定位到演唱 Deck，保留总音量并等待 AI 播放保护及 mpv 返回 |
| `{"type":"pause"}` | 暂停当前歌 |
| `{"type":"restart"}` | 回到开头，保持原来的播放/暂停状态，复用中控静音定位流程 |
| `{"type":"vocal_mode","mode":"original"}` | 切原唱，保持进度和播放状态 |
| `{"type":"vocal_mode","mode":"accompaniment"}` | 切伴唱，缺少伴奏时拒绝，不现场制作 |

一份回执包含 `id/status/error/revision`。状态依次为 `queued → executing → succeeded/failed`，未执行的旧请求也可成为 `rejected/expired/cancelled`。只有 `succeeded` 才可显示完成。失败后读取当前状态，不能猜测播放器没有发生任何变化；部分底层操作已执行但后续读取可能失败。

服务最多允许一条未完成操作，保留最近 128 份回执。同一个 ID 和完全相同的请求重传只返回原回执；同 ID 不同内容返回 409。新请求必须是当前会话和修订号、中控时间前后 5 秒内，未执行队列也只保留 5 秒。曲目、播放状态、原伴唱、路由或连接改变会使旧请求失效。执行中的请求不会因为 HTTP 超时被自动重做。

网络不确定时保留原 `commandId` 查询回执；不得重新生成 ID 自动补发切歌。接口关闭或中控重启后，平板重新读取会话及状态；不发送断线期间积累的操作。

## 错误

| 返回 | 处理 |
| --- | --- |
| 401 `unauthorized` | 密钥错误、已更换或接口关闭，重新连接 |
| 403 `lan_only` / `browser_origin_not_enabled` | 使用允许的员工局域网/原生客户端 |
| 409 `state_changed` | 中控状态已变化，刷新页面后由用户重新操作 |
| 409 `controller_busy` | 等待现有操作回执 |
| 409 `command_expired` / `id_reused` | 不执行，检查请求生成逻辑 |
| 503 `controller_offline` | 主窗口桥接或播放器未就绪；冻结远程操作 |
| 404 `song_not_found` / `receipt_not_found` | 更新曲库/状态，不用猜测 ID |
| 回执 `cue_active` / `desktop_mix_active` | CUE 时拒绝远程操作；双 Deck 同播/自动混音时先选歌接管背景音乐，再使用播放、重唱等操作 |
| 回执 `accompaniment_unavailable` | 保持原模式，提示该歌没有伴唱 |
| 回执 `playback_operation_failed` | 底层操作失败，详细原因在中控消息与日志中；重新读状态 |

接口不控制麦克风推子、Qu-16 路由、补音武装、灯具参数或视频上屏。已有灯光自动联动继续读取同一个 Deck 真实播放状态。

## 平板项目交接

复用 `integrations/singer-client.mjs`，原生网络层按同一协议实现即可。可导入的协议文件是同目录 `singer-lan.openapi.json`。

```js
import {SingerClient} from './singer-client.mjs';
const client = new SingerClient({baseUrl: savedAddress, token: savedKey});
const {items} = await client.songs('歌名或歌手');
await client.selectSong(items[0].id); // 等待实际装载回执
const lyrics = await client.lyrics(items[0].id);
await client.setVocalMode('accompaniment');
await client.play();
```

后续平板只需连接页、曲库选歌页、横屏演唱页。演唱页保留大字当前歌词、下一句、原唱/伴唱、重唱、切歌、播放/暂停和明确的连接状态；不需要吧台管理、顾客点歌或云端队列。

服务采用 [Axum 官方 HTTP 路由与共享状态机制](https://docs.rs/axum/0.8.9/axum/)，播放由已有桌面控制函数执行并确认。
