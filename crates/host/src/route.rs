//! Route geometry from the game plugin, with a direct reader for older plugins. The game's junction
//! paths and maneuvers are resolved independently from the played profile's map files.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use crate::maps::PlayedMap;

use westplay_mapdata::junctions::{self, CoachAnchor, Junctions, Maneuver};
use westplay_setup::map;
pub use westplay_shared::game_route::RouteNode;
use westplay_shared::game_route::{Layout, RouteReader, Update, locate_in_image};
pub(crate) use westplay_shared::game_route::{Memory, Section, section};
use westplay_shared::route_feed::RouteSubscriber;
use westplay_shared::{BridgeMapping, PluginBlock};
use windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, TH32CS_SNAPMODULE,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    QueryFullProcessImageNameW,
};
use windows::core::{HRESULT, PWSTR};

/// How often the route is read.
const READ_EVERY: Duration = Duration::from_millis(500);
/// Give a newly connected DLL time to publish before trying the older direct reader.
const WAIT_FOR_FEED: Duration = Duration::from_secs(2);

/// What's sent as the route changes: a new route (its map nodes in order, from the start), the ways
/// through its junctions (for each, the index of the node it starts at and its points, x z) and the turns
/// there (by the same index), the truck's progress along it (the index of the next map node ahead), or no
/// route. A route's `id` is the host's number for it (counting up, never the same for two routes), which its
/// junctions' ways carry too.
#[derive(Clone, Debug, PartialEq)]
pub enum RouteUpdate {
    Route {
        id: u32,
        nodes: Vec<RouteNode>,
        /// The game's waypoints (their map nodes' uids, in the order they were put in), the player's stops
        /// and any WestPlay put in to hold a route it handed over; none if they couldn't be read.
        waypoints: Vec<u64>,
        /// Map node indices of the remaining intermediate coach stops, in route order.
        coach_stops: Vec<usize>,
    },
    /// The ways through the route's junctions and its turns there (by the node index each starts at), and
    /// how far to the right of its way the route runs at its nodes on roads (on the carriageway it drives
    /// on: westplay_mapdata::junctions::Ways).
    Paths {
        id: u32,
        paths: Vec<(usize, Vec<[f32; 2]>)>,
        maneuvers: Vec<(usize, Maneuver)>,
        shifts: Vec<(usize, f32)>,
        coach_anchors: Vec<CoachAnchor>,
    },
    /// The ways of route `index` offered for the page's request `id` (planner.rs), each as it's read: a route across the
    /// map takes seconds.
    Offered {
        id: u32,
        index: usize,
        route: OfferedWays,
    },
    Next(usize),
    None,
}

/// A route offered before Go, to draw as the game's route is: where its map nodes are, and its ways.
#[derive(Clone, Debug, PartialEq)]
pub struct OfferedWays {
    pub nodes: Vec<[f32; 2]>,
    pub ways: junctions::Ways,
}

/// What's to be read from the game's files.
enum Job {
    /// A live route and its marked coach arrivals, read against the game installed in the folder.
    Route(u32, Vec<RouteNode>, Vec<usize>, Option<PathBuf>),
    /// The routes offered for a request, each as its map nodes.
    Offered(u32, Vec<Vec<junctions::RouteNode>>),
}

pub struct RouteWatch {
    pub updates: Receiver<RouteUpdate>,
    jobs: Sender<Job>,
    /// Its thread ends with it (`worker`), and the junctions' then (the jobs' senders gone).
    _ending: crate::worker::Ending,
}

