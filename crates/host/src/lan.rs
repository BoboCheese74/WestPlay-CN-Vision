//! Optional LAN-only MJPEG mirror and remote mouse events for the existing cabin WebView2.
//! Network/JPEG/GPU readback run off the WebView2 STA. No second web application is created.

use std::cell::Cell;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;
use windows::core::Result as WinResult;

use crate::gpu::{Gpu, Lock, SharedFrame};

const PORT: u16 = 8765;
const FPS_INTERVAL: Duration = Duration::from_micros(66_667);
const READBACK_TIMEOUT: Duration = Duration::from_millis(100);
const READBACK_RETRY: Duration = Duration::from_millis(2);
const FRAME_WIDTH: u32 = 1280;
const FRAME_HEIGHT: u32 = 720;
const MAX_VIEWERS: usize = 3;
const MAX_CLIENTS: usize = 12;
const MAX_TOUCH_BATCH: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Down,
    Move,
    Up,
    Cancel,
}

#[derive(Clone, Copy, Debug)]
pub struct Touch {
    pub session: u64,
    pub phase: Phase,
    /// Normalized within the original image (not within CSS black bars).
    pub x: f32,
    pub y: f32,
}

impl Touch {
    /// Undo the frame placement and squeeze before forwarding the touch to the page.
    pub fn on_page(&self, width: u32, height: u32, page: westplay_shared::PagePlace) -> Option<(f32, f32)> {
        if self.phase == Phase::Cancel {
            return Some((0.0, 0.0));
        }
        let x = (self.x * width as f32 - page.left as f32) / page.width.max(1) as f32;
        let y = (self.y * height as f32 - page.top as f32) / page.rows.max(1) as f32;
        if self.phase == Phase::Down && !((0.0..1.0).contains(&x) && (0.0..1.0).contains(&y)) {
            return None;
        }
        Some((x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)))
    }
}

#[derive(Default)]
struct Picture {
    sequence: u64,
    jpeg: Option<Arc<Vec<u8>>>,
}

pub struct Shared {
    viewers: AtomicUsize,
    closed: AtomicBool,
    picture: Mutex<Picture>,
    picture_ready: Condvar,
}

impl Shared {
    fn close(&self) {
        // Change the condition under the same lock as the MJPEG wait.
        let _picture = self.picture.lock().unwrap_or_else(|e| e.into_inner());
        self.closed.store(true, Ordering::Release);
        self.picture_ready.notify_all();
    }

    fn publish(&self, jpeg: Vec<u8>) {
        let mut state = self.picture.lock().unwrap_or_else(|e| e.into_inner());
        state.sequence = state.sequence.wrapping_add(1);
        state.jpeg = Some(Arc::new(jpeg));
        self.picture_ready.notify_all();
    }

    fn has_viewers(&self) -> bool {
        self.viewers.load(Ordering::Acquire) != 0
    }
}

pub struct Lan {
    shared: Arc<Shared>,
    touches: Receiver<Touch>,
    session: Arc<AtomicU64>,
    token: String,
    port: u16,
    listener_thread: Option<std::thread::JoinHandle<()>>,
}

