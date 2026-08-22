// KING CLUB is a desktop control console. Keep the Windows terminal hidden in
// both development and release builds; development logs stay in the Tauri
// runner that launched the application.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    king_broadcast_control_lib::run();
}
