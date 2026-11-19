//! Samples navigation inside the game, away from the SDK and rendering threads.

use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use westplay_shared::game_route::{Memory, RouteReader, Update, locate_in_image};
use westplay_shared::route_feed::RoutePublisher;
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentProcess;

use crate::{bridge, log};

const READ_EVERY: Duration = Duration::from_millis(500);

struct Worker {
    lifetime: Sender<()>,
    thread: JoinHandle<()>,
}

static WORKER: Mutex<Option<Worker>> = Mutex::new(None);

/// Starts one sampler for this telemetry session, logging startup errors in the plugin log.
pub(crate) fn start() {
    let mut worker = WORKER.lock().unwrap_or_else(|error| error.into_inner());
    if worker.is_some() {
        return;
    }
    let (lifetime, stopping) = mpsc::channel();
    match std::thread::Builder::new().name("westplay-game-route".into()).spawn(move || {
        if let Err(error) = run(stopping) {
            log!("route: game publisher stopped: {error}");
        }
    }) {
        Ok(thread) => *worker = Some(Worker { lifetime, thread }),
        Err(error) => log!("route: couldn't start the game publisher: {error}"),
    }
}

/// Stops the sampler and releases its mapping before the DLL can be unloaded.
pub(crate) fn stop() {
    let worker = WORKER.lock().unwrap_or_else(|error| error.into_inner()).take();
    if let Some(Worker { lifetime, thread }) = worker {
        drop(lifetime);
        if let Err(error) = thread.join() {
            log!("route: game publisher panicked: {error:?}");
        }
    }
}

fn run(stopping: Receiver<()>) -> Result<(), Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    let layout = locate_in_image(&std::fs::read(&exe)?)
        .ok_or_else(|| format!("navigator signatures not found in {}", exe.display()))?;
    // SAFETY: a null name returns this process's executable module, valid while the game runs.
    let base = unsafe { GetModuleHandleW(None)? }.0 as usize;
    let global = base.checked_add(layout.global_rva).ok_or("navigator address overflow")?;
    let mut publisher = RoutePublisher::create()?;
    let mut reader = RouteReader::default();
    log!("route: game publisher ready for PID {}", std::process::id());
    loop {
        let coach = bridge::get().and_then(|bridge| bridge.plugin.coach_job.read()).unwrap_or(reader.last_coach());
        let updates = reader.poll(&ThisGame, global, &layout, coach);
        if let Some(Update::Route { waypoints, coach_stops, .. }) = updates.first()
            && coach.is_active()
            && coach.current_stage + 1 < coach.stage_count
            && waypoints.is_empty()
            && coach_stops.is_empty()
        {
            log!("route: no verified coach stop boundaries for stage {} of {}", coach.current_stage, coach.stage_count);
        }
        publisher.publish(&updates)?;
        if stopping.recv_timeout(READ_EVERY) != Err(RecvTimeoutError::Timeout) {
            break;
        }
    }
    Ok(())
}

struct ThisGame;

impl Memory for ThisGame {
    fn read(&self, address: usize, buffer: &mut [u8]) -> bool {
        let mut read = 0;
        // SAFETY: Windows checks the attempted read from our own process. A changing or unreadable
        // game address is an ordinary failed read, never dereferenced as a Rust reference.
        let result = unsafe {
            ReadProcessMemory(
                GetCurrentProcess(),
                address as *const _,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                Some(&mut read),
            )
        };
        result.is_ok() && read == buffer.len()
    }
}
