//! 🎮 Steamworks for the Steam build (desktop/steam-integration.js): the Steam ID and a Web API auth ticket (identity "kroom", checked by
//! server/steamlogin.mjs). init() gives None — never fails — when this is not the Steam build, there is no App ID or Steam is not running.
//! Like the Electron version, NOT tested against a real Steam client yet (docs/STEAM-LOGIN.md).
#[cfg(feature = "steam")]
mod imp {
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    pub struct Steam {
        client: steamworks::Client,
        waiting: Arc<Mutex<Vec<(steamworks::AuthTicket, mpsc::Sender<Vec<u8>>)>>>,
        _cb: steamworks::CallbackHandle,
    }

    /// the App ID from env STEAM_APP_ID or steam_appid.txt next to the exe
    fn app_id() -> u32 {
        if let Some(n) = std::env::var("STEAM_APP_ID").ok().and_then(|s| s.trim().parse::<u32>().ok()).filter(|n| *n > 0) {
            return n;
        }
        let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
        dir.and_then(|d| std::fs::read_to_string(d.join("steam_appid.txt")).ok()).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }

    pub fn init() -> Option<Steam> {
        let id = app_id();
        if id == 0 {
            eprintln!("steam: no App ID (steam_appid.txt / STEAM_APP_ID): Steamworks stays off");
            return None;
        }
        let client = match steamworks::Client::init_app(id) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("steam: init failed (Steam not running?) {e}");
                return None;
            }
        };
        let waiting: Arc<Mutex<Vec<(steamworks::AuthTicket, mpsc::Sender<Vec<u8>>)>>> = Arc::default();
        let w = waiting.clone();
        let cb = client.register_callback(move |r: steamworks::TicketForWebApiResponse| {
            let mut l = w.lock().unwrap();
            if let Some(i) = l.iter().position(|(t, _)| *t == r.ticket_handle) {
                let (_, tx) = l.remove(i);
                let _ = tx.send(if r.result.is_ok() { r.ticket } else { Vec::new() });
            }
        });
        let pump = client.clone();
        std::thread::spawn(move || loop {
            pump.run_callbacks();
            std::thread::sleep(Duration::from_millis(100));
        });
        Some(Steam { client, waiting, _cb: cb })
    }

    impl Steam {
        /// the 64-bit Steam ID as a 17-digit string (the server never trusts it on its own)
        pub fn steam_id(&self) -> String {
            self.client.user().steam_id().raw().to_string()
        }
        /// a Web API ticket as hex, or ''
        pub fn ticket(&self) -> String {
            let (tx, rx) = mpsc::channel();
            {
                let mut l = self.waiting.lock().unwrap();
                let t = self.client.user().authentication_session_ticket_for_webapi("kroom");
                l.push((t, tx));
            }
            rx.recv_timeout(Duration::from_secs(10)).map(|b| b.iter().map(|x| format!("{x:02x}")).collect()).unwrap_or_default()
        }
    }
}

#[cfg(not(feature = "steam"))]
mod imp {
    pub struct Steam;
    pub fn init() -> Option<Steam> {
        None
    }
    impl Steam {
        pub fn steam_id(&self) -> String {
            String::new()
        }
        pub fn ticket(&self) -> String {
            String::new()
        }
    }
}

pub use imp::*;