impl RouteWatch {
    /// Follows the route of the game the plugin is in (`bridge`), its junctions read with the map mods of the
    /// profile `played`.
    pub fn start(bridge: Arc<BridgeMapping>, played: PlayedMap) -> Self {
        let (sender, updates) = mpsc::channel();
        let (jobs, pending) = mpsc::channel();
        let offered_jobs = jobs.clone();
        let paths_sender = sender.clone();
        let (ending, ended) = crate::worker::ending();
        let _ = std::thread::Builder::new()
            .name("westplay-junctions".into())
            .spawn(move || resolve_junctions(pending, paths_sender, played));
        if let Err(error) = std::thread::Builder::new()
            .name("westplay-route".into())
            .spawn(move || follow_route(&bridge.bridge().plugin, &sender, &jobs, ended))
        {
            log!("route: couldn't start the route watcher: {error}");
        }
        Self { updates, jobs: offered_jobs, _ending: ending }
    }

    /// Has the ways of the routes offered for request `id` read (each one's map nodes, and where they are): they come as
    /// [`RouteUpdate::Offered`].
    pub fn offer(&self, id: u32, routes: &[Vec<u64>], positions: &[Vec<[f32; 2]>]) {
        let route = |(uids, positions): (&Vec<u64>, &Vec<[f32; 2]>)| {
            uids.iter().zip(positions).map(|(&uid, &position)| junctions::RouteNode { uid, position }).collect()
        };
        let _ = self.jobs.send(Job::Offered(id, routes.iter().zip(positions).map(route).collect()));
    }
}

fn follow_route(plugin: &PluginBlock, sender: &Sender<RouteUpdate>, jobs: &Sender<Job>, ended: crate::worker::Ended) {
    let mut source: Option<RouteSource> = None;
    let mut displayed = DisplayedRoute::default();
    while !ended.now() {
        let pid = plugin.pid.load(Ordering::Acquire);
        let running = (pid != 0 && crate::is_running(pid)).then_some(pid);
        if source.as_ref().map(|source| source.pid) != running {
            if !displayed.send(Update::None, None, sender, jobs) {
                return;
            }
            source = running.map(RouteSource::new);
        }
        if let Some(source) = &mut source {
            for update in source.poll(plugin) {
                if !displayed.send(update, source.install.as_deref(), sender, jobs) {
                    return;
                }
            }
            displayed.log_distances(plugin);
        }
        std::thread::sleep(READ_EVERY);
    }
}

struct RouteSource {
    pid: u32,
    install: Option<PathBuf>,
    feed: Option<RouteSubscriber>,
    reported_error: bool,
    legacy: Option<Game>,
    retry_legacy_at: Instant,
}

impl RouteSource {
    fn new(pid: u32) -> Self {
        let install = match game_executable(pid) {
            Ok(executable) => install_of(&executable),
            Err(error) => {
                log!("route: couldn't identify the game install for PID {pid}: {error}");
                None
            }
        };
        Self {
            pid,
            install,
            feed: None,
            reported_error: false,
            legacy: None,
            retry_legacy_at: Instant::now() + WAIT_FOR_FEED,
        }
    }

    /// Keeps the DLL feed authoritative once available. Before it exists, older plugins can still
    /// use the direct reader when Windows grants the desktop app access to the game's memory.
    fn poll(&mut self, plugin: &PluginBlock) -> Vec<Update> {
        if self.feed.is_none() {
            match RouteSubscriber::open(self.pid) {
                Ok(feed) => {
                    log!("route: using game DLL snapshots for PID {}", self.pid);
                    self.feed = Some(feed);
                    self.legacy = None;
                    self.reported_error = false;
                }
                Err(error) if error.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) => {}
                Err(error) => self.report_feed_error(error),
            }
        }
        if let Some(feed) = &mut self.feed {
            return match feed.poll() {
                Ok(updates) => {
                    self.reported_error = false;
                    updates
                }
                Err(error) => {
                    self.report_feed_error(error);
                    vec![Update::None]
                }
            };
        }
        if self.legacy.is_none() && Instant::now() >= self.retry_legacy_at {
            self.legacy = Game::open(self.pid);
            self.retry_legacy_at = Instant::now() + RETRY_AFTER;
            if self.install.is_none() {
                self.install = self.legacy.as_ref().and_then(|game| install_of(&game.process.exe));
            }
        }
        self.legacy.as_mut().map_or_else(Vec::new, |game| game.poll(plugin))
    }

    fn report_feed_error(&mut self, error: impl std::fmt::Display) {
        if !self.reported_error {
            log!("route: game DLL snapshot for PID {} couldn't be read: {error}", self.pid);
            self.reported_error = true;
        }
    }
}

