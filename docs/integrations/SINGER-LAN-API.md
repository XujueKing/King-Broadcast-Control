# 主唱平板局域网接口 v1

2026-09-10 实机验收：中控已重新构建并启动，Android 0.1.5 Release（versionCode 6）已覆盖安装到 Lenovo TB-X616M。系统设置横屏时应用仍为竖屏；平板真实 HTTP 读取阿俊歌单 21 首，点击升调后中控确认 +1 半音，再点击原调确认 0。暂停状态下将临时点播《茶花开了》定位至曲终，中控自动恢复阿俊歌单《后来的我们》61.52 秒、原升降调设置并保持暂停。验证未发送播放命令。证据位于 `ui-prototype/artifacts/singer-interlude-live-verification.json`；Android 实机截图位于独立安卓项目 `artifacts/*0.1.5.png` 和 `artifacts/pitch-confirmation.png`。

范围：主唱从中控本地曲库选歌、看同步歌词、原唱/伴唱、重唱、切歌，以及必要的播放/暂停。平板程序在后续独立项目开发。本项目提供中控 API、设置入口和可复用客户端。

## 连接

### 自动发现与 4 位配对（Android 0.1.2）

平板与中控接入同一员工局域网。安卓端通过 UDP 4866 自动发现中控；仅一台时自动选中，多台时由歌手选择。在中控生成 4 位配对码，平板输入一次即可保存长期密钥。短码有效期 5 分钟、成功一次即关闭，累计输错 5 次锁定该窗口，需中控重新生成。窗口不会跨重启保留。

后续启动自动重连；已连接时遇到网络错误，最多每 10 秒尝试重新发现。改用新地址前，必须验证 HMAC-SHA256：密钥为原 64 字符 token 的 UTF-8 字节，消息为 `kingclub-singer-v1|<nonce>|<controllerId>|<port>`，结果为 64 位 hex。nonce 为每次新生成的 32 位随机 hex，controllerId 持久保存。发现消息不会发送密钥，返回包没有配对码。自动重连只读取状态，不播放、切歌或调音。

新增无 Bearer 路由 `GET /info?nonce=<32位hex>` 返回公开身份和证明；`POST /pair` 接收 `{controllerId,code}`，成功返回 `{apiVersion:1,controllerId,token}`。两条路由仍限制私有 IPv4/回环并拒绝 Origin。其余路由继续要求长期 Bearer。短码关闭、过期、锁定分别返回 `pairing_closed`、`pairing_expired`、`pairing_locked`。

防火墙除现有 TCP 接口外，还需允许应用 UDP 4866 入站。广播过滤、跨网段或访客隔离会阻止自动发现；可在折叠入口手动填写可达地址并使用相同 4 位配对。长密钥仅保留兼容旧中控。下面原 v1 的“所有路由需密钥”规则不包括以上两个新增路由。

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


## Android 0.1.5：歌单、临时点播、升降调

客户端固定竖屏。`state.features` 声明 `pitch`、`playlists`、`temporarySelect`；老中控缺少能力时不显示歌单操作，升降调禁用。

- `GET /playlists` 返回 `items:[{id,name,kind,library,count}]`。类别为 weekday/event/custom，库号为 1/2；ID 不包含本地路径。
- `GET /songs?playlistId=<id>` 按该歌单的原顺序分页，可结合 q 搜索。省略 playlistId 则搜索全部曲库。未知歌单返回空结果，绝不退回全库误播。
- `playlist_select` 携带 songId、playlistId，服务端检查归属并在执行时再次检查；装载暂停，将 Deck 绑定到该歌单。
- `temporary_select` 携带 songId：保存原曲稳定路径、真实 mpv 位置、原歌单来源、原唱/伴唱与音高；再装载临时歌曲并暂停。连续临时选歌保留第一份原位置。匹配临时歌曲的真实 EOF 在中控恢复原曲并定位，保持暂停。重复/过期 EOF 不重复恢复；本机明确重新选歌取消旧书签；遇到其他 Deck 播放、CUE 或混音则不强行恢复。书签存在中控本次运行内，平板后台或断网不影响；中控重启不自动恢复此书签。
- `state.playlist` 是当前来源摘要；`state.interlude` 有 active、returnSong、returnPositionSeconds、returnRevision。成功恢复才增加 returnRevision，平板据此恢复列表分类、分页、搜索与滚动位置，不发送播放命令。
- `pitch` 携带整数 semitones，范围 −6..+6，0 是原调。真实 mpv rubberband 标签滤镜调整音高；保留输出校准滤镜、速度、位置、暂停状态；换歌回到原调，同曲原伴唱切换保留音高。命令等滤镜参数回读后才成功，`playback.pitchSemitones` 是已确认值。

算法参照 [mpv 官方 rubberband 文档](https://mpv.io/manual/stable/#audio-filters-rubberband)。本机隔离测试使用 `ao=null` 和 PCM 文件输出，±2 半音的 440Hz 测试音测得 392.00Hz / 493.88Hz，时长均 3.0 秒，没有连接真实音响。现场音质仍由歌手听感确认。


## Android 0.1.15: atmosphere sound pad

`state.features.atmosphere=true` enables the right-side pad. Submit the usual authenticated, revision-checked command with `operation: {type:"atmosphere", effect:"applause"|"cheer"|"scream"|"stop", volume:0..60}`. Volume is an integer, default client value 30, applied to the next triggered effect. Succeeded confirms mpv acknowledged playback/stop, not operator hearing. No path or URL is accepted. Commands keep the existing receipt journal and never replay after reconnect.

The desktop bundles three CC0 recordings (see src-tauri/assets/atmosphere/LICENSE.md), plays at most one effect on private mpv lane 21 using the preferred audio output, leaves both songs and CUE lanes untouched, and exits the effect process at EOF. Stop does not create a player. The APK contains controls only; audio plays on the desktop.
