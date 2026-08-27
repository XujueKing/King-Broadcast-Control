use crate::SAMPLE_RATE;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[derive(Default)]
struct SharedPlaybackClock {
    frame: AtomicU64,
    playing: AtomicBool,
    enabled: AtomicBool,
    revision: AtomicU64,
}

#[derive(Clone)]
pub struct PlaybackClockControl {
    shared: Arc<SharedPlaybackClock>,
}

pub(crate) struct PlaybackClockReceiver {
    shared: Arc<SharedPlaybackClock>,
    local_frame: u64,
    seen_revision: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackClockStatus {
    pub enabled: bool,
    pub playing: bool,
    pub frame: u64,
    pub seconds: f64,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PlaybackFrame {
    pub position: u64,
    pub playing: bool,
}

impl PlaybackClockControl {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(SharedPlaybackClock::default()),
        }
    }

    pub(crate) fn receiver(&self) -> PlaybackClockReceiver {
        PlaybackClockReceiver {
            shared: Arc::clone(&self.shared),
            local_frame: 0,
            seen_revision: u64::MAX,
        }
    }

    /// Publish the authoritative Deck position. The revision is stored last so the
    /// realtime receiver never observes a new revision with an older position.
    pub fn sync(&self, seconds: f64, playing: bool) -> PlaybackClockStatus {
        let seconds = if seconds.is_finite() {
            seconds.max(0.0)
        } else {
            0.0
        };
        let frame = (seconds * SAMPLE_RATE as f64).round() as u64;
        self.shared.frame.store(frame, Ordering::Relaxed);
        self.shared.playing.store(playing, Ordering::Relaxed);
        self.shared.enabled.store(true, Ordering::Relaxed);
        self.shared.revision.fetch_add(1, Ordering::Release);
        self.status()
    }

    pub fn disable(&self) -> PlaybackClockStatus {
        self.shared.enabled.store(false, Ordering::Relaxed);
        self.shared.revision.fetch_add(1, Ordering::Release);
        self.status()
    }

    pub fn status(&self) -> PlaybackClockStatus {
        let frame = self.shared.frame.load(Ordering::Relaxed);
        PlaybackClockStatus {
            enabled: self.shared.enabled.load(Ordering::Relaxed),
            playing: self.shared.playing.load(Ordering::Relaxed),
            frame,
            seconds: frame as f64 / SAMPLE_RATE as f64,
            revision: self.shared.revision.load(Ordering::Acquire),
        }
    }
}

impl Default for PlaybackClockControl {
    fn default() -> Self {
        Self::new()
    }
}

impl PlaybackClockReceiver {
    pub(crate) fn next(&mut self, fallback_position: u64) -> PlaybackFrame {
        if !self.shared.enabled.load(Ordering::Relaxed) {
            return PlaybackFrame {
                position: fallback_position,
                playing: true,
            };
        }
        let revision = self.shared.revision.load(Ordering::Acquire);
        if revision != self.seen_revision {
            self.local_frame = self.shared.frame.load(Ordering::Relaxed);
            self.seen_revision = revision;
        }
        let playing = self.shared.playing.load(Ordering::Relaxed);
        let position = self.local_frame;
        if playing {
            self.local_frame = self.local_frame.saturating_add(1);
        }
        PlaybackFrame { position, playing }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsynchronised_receiver_uses_engine_fallback_clock() {
        let control = PlaybackClockControl::new();
        let mut receiver = control.receiver();
        assert_eq!(
            receiver.next(123),
            PlaybackFrame {
                position: 123,
                playing: true
            }
        );
    }

    #[test]
    fn seek_pause_and_resume_follow_authoritative_deck_position() {
        let control = PlaybackClockControl::new();
        let mut receiver = control.receiver();
        control.sync(2.0, true);
        assert_eq!(receiver.next(0).position, 96_000);
        assert_eq!(receiver.next(1).position, 96_001);

        control.sync(8.5, false);
        let paused = receiver.next(2);
        assert_eq!(paused.position, 408_000);
        assert!(!paused.playing);
        assert_eq!(receiver.next(3).position, 408_000);

        control.sync(8.5, true);
        assert_eq!(receiver.next(4).position, 408_000);
        assert_eq!(receiver.next(5).position, 408_001);
    }
}
