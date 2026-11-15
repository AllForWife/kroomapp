fn main() {
    // the app's own commands are listed, so a capability must name each one (capabilities/default.json): only the K ROOM sites get them
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "login_with_browser", "get_display", "set_beta", "set_unlock_fps", "relaunch", "get_sites", "set_site", "set_awake", "set_presence",
        "steam_ticket", "steam_id", "keep_room", "open_external", "js_result", "get_engine", "set_engine",
    ])))
    .expect("tauri build script");
}