impl Lan {
    pub fn start(width: u32, height: u32) -> io::Result<Self> {
        Self::listen(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT), width, height)
    }

    fn listen(addr: SocketAddrV4, width: u32, height: u32) -> io::Result<Self> {
        let listener = TcpListener::bind(addr)?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;

        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random)
            .map_err(|e| io::Error::other(format!("LAN pairing token generation failed: {e}")))?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let shared = Arc::new(Shared {
            viewers: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            picture: Mutex::new(Picture::default()),
            picture_ready: Condvar::new(),
        });
        let (tx, touches) = mpsc::sync_channel(128);
        let session = Arc::new(AtomicU64::new(0));
        let controller = Arc::new(AtomicBool::new(false));
        let server_shared = shared.clone();
        let server_session = session.clone();
        let server_token = token.clone();
        let listener_thread = std::thread::Builder::new().name("westplay-lan-http".into()).spawn(move || {
            let mut clients = Vec::<(TcpStream, std::thread::JoinHandle<()>)>::new();
            while !server_shared.closed.load(Ordering::Acquire) {
                clients.retain(|(_, worker)| !worker.is_finished());
                match listener.accept() {
                    Ok((stream, addr)) => {
                        if clients.len() >= MAX_CLIENTS || !allowed(addr.ip()) {
                            continue;
                        }
                        let Ok(socket) = stream.try_clone() else { continue };
                        let hub = server_shared.clone();
                        let tx = tx.clone();
                        let token = server_token.clone();
                        let session = server_session.clone();
                        let controller = controller.clone();
                        if let Ok(worker) =
                            std::thread::Builder::new().name("westplay-lan-client".into()).spawn(move || {
                                let _ = serve(stream, hub, tx, token, session, controller, width, height);
                            })
                        {
                            clients.push((socket, worker));
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(Duration::from_millis(25));
                    }
                    Err(e) => {
                        crate::log!("Mobile WebUI listener stopped: {e}");
                        break;
                    }
                }
            }
            drop(listener);
            server_shared.close();
            for (socket, _) in &clients {
                let _ = socket.shutdown(Shutdown::Both);
            }
            for (_, worker) in clients {
                let _ = worker.join();
            }
        })?;
        Ok(Self { shared, touches, session, token, port, listener_thread: Some(listener_thread) })
    }

    pub fn running(&self) -> bool {
        !self.shared.closed.load(Ordering::Acquire)
            && self.listener_thread.as_ref().is_some_and(|worker| !worker.is_finished())
    }

    pub fn pairing_urls(&self) -> Vec<String> {
        lan_addresses().into_iter().map(|ip| format!("http://{ip}:{}/?token={}", self.port, self.token)).collect()
    }

    pub fn shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }

    pub fn session(&self) -> u64 {
        self.session.load(Ordering::Acquire)
    }

    /// Called on the existing WebView2 STA, never on the network thread.
    pub fn next_touch(&self) -> Option<Touch> {
        self.touches.try_recv().ok()
    }

    pub const fn max_touch_batch() -> usize {
        MAX_TOUCH_BATCH
    }
}

impl Drop for Lan {
    fn drop(&mut self) {
        self.shared.close();
        if let Some(thread) = self.listener_thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

/// List private IPv4s even if the PC is on an isolated LAN with no default route.
fn lan_addresses() -> Vec<Ipv4Addr> {
    use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetIpAddrTable, MIB_IPADDR_DISCONNECTED, MIB_IPADDRROW_XP, MIB_IPADDRTABLE,
    };

    let mut size = 0;
    // SAFETY: A null table asks Windows for the buffer size.
    if unsafe { GetIpAddrTable(None, &mut size, false) } != ERROR_INSUFFICIENT_BUFFER.0 || size < 4 {
        return Vec::new();
    }
    let mut words = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
    let table = words.as_mut_ptr().cast::<MIB_IPADDRTABLE>();
    // SAFETY: The zeroed, aligned buffer is at least size bytes; Windows writes the number and rows on success.
    if unsafe { GetIpAddrTable(Some(table), &mut size, false) } != 0 {
        return Vec::new();
    }
    let offset = std::mem::offset_of!(MIB_IPADDRTABLE, table);
    let count = (words[0] as usize).min((words.len() * size_of::<u32>() - offset) / size_of::<MIB_IPADDRROW_XP>());
    // SAFETY: The offset and stride come from the C layout, and count is bounded by the allocation.
    let rows = unsafe {
        std::slice::from_raw_parts(words.as_ptr().cast::<u8>().add(offset).cast::<MIB_IPADDRROW_XP>(), count)
    };
    let mut ips: Vec<_> = rows
        .iter()
        .filter(|row| u32::from(row.wType) & MIB_IPADDR_DISCONNECTED == 0)
        .map(|row| Ipv4Addr::from(row.dwAddr.to_ne_bytes()))
        .filter(Ipv4Addr::is_private)
        .collect();
    ips.sort_unstable();
    ips.dedup();
    ips
}

fn allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(),
        IpAddr::V6(_) => false,
    }
}

