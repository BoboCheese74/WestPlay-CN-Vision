//! NetEase Cloud Music from the host's side: what the page is told about the layer.
//!
//! The page draws the app and asks the layer itself over the loopback (`netease_layer`), so very little
//! passes through here — only what the page can't know by itself: which port the layer answered on (it
//! may not be the first one tried), and whether an account is signed in.
//!
//! Holding the account here would be the wrong shape twice over: the page must never see the cookie (it's
//! a browser context), and the layer already keeps it on disk.

use std::sync::Mutex;

/// What the host knows about the layer this run.
#[derive(Default)]
pub struct Netease {
    /// The port the layer answers on, once it has started.
    port: Mutex<Option<u16>>,
}

impl Netease {
    /// A new, unstarted layer handle.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records the port the layer came up on.
    pub fn started(&self, port: u16) {
        *self.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(port);
        crate::log!("[netease] the layer answers on {port}");
    }

    /// The port the layer answers on, or `None` while it isn't running.
    pub fn port(&self) -> Option<u16> {
        *self.port.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The message that tells the page where the layer is.
    ///
    /// `signedIn` and `nickname` come from the layer's own health route, asked here so the page has them
    /// in the same breath as the port (and so a page that starts late still learns them).
    pub fn message(&self) -> String {
        let port = self.port();
        let (signed_in, nickname) = match port {
            Some(port) => crate::netease_layer::health(port).unwrap_or((false, String::new())),
            None => (false, String::new()),
        };
        serde_json::json!({
            "type": "netease",
            "port": port,
            "signedIn": signed_in,
            "nickname": nickname,
        })
        .to_string()
    }
}

/// Asks the layer to forget its account.
///
/// The cookie lives on the layer's disk, so this is the layer's call to make; the page's own request comes
/// here to make sure it happens even if the page's own `fetch` was refused.
pub fn sign_out(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let request = b"POST /api/signout HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    let worked = answer.contains("\"ok\"");
    crate::log!("[netease] sign-out asked of the layer: {}", if worked { "done" } else { "refused" });
    worked
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh handle has no port: the layer hasn't started.
    #[test]
    fn a_new_handle_has_no_port() {
        assert_eq!(Netease::new().port(), None);
    }

    /// The port it's told is the port it reports.
    #[test]
    fn the_started_port_is_what_it_reports() {
        let netease = Netease::new();
        netease.started(8788);
        assert_eq!(netease.port(), Some(8788));
    }

    /// Without a layer the message still parses, and says so: a page that starts first must not break.
    #[test]
    fn the_message_without_a_layer_says_so() {
        let parsed: serde_json::Value = serde_json::from_str(&Netease::new().message()).unwrap();
        assert_eq!(parsed["type"], "netease");
        assert!(parsed["port"].is_null());
        assert_eq!(parsed["signedIn"].as_bool(), Some(false));
    }
}