#[derive(Default)]
struct DisplayedRoute {
    /// Keeps junction jobs distinct even when the game or route source changes.
    number: u32,
    distances: Vec<f32>,
    next: usize,
    distances_said: Option<Instant>,
}

impl DisplayedRoute {
    fn send(
        &mut self,
        update: Update,
        install: Option<&Path>,
        sender: &Sender<RouteUpdate>,
        jobs: &Sender<Job>,
    ) -> bool {
        match update {
            Update::Route { nodes, waypoints, coach_stops, coach_destination, .. } => {
                log!("{}", said_route(&nodes, &waypoints));
                if let Some(end) = coach_stops.first() {
                    log!(
                        "route: next coach stop at node {end} of {} (all intermediate nodes {coach_stops:?})",
                        nodes.len()
                    );
                }
                self.number = self.number.wrapping_add(1);
                self.distances = nodes.iter().map(|node| node.distance_left).collect();
                self.next = 0;
                self.distances_said = None;
                let id = self.number;
                let mut stops = coach_stops.clone();
                if coach_destination && let Some(terminal) = nodes.len().checked_sub(1) {
                    stops.push(terminal);
                }
                let job = Job::Route(id, nodes.clone(), stops, install.map(Path::to_owned));
                // Send the route before its junctions can be resolved.
                if sender.send(RouteUpdate::Route { id, nodes, waypoints, coach_stops }).is_err() {
                    return false;
                }
                let _ = jobs.send(job);
                true
            }
            Update::Next(index) if !self.distances.is_empty() => {
                self.next = index;
                sender.send(RouteUpdate::Next(index)).is_ok()
            }
            Update::None if !self.distances.is_empty() => {
                self.distances.clear();
                sender.send(RouteUpdate::None).is_ok()
            }
            _ => true,
        }
    }

    fn log_distances(&mut self, plugin: &PluginBlock) {
        if self.distances_said.is_none_or(|at| at.elapsed() >= SAY_DISTANCES_EVERY)
            && let Some(line) = said_distances(&self.distances, self.next, plugin.telemetry.read())
        {
            log!("{line}");
            self.distances_said = Some(Instant::now());
        }
    }
}

/// The line saying a route the game planned was read: its nodes and waypoints, where the waypoints are along it, and
/// where its nodes' own distances left rise instead of falling (a turn's distance is the game's distance left less its
/// node's, so it takes them falling all the way: a player's every turn "now" on jobs to and from Iceland, across the
/// ferry, 2026-11-12, each of those routes with waypoints the player hadn't set).
fn said_route(nodes: &[RouteNode], waypoints: &[u64]) -> String {
    let at: Vec<String> = waypoints
        .iter()
        .map(|uid| {
            nodes.iter().position(|node| node.uid == *uid).map_or("not on it".to_owned(), |at| format!("node {at}"))
        })
        .collect();
    let rises: Vec<usize> =
        (1..nodes.len()).filter(|&at| nodes[at].distance_left > nodes[at - 1].distance_left + 1.0).collect();
    let mut line = format!("route: the game's route read, {} nodes, {} waypoints", nodes.len(), waypoints.len());
    if !at.is_empty() {
        line += &format!(" (at {})", at.join(", "));
    }
    if let Some(&first) = rises.first() {
        line += &format!(
            "; its own distances left rise {} times, first from node {} to {}: {:.0} m to {:.0} m",
            rises.len(),
            first - 1,
            first,
            nodes[first - 1].distance_left,
            nodes[first].distance_left
        );
    }
    line
}

