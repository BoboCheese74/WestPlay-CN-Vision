//! The game DLL publishes checked route geometry in a process-scoped mapping. WestPlay opens it
//! read-only even when the game's process has higher privileges, without a handle to its memory.

use std::io;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering, fence};

use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP, FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
    OpenFileMappingW, PAGE_READWRITE, UnmapViewOfFile,
};
use windows::core::HSTRING;

use crate::game_route::{MAX_NODES, MAX_WAYPOINTS, RouteNode, Update};

const MAGIC: u32 = u32::from_le_bytes(*b"WPR1");

fn name(pid: u32) -> HSTRING {
    HSTRING::from(format!("Local\\WestPlay.Route.v1.{pid}"))
}

// Every field that can overlap a write is atomic, including the coordinates. A failed snapshot
// never exposes partially updated values to the application.
#[repr(C)]
struct Record {
    uid: AtomicU64,
    values: [AtomicU32; 6],
}

impl Record {
    fn write(&self, node: &RouteNode) {
        let [x, z] = node.position;
        let [forward_x, forward_z] = node.forward;
        self.uid.store(node.uid, Ordering::Relaxed);
        for (word, value) in self.values.iter().zip([x, z, forward_x, forward_z, node.distance_left, node.height]) {
            word.store(value.to_bits(), Ordering::Relaxed);
        }
    }

    fn read(&self) -> RouteNode {
        let [x, z, forward_x, forward_z, distance_left, height] =
            std::array::from_fn(|index| f32::from_bits(self.values[index].load(Ordering::Relaxed)));
        RouteNode {
            uid: self.uid.load(Ordering::Relaxed),
            position: [x, z],
            forward: [forward_x, forward_z],
            distance_left,
            height,
        }
    }
}

#[repr(C)]
struct RouteBuffer {
    magic: AtomicU32,
    // The v1 alignment gap before sequence. Old publishers leave these zero-filled bytes alone.
    coach_destination: AtomicU32,
    sequence: AtomicU64,
    node_count: AtomicU32,
    waypoint_count: AtomicU32,
    stop_count: AtomicU32,
    next: AtomicU32,
    waypoints: [AtomicU64; MAX_WAYPOINTS],
    stops: [AtomicU32; MAX_WAYPOINTS],
    nodes: [Record; MAX_NODES],
}

const _: () = assert!(std::mem::offset_of!(RouteBuffer, sequence) == 8);

impl RouteBuffer {
    fn still(&self, sequence: u64) -> bool {
        fence(Ordering::Acquire);
        self.sequence.load(Ordering::Acquire) == sequence
    }

    fn snapshot(&self, next: usize, sequence: u64) -> io::Result<Vec<Update>> {
        let nodes = self.node_count.load(Ordering::Relaxed) as usize;
        let waypoints = self.waypoint_count.load(Ordering::Relaxed) as usize;
        let stops = self.stop_count.load(Ordering::Relaxed) as usize;
        if nodes > MAX_NODES || waypoints > MAX_WAYPOINTS || stops > MAX_WAYPOINTS || next >= nodes.max(1) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "route snapshot counts or progress out of bounds"));
        }
        if nodes == 0 {
            return if waypoints == 0 && stops == 0 {
                Ok(vec![Update::None])
            } else {
                Err(io::Error::new(io::ErrorKind::InvalidData, "stops were published without a route"))
            };
        }
        let nodes: Vec<_> = self.nodes[..nodes].iter().map(Record::read).collect();
        let waypoints = self.waypoints[..waypoints].iter().map(|item| item.load(Ordering::Relaxed)).collect();
        let coach_stops: Vec<_> =
            self.stops[..stops].iter().map(|item| item.load(Ordering::Relaxed) as usize).collect();
        if !valid_stops(&coach_stops, nodes.len()) || !nodes.iter().all(RouteNode::is_finite) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "route snapshot has invalid geometry or stops"));
        }
        // v1 publishers also verified the terminal whenever they could send intermediate stops.
        let coach_destination = self.coach_destination.load(Ordering::Relaxed) == 1 || stops > 0;
        Ok(vec![
            Update::Route { id: (sequence / 2) as u32, nodes, waypoints, coach_stops, coach_destination },
            Update::Next(next),
        ])
    }
}

fn valid_stops(stops: &[usize], node_count: usize) -> bool {
    stops.last().is_none_or(|&stop| stop < node_count.saturating_sub(1))
        && stops.windows(2).all(|pair| pair[0] < pair[1])
}

struct View {
    handle: HANDLE,
    address: MEMORY_MAPPED_VIEW_ADDRESS,
}

