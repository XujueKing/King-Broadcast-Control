use king_vocal_engine::{
    benchmark_transfer,
    correction::{parse_tonic, ScaleMode},
    enumerate_devices,
    failover::run_failover_matrix,
    multilane::run_multilane_simulation,
    preset::VocalPreset,
    routing::run_virtual_routing_discovery,
    run_for_duration,
    simulation::{run_simulation, SimulationConfig, SimulationFault},
    site::build_site_readiness,
    LoopbackConfig,
};
use std::{
    env, fs, io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        Some("devices") => {
            println!("{}", serde_json::to_string_pretty(&enumerate_devices()?)?);
            Ok(())
        }
        Some("run") => run_loopback(&arguments[1..]),
        Some("bench") => run_benchmark(&arguments[1..]),
        Some("simulate") => run_simulator(&arguments[1..]),
        Some("site-check") => run_site_check(&arguments[1..]),
        Some("simulate-multilane") => run_multilane_simulator(&arguments[1..]),
        Some("simulate-failover") => run_failover_simulator(&arguments[1..]),
        Some("discover-routing-virtual") => run_virtual_routing(&arguments[1..]),
        Some("control-stdio") => {
            king_vocal_engine::control::serve_control_lines(
                io::stdin().lock(),
                io::stdout().lock(),
            )?;
            Ok(())
        }
        _ => {
            print_help();
            Ok(())
        }
    }
}

fn run_virtual_routing(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let report = run_virtual_routing_discovery()?;
    let encoded = serde_json::to_vec_pretty(&report)?;
    if let Some(path) = string_argument(arguments, "--output").map(PathBuf::from) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &encoded)?;
    }
    println!("{}", String::from_utf8(encoded)?);
    Ok(())
}

fn run_failover_simulator(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let duration_seconds = number_argument(arguments, "--seconds")?.unwrap_or(3.0);
    let block_frames = number_argument(arguments, "--block-frames")?.unwrap_or(128);
    let report = run_failover_matrix(duration_seconds, block_frames)?;
    let encoded = serde_json::to_vec_pretty(&report)?;
    if let Some(path) = string_argument(arguments, "--output").map(PathBuf::from) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &encoded)?;
    }
    println!("{}", String::from_utf8(encoded)?);
    Ok(())
}

fn run_multilane_simulator(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let duration_seconds = number_argument(arguments, "--seconds")?.unwrap_or(3.0);
    let block_frames = number_argument(arguments, "--block-frames")?.unwrap_or(128);
    let report = run_multilane_simulation(duration_seconds, block_frames)?;
    let encoded = serde_json::to_vec_pretty(&report)?;
    if let Some(path) = string_argument(arguments, "--output").map(PathBuf::from) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &encoded)?;
    }
    println!("{}", String::from_utf8(encoded)?);
    Ok(())
}

fn run_site_check(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let report = build_site_readiness(&enumerate_devices()?);
    let encoded = serde_json::to_vec_pretty(&report)?;
    if let Some(path) = string_argument(arguments, "--output").map(PathBuf::from) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &encoded)?;
    }
    println!("{}", String::from_utf8(encoded)?);
    Ok(())
}