struct Viewer(Arc<Shared>);
impl Viewer {
    fn enter(shared: Arc<Shared>) -> Option<Self> {
        let increment = shared
            .viewers
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| (count < MAX_VIEWERS).then_some(count + 1));
        increment.ok().map(|_| Self(shared))
    }
}
impl Drop for Viewer {
    fn drop(&mut self) {
        self.0.viewers.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Controller(Arc<AtomicBool>, Arc<AtomicU64>);
impl Drop for Controller {
    fn drop(&mut self) {
        // Even if the event queue is full, the STA notices the new generation and releases the press.
        self.1.fetch_add(1, Ordering::AcqRel);
        self.0.store(false, Ordering::Release);
        crate::log!("LAN touch controller disconnected; releasing held buttons");
    }
}

fn serve(
    mut stream: TcpStream,
    shared: Arc<Shared>,
    touches: SyncSender<Touch>,
    token: String,
    session: Arc<AtomicU64>,
    controller: Arc<AtomicBool>,
    width: u32,
    height: u32,
) -> io::Result<()> {
    if shared.closed.load(Ordering::Acquire) {
        return Ok(());
    }
    // Winsock inherits the listener's nonblocking mode. Each client has its own thread
    // and uses timeouts so a request or frame split across TCP packets can be read in full.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_millis(800)))?;
    let request = read_request(&mut stream)?;
    let (method, target, _version) = request
        .lines()
        .next()
        .and_then(|line| {
            let mut parts = line.split_ascii_whitespace();
            Some((parts.next()?, parts.next()?, parts.next()?))
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP request"))?;
    if method != "GET" {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"GET required");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let paired = query.split('&').any(|part| part.strip_prefix("token=") == Some(token.as_str()));
    if !paired {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"Pairing token required");
    }
    match path {
        "/" => {
            let html = include_str!("lan.html")
                .replace("__SOURCE_WIDTH__", &width.to_string())
                .replace("__SOURCE_HEIGHT__", &height.to_string());
            respond(&mut stream, "200 OK", "text/html; charset=utf-8", html.as_bytes())
        }
        "/stream" => mjpeg(&mut stream, shared),
        "/ws" => {
            if controller.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
                return respond(&mut stream, "409 Conflict", "text/plain", b"Another controller is connected");
            }
            let _guard = Controller(controller, session.clone());
            let id = session.fetch_add(1, Ordering::AcqRel) + 1;
            websocket(&mut stream, &request, touches, id, shared)
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"Not found"),
    }
}

fn read_request(stream: &mut TcpStream) -> io::Result<String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::with_capacity(1024);
    while bytes.len() < 8192 {
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let mut b = [0u8; 1];
        stream.read_exact(&mut b)?;
        bytes.push(b[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            return String::from_utf8(bytes)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF8 headers"));
        }
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "oversize headers"))
}

fn respond(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8]) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

fn mjpeg(stream: &mut TcpStream, shared: Arc<Shared>) -> io::Result<()> {
    let _viewer = match Viewer::enter(shared.clone()) {
        Some(viewer) => viewer,
        None => return respond(stream, "503 Service Unavailable", "text/plain", b"Too many mirror viewers"),
    };
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=westplay\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n")?;
    let mut last = 0;
    loop {
        if shared.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut guard = shared.picture.lock().unwrap_or_else(|e| e.into_inner());
        while guard.sequence == last && !shared.closed.load(Ordering::Acquire) {
            let (state, timeout) =
                shared.picture_ready.wait_timeout(guard, Duration::from_secs(4)).unwrap_or_else(|e| e.into_inner());
            guard = state;
            if timeout.timed_out() {
                break;
            }
        }
        if shared.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if guard.sequence == last {
            continue;
        }
        last = guard.sequence;
        let frame = guard.jpeg.clone();
        drop(guard);
        if let Some(jpeg) = frame {
            write!(stream, "--westplay\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", jpeg.len())?;
            stream.write_all(&jpeg)?;
            stream.write_all(b"\r\n")?;
        }
    }
}