/// How often the distances turns are worked out from are written to the log, while there's a route.
const SAY_DISTANCES_EVERY: Duration = Duration::from_secs(30);

/// The line saying the SDK's distance left to the destination and the route's own at the node ahead, its first and
/// its last (the game's scale, metres); `None` without a route or telemetry.
fn said_distances(distances: &[f32], next: usize, telemetry: Option<westplay_shared::Telemetry>) -> Option<String> {
    let telemetry = telemetry?;
    let (first, last) = (distances.first()?, distances.last()?);
    let next = next.min(distances.len() - 1);
    Some(format!(
        "route: distance left {:.0} m (the game's telemetry); the route's own at the node ahead {:.0} m (node {} of {}), \
         at its first {:.0} m, its last {:.0} m; scale {:.1}",
        telemetry.navigation_distance,
        distances[next],
        next,
        distances.len(),
        first,
        last,
        telemetry.local_scale,
    ))
}

/// How long before a game process that couldn't be read is tried again.
const RETRY_AFTER: Duration = Duration::from_secs(30);

/// Resolves the ways through each route's junctions as routes come (only the latest of each kind, when several wait,
/// the game's route first), opening the game's files once (again when the profile played has other map mods). Anything
/// new leaves the routes offered still to read.
fn resolve_junctions(pending: Receiver<Job>, sender: Sender<RouteUpdate>, played: PlayedMap) {
    let mut opened: Option<(JunctionFiles, Junctions)> = None;
    // The running game's install, once a route of its has said; until then the profile played's.
    let mut install: Option<PathBuf> = None;
    let mut newer: Vec<Job> = Vec::new();
    loop {
        let first = if newer.is_empty() { pending.recv().ok() } else { Some(newer.remove(0)) };
        let Some(first) = first else { return };
        let (mut route, mut offered) = (None, None);
        for job in std::iter::once(first).chain(newer.drain(..)).chain(pending.try_iter()) {
            if matches!(job, Job::Route(..)) { route = Some(job) } else { offered = Some(job) }
        }
        for job in route.into_iter().chain(offered) {
            if let Job::Route(_, _, _, folder) = &job {
                install.clone_from(folder);
            }
            let files = {
                let played = played.lock().unwrap_or_else(|e| e.into_inner());
                let folder = install.clone().or_else(|| played.as_ref().map(|(game, _)| game.dir.clone()));
                folder.map(|folder| JunctionFiles::of(&folder, played.as_ref()))
            };
            let Some(files) = files else { continue };
            if opened.as_ref().map(|(known, _)| known) != Some(&files) {
                opened = files.open().map(|junctions| (files, junctions));
            }
            let Some((_, junctions)) = &opened else { continue };
            match job {
                Job::Route(id, nodes, stops, _) => {
                    let route: Vec<junctions::RouteNode> = nodes
                        .iter()
                        .map(|node| junctions::RouteNode { uid: node.uid, position: node.position })
                        .collect();
                    match junctions.junctions_with_coach_stops(&route, &stops) {
                        Ok(found) => {
                            for stop in stops {
                                if !found.coach_anchors.iter().any(|anchor| anchor.node == stop) {
                                    log!(
                                        "route {id}: coach stop node {stop} has no unique parking location on its adjacent ways"
                                    );
                                }
                            }
                            let maneuvers = found
                                .junctions
                                .iter()
                                .filter_map(|junction| Some((junction.span, junction.maneuver?)))
                                .collect();
                            let paths =
                                found.junctions.into_iter().map(|junction| (junction.span, junction.path)).collect();
                            let update = RouteUpdate::Paths {
                                id,
                                paths,
                                maneuvers,
                                shifts: found.shifts,
                                coach_anchors: found.coach_anchors,
                            };
                            if sender.send(update).is_err() {
                                return;
                            }
                        }
                        Err(error) => log!("route: the route's junctions couldn't be read: {error}"),
                    }
                }
                Job::Offered(id, routes) => {
                    for (index, route) in routes.iter().enumerate() {
                        newer.extend(pending.try_iter());
                        if !newer.is_empty() {
                            break;
                        }
                        match junctions.junctions(route) {
                            Ok(ways) => {
                                let route =
                                    OfferedWays { nodes: route.iter().map(|node| node.position).collect(), ways };
                                if sender.send(RouteUpdate::Offered { id, index, route }).is_err() {
                                    return;
                                }
                            }
                            Err(error) => log!("routes: a route's ways couldn't be read: {error}"),
                        }
                    }
                }
            }
        }
    }
}

