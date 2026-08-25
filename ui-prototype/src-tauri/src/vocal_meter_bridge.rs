use king_vocal_engine::desktop_bridge::{
    DesktopQu16MeterBridge, DesktopQu16MeterBridgeStatus, DesktopQu16MeterBridgeUpdate,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct VocalMeterBridge {
    inner: Arc<Mutex<DesktopQu16MeterBridge>>,
}

impl Default for VocalMeterBridge {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(DesktopQu16MeterBridge::default())),
        }
    }
}

impl VocalMeterBridge {
    pub fn ingest<T: Serialize>(
        &self,
        snapshot: &T,
    ) -> Result<DesktopQu16MeterBridgeUpdate, String> {
        let value = serde_json::to_value(snapshot)
            .map_err(|error| format!("Qu-16 表计快照编码失败：{error}"))?;
        self.ingest_value_at(value, unix_time_ms())
    }

    pub fn status(&self) -> DesktopQu16MeterBridgeStatus {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .status()
    }

    fn ingest_value_at(
        &self,
        value: Value,
        now_ms: u64,
    ) -> Result<DesktopQu16MeterBridgeUpdate, String> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .ingest_json(value, now_ms)
            .map_err(|error| error.to_string())
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(connected: bool, state: &str, sequence: u64, updated_at_ms: u64) -> Value {
        json!({
            "source":"qu16-tcp-midi",
            "sessionId":17,
            "connected":connected,
            "state":state,
            "updatedAtMs":updated_at_ms,
            "frameSequence":sequence,
            "channels":{"ch-1":{"levelDbfs":-12.0,"peakDbfs":-11.0}}
        })
    }

    #[test]
    fn desktop_wrapper_preserves_reconnect_generation() {
        let bridge = VocalMeterBridge::default();
        bridge
            .ingest_value_at(snapshot(true, "metering", 1, 1_000), 1_000)
            .unwrap();
        bridge
            .ingest_value_at(snapshot(false, "reconnecting", 0, 1_010), 1_010)
            .unwrap();
        bridge
            .ingest_value_at(snapshot(true, "metering", 1, 1_020), 1_020)
            .unwrap();
        let status = bridge.status();
        assert_eq!(status.connection_generation, 2);
        assert_eq!(status.accepted_snapshots, 2);
        assert!(!status.output_stream_started);
        assert!(!status.qu16_writes_performed);
    }
}