fn run_loopback(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if !arguments.iter().any(|argument| argument == "--arm") {
        return Err("安全拒绝：run 必须显式提供 --arm；开始前请关闭扬声器或使用耳机/调音台安全返回，避免麦克风啸叫".into());
    }
    let key_tonic = string_argument(arguments, "--key")
        .map(|value| parse_tonic(&value))
        .transpose()?;
    let scale_mode = string_argument(arguments, "--scale")
        .map(|value| value.parse::<ScaleMode>())
        .transpose()?;
    let config = LoopbackConfig {
        input_device: string_argument(arguments, "--input"),
        output_device: string_argument(arguments, "--output"),
        input_channel: number_argument(arguments, "--input-channel")?.unwrap_or(0),
        output_channel: number_argument(arguments, "--output-channel")?.unwrap_or(0),
        buffer_frames: number_argument(arguments, "--buffer-frames")?.unwrap_or(128),
        ring_capacity_frames: number_argument(arguments, "--ring-frames")?.unwrap_or(4096),
        prefill_frames: number_argument(arguments, "--prefill-frames")?.unwrap_or(256),
        gain_db: number_argument(arguments, "--gain-db")?.unwrap_or(-18.0),
        pitch_correction_enabled: arguments
            .iter()
            .any(|argument| argument == "--enable-pitch-correction"),
        correction_strength: number_argument(arguments, "--correction-strength")?.unwrap_or(0.75),
        correction_deadband_cents: number_argument(arguments, "--deadband-cents")?.unwrap_or(8.0),
        maximum_correction_cents: number_argument(arguments, "--max-correction-cents")?
            .unwrap_or(45.0),
        key_tonic,
        scale_mode,
        reference_map: string_argument(arguments, "--reference").map(PathBuf::from),
        vocal_dynamics_enabled: arguments
            .iter()
            .any(|argument| argument == "--enable-vocal-dynamics"),
        vocal_quality_enabled: arguments
            .iter()
            .any(|argument| argument == "--enable-vocal-quality"),
        adaptive_vocal_blend_enabled: arguments
            .iter()
            .any(|argument| argument == "--enable-adaptive-blend"),
        vocal_preset: string_argument(arguments, "--vocal-preset")
            .map(|value| value.parse::<VocalPreset>())
            .transpose()?
            .unwrap_or_default(),
    };
    let seconds = number_argument::<u64>(arguments, "--seconds")?.unwrap_or(10);
    let metrics_path = string_argument(arguments, "--metrics").map(PathBuf::from);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_signal = Arc::clone(&stop);
    ctrlc::set_handler(move || stop_signal.store(true, Ordering::Relaxed))?;
    let final_metrics = run_for_duration(&config, Duration::from_secs(seconds), stop, |metrics| {
        println!("{}", serde_json::to_string(metrics).unwrap_or_default())
    })?;
    let encoded = serde_json::to_vec_pretty(&final_metrics)?;
    if let Some(path) = metrics_path {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &encoded)?;
    }
    println!("{}", String::from_utf8(encoded)?);
    Ok(())
}

fn run_benchmark(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let block_frames = number_argument(arguments, "--block-frames")?.unwrap_or(128);
    let blocks = number_argument(arguments, "--blocks")?.unwrap_or(10_000);
    println!(
        "{}",
        serde_json::to_string_pretty(&benchmark_transfer(block_frames, blocks)?)?
    );
    Ok(())
}

fn run_simulator(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let key_tonic = string_argument(arguments, "--key")
        .map(|value| parse_tonic(&value))
        .transpose()?;
    let scale_mode = string_argument(arguments, "--scale")
        .map(|value| value.parse::<ScaleMode>())
        .transpose()?;
    let config = SimulationConfig {
        input_wav: string_argument(arguments, "--input-wav").map(PathBuf::from),
        output_dir: string_argument(arguments, "--output-dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("artifacts/simulation")),
        duration_seconds: number_argument(arguments, "--seconds")?.unwrap_or(5.0),
        block_frames: number_argument(arguments, "--block-frames")?.unwrap_or(128),
        gain_db: number_argument(arguments, "--gain-db")?.unwrap_or(0.0),
        fault: string_argument(arguments, "--fault")
            .unwrap_or_else(|| "none".into())
            .parse::<SimulationFault>()?,
        correction_strength: number_argument(arguments, "--correction-strength")?.unwrap_or(0.75),
        correction_deadband_cents: number_argument(arguments, "--deadband-cents")?.unwrap_or(8.0),
        maximum_correction_cents: number_argument(arguments, "--max-correction-cents")?
            .unwrap_or(45.0),
        key_tonic,
        scale_mode,
        reference_map: string_argument(arguments, "--reference").map(PathBuf::from),
        synthetic_detune_cents: number_argument(arguments, "--synthetic-detune-cents")?
            .unwrap_or(0.0),
        audio_transform_enabled: !arguments
            .iter()
            .any(|argument| argument == "--bypass-transform"),
        vocal_dynamics_enabled: arguments
            .iter()
            .any(|argument| argument == "--enable-vocal-dynamics"),
        adaptive_vocal_blend_enabled: arguments
            .iter()
            .any(|argument| argument == "--enable-adaptive-blend"),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&run_simulation(&config)?)?
    );
    Ok(())
}