/// What a route's junctions are read from: the running game's install, the map its profile plays and the
/// map mods over it, in their load order (only these tell two apart: the profile's saves don't count).
#[derive(Clone, Debug)]
struct JunctionFiles {
    install: PathBuf,
    /// The running game's base map (`europe`, `usa`): what the game's own junctions are read for.
    base: &'static str,
    map: String,
    mods: Vec<PathBuf>,
    /// The profile played, to mount its map mods (`None`: not worked out yet, the base game's map).
    played: Option<(westplay_setup::game::Game, westplay_setup::profiles::Profile)>,
}

impl PartialEq for JunctionFiles {
    fn eq(&self, other: &Self) -> bool {
        (&self.install, &self.map, &self.mods) == (&other.install, &other.map, &other.mods)
    }
}

impl JunctionFiles {
    fn of(install: &Path, played: Option<&(westplay_setup::game::Game, westplay_setup::profiles::Profile)>) -> Self {
        use westplay_setup::game::{FoundBy, Game, Kind};
        // The running game (its install says which); the profile played only if it's that game's: one of the
        // other game's (the one played last, while this one isn't set up) says nothing of this one's map.
        let running = Game::at(install, FoundBy::Chosen).map(|game| game.kind);
        let played = played.filter(|(game, _)| running.is_none_or(|kind| kind == game.kind));
        let base = running.or(played.map(|(game, _)| game.kind)).unwrap_or(Kind::Ets2).base_map();
        // The running game's own install, whichever WestPlay is set up in.
        let played = played.map(|(game, profile)| (Game { dir: install.to_owned(), ..game.clone() }, profile.clone()));
        let (map, mods) = match &played {
            Some((_, profile)) => (profile.map.clone(), profile.map_mods().filter_map(|m| m.files.clone()).collect()),
            None => (base.to_owned(), Vec::new()),
        };
        Self { install: install.to_owned(), base, map, mods, played }
    }

    /// The junctions as these files have them. A map mod that can't be read (HVT's, say) leaves the base
    /// game's, so its roads still get their ways.
    fn open(&self) -> Option<Junctions> {
        if let Some((game, profile)) = &self.played
            && !self.mods.is_empty()
        {
            match map::mount(game, profile)
                .map_err(|error| error.to_string())
                .and_then(|files| Junctions::new(files, &self.map).map_err(|error| error.to_string()))
            {
                Ok(junctions) => return Some(junctions),
                Err(error) => log!(
                    "route: the map mods of {:?} couldn't be read, so only the game's own junctions are: {error}",
                    profile.name
                ),
            }
        }
        match Junctions::open(&self.install, self.base) {
            Ok(junctions) => Some(junctions),
            Err(error) => {
                log!("route: the game's files in {} couldn't be read: {error}", self.install.display());
                None
            }
        }
    }
}

/// The running game's process, opened to read its memory: where its executable is loaded, and its file.
pub(crate) struct Process {
    pub pid: u32,
    handle: HANDLE,
    pub base: usize,
    pub exe: PathBuf,
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: the process handle is this reader's own, closed once, as it goes.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

impl Process {
    /// `who` names the reader in what's logged.
    pub fn open(pid: u32, who: &str) -> Option<Self> {
        // Windows refuses this for a game running as administrator when WestPlay isn't.
        let (base, exe) = match main_module(pid) {
            Ok(module) => module,
            Err(error) => {
                log!("{who}: the game's process can't be looked into: {error}");
                return None;
            }
        };
        // SAFETY: a plain call: read access to the game's process, by its id.
        match unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) } {
            Ok(handle) => Some(Self { pid, handle, base, exe }),
            Err(error) => {
                log!("{who}: the game's memory can't be read: {error}");
                None
            }
        }
    }
}