fn header<'a>(request: &'a str, key: &str) -> Option<&'a str> {
    request
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
}

fn websocket(
    stream: &mut TcpStream,
    request: &str,
    tx: SyncSender<Touch>,
    id: u64,
    shared: Arc<Shared>,
) -> io::Result<()> {
    let host = header(request, "Host").unwrap_or_default();
    let origin = header(request, "Origin").unwrap_or_default();
    let key = header(request, "Sec-WebSocket-Key").unwrap_or_default();
    if host.is_empty()
        || !origin.eq_ignore_ascii_case(&format!("http://{host}"))
        || header(request, "Sec-WebSocket-Version") != Some("13")
        || !header(request, "Upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        || !header(request, "Connection").is_some_and(|value| value.to_ascii_lowercase().contains("upgrade"))
        || base64::Engine::decode(&base64::engine::general_purpose::STANDARD, key)
            .ok()
            .is_none_or(|value| value.len() != 16)
    {
        return respond(stream, "403 Forbidden", "text/plain", b"Invalid WebSocket handshake");
    }
    let accept = websocket_accept(key);
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    let mut last_seen = Instant::now();
    loop {
        if shared.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut head = [0u8; 2];
        match stream.read_exact(&mut head[..1]) {
            Ok(()) => {}
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                if last_seen.elapsed() > Duration::from_secs(3) {
                    return Ok(());
                }
                continue;
            }
            Err(e) => return Err(e),
        }
        stream.read_exact(&mut head[1..])?;
        // Browser-originated WS messages are FIN + masked. No fragmentation or large frames accepted.
        if head[0] & 0xf0 != 0x80 || head[1] & 0x80 == 0 {
            return Ok(());
        }
        let opcode = head[0] & 0x0f;
        let len = (head[1] & 0x7f) as usize;
        if len > 125 {
            return Ok(());
        }
        let mut mask = [0u8; 4];
        stream.read_exact(&mut mask)?;
        let mut message = vec![0u8; len];
        stream.read_exact(&mut message)?;
        for (i, b) in message.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
        last_seen = Instant::now();
        match opcode {
            8 => return Ok(()),
            9 => {
                stream.write_all(&[0x8a, len as u8])?;
                stream.write_all(&message)?;
            }
            1 => {
                if let Some(touch) = parse_touch(&message, id) {
                    // Move events are lossy under contention. The session epoch always cancels on disconnect.
                    if touch.phase == Phase::Move {
                        let _ = tx.try_send(touch);
                    } else if tx.try_send(touch).is_err() {
                        // A saturated queue must release the gesture, and never block service shutdown.
                        return Ok(());
                    }
                }
            }
            _ => return Ok(()),
        }
    }
}

#[derive(serde::Deserialize)]
struct WireTouch {
    #[serde(rename = "type")]
    kind: String,
    x: Option<f32>,
    y: Option<f32>,
}

fn parse_touch(bytes: &[u8], session: u64) -> Option<Touch> {
    let msg: WireTouch = serde_json::from_slice(bytes).ok()?;
    let phase = match msg.kind.as_str() {
        "down" => Phase::Down,
        "move" => Phase::Move,
        "up" => Phase::Up,
        "cancel" => Phase::Cancel,
        _ => return None,
    };
    let (x, y) = if phase == Phase::Cancel { (0.0, 0.0) } else { (msg.x?, msg.y?) };
    if !(x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)) {
        return None;
    }
    Some(Touch { session, phase, x, y })
}

