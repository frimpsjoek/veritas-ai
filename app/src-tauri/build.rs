/// The app's own commands, each with an `allow-<command>` permission that capabilities/ grant: the start page gets
/// `boot` and `pick_folder`, the web app the Browse commands, and pages in Browse tabs only the Save hand-over.
const COMMANDS: &[&str] = &[
    "boot",
    "pick_folder",
    "browse_available",
    "browse_open",
    "browse_show",
    "browse_hide",
    "browse_back",
    "browse_forward",
    "browse_reload",
    "browse_close",
    "browse_sign_out",
    "browse_save_pdf",
    "browse_pdf_info",
    "browse_pdf_bytes",
    "app_auto_update",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}