impl Memory for Process {
    fn read(&self, address: usize, buffer: &mut [u8]) -> bool {
        let mut read = 0;
        // SAFETY: the handle is open with read access; the buffer is ours and the call writes at most its length.
        let ok = unsafe {
            ReadProcessMemory(
                self.handle,
                address as *const _,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                Some(&mut read),
            )
        };
        ok.is_ok() && read == buffer.len()
    }
}

/// Reads navigation directly for older plugins without a route feed.
struct Game {
    process: Process,
    layout: Layout,
    reader: RouteReader,
}

impl Game {
    fn open(pid: u32) -> Option<Self> {
        let process = Process::open(pid, "route")?;
        let Some(layout) = std::fs::read(&process.exe).ok().and_then(|image| locate_in_image(&image)) else {
            log!("route: the game's navigator wasn't found in {} (a new game version?)", process.exe.display());
            return None;
        };
        Some(Self { process, layout, reader: RouteReader::default() })
    }

    fn poll(&mut self, plugin: &PluginBlock) -> Vec<Update> {
        let coach = plugin.coach_job.read().unwrap_or(self.reader.last_coach());
        self.reader.poll(&self.process, self.process.base + self.layout.global_rva, &self.layout, coach)
    }
}

/// The executable's path, available with limited process-query rights even for an elevated game.
fn game_executable(pid: u32) -> windows::core::Result<PathBuf> {
    // SAFETY: the handle is closed after the query, which is given the writable buffer's size.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
        let mut path = vec![0u16; 32_768];
        let mut length = path.len() as u32;
        let found = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut length);
        let _ = CloseHandle(process);
        found?;
        use std::os::windows::ffi::OsStringExt;
        Ok(std::ffi::OsString::from_wide(&path[..length as usize]).into())
    }
}

fn install_of(executable: &Path) -> Option<PathBuf> {
    // The executable is in `bin/win_x64` of the install.
    executable.ancestors().nth(3).filter(|dir| dir.join("base.scs").is_file()).map(Path::to_owned)
}