/// SHA-1 is used ONLY by the RFC 6455 accept handshake, never for authentication.
fn websocket_accept(key: &str) -> String {
    let mut value = key.as_bytes().to_vec();
    value.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sha1(&value))
}

fn sha1(input: &[u8]) -> [u8; 20] {
    let mut message = input.to_vec();
    let bit_len = (message.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    let mut h = [0x67452301u32, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    for chunk in message.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let mut v = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((v[1] & v[2]) | ((!v[1]) & v[3]), 0x5a827999),
                20..=39 => (v[1] ^ v[2] ^ v[3], 0x6ed9eba1),
                40..=59 => ((v[1] & v[2]) | (v[1] & v[3]) | (v[2] & v[3]), 0x8f1bbcdc),
                _ => (v[1] ^ v[2] ^ v[3], 0xca62c1d6),
            };
            let next = v[0].rotate_left(5).wrapping_add(f).wrapping_add(v[4]).wrapping_add(k).wrapping_add(*word);
            v = [next, v[0], v[1].rotate_left(30), v[2], v[3]];
        }
        for i in 0..5 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// Non-blocking GPU producer on the existing capture/STA thread. CPU readback + JPEG happen on a worker.
/// Only one staging texture is in flight, so it cannot be overwritten while the worker maps it.
pub struct Tap {
    shared: Arc<Shared>,
    free: Receiver<ID3D11Texture2D>,
    free_sender: SyncSender<ID3D11Texture2D>,
    frames: SyncSender<ID3D11Texture2D>,
    last: Cell<Instant>,
    worker: std::thread::JoinHandle<()>,
}

impl Tap {
    pub fn new(gpu: &Gpu, width: u32, height: u32, shared: Arc<Shared>) -> WinResult<Self> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: This is our GPU and a local staging description.
        unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture))? };
        let staging = texture.ok_or_else(windows::core::Error::empty)?;
        let (free_tx, free) = mpsc::sync_channel(1);
        let _ = free_tx.send(staging);
        let worker_free_tx = free_tx.clone();
        let (frames, frame_rx) = mpsc::sync_channel(1);
        let context = gpu.context.clone();
        let encode_hub = shared.clone();
        let worker = std::thread::Builder::new()
            .name("westplay-lan-jpeg".into())
            .spawn(move || {
                while let Ok(texture) = frame_rx.recv() {
                    let pixels = readback(&context, &texture, width, height, &encode_hub);
                    // Pixels are in CPU memory now. The next GPU copy can run during JPEG encoding.
                    if worker_free_tx.send(texture).is_err() {
                        break;
                    }
                    match pixels {
                        Ok(Some(bgra)) if encode_hub.has_viewers() && !encode_hub.closed.load(Ordering::Acquire) => {
                            let rgb = scale_bgra(&bgra, width, height, FRAME_WIDTH, FRAME_HEIGHT);
                            let mut jpeg = Vec::with_capacity(128 * 1024);
                            if JpegEncoder::new_with_quality(&mut jpeg, 72)
                                .encode(&rgb, FRAME_WIDTH, FRAME_HEIGHT, image::ExtendedColorType::Rgb8)
                                .is_ok()
                            {
                                encode_hub.publish(jpeg);
                            }
                        }
                        Err(e) if e.code() != DXGI_ERROR_WAS_STILL_DRAWING => {
                            crate::log!("LAN mirror staging readback failed: {e}");
                            break;
                        }
                        _ => {}
                    }
                }
            })
            .map_err(|_| windows::core::Error::empty())?;
        Ok(Self { shared, free, free_sender: free_tx, frames, last: Cell::new(Instant::now() - FPS_INTERVAL), worker })
    }

    pub fn failed(&self) -> bool {
        self.worker.is_finished()
    }

    pub fn try_capture(&self, context: &ID3D11DeviceContext, frame: &SharedFrame) -> Option<Lock> {
        if !self.shared.has_viewers()
            || self.shared.closed.load(Ordering::Acquire)
            || self.last.get().elapsed() < FPS_INTERVAL
        {
            return None;
        }
        let staging = self.free.try_recv().ok()?;
        let lock = frame.try_lock();
        if lock != Lock::Held {
            // Keep the staging texture for the next attempt. The capture owner handles an abandoned mutex.
            let _ = self.free_sender.try_send(staging);
            return Some(lock);
        }
        // SAFETY: GPU copy is queued only, staging is not mapped or reused until returned by worker.
        unsafe {
            context.CopyResource(&staging, &frame.texture);
            context.Flush(); // enqueue work only; never wait for GPU completion on the STA
        }
        frame.unlock();
        self.last.set(Instant::now());
        let _ = self.frames.try_send(staging);
        Some(Lock::Held)
    }
}

