//! Native XTA DP448 V3.01 transport, verified against the venue unit.
//! Only gain/delay writes are enabled. See docs/integrations/DP448-PROTOCOL.md.
use serde::Serialize;
use serialport::SerialPort;
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Default, Clone)]
pub struct Dp448(pub Arc<Mutex<Runtime>>);
#[derive(Default)]
pub struct Runtime {
    connection: Option<Connection>,
    epoch: u64,
}
struct Connection {
    port: Box<dyn SerialPort>,
    epoch: u64,
    name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    id: u8,
    label: String,
    gain_db: f64,
    delay_ms: f64,
    linked_outputs: Vec<u8>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    model: String,
    port: String,
    epoch: u64,
    revision: String,
    outputs: Vec<Output>,
}

fn pack(raw: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    for group in raw.chunks(7) {
        result.push(
            group
                .iter()
                .enumerate()
                .fold(0, |m, (i, b)| m | ((b >> 7) << i)),
        );
        result.extend(group.iter().map(|b| b & 127));
    }
    result
}
fn unpack(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.iter().any(|b| *b > 127) {
        return Err("DP448 数据编码无效".into());
    }
    let mut result = Vec::new();
    for g in data.chunks(8) {
        if g.len() == 1 {
            return Err("DP448 数据块不完整".into());
        }
        result.extend(
            g[1..]
                .iter()
                .enumerate()
                .map(|(i, b)| b | (((g[0] >> i) & 1) << 7)),
        );
    }
    Ok(result)
}
fn packet(command: u8, data: &[u8], ack: bool) -> Vec<u8> {
    let len = data.len() + 7;
    let mut frame = vec![
        if ack { 0xf1 } else { 0xf0 },
        (len >> 7) as u8,
        (len & 127) as u8,
        0x78,
        1,
        0,
        command,
    ];
    frame.extend_from_slice(data);
    frame.push(frame.iter().fold(0u8, |s, b| s.wrapping_add(*b)) & 127);
    frame
}
fn validate_frame(frame: &[u8]) -> Result<(), String> {
    if frame.len() < 5
        || frame[0] < 128
        || *frame.last().unwrap() != 255
        || frame[1] as usize * 128 + frame[2] as usize + 2 != frame.len()
        || frame[1..frame.len() - 1].iter().any(|b| *b > 127)
        || (frame[..frame.len() - 2]
            .iter()
            .fold(0u8, |s, b| s.wrapping_add(*b))
            & 127)
            != frame[frame.len() - 2]
    {
        return Err("DP448 返回长度或校验和错误".into());
    }
    Ok(())
}
fn verified_identity(identity: &[u8]) -> bool {
    identity.len() == 22
        && identity[0] == 0xb8
        && identity[3] == 1
        && identity[4..20] == *b"XTA DP448 V3.01 "
}
fn transact(
    port: &mut dyn SerialPort,
    request: &[u8],
    command: Option<u8>,
) -> Result<Vec<u8>, String> {
    port.clear(serialport::ClearBuffer::Input)
        .map_err(|e| e.to_string())?;
    port.write_all(request)
        .map_err(|e| format!("DP448 写入失败：{e}"))?;
    let until = Instant::now() + Duration::from_secs(2);
    let mut frame = Vec::new();
    let mut buf = [0u8; 256];
    while Instant::now() < until {
        match port.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => {
                for b in &buf[..n] {
                    frame.push(*b);
                    if frame.len() > 2048 {
                        return Err("DP448 返回数据超过上限".into());
                    }
                    if *b == 255 {
                        validate_frame(&frame)?;
                        if command.map_or(true, |c| {
                            frame.len() > 7 && frame[0] == 0xa8 && frame[3..7] == [0x78, 1, 0, c]
                        }) {
                            return Ok(frame);
                        }
                        frame.clear();
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(e) => return Err(format!("DP448 连接已断开：{e}")),
        }
    }
    Err("DP448 回读超时；未确认执行，禁止自动重发".into())
}
fn read_outputs(port: &mut dyn SerialPort) -> Result<Vec<u8>, String> {
    let frame = transact(port, &packet(0x32, &[0, 0, 0], false), Some(0x32))?;
    let raw = unpack(&frame[7..frame.len() - 2])?;
    parse_outputs(&raw)?;
    Ok(raw)
}
fn parse_outputs(raw: &[u8]) -> Result<Vec<Output>, String> {
    if raw.len() != 685 {
        return Err("DP448 输出参数版本不匹配".into());
    }
    let mut outputs = Vec::new();
    for i in 0..8 {
        let group = raw[2 + i];
        if !group.is_power_of_two() || raw[2 + group.trailing_zeros() as usize] != group {
            return Err("DP448 联动组编码尚未验证".into());
        }
        let gain = i16::from_le_bytes([raw[18 + 2 * i], raw[19 + 2 * i]]) as f64 / 10.;
        let p = 34 + 3 * i;
        let ticks = u32::from_le_bytes([raw[p], raw[p + 1], raw[p + 2], 0]);
        if !(-80.0..=15.0).contains(&gain) {
            return Err("DP448 增益读回值无效".into());
        }
        let label = std::str::from_utf8(&raw[621 + 8 * i..629 + 8 * i])
            .map_err(|_| "DP448 输出名称编码无效")?
            .trim()
            .to_string();
        outputs.push(Output {
            id: (i + 1) as u8,
            label,
            gain_db: gain,
            delay_ms: ticks as f64 / 12288.,
            linked_outputs: (0..8)
                .filter(|j| raw[2 + j] == group)
                .map(|j| (j + 1) as u8)
                .collect(),
        });
    }
    Ok(outputs)
}
fn snapshot(c: &Connection, raw: &[u8]) -> Result<Snapshot, String> {
    Ok(Snapshot {
        model: "XTA DP448 V3.01 · ID 1".into(),
        port: c.name.clone(),
        epoch: c.epoch,
        revision: blake3::hash(raw).to_hex().to_string(),
        outputs: parse_outputs(raw)?,
    })
}
fn write_plan(
    raw: &[u8],
    output: u8,
    field: &str,
    value: f64,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    if !(1..=8).contains(&output) || !value.is_finite() {
        return Err("DP448 参数无效".into());
    }
    let outputs = parse_outputs(raw)?;
    let (command, bytes, offset, width) = match field {
        "gainDb" if (-60.0..=12.0).contains(&value) => (
            2,
            ((value * 10.).round() as i16).to_le_bytes().to_vec(),
            18,
            2,
        ),
        "delayMs" if (0.0..=1000.0).contains(&value) => (
            1,
            ((value * 12288.).round() as u32).to_le_bytes()[..3].to_vec(),
            34,
            3,
        ),
        _ => return Err("该参数未开放原生写入或超出软件控制范围".into()),
    };
    let mut expected = raw.to_vec();
    for id in &outputs[output as usize - 1].linked_outputs {
        let at = offset + (*id as usize - 1) * width;
        expected[at..at + width].copy_from_slice(&bytes);
    }
    let mut payload = vec![output + 4];
    payload.extend(bytes);
    Ok((packet(command, &pack(&payload), true), expected))
}

#[tauri::command]
pub async fn dp448_ports() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        serialport::available_ports()
            .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dp448_connect(
    state: tauri::State<'_, Dp448>,
    port: String,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Only a currently enumerated serial device can be opened; no arbitrary paths.
        if !serialport::available_ports()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|p| p.port_name == port)
        {
            return Err("串口不存在，请检查 DP448 USB 转串口连接".into());
        }
        let mut state = state.0.lock().map_err(|e| e.to_string())?;
        if state.connection.is_some() {
            return Err("DP448 已连接，请先断开旧连接".into());
        }
        let mut serial = serialport::new(&port, 115200)
            .timeout(Duration::from_millis(30))
            .open()
            .map_err(|e| format!("无法打开 {port}：{e}。AudioCore 不能同时占用此串口。"))?;
        let identity = transact(serial.as_mut(), &[0xb0, 1], None)?;
        if !verified_identity(&identity) {
            return Err("设备不是已验证的 ID1 XTA DP448 V3.01，未开放控制".into());
        }
        let raw = read_outputs(serial.as_mut())?;
        state.epoch += 1;
        let c = Connection {
            port: serial,
            epoch: state.epoch,
            name: port,
        };
        let result = snapshot(&c, &raw)?;
        state.connection = Some(c);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dp448_disconnect(state: tauri::State<'_, Dp448>, epoch: u64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        if s.connection.as_ref().is_some_and(|c| c.epoch == epoch) {
            s.connection = None;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dp448_read(state: tauri::State<'_, Dp448>, epoch: u64) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        operate(&state, epoch, |c| {
            let raw = read_outputs(c.port.as_mut())?;
            snapshot(c, &raw)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn operate<T>(
    state: &Dp448,
    epoch: u64,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let c = s
        .connection
        .as_mut()
        .filter(|c| c.epoch == epoch)
        .ok_or("DP448 会话已失效，请重新连接")?;
    let result = f(c);
    if result.is_err() {
        s.connection = None;
    } // Release hardware on any uncertain transaction. Never replay.
    result
}
#[tauri::command]
pub async fn dp448_write(
    state: tauri::State<'_, Dp448>,
    epoch: u64,
    revision: String,
    output: u8,
    field: String,
    value: f64,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        operate(&state, epoch, |c| {
            let baseline = read_outputs(c.port.as_mut())?;
            if blake3::hash(&baseline).to_hex().as_str() != revision {
                return Err("DP448 参数已在设备端变化，请重新读取后操作".into());
            }
            let (request, expected) = write_plan(&baseline, output, &field, value)?;
            if expected == baseline {
                return snapshot(c, &baseline);
            }
            c.port
                .write_all(&request)
                .map_err(|e| format!("DP448 写入失败：{e}"))?;
            std::thread::sleep(Duration::from_millis(100));
            let after = read_outputs(c.port.as_mut())?;
            if after != expected {
                return Err("DP448 回读与目标不一致，未确认成功；连接已释放，请重新读取".into());
            }
            snapshot(c, &after)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_short_or_wrong_identity_without_panic() {
        for length in 0..22 { assert!(!verified_identity(&vec![0; length])); }
        let mut identity = vec![0xb8, 0, 20, 1];
        identity.extend_from_slice(b"XTA DP448 V3.01 ");
        identity.extend([0x66, 0xff]);
        assert!(verified_identity(&identity));
        identity[17] = b'9';
        assert!(!verified_identity(&identity));
    }
    const RAW: &[u8] = include_bytes!("../tests/fixtures/dp448-v301-outputs.bin");
    const FRAME: &[u8] = include_bytes!("../tests/fixtures/dp448-v301-output-frame.bin");
    #[test]
    fn captured_frame_roundtrip() {
        validate_frame(FRAME).unwrap();
        assert_eq!(unpack(&FRAME[7..FRAME.len() - 2]).unwrap(), RAW);
        assert_eq!(unpack(&pack(RAW)).unwrap(), RAW);
    }
    #[test]
    fn captured_values_and_groups() {
        let o = parse_outputs(RAW).unwrap();
        assert_eq!(
            o.iter().map(|o| o.gain_db).collect::<Vec<_>>(),
            vec![-9., -9., -11., -11., -11., -11., -7., -7.]
        );
        assert_eq!(o[0].linked_outputs, vec![1, 2]);
        assert_eq!(o[2].linked_outputs, vec![3, 4]);
        assert_eq!(o[4].linked_outputs, vec![5]);
        assert_eq!(o[0].delay_ms, 14.);
        assert_eq!(o[2].delay_ms, 45.5);
        assert_eq!(o[0].label, "M-F15+L");
    }
    #[test]
    fn captured_gain_write_and_linked_readback() {
        let (p, r) = write_plan(RAW, 1, "gainDb", -10.4).unwrap();
        assert_eq!(p, vec![0xf1, 0, 11, 0x78, 1, 0, 2, 6, 5, 0x18, 0x7f, 0x19]);
        let changed: Vec<_> = r
            .iter()
            .zip(RAW)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(changed, vec![18, 20]);
    }
    #[test]
    fn captured_delay_write() {
        let (p, _) = write_plan(RAW, 1, "delayMs", 172020. / 12288.).unwrap();
        assert_eq!(
            p,
            vec![0xf1, 0, 12, 0x78, 1, 0, 1, 6, 5, 0x74, 0x1f, 2, 0x17]
        );
    }
    #[test]
    fn reject_invalid_and_unverified_commands() {
        for (o, f, v) in [
            (0, "gainDb", 0.),
            (9, "gainDb", 0.),
            (1, "gainDb", 13.),
            (1, "gainDb", f64::NAN),
            (1, "delayMs", -1.),
            (1, "hpfHz", 65.),
        ] {
            assert!(write_plan(RAW, o, f, v).is_err());
        }
    }
    #[test]
    fn reject_corrupted_frames_and_groups() {
        let mut b = FRAME.to_vec();
        b[20] ^= 1;
        assert!(validate_frame(&b).is_err());
        assert!(validate_frame(&FRAME[..20]).is_err());
        assert!(unpack(&[128, 1]).is_err());
        let mut r = RAW.to_vec();
        r[2] = 3;
        assert!(parse_outputs(&r).is_err());
        assert!(parse_outputs(&r[..100]).is_err());
    }
}
