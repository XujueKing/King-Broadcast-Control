use king_vocal_engine::{
    benchmark_transfer, enumerate_devices, run_for_duration,
    simulation::{run_simulation, SimulationConfig, SimulationFault},
    LoopbackConfig,
};
use std::{
    env, fs,
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
        _ => {
            print_help();
            Ok(())
        }
    }
}

fn run_loopback(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if !arguments.iter().any(|argument| argument == "--arm") {
        return Err("安全拒绝：run 必须显式提供 --arm；开始前请关闭扬声器或使用耳机/调音台安全返回，避免麦克风啸叫".into());
    }
    let config = LoopbackConfig {
        input_device: string_argument(arguments, "--input"),
        output_device: string_argument(arguments, "--output"),
        input_channel: number_argument(arguments, "--input-channel")?.unwrap_or(0),
        output_channel: number_argument(arguments, "--output-channel")?.unwrap_or(0),
        buffer_frames: number_argument(arguments, "--buffer-frames")?.unwrap_or(128),
        ring_capacity_frames: number_argument(arguments, "--ring-frames")?.unwrap_or(4096),
        prefill_frames: number_argument(arguments, "--prefill-frames")?.unwrap_or(256),
        gain_db: number_argument(arguments, "--gain-db")?.unwrap_or(-18.0),
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
        "KING Vocal Engine P0\n\n  devices\n      枚举本机 48kHz float32 输入/输出能力\n\n  bench [--block-frames 128] [--blocks 10000]\n      仅测试无锁传输内核，不冒充驱动/USB/物理 RTT。\n\n  simulate [options]\n      虚拟 Qu-16 USB 试验台，生成 raw/processed WAV、metrics、pitch 和 correction JSON。\n      --input-wav PATH             optional; 必须为 48kHz\n      --output-dir PATH            default artifacts/simulation\n      --seconds N                  default 5\n      --block-frames N             default 128\n      --gain-db DB                 default 0\n      --correction-strength N      default 0.75; range 0..1\n      --deadband-cents N           default 8\n      --max-correction-cents N     default 45\n      --fault MODE                 none/underrun/disconnect/cpu-overload\n\n  run --arm [options]\n      启动低延迟直通。--arm 是防啸叫硬门。\n\nOptions:\n  --input NAME\n  --output NAME\n  --input-channel N\n  --output-channel N\n  --buffer-frames N     default 128\n  --ring-frames N       default 4096\n  --prefill-frames N    default 256\n  --gain-db DB          default -18\n  --seconds N           default 10; 0 means until Ctrl+C\n  --metrics PATH"
    );
}