fn readback(
    context: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    width: u32,
    height: u32,
    shared: &Shared,
) -> WinResult<Option<Vec<u8>>> {
    let start = Instant::now();
    let mut retries = 0;
    // Keep this staging copy while the GPU completes it. Replacing it after only a few polls can
    // discard every frame on a busy GPU. Only the worker sleeps between nonblocking Map calls.
    while shared.has_viewers() && !shared.closed.load(Ordering::Acquire) {
        // SAFETY: The GPU context is multithread protected by `Gpu::new`; DO_NOT_WAIT prevents a GPU wait.
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            let result =
                context.Map(staging, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32, Some(&mut mapped));
            if let Err(e) = result {
                if e.code() != DXGI_ERROR_WAS_STILL_DRAWING || start.elapsed() >= READBACK_TIMEOUT {
                    return Err(e);
                }
            } else {
                let mut bgra = vec![0; width as usize * height as usize * 4];
                for y in 0..height as usize {
                    std::ptr::copy_nonoverlapping(
                        (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                        bgra.as_mut_ptr().add(y * width as usize * 4),
                        width as usize * 4,
                    );
                }
                context.Unmap(staging, 0);
                if retries >= 4 {
                    static SAID: std::sync::Once = std::sync::Once::new();
                    SAID.call_once(|| {
                        crate::log!("LAN mirror staging ready after {:?} and {retries} busy polls", start.elapsed());
                    });
                }
                return Ok(Some(bgra));
            }
        }
        retries += 1;
        std::thread::sleep(READBACK_RETRY);
    }
    Ok(None)
}