impl View {
    fn map(handle: HANDLE, access: FILE_MAP) -> windows::core::Result<Self> {
        // SAFETY: the view requests the whole fixed-size buffer. The owned handle is closed on failure.
        unsafe {
            let address = MapViewOfFile(handle, access, 0, 0, size_of::<RouteBuffer>());
            if address.Value.is_null() {
                let error = windows::core::Error::from_thread();
                let _ = CloseHandle(handle);
                return Err(error);
            }
            Ok(Self { handle, address })
        }
    }

    fn buffer(&self) -> &RouteBuffer {
        // SAFETY: the view covers an aligned RouteBuffer, is alive through this borrow, and contains
        // only atomic integers, for which zero and every other bit pattern are valid.
        unsafe { &*self.address.Value.cast::<RouteBuffer>() }
    }
}

impl Drop for View {
    fn drop(&mut self) {
        // SAFETY: this owns both the view and the handle, and releases them exactly once.
        unsafe {
            let _ = UnmapViewOfFile(self.address);
            let _ = CloseHandle(self.handle);
        }
    }
}

/// Single writer for the current game's route snapshots, owned by its plugin.
pub struct RoutePublisher(View);

impl RoutePublisher {
    /// Creates a session-local mapping under this process's PID and publishes an empty route.
    /// An OS error means the view couldn't be opened for writing.
    pub fn create() -> windows::core::Result<Self> {
        // SAFETY: a non-executable, page-file-backed mapping, with the creating token's ACL.
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                size_of::<RouteBuffer>() as u32,
                &name(std::process::id()),
            )?
        };
        let mut publisher = Self(View::map(handle, FILE_MAP_WRITE)?);
        publisher.replace(&[], &[], &[], false, 0);
        publisher.0.buffer().magic.store(MAGIC, Ordering::Release);
        Ok(publisher)
    }

    /// Publishes one poll's changes. A new route and its initial progress are committed together.
    /// An invalid batch or route outside the transport bounds leaves the last snapshot intact.
    pub fn publish(&mut self, updates: &[Update]) -> io::Result<()> {
        match updates {
            [] => {}
            [Update::None] => self.replace(&[], &[], &[], false, 0),
            [Update::Next(next)] if *next < self.0.buffer().node_count.load(Ordering::Relaxed) as usize => {
                self.0.buffer().next.store(*next as u32, Ordering::Release);
            }
            [Update::Route { nodes, waypoints, coach_stops, coach_destination, .. }, Update::Next(next)]
                if nodes.len() <= MAX_NODES
                    && waypoints.len() <= MAX_WAYPOINTS
                    && coach_stops.len() <= MAX_WAYPOINTS
                    && *next < nodes.len()
                    && valid_stops(coach_stops, nodes.len())
                    && nodes.iter().all(RouteNode::is_finite) =>
            {
                self.replace(nodes, waypoints, coach_stops, *coach_destination, *next);
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid route publication")),
        }
        Ok(())
    }

    fn replace(
        &mut self,
        nodes: &[RouteNode],
        waypoints: &[u64],
        stops: &[usize],
        coach_destination: bool,
        next: usize,
    ) {
        let buffer = self.0.buffer();
        let previous = buffer.sequence.load(Ordering::Relaxed) & !1;
        buffer.sequence.swap(previous.wrapping_add(1), Ordering::AcqRel);
        for (destination, node) in buffer.nodes.iter().zip(nodes) {
            destination.write(node);
        }
        for (destination, &waypoint) in buffer.waypoints.iter().zip(waypoints) {
            destination.store(waypoint, Ordering::Relaxed);
        }
        for (destination, &stop) in buffer.stops.iter().zip(stops) {
            destination.store(stop as u32, Ordering::Relaxed);
        }
        buffer.node_count.store(nodes.len() as u32, Ordering::Relaxed);
        buffer.waypoint_count.store(waypoints.len() as u32, Ordering::Relaxed);
        buffer.stop_count.store(stops.len() as u32, Ordering::Relaxed);
        buffer.coach_destination.store(u32::from(coach_destination), Ordering::Relaxed);
        buffer.next.store(next as u32, Ordering::Relaxed);
        buffer.sequence.store(previous.wrapping_add(2), Ordering::Release);
    }
}

impl Drop for RoutePublisher {
    fn drop(&mut self) {
        self.replace(&[], &[], &[], false, 0);
    }
}

/// Read-only view of the route published by the game DLL.
pub struct RouteSubscriber {
    view: View,
    seen: Option<(u64, usize)>,
}