fn string_argument(arguments: &[String], key: &str) -> Option<String> {
    arguments
        .iter()
        .position(|argument| argument == key)
        .and_then(|index| arguments.get(index + 1))
        .cloned()
}

fn number_argument<T>(
    arguments: &[String],
    key: &str,
) -> Result<Option<T>, Box<dyn std::error::Error>>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + 'static,
{
    string_argument(arguments, key)
        .map(|value| {
            value
                .parse::<T>()
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)
        })
        .transpose()
}

fn print_help() {
    println!(
        r#"KING Vocal Engine P11

  devices
      枚举本机 48kHz float32 输入/输出能力

  site-check [--output PATH]
      P12 只读现场就绪扫描；不写 Qu-16、不启动输入流或音频输出。

  simulate-multilane [--seconds 3] [--block-frames 128] [--output PATH]
      P13 固定三路 Vocal Engine 模拟；验证隔离、串音和处理预算，不启动物理音频。

  control-stdio
      P14 NDJSON 控制/遥测桥；启动时固定未武装，不会启动物理音频。

  simulate-failover [--seconds 3] [--block-frames 128] [--output PATH]
      P15 虚拟三路 ASIO 故障矩阵；验证超时、异常输出、控制断线、输入断线和恢复，不启动物理音频。

  discover-routing-virtual [--output PATH]
      P17 离线 ASIO 通道发现与逐路信号追踪；保存映射证据，不写 Qu-16、不启动音频输出。

  bench [--block-frames 128] [--blocks 10000]
      仅测试无锁传输内核，不冒充驱动/USB/物理 RTT。

  simulate [options]
      虚拟 Qu-16 USB 试验台，生成 raw/processed WAV、metrics、pitch、correction、quality、blend 和 reference JSON。
      --input-wav PATH             optional; 必须为 48kHz
      --output-dir PATH            default artifacts/simulation
      --seconds N                  default 5
      --block-frames N             default 128
      --gain-db DB                 default 0
      --correction-strength N      default 0.75; range 0..1
      --deadband-cents N           default 8
      --max-correction-cents N     default 45
      --key NOTE --scale MODE      optional; example C major / F# minor
      --reference PATH             optional reference.json from a prior preparation run
      --synthetic-detune-cents N   test-only synthetic singer detune, range ±1200
      --bypass-transform           只生成控制轨，不实际修改 processed.wav
      --enable-vocal-dynamics      启用 EQ/De-esser/Compressor/Limiter
      --enable-adaptive-blend      启用质量驱动的 dry/corrected 平滑混合
      --fault MODE                 none/underrun/disconnect/cpu-overload

  run --arm [options]
      启动低延迟直通。--arm 是防啸叫硬门；修音默认关闭。

Options:
  --input NAME
  --output NAME
  --input-channel N
  --output-channel N
  --buffer-frames N     default 128
  --ring-frames N       default 4096
  --prefill-frames N    default 256
  --gain-db DB          default -18
  --enable-pitch-correction
                        显式启用实时 Reference/Scale 修音
  --reference PATH      optional reference.json
  --key NOTE --scale MODE
                        optional fallback key/scale target
  --correction-strength N
  --deadband-cents N
  --max-correction-cents N
  --enable-vocal-dynamics
                        启用 EQ/De-esser/Compressor/Limiter
  --enable-vocal-quality
                        启用实时分项演唱评分；修音开启时自动启用
  --enable-adaptive-blend
                        启用 P10 平滑混合；必须同时启用 Pitch Correction
  --vocal-preset MODE   natural/professional/strong/auto；默认 professional
  --seconds N           default 10; 0 means until Ctrl+C
  --metrics PATH"#
    );
}