/// Letterbox if the producer is not 16:9. Alpha is composited onto black for JPEG.
fn scale_bgra(source: &[u8], sw: u32, sh: u32, tw: u32, th: u32) -> Vec<u8> {
    let mut out = vec![0u8; tw as usize * th as usize * 3];
    if sw == 0 || sh == 0 {
        return out;
    }
    let scale = (tw as f64 / sw as f64).min(th as f64 / sh as f64);
    let dw = (sw as f64 * scale).round().clamp(1.0, tw as f64) as u32;
    let dh = (sh as f64 * scale).round().clamp(1.0, th as f64) as u32;
    let ox = (tw - dw) / 2;
    let oy = (th - dh) / 2;
    for y in 0..dh {
        for x in 0..dw {
            let sx = (x as u64 * sw as u64 / dw as u64) as usize;
            let sy = (y as u64 * sh as u64 / dh as u64) as usize;
            let si = (sy * sw as usize + sx) * 4;
            let di = (((oy + y) * tw + ox + x) * 3) as usize;
            if si + 3 < source.len() {
                out[di] = source[si + 2];
                out[di + 1] = source[si + 1];
                out[di + 2] = source[si];
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_require_pairing_and_shutdown_releases_the_port() {
        use std::io::{BufRead, BufReader};

        fn request(server: &Lan, target: &str, websocket: bool) -> (BufReader<TcpStream>, String) {
            let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, server.port);
            let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(2)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            write!(stream, "GET {target} HTTP/1.1\r\nHost: {address}\r\n").unwrap();
            if websocket {
                write!(stream, "Origin: http://{address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n").unwrap();
            }
            stream.write_all(b"\r\n").unwrap();
            let mut reader = BufReader::new(stream);
            let mut status = String::new();
            reader.read_line(&mut status).unwrap();
            (reader, status)
        }

        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0);
        let server = Lan::listen(address, 1280, 720).unwrap();
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, server.port);
        assert!(Lan::listen(address, 1280, 720).is_err(), "an occupied port must fail");
        for (path, ws) in [("/", false), ("/stream?token=wrong", false), ("/ws", true)] {
            assert_eq!(request(&server, path, ws).1, "HTTP/1.1 403 Forbidden\r\n");
        }
        assert_eq!(request(&server, &format!("/?token={}", server.token), false).1, "HTTP/1.1 200 OK\r\n");
        assert_eq!(request(&server, &format!("/stream?token={}", server.token), false).1, "HTTP/1.1 200 OK\r\n");
        let (mut socket, status) = request(&server, &format!("/ws?token={}", server.token), true);
        assert_eq!(status, "HTTP/1.1 101 Switching Protocols\r\n");
        while {
            let mut header = String::new();
            socket.read_line(&mut header).unwrap() != 0 && header != "\r\n"
        } {}
        let payload = br#"{"type":"down","x":0.25,"y":0.5}"#;
        let mask = [1, 2, 3, 4];
        let mut frame = vec![0x81, 0x80 | payload.len() as u8];
        frame.extend(mask);
        frame.extend(payload.iter().enumerate().map(|(i, byte)| byte ^ mask[i % 4]));
        socket.get_mut().write_all(&frame).unwrap();
        let touch = server.touches.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!((touch.phase, touch.x, touch.y), (Phase::Down, 0.25, 0.5));

        let old_token = server.token.clone();
        drop(server);
        match socket.read(&mut [0; 1]) {
            Ok(0) => {}
            Err(e) if matches!(e.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) => {}
            result => panic!("the WebSocket should be closed: {result:?}"),
        }
        let restarted = Lan::listen(address, 1280, 720).unwrap();
        assert_ne!(restarted.token, old_token);
        assert_eq!(request(&restarted, &format!("/ws?token={old_token}"), true).1, "HTTP/1.1 403 Forbidden\r\n");
    }

    #[test]
    fn touches_follow_a_page_within_a_squeezed_frame() {
        let page = westplay_shared::PagePlace { left: 100, top: 50, width: 600, rows: 300, height: 450 };
        let mut touch = Touch { session: 1, phase: Phase::Down, x: 0.4, y: 0.4 };
        assert_eq!(touch.on_page(1000, 500, page), Some((0.5, 0.5)));
        touch.x = 0.05;
        assert_eq!(touch.on_page(1000, 500, page), None);
        touch.phase = Phase::Up;
        assert_eq!(touch.on_page(1000, 500, page), Some((0.0, 0.5)));
    }

    #[test]
    fn rfc6455_handshake() {
        assert_eq!(websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn private_addresses_and_touch_coordinates_are_validated() {
        assert!(parse_touch(br#"{"type":"down","x":0.5,"y":0.25}"#, 9).is_some());
        assert!(parse_touch(br#"{"type":"down","x":-0.1,"y":0.5}"#, 9).is_none());
        assert!(parse_touch(br#"{"type":"move","x":2,"y":0.5}"#, 9).is_none());
        assert!(allowed("192.168.1.9".parse().unwrap()));
        assert!(!allowed("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn letterbox_preserves_aspect_ratio() {
        let rgb = scale_bgra(&vec![255u8; 4 * 4 * 4], 4, 4, 8, 4);
        assert_eq!(&rgb[0..3], &[0, 0, 0]);
        assert_eq!(&rgb[3 * 2..3 * 3], &[255, 255, 255]);
    }
}