impl RouteSubscriber {
    /// Opens the mapping for the given live game's PID. An OS error can also mean the plugin has not started yet.
    pub fn open(pid: u32) -> windows::core::Result<Self> {
        // SAFETY: opens this session's named mapping with read access only, and owns the resulting handle.
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, &name(pid))? };
        Ok(Self { view: View::map(handle, FILE_MAP_READ)?, seen: None })
    }

    /// Returns the stable geometry or progress changes since the last read. An in-progress write is retried
    /// on the next poll. An incompatible or malformed stable snapshot produces an error.
    pub fn poll(&mut self) -> io::Result<Vec<Update>> {
        let buffer = self.view.buffer();
        match buffer.magic.load(Ordering::Acquire) {
            0 => return Ok(Vec::new()),
            MAGIC => {}
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unrecognized route mapping")),
        }
        let sequence = buffer.sequence.load(Ordering::Acquire);
        if sequence & 1 != 0 {
            return Ok(Vec::new());
        }
        let next = buffer.next.load(Ordering::Acquire) as usize;
        let updates = match self.seen {
            Some((last, previous)) if last == sequence && next == previous => return Ok(Vec::new()),
            Some((last, _)) if last == sequence => {
                let count = buffer.node_count.load(Ordering::Relaxed) as usize;
                if next < count {
                    Ok(vec![Update::Next(next)])
                } else {
                    Err(io::Error::new(io::ErrorKind::InvalidData, "route progress out of bounds"))
                }
            }
            _ => buffer.snapshot(next, sequence),
        };
        if !buffer.still(sequence) {
            return Ok(Vec::new());
        }
        let updates = updates.inspect_err(|_| self.seen = None)?;
        self.seen = Some((sequence, next));
        Ok(updates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes() -> Vec<RouteNode> {
        // The route crosses the same node on the way out and back, at indices 1 and 3.
        [11, 22, 33, 22, 44]
            .into_iter()
            .enumerate()
            .map(|(index, uid)| RouteNode {
                uid,
                position: [uid as f32, uid as f32 + 1.0],
                forward: [0.0, if index == 3 { -1.0 } else { 1.0 }],
                distance_left: (4 - index) as f32 * 100.0,
                height: 5.0,
            })
            .collect()
    }

    #[test]
    fn shares_routes_stops_and_progress_and_clears_on_exit() {
        let pid = std::process::id();
        assert!(RouteSubscriber::open(pid).is_err());
        let mut publisher = RoutePublisher::create().unwrap();
        let mut subscriber = RouteSubscriber::open(pid).unwrap();
        assert_eq!(subscriber.poll().unwrap(), [Update::None]);
        let nodes = nodes();
        let waypoints = vec![11, 33];
        let publish =
            |publisher: &mut RoutePublisher, coach_stops: Vec<usize>, coach_destination: bool, next: usize| {
                publisher.publish(&[
                    Update::Route {
                        id: 9,
                        nodes: nodes.clone(),
                        waypoints: waypoints.clone(),
                        coach_stops,
                        coach_destination,
                    },
                    Update::Next(next),
                ])
            };
        // A v1 DLL leaves the terminal flag zero but still sends verified intermediate arrivals.
        publish(&mut publisher, vec![1, 2, 3], false, 0).unwrap();
        assert_eq!(
            subscriber.poll().unwrap(),
            [
                Update::Route {
                    id: 2,
                    nodes: nodes.clone(),
                    waypoints: waypoints.clone(),
                    coach_stops: vec![1, 2, 3],
                    coach_destination: true
                },
                Update::Next(0)
            ],
        );
        assert!(subscriber.poll().unwrap().is_empty());

        publisher.publish(&[Update::Next(2)]).unwrap();
        assert_eq!(subscriber.poll().unwrap(), [Update::Next(2)]);
        assert_eq!(publish(&mut publisher, vec![3, 2], true, 2).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert!(subscriber.poll().unwrap().is_empty());

        for (remaining, next) in [(vec![2, 3], 2), (vec![3], 3), (vec![], 4)] {
            publish(&mut publisher, remaining.clone(), true, next).unwrap();
            let updates = subscriber.poll().unwrap();
            let [Update::Route { coach_stops, coach_destination: true, .. }, Update::Next(ahead)] = updates.as_slice()
            else {
                panic!("unexpected route changes: {updates:?}");
            };
            assert_eq!((coach_stops, *ahead), (&remaining, next));
        }
        assert!(matches!(
            RouteSubscriber::open(pid).unwrap().poll().unwrap()[..],
            [Update::Route { .. }, Update::Next(4)]
        ));
        publish(&mut publisher, vec![], false, 0).unwrap();
        assert!(matches!(
            subscriber.poll().unwrap()[..],
            [Update::Route { coach_destination: false, .. }, Update::Next(0)]
        ));
        drop(publisher);
        assert_eq!(subscriber.poll().unwrap(), [Update::None]);
        assert!(subscriber.poll().unwrap().is_empty());
    }
}