/// The game's executable: where it's loaded and its file.
fn main_module(pid: u32) -> windows::core::Result<(usize, PathBuf)> {
    // SAFETY: the snapshot is closed once after use; `entry` is a local with its size set, as the call requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid)?;
        let mut entry = MODULEENTRY32W { dwSize: size_of::<MODULEENTRY32W>() as u32, ..Default::default() };
        let found = Module32FirstW(snapshot, &mut entry);
        let _ = CloseHandle(snapshot);
        found?;
        let length = entry.szExePath.iter().position(|&c| c == 0).unwrap_or(entry.szExePath.len());
        Ok((entry.modBaseAddr as usize, PathBuf::from(String::from_utf16_lossy(&entry.szExePath[..length]))))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn says_the_distances_a_turns_is_worked_out_from() {
        assert_eq!(said_distances(&[], 0, Some(westplay_shared::Telemetry::default())), None, "no route");
        let distances = [9000.0, 5000.0, 0.0];
        let telemetry =
            westplay_shared::Telemetry { navigation_distance: 6200.0, local_scale: 19.0, ..Default::default() };
        assert_eq!(
            said_distances(&distances, 1, Some(telemetry)).unwrap(),
            concat!(
                "route: distance left 6200 m (the game's telemetry); the route's own at the node ahead 5000 m (node 1 of 3), ",
                "at its first 9000 m, its last 0 m; scale 19.0"
            )
        );
        assert_eq!(said_distances(&distances, 1, None), None, "no telemetry");
    }

    #[test]
    fn a_route_read_says_its_waypoints_and_where_its_distances_rise() {
        let node = |uid: u64, distance_left: f32| RouteNode {
            position: [0.0, 0.0],
            height: 0.0,
            forward: [1.0, 0.0],
            uid,
            distance_left,
        };
        let falling = [node(1, 900.0), node(2, 500.0), node(3, 0.0)];
        assert_eq!(said_route(&falling, &[]), "route: the game's route read, 3 nodes, 0 waypoints");
        let rising = [node(1, 900.0), node(2, 500.0), node(3, 7000.0), node(4, 6000.0), node(5, 0.0)];
        assert_eq!(
            said_route(&rising, &[3, 9]),
            concat!(
                "route: the game's route read, 5 nodes, 2 waypoints (at node 2, not on it); ",
                "its own distances left rise 1 times, first from node 1 to 2: 500 m to 7000 m"
            )
        );
    }

    use super::*;

    #[test]
    fn reads_the_junctions_with_the_played_profiles_map_mods() {
        use westplay_setup::game::{FoundBy, Game, Kind};
        use westplay_setup::profiles::{MapContent, Mod, Profile};

        let a_mod = |package: &str, sectors: &[&str], files: bool| Mod {
            package: package.into(),
            name: package.into(),
            files: files.then(|| PathBuf::from(format!("mods/{package}.scs"))),
            categories: vec![],
            author: None,
            map: MapContent {
                sectors: sectors.iter().map(|s| (*s).to_owned()).collect(),
                definitions: false,
                hidden: false,
            },
            problem: None,
        };
        let mut profile = Profile::new_player(Kind::Ets2);
        profile.mods =
            vec![a_mod("promods", &["europe"], true), a_mod("truck", &[], true), a_mod("gone", &["europe"], false)];
        // WestPlay set up in one install, the game running from another: the running one's files.
        let set_up =
            Game { kind: Kind::Ets2, dir: "set-up".into(), found_by: FoundBy::Steam, version: None, dlcs: vec![] };
        let running = Path::new("running");

        let files = JunctionFiles::of(running, Some(&(set_up.clone(), profile.clone())));
        assert_eq!(files.install, running);
        assert_eq!(files.played.as_ref().map(|(game, _)| game.dir.as_path()), Some(running));
        // Only the map mods it has the files of, in the profile's order.
        assert_eq!((files.map.as_str(), files.mods.clone()), ("europe", vec![PathBuf::from("mods/promods.scs")]));

        // Not worked out yet: the base game's map alone.
        let base = JunctionFiles::of(running, None);
        assert_eq!((base.map.as_str(), base.mods.len()), ("europe", 0));
        assert_ne!(base, files);

        // A save changes nothing read (the files stay open); other map mods do.
        let mut saved = profile.clone();
        saved.last_saved = Some(std::time::SystemTime::now());
        assert_eq!(JunctionFiles::of(running, Some(&(set_up.clone(), saved))), files);
        let profile_again = profile.clone();
        let mut other = profile;
        other.mods.push(a_mod("turkey", &["europe"], true));
        assert_ne!(JunctionFiles::of(running, Some(&(set_up.clone(), other))), files);

        // ATS running, the profile played ETS2's (ATS not set up yet): ATS's base map alone.
        let ats = std::env::temp_dir().join(format!("westplay-junctions-ats-{}", std::process::id()));
        std::fs::create_dir_all(ats.join("bin").join("win_x64")).unwrap();
        std::fs::write(ats.join("base.scs"), b"").unwrap();
        std::fs::write(ats.join("bin").join("win_x64").join("amtrucks.exe"), b"").unwrap();
        let in_ats = JunctionFiles::of(&ats, Some(&(set_up, profile_again)));
        assert_eq!(
            (in_ats.base, in_ats.map.as_str(), in_ats.mods.len(), in_ats.played.is_none()),
            ("usa", "usa", 0, true)
        );
        let _ = std::fs::remove_dir_all(&ats);
    }
}
