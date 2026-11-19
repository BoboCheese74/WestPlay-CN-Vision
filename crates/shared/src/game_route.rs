//! The game's GPS route, whatever set it (a job, a point the player put on the map, any routing mode),
//! sampled read-only by the game plugin. The desktop app shares this decoder with its older-plugin
//! fallback. The SDK gives the distance and time left; the route itself is the game's own:
//!
//! - its telemetry getter for `truck.navigation.distance` reads a global pointer to an object whose member
//!   at an offset is the navigator. Both are found in the game's executable at startup, not hard-coded:
//!   the getter is registered right next to the channel's name ([`locate`]);
//! - the navigator's route id is at `+0x10`; its pointer at `+0x28` leads to the route's holder, and the
//!   route is at `holder + 0x78`: an array (`+0x08`) of nodes (`+0x10` of them), 0x30 bytes each (ATS 1.62:
//!   0x38, read from the navigator's own walk along them), and the
//!   next node ahead of the truck at navigator `+0x198`, while its route id at `+0x190` is the route's
//!   (ETS2 1.61's; ATS 1.62 has them, and every navigator field from `+0x118` up, 0x10 further on: those
//!   past `+0x118` are read from the game's own instructions that use them, westplay_shared::navigator, as
//!   are the waypoints' list; the route id and the holder, in the route object at `+0x08`, stayed put);
//! - a node is a map node (type 0, `+0x08` points to it) or a point inside a junction (type 1); a map node
//!   is laid out as the map's own: its position (three integers of 1/256 m), its rotation (w, x, y, z
//!   floats at `+0x10`), its id at `+0x30`.
//!
use crate::CoachJob;
use crate::navigator::{
    NEXT_NODE, NextNode, ROUTE_WALK, SET_TARGETS, find_unique, read_next_node, read_route_walk, read_set_targets,
};

const NAVIGATOR_ROUTE_ID: usize = 0x10;
const NAVIGATOR_HOLDER: usize = 0x28;
const HOLDER_ROUTE: usize = 0x78;
/// The navigator's waypoints are in the order they were put in (an array, its offset in the navigator read from
/// the game's code: its entries at `+0x08`, their count at `+0x10`); each entry 0x18 bytes, its map node's
/// pointer at `+0x08` (the destination isn't among them).
const WAYPOINT_SIZE: usize = 0x18;
const WAYPOINT_NODE: usize = 0x08;
/// More waypoints than the game takes: a count past this is a layout misread.
pub(crate) const MAX_WAYPOINTS: usize = 64;
/// A route node's distance left to the destination (a float).
const ROUTE_NODE_DISTANCE: usize = 0x24;
/// The byte the game sets on a route's marked targets (ETS2 1.62). Only used when the marks agree
/// with the navigator's ordered targets. Three bytes of padding follow it.
const ROUTE_NODE_TARGET: usize = 0x34;
const MAP_NODE_SIZE: usize = 0x38;
/// More nodes than any route across the map has: a count past this is a layout misread.
pub(crate) const MAX_NODES: usize = 200_000;

/// Where the game keeps its navigator: a global (its offset in the executable) pointing to an object, the
/// navigator's offset in it, and where in the navigator its next node and its waypoints' list are (read from
/// the game's code).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub global_rva: usize,
    pub navigator: usize,
    pub next: NextNode,
    pub waypoints: usize,
    /// Offset of the ordered targets, including the game's own passenger stops and destination.
    pub route_targets: usize,
    /// A route node's size.
    pub node_size: usize,
}

/// One of the route's map nodes: where it is, which way it points (the way of the roads through it,
/// x and z), and its id (the map's own).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RouteNode {
    pub position: [f32; 2],
    /// How high it is in the game, m.
    pub height: f32,
    pub forward: [f32; 2],
    pub uid: u64,
    /// The distance left from the node to the destination, as the game counts distances (its map's
    /// scale, as the SDK's `navigation.distance`), metres.
    pub distance_left: f32,
}

impl RouteNode {
    pub(crate) fn is_finite(&self) -> bool {
        let [x, z] = self.position;
        let [forward_x, forward_z] = self.forward;
        [x, z, forward_x, forward_z, self.distance_left, self.height].into_iter().all(f32::is_finite)
    }
}

/// Changes in the game's checked route since the last sample.
#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    /// A new geometry and the stops it includes. A progress update follows it in the same sample.
    Route { id: u32, nodes: Vec<RouteNode>, waypoints: Vec<u64>, coach_stops: Vec<usize> },
    /// The next map node ahead in the current route.
    Next(usize),
    /// The game no longer has a route to show.
    None,
}

/// Follows the game's route from poll to poll: reads it whole only when it's a new one (and twice, the same
/// both times, so a route the game is still writing isn't taken), then only the navigator's progress.
/// The route number changes with every new snapshot, including when the game's own route id is reused.
#[derive(Default)]
pub struct RouteReader {
    /// The route followed: which it is in the game's memory, its map nodes, and for each of its nodes in
    /// memory, the map node at or after it.
    route: Option<(RouteKey, Vec<RouteNode>, Vec<usize>)>,
    /// The number of the route snapshot last sent.
    number: u32,
    sent_next: Option<usize>,
    coach: CoachJob,
    coach_stops: Vec<usize>,
}

/// Which route the game's memory holds: its id, where its nodes are and how many.
type RouteKey = (u32, usize, usize);

impl RouteReader {
    /// What changed since the last poll, read from the navigator (`layout.navigator` bytes into the object the
    /// global at `global` points to).
    pub fn poll(&mut self, memory: &impl Memory, global: usize, layout: &Layout, coach: CoachJob) -> Vec<Update> {
        let Some(header) = read_header(memory, global, layout) else { return self.lost() };
        let key = (header.id, header.array, header.count);
        let mut updates = Vec::new();
        let new_route = self.route.as_ref().map(|(seen, _, _)| *seen) != Some(key);
        if new_route || self.coach != coach {
            // A new route that doesn't read (it doesn't add up): no route. One that reads differently twice
            // (still being written): looked at again next time.
            let (Some(first), Some(again)) = (read_nodes(memory, &header), read_nodes(memory, &header)) else {
                return self.lost();
            };
            if first != again {
                return updates;
            }
            let waypoints = read_waypoints(memory, global, layout);
            let marked_stops = waypoints
                .as_deref()
                .and_then(|waypoints| coach_stops(memory, global, layout, coach, &first, waypoints));
            // Keep the verified stops of this geometry while the SDK and the GPS update separately.
            let coach_stops = match marked_stops {
                Some(stops) => stops,
                None if !new_route && coach.is_active() => self.coach_stops.clone(),
                None => Vec::new(),
            };
            let ReadRoute { nodes, after, .. } = first;
            self.number = self.number.wrapping_add(1);
            self.sent_next = None;
            self.coach = coach;
            self.coach_stops.clone_from(&coach_stops);
            updates.push(Update::Route {
                id: self.number,
                nodes: nodes.clone(),
                waypoints: waypoints.unwrap_or_default(),
                coach_stops,
            });
            self.route = Some((key, nodes, after));
        }
        let Some((_, nodes, after)) = &self.route else { return updates };
        let next = after.get(header.next_index).copied().unwrap_or(nodes.len() - 1);
        if self.sent_next != Some(next) {
            self.sent_next = Some(next);
            updates.push(Update::Next(next));
        }
        updates
    }

    /// The coach job most recently read, for when a telemetry write is in progress.
    pub fn last_coach(&self) -> CoachJob {
        self.coach
    }

    /// Yields a route clear once when losing the game or its route.
    fn lost(&mut self) -> Vec<Update> {
        self.sent_next = None;
        self.coach = CoachJob::default();
        self.coach_stops.clear();
        match self.route.take() {
            Some(_) => vec![Update::None],
            None => Vec::new(),
        }
    }
}

/// Read access to the game's address space, or a stand-in for tests.
pub trait Memory {
    /// Copies exactly `buffer.len()` bytes at `address`, returning false if it cannot read all of them.
    fn read(&self, address: usize, buffer: &mut [u8]) -> bool;

    /// Reads one little-endian 64-bit value, or returns `None` on failure.
    fn u64_at(&self, address: usize) -> Option<u64> {
        let mut word = [0u8; 8];
        self.read(address, &mut word).then(|| u64::from_le_bytes(word))
    }
}

/// The navigator's route as it stands: its id, where its nodes are and how many, and the index of the
/// node ahead of the truck (0 if the navigator's pointer isn't into this route).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Header {
    id: u32,
    array: usize,
    count: usize,
    next_index: usize,
    node_size: usize,
}

fn read_header(memory: &impl Memory, global: usize, layout: &Layout) -> Option<Header> {
    let owner = memory.u64_at(global)? as usize;
    if owner == 0 {
        return None;
    }
    let navigator = owner.checked_add(layout.navigator)?;
    let id = memory.u64_at(navigator.checked_add(NAVIGATOR_ROUTE_ID)?)? as u32;
    let holder = memory.u64_at(navigator.checked_add(NAVIGATOR_HOLDER)?)? as usize;
    if holder == 0 {
        return None;
    }
    let route = holder.checked_add(HOLDER_ROUTE)?;
    let array = memory.u64_at(route.checked_add(8)?)? as usize;
    let count = memory.u64_at(route.checked_add(0x10)?)? as usize;
    if array == 0 || count == 0 || count > MAX_NODES {
        return None;
    }
    let size = layout.node_size;
    let end = array.checked_add(count.checked_mul(size)?)?;
    let next_id = memory.u64_at(navigator.checked_add(layout.next.id)?)? as u32;
    let next = memory.u64_at(navigator.checked_add(layout.next.node)?)? as usize;
    // The next node ahead: a node of this route (the pointer may still be an old route's).
    let in_route = next >= array && next < end && (next - array).is_multiple_of(size);
    let next_index = if next_id == id && in_route { (next - array) / size } else { 0 };
    Some(Header { id, array, count, next_index, node_size: size })
}

/// The navigator's waypoints: their map nodes' uids, in the order they were put in; `None` if what's read
/// doesn't add up.
fn read_waypoints(memory: &impl Memory, global: usize, layout: &Layout) -> Option<Vec<u64>> {
    read_targets(memory, global, layout, layout.waypoints)?
        .into_iter()
        .map(|pointer| {
            let mut map_node = [0u8; MAP_NODE_SIZE];
            memory.read(pointer, &mut map_node).then(|| map_node_of(&map_node).uid)
        })
        .collect()
}

/// The map node pointers in one of the navigator's target lists. The entries also carry a target kind,
/// which is different for a city stop and a tourist stop.
fn read_targets(memory: &impl Memory, global: usize, layout: &Layout, offset: usize) -> Option<Vec<usize>> {
    let owner = memory.u64_at(global)? as usize;
    let list = owner.checked_add(layout.navigator)?.checked_add(offset)?;
    let count = memory.u64_at(list.checked_add(0x10)?)? as usize;
    if count == 0 {
        return Some(Vec::new());
    }
    let array = memory.u64_at(list.checked_add(8)?)? as usize;
    if array == 0 || count > MAX_WAYPOINTS {
        return None;
    }
    let mut raw = vec![0u8; count * WAYPOINT_SIZE];
    if !memory.read(array, &mut raw) {
        return None;
    }
    raw.chunks_exact(WAYPOINT_SIZE)
        .map(|entry| {
            let pointer = u64::from_le_bytes(entry[WAYPOINT_NODE..WAYPOINT_NODE + 8].try_into().unwrap()) as usize;
            (pointer != 0).then_some(pointer)
        })
        .collect()
}

#[derive(PartialEq)]
struct ReadRoute {
    nodes: Vec<RouteNode>,
    after: Vec<usize>,
    /// Ordered occurrences of map node pointers explicitly marked by the game, including its route start.
    targets: Vec<(usize, usize)>,
}

/// The intermediate coach stops in route order. Match explicit arrivals before dropping the terminal
/// target: a station's node can also occur on the way past or when leaving the stop.
fn coach_stops(
    memory: &impl Memory,
    global: usize,
    layout: &Layout,
    coach: CoachJob,
    route: &ReadRoute,
    waypoints: &[u64],
) -> Option<Vec<usize>> {
    if !coach.is_active() || !waypoints.is_empty() {
        return None;
    }
    let targets = read_targets(memory, global, layout, layout.route_targets)?;
    if targets.len() > coach.stage_count as usize {
        return None;
    }
    let mut marked = route.targets.as_slice();
    if marked.len() == targets.len() + 1 && marked.first()?.0 == 0 {
        marked = &marked[1..];
    }
    let (&(end, _), intermediate) = marked.split_last()?;
    if end + 1 != route.nodes.len()
        || marked.len() != targets.len()
        || !marked.iter().zip(&targets).all(|((_, pointer), target)| pointer == target)
    {
        return None;
    }
    Some(intermediate.iter().map(|&(node, _)| node).collect())
}

/// The route's map nodes, and for each of its nodes in memory, the map node at or after it (where the truck
/// is along the map nodes when it's at that node); `None` without any, or if what's read doesn't add up.
fn read_nodes(memory: &impl Memory, header: &Header) -> Option<ReadRoute> {
    let mut raw = vec![0u8; header.count * header.node_size];
    if !memory.read(header.array, &mut raw) {
        return None;
    }
    let mut nodes = Vec::new();
    let mut targets = Vec::new();
    // For each node in memory, the map node before which it lies.
    let mut before = Vec::with_capacity(header.count);
    for node in raw.chunks_exact(header.node_size) {
        before.push(nodes.len());
        match u32::from_le_bytes(node[0..4].try_into().unwrap()) {
            0 => {
                let pointer = u64::from_le_bytes(node[8..16].try_into().unwrap()) as usize;
                let mut map_node = [0u8; MAP_NODE_SIZE];
                if !memory.read(pointer, &mut map_node) {
                    return None;
                }
                let distance_left =
                    f32::from_le_bytes(node[ROUTE_NODE_DISTANCE..ROUTE_NODE_DISTANCE + 4].try_into().unwrap());
                if node.get(ROUTE_NODE_TARGET) == Some(&1) {
                    targets.push((nodes.len(), pointer));
                }
                let node = RouteNode { distance_left, ..map_node_of(&map_node) };
                if !node.is_finite() {
                    return None;
                }
                nodes.push(node);
            }
            1 => {}
            // Neither kind of node: the layout isn't what it was.
            _ => return None,
        }
    }
    if nodes.is_empty() {
        return None;
    }
    let last = nodes.len() - 1;
    let after = before.into_iter().map(|index| index.min(last)).collect();
    Some(ReadRoute { nodes, after, targets })
}

/// A map node as the game keeps it: position (integers of 1/256 m: x, height, z), rotation (w, x, y, z), id.
fn map_node_of(bytes: &[u8; MAP_NODE_SIZE]) -> RouteNode {
    let int = |at: usize| i32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as f32 / 256.0;
    let float = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    // The game's forward (0, 0, -1) turned by the rotation's yaw (as the map's nodes: geometry::node_forward).
    let (w, y) = (float(0x10), float(0x18));
    let yaw = 2.0 * y.atan2(w);
    RouteNode {
        position: [int(0), int(8)],
        height: int(4),
        forward: [-yaw.sin(), -yaw.cos()],
        uid: u64::from_le_bytes(bytes[0x30..0x38].try_into().unwrap()),
        distance_left: 0.0,
    }
}

/// A section of an executable: where it's mapped (rva) and its bytes in the file.
pub struct Section<'a> {
    pub rva: usize,
    pub bytes: &'a [u8],
}

/// The navigator's layout, from the game's executable file: its code (`.text`) and constant data (`.rdata`).
pub fn locate_in_image(image: &[u8]) -> Option<Layout> {
    locate(&section(image, b".text\0")?, &section(image, b".rdata\0")?)
}

/// A section of an executable file (`image`) by its name (NUL-terminated, eight bytes at most).
pub fn section<'a>(image: &'a [u8], name: &[u8]) -> Option<Section<'a>> {
    let u16_at = |at: usize| image.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));
    let u32_at = |at: usize| image.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize);
    let header = u32_at(0x3c)?;
    let sections = u16_at(header + 6)? as usize;
    let optional = u16_at(header + 20)? as usize;
    (0..sections).find_map(|i| {
        let at = header + 24 + optional + i * 40;
        let named = image.get(at..at + 8)?.starts_with(name);
        let (rva, size, raw) = (u32_at(at + 12)?, u32_at(at + 16)?, u32_at(at + 20)?);
        named.then(|| Some(Section { rva, bytes: image.get(raw..raw + size)? })).flatten()
    })
}

/// The navigator's layout, from the code: the getter registered beside the name `truck.navigation.distance`
/// (`lea rax, [getter]` a little before `lea …, [name]`) starts `sub rsp, 28h; mov rax, [global]`, and
/// soon `lea rcx, [rax + navigator]`; the next node, the waypoints' list and a route node's size where the
/// navigator's own code uses them (westplay_shared::navigator), each piece found once by its shape.
fn locate(text: &Section, rdata: &Section) -> Option<Layout> {
    let (global_rva, navigator) = locate_getter(text, rdata)?;
    let code = text.bytes;
    let next = read_next_node(&code[find_unique(code, &NEXT_NODE)?..])?;
    let targets = read_set_targets(&code[find_unique(code, &SET_TARGETS)?..])?;
    let node_size = read_route_walk(&code[find_unique(code, &ROUTE_WALK)?..])?;
    Some(Layout { global_rva, navigator, next, waypoints: targets.waypoints, route_targets: targets.route, node_size })
}

/// The global and the navigator's offset in its object, from the distance getter (as [`locate`] says).
fn locate_getter(text: &Section, rdata: &Section) -> Option<(usize, usize)> {
    let name = b"truck.navigation.distance\0";
    let name_rva = rdata.rva + rdata.bytes.windows(name.len()).position(|w| w == name)?;
    let code = text.bytes;
    // A RIP-relative lea (48 or 4C, 8D, a register with [rip + disp32]) at `at`, and where it points.
    let lea_target = |at: usize| -> Option<usize> {
        let b = code.get(at..at + 7)?;
        let rip_relative = (b[0] == 0x48 || b[0] == 0x4c) && b[1] == 0x8d && b[2] & 0xc7 == 0x05;
        rip_relative
            .then(|| (text.rva + at + 7).wrapping_add_signed(i32::from_le_bytes(b[3..7].try_into().unwrap()) as isize))
    };
    for site in (0..code.len().saturating_sub(7)).filter(|&at| lea_target(at) == Some(name_rva)) {
        for back in 1..=64 {
            let Some(getter) = site.checked_sub(back).and_then(lea_target) else { continue };
            let Some(start) = getter.checked_sub(text.rva) else { continue };
            if let Some(found) = read_getter(code, start, getter) {
                return Some(found);
            }
        }
    }
    None
}

/// The global and navigator a distance getter at `start` in the code (rva `rva`) reads: `48 83 EC 28` (sub rsp,
/// 28h), `48 8B 05 disp32` (mov rax, [rip + disp32]: the global), then within a few instructions
/// `48 8D 88 imm32` (lea rcx, [rax + imm32]: the navigator).
fn read_getter(code: &[u8], start: usize, rva: usize) -> Option<(usize, usize)> {
    let b = code.get(start..start + 48)?;
    if b[..4] != [0x48, 0x83, 0xec, 0x28] || b[4..7] != [0x48, 0x8b, 0x05] {
        return None;
    }
    let global_rva = (rva + 11).wrapping_add_signed(i32::from_le_bytes(b[7..11].try_into().unwrap()) as isize);
    let at = (11..b.len() - 7).find(|&i| b[i..i + 3] == [0x48, 0x8d, 0x88])?;
    let navigator = u32::from_le_bytes(b[at + 3..at + 7].try_into().unwrap()) as usize;
    Some((global_rva, navigator))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// The navigator's layout found in each game build named by `WESTPLAY_GAME_EXES` (paths to the games'
    /// executables, ETS2's and ATS's, separated by `;`), printed.
    #[test]
    #[ignore = "needs game executables: WESTPLAY_GAME_EXES"]
    fn finds_the_route_in_each_game_build() {
        let exes = std::env::var("WESTPLAY_GAME_EXES").expect("WESTPLAY_GAME_EXES");
        for exe in exes.split(';').filter(|exe| !exe.is_empty()) {
            let layout = locate_in_image(&std::fs::read(exe).unwrap());
            println!("{exe}: {layout:x?}");
            assert!(layout.is_some(), "{exe}: the route isn't found");
        }
    }
    use std::collections::BTreeMap;

    /// A stand-in for the game's memory: blocks of bytes at addresses. `shaky` changes one map node's
    /// position on every read of it (a route the game is still writing).
    #[derive(Default)]
    struct FakeMemory {
        blocks: BTreeMap<usize, Vec<u8>>,
        shaky: Option<usize>,
        reads: Cell<u32>,
    }

    impl Memory for FakeMemory {
        fn read(&self, address: usize, buffer: &mut [u8]) -> bool {
            let Some((&start, block)) = self.blocks.range(..=address).next_back() else { return false };
            let at = address - start;
            let Some(bytes) = block.get(at..at + buffer.len()) else { return false };
            buffer.copy_from_slice(bytes);
            if self.shaky == Some(address) {
                let read = self.reads.get() + 1;
                self.reads.set(read);
                buffer[0..4].copy_from_slice(&(read as i32 * 256).to_le_bytes());
            }
            true
        }
    }

    const GLOBAL: usize = 0x1000;
    const OWNER: usize = 0x10_000;
    const NAVIGATOR: usize = 0x40;
    /// The navigator's fields as ETS2 1.61 has them.
    const LAYOUT: Layout = Layout {
        global_rva: 0,
        navigator: NAVIGATOR,
        next: NextNode { id: 0x190, node: 0x198 },
        waypoints: 0x248,
        route_targets: 0x1f8,
        node_size: 0x30,
    };
    const HOLDER: usize = 0x20_000;
    const ARRAY: usize = 0x30_000;
    const MAP_NODES: usize = 0x40_000;

    /// A navigator with a route of `kinds` (0 a map node, 1 a junction point), id `id`, the next node ahead
    /// at index `next` (of the route `next_id`).
    fn navigator(id: u32, kinds: &[u32], next: usize, next_id: u32) -> FakeMemory {
        navigator_with_layout(&LAYOUT, id, kinds, next, next_id)
    }

    fn navigator_with_layout(layout: &Layout, id: u32, kinds: &[u32], next: usize, next_id: u32) -> FakeMemory {
        let node_size = layout.node_size;
        let mut memory = FakeMemory::default();
        memory.blocks.insert(GLOBAL, (OWNER as u64).to_le_bytes().to_vec());
        let mut owner = vec![0u8; NAVIGATOR + layout.next.node + 8];
        let put = |bytes: &mut Vec<u8>, at: usize, value: u64| bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
        put(&mut owner, NAVIGATOR + NAVIGATOR_ROUTE_ID, u64::from(id));
        put(&mut owner, NAVIGATOR + NAVIGATOR_HOLDER, HOLDER as u64);
        put(&mut owner, NAVIGATOR + layout.next.id, u64::from(next_id));
        put(&mut owner, NAVIGATOR + layout.next.node, (ARRAY + next * node_size) as u64);
        memory.blocks.insert(OWNER, owner);
        let mut holder = vec![0u8; HOLDER_ROUTE + 0x18];
        put(&mut holder, HOLDER_ROUTE + 8, ARRAY as u64);
        put(&mut holder, HOLDER_ROUTE + 0x10, kinds.len() as u64);
        memory.blocks.insert(HOLDER, holder);
        let mut array = vec![0u8; kinds.len() * node_size];
        for (index, &kind) in kinds.iter().enumerate() {
            let node = &mut array[index * node_size..(index + 1) * node_size];
            node[0..4].copy_from_slice(&kind.to_le_bytes());
            node[8..16].copy_from_slice(&((MAP_NODES + index * 0x100) as u64).to_le_bytes());
            let mut map_node = vec![0u8; MAP_NODE_SIZE];
            map_node[0..4].copy_from_slice(&((index as i32) * 256 * 10).to_le_bytes());
            map_node[0x10..0x14].copy_from_slice(&1.0f32.to_le_bytes());
            map_node[0x30..0x38].copy_from_slice(&(index as u64 + 1).to_le_bytes());
            memory.blocks.insert(MAP_NODES + index * 0x100, map_node);
        }
        memory.blocks.insert(ARRAY, array);
        memory
    }

    fn poll(reader: &mut RouteReader, memory: &FakeMemory) -> Vec<Update> {
        reader.poll(memory, GLOBAL, &LAYOUT, CoachJob::default())
    }

    const COACH_LAYOUT: Layout = Layout {
        next: NextNode { id: 0x1a0, node: 0x1a8 },
        waypoints: 0x258,
        route_targets: 0x208,
        node_size: 0x38,
        ..LAYOUT
    };

    /// Set the route's pointers and marks, and the corresponding ordered targets in the navigator.
    fn coach_navigator(id: u32, kinds: &[u32], map_nodes: &[(usize, bool)], targets: &[usize]) -> FakeMemory {
        let mut memory = navigator_with_layout(&COACH_LAYOUT, id, kinds, 0, id);
        let put_pointer = |bytes: &mut [u8], at: usize, node: usize| {
            bytes[at..at + 8].copy_from_slice(&((MAP_NODES + node * 0x100) as u64).to_le_bytes());
        };
        let array = memory.blocks.get_mut(&ARRAY).unwrap();
        for (raw_index, &(node, marked)) in map_nodes.iter().enumerate() {
            let at = raw_index * COACH_LAYOUT.node_size;
            put_pointer(array, at + 8, node);
            array[at + ROUTE_NODE_TARGET] = u8::from(marked);
            // Only the flag byte is defined. Adjacent padding may have arbitrary data.
            array[at + ROUTE_NODE_TARGET + 1] = 0xaa;
        }
        const TARGETS: usize = 0x50_000;
        let owner = memory.blocks.get_mut(&OWNER).unwrap();
        owner.resize(NAVIGATOR + COACH_LAYOUT.waypoints + 0x18, 0);
        let at = NAVIGATOR + COACH_LAYOUT.route_targets;
        owner[at + 8..at + 16].copy_from_slice(&(TARGETS as u64).to_le_bytes());
        owner[at + 0x10..at + 0x18].copy_from_slice(&(targets.len() as u64).to_le_bytes());
        let mut entries = vec![0u8; targets.len() * WAYPOINT_SIZE];
        for (entry, &node) in targets.iter().enumerate() {
            put_pointer(&mut entries, entry * WAYPOINT_SIZE + WAYPOINT_NODE, node);
        }
        memory.blocks.insert(TARGETS, entries);
        memory
    }

    #[test]
    fn the_marked_arrival_splits_a_coach_round_trip_until_the_game_advances() {
        // The route passes the station's map node before returning to it for the scheduled stop.
        // Only the arrival is marked. The junction's raw point doesn't count as a map node.
        let outward = coach_navigator(
            1,
            &[0, 0, 0, 1, 0, 0, 0, 0],
            &[(0, true), (3, false), (1, false), (2, false), (3, true), (3, false), (1, false), (0, true)],
            &[3, 0],
        );
        let mut reader = RouteReader::default();
        let first = CoachJob { current_stage: 0, stage_count: 2 };
        let last = CoachJob { current_stage: 1, ..first };
        let check = |updates: &[Update], stops: &[usize]| {
            assert!(matches!(updates.first(), Some(Update::Route { coach_stops, .. }) if coach_stops == stops));
        };
        check(&reader.poll(&outward, GLOBAL, &COACH_LAYOUT, first), &[3]);
        // The SDK advances while the GPS still holds the old path.
        check(&reader.poll(&outward, GLOBAL, &COACH_LAYOUT, last), &[3]);

        let home = coach_navigator(2, &[0, 0, 0], &[(0, true), (1, false), (2, true)], &[2]);
        check(&reader.poll(&home, GLOBAL, &COACH_LAYOUT, last), &[]);
        let mut reader = RouteReader::default();
        check(&reader.poll(&outward, GLOBAL, &COACH_LAYOUT, CoachJob::default()), &[]);
    }

    #[test]
    fn only_the_remaining_marked_coach_arrivals_are_sent_after_each_stop() {
        // The first station is both passed without stopping and visited again on the return leg.
        let first = coach_navigator(
            1,
            &[0, 0, 1, 0, 0, 0, 0, 0, 0],
            &[(0, true), (3, false), (1, false), (3, true), (3, false), (4, true), (4, false), (3, true), (0, true)],
            &[3, 4, 3, 0],
        );
        let second = coach_navigator(
            2,
            &[0, 0, 0, 0, 0, 0],
            &[(0, true), (1, false), (2, true), (2, false), (3, true), (4, true)],
            &[2, 3, 4],
        );
        let third = coach_navigator(3, &[0, 0, 0, 0], &[(0, true), (1, false), (2, true), (3, true)], &[2, 3]);
        let terminal = coach_navigator(4, &[0, 0, 0], &[(0, true), (1, false), (2, true)], &[2]);
        let mut reader = RouteReader::default();
        let routes: [(&FakeMemory, &[usize]); 4] =
            [(&first, &[2, 4, 6]), (&second, &[2, 4]), (&third, &[2]), (&terminal, &[])];
        for (stage, (memory, expected)) in routes.into_iter().enumerate() {
            let coach = CoachJob { current_stage: stage as u32, stage_count: routes.len() as u32 };
            let updates = reader.poll(memory, GLOBAL, &COACH_LAYOUT, coach);
            assert!(
                matches!(updates.first(), Some(Update::Route { coach_stops, .. }) if coach_stops == expected),
                "{updates:?}"
            );
        }
    }

    fn summary(updates: &[Update]) -> Vec<String> {
        updates
            .iter()
            .map(|update| match update {
                Update::Route { id, nodes, .. } => format!("route {id}: {} nodes", nodes.len()),
                Update::Next(next) => format!("next {next}"),
                Update::None => "none".into(),
            })
            .collect()
    }

    #[test]
    fn reads_the_navigators_waypoints_with_a_new_route() {
        // Map nodes 1, 2 and 3; waypoints at the second and the first map node, in that order.
        let mut memory = navigator(77, &[0, 0, 0], 0, 77);
        const WAYPOINTS: usize = 0x50_000;
        let owner = memory.blocks.get_mut(&OWNER).unwrap();
        owner.resize(NAVIGATOR + LAYOUT.waypoints + 0x18, 0);
        let list = NAVIGATOR + LAYOUT.waypoints;
        owner[list + 8..list + 16].copy_from_slice(&(WAYPOINTS as u64).to_le_bytes());
        owner[list + 0x10..list + 0x18].copy_from_slice(&2u64.to_le_bytes());
        let mut entries = vec![0u8; 2 * WAYPOINT_SIZE];
        for (entry, node) in [1usize, 0].into_iter().enumerate() {
            let at = entry * WAYPOINT_SIZE + WAYPOINT_NODE;
            entries[at..at + 8].copy_from_slice(&((MAP_NODES + node * 0x100) as u64).to_le_bytes());
        }
        memory.blocks.insert(WAYPOINTS, entries);
        let mut reader = RouteReader::default();
        let updates = poll(&mut reader, &memory);
        assert!(matches!(&updates[0], Update::Route { waypoints, .. } if waypoints == &[2, 1]), "{updates:?}");
        // A list that can't be read: none known (not an empty list).
        assert_eq!(read_waypoints(&navigator(77, &[0], 0, 77), GLOBAL, &LAYOUT), None);
        // An empty one: none.
        let mut empty = navigator(77, &[0], 0, 77);
        empty.blocks.get_mut(&OWNER).unwrap().resize(NAVIGATOR + LAYOUT.waypoints + 0x18, 0);
        assert_eq!(read_waypoints(&empty, GLOBAL, &LAYOUT), Some(Vec::new()));
    }

    #[test]
    fn reads_a_route_once_then_only_the_progress_along_it() {
        // Map nodes at 0, 2 and 3; a junction point at 1. The truck heads for the junction point: the map
        // node at or after it is the second one.
        let mut reader = RouteReader::default();
        let memory = navigator(77, &[0, 1, 0, 0], 1, 77);
        assert_eq!(summary(&poll(&mut reader, &memory)), ["route 1: 3 nodes", "next 1"]);
        // Nothing new: nothing sent.
        assert!(poll(&mut reader, &memory).is_empty());
        // On to the last node.
        let memory = navigator(77, &[0, 1, 0, 0], 3, 77);
        assert_eq!(summary(&poll(&mut reader, &memory)), ["next 2"]);
        // A pointer into another route (the navigator's not caught up): the start.
        let memory = navigator(77, &[0, 1, 0, 0], 3, 76);
        assert_eq!(summary(&poll(&mut reader, &memory)), ["next 0"]);
    }

    #[test]
    fn a_new_route_gets_a_new_number_even_under_the_same_game_id() {
        let mut reader = RouteReader::default();
        assert_eq!(summary(&poll(&mut reader, &navigator(5, &[0, 0], 0, 5))), ["route 1: 2 nodes", "next 0"]);
        // The game's id again, but other nodes: another route, numbered anew (late junction ways for the
        // first can't be taken for it).
        assert_eq!(summary(&poll(&mut reader, &navigator(5, &[0, 0, 0], 0, 5))), ["route 2: 3 nodes", "next 0"]);
        assert_eq!(summary(&poll(&mut reader, &navigator(6, &[0, 0, 0], 0, 6))), ["route 3: 3 nodes", "next 0"]);
    }

    #[test]
    fn a_route_still_being_written_is_left_until_it_reads_the_same_twice() {
        let mut reader = RouteReader::default();
        let mut memory = navigator(9, &[0, 0], 0, 9);
        memory.shaky = Some(MAP_NODES);
        assert!(poll(&mut reader, &memory).is_empty());
        memory.shaky = None;
        assert_eq!(summary(&poll(&mut reader, &memory)), ["route 1: 2 nodes", "next 0"]);
    }

    #[test]
    fn what_does_not_add_up_reads_as_no_route() {
        let mut reader = RouteReader::default();
        assert_eq!(summary(&poll(&mut reader, &navigator(3, &[0, 0], 0, 3))), ["route 1: 2 nodes", "next 0"]);
        // A new route with a node of neither kind (a new game version's layout): no route, said once.
        assert_eq!(summary(&poll(&mut reader, &navigator(4, &[0, 7], 0, 4))), ["none"]);
        assert!(poll(&mut reader, &navigator(4, &[0, 7], 0, 4)).is_empty());
        // Only junction points: nothing to draw.
        assert!(poll(&mut reader, &navigator(4, &[1, 1], 0, 4)).is_empty());
        // No navigator object.
        let mut memory = navigator(4, &[0], 0, 4);
        memory.blocks.insert(GLOBAL, 0u64.to_le_bytes().to_vec());
        assert!(read_header(&memory, GLOBAL, &LAYOUT).is_none());
        // A count past any real route's.
        let mut memory = navigator(4, &[0], 0, 4);
        let holder = memory.blocks.get_mut(&HOLDER).unwrap();
        holder[HOLDER_ROUTE + 0x10..HOLDER_ROUTE + 0x18].copy_from_slice(&((MAX_NODES + 1) as u64).to_le_bytes());
        assert!(read_header(&memory, GLOBAL, &LAYOUT).is_none());
    }

    fn hex(bytes: &str) -> Vec<u8> {
        bytes.split_whitespace().map(|b| u8::from_str_radix(b, 16).unwrap()).collect()
    }

    #[test]
    fn locates_the_navigator_from_the_getter_registered_beside_its_name() {
        // Constant data at rva 0x2000 with the name 0x10 in; code at rva 0x1000: the getter at 0x40, and at
        // 0x100 the registration: lea rax, [getter], then 6 bytes on, lea rax, [name].
        let mut rdata = vec![0u8; 0x40];
        rdata[0x10..0x10 + 26].copy_from_slice(b"truck.navigation.distance\0");
        let mut code = vec![0x90u8; 0x200];
        // The getter: sub rsp, 28h; mov rax, [rip + disp] (the global at rva 0x9000); test rax, rax; jnz +8;
        // xorps; add rsp, 28h; ret; lea rcx, [rax + 0x4128].
        let getter = [
            0x48, 0x83, 0xec, 0x28, 0x48, 0x8b, 0x05, 0, 0, 0, 0, 0x48, 0x85, 0xc0, 0x75, 0x08, 0x0f, 0x57, 0xc0, 0x48,
            0x83, 0xc4, 0x28, 0xc3, 0x48, 0x8d, 0x88, 0x28, 0x41, 0x00, 0x00,
        ];
        code[0x40..0x40 + getter.len()].copy_from_slice(&getter);
        let global_disp = (0x9000i64 - (0x1040 + 11)) as i32;
        code[0x47..0x4b].copy_from_slice(&global_disp.to_le_bytes());
        let lea = |code: &mut Vec<u8>, at: usize, target: usize| {
            code[at..at + 3].copy_from_slice(&[0x48, 0x8d, 0x05]);
            let disp = (target as i64 - (0x1000 + at as i64 + 7)) as i32;
            code[at + 3..at + 7].copy_from_slice(&disp.to_le_bytes());
        };
        lea(&mut code, 0x100, 0x1040);
        lea(&mut code, 0x10d, 0x2010);
        // Without the navigator's own functions, no layout: its next node and waypoints aren't known.
        assert_eq!(locate(&Section { rva: 0x1000, bytes: &code }, &Section { rva: 0x2000, bytes: &rdata }), None);
        // Its "set targets" and "next node" as ATS 1.62.1.1 has them (their fields 0x10 on from ETS2 1.61's).
        let set_targets =
            hex("48 89 5c 24 08 48 89 74 24 10 57 48 83 ec 20 48 8b f9 89 91 d8 01 00 00 48 81 c1 e0 01 \
            00 00 33 f6 49 8b d9 4c 3b c1 74 0c 49 8b d0 48 89 71 10 e8 2b 3c 00 00 48 8d 8f 08 02 00 00 48 3b d9 74 \
            0c 48 8b d3 48 89 71 10 e8 13 3c 00 00 48 8b 54 24 50 48 8d 8f 30 02 00 00 48 3b d1 74 09 48 89 71 10 e8 \
            f9 3b 00 00 48 8b 54 24 58 48 8d 8f 58 02 00 00");
        let next = hex("40 53 48 83 ec 20 48 8b 41 08 48 8b d9 48 83 c1 08 ff 50 30 3b 83 a0 01 00 00 75 0d 48 8b \
            83 a8 01 00 00 48 83 c4 20 5b c3");
        let walk = hex("4d 8b 6b 08 49 8d 5d c8 4c 3b e3 74 41 49 83 fa 02 73 3b 44 8b 0a 45 85 c9 74 0c 41 83 f9 \
            01 75 16 48 39 7a 08 eb 0e 48 8b 42 08 48 39 78 28 74 4a 48 39 78 20 74 44 48 83 ea 38");
        code.extend(&set_targets);
        code.extend([0xcc; 13]);
        code.extend(&next);
        code.extend([0xcc; 7]);
        code.extend(&walk);
        let layout = locate(&Section { rva: 0x1000, bytes: &code }, &Section { rva: 0x2000, bytes: &rdata });
        assert_eq!(
            layout,
            Some(Layout {
                global_rva: 0x9000,
                navigator: 0x4128,
                next: NextNode { id: 0x1a0, node: 0x1a8 },
                waypoints: 0x258,
                route_targets: 0x208,
                node_size: 0x38
            })
        );
        // Without the name, or with a different getter, nothing.
        let other = vec![0u8; 0x40];
        assert_eq!(locate(&Section { rva: 0x1000, bytes: &code }, &Section { rva: 0x2000, bytes: &other }), None);
    }

    #[test]
    fn reads_a_map_node_as_the_game_keeps_it() {
        let mut bytes = [0u8; MAP_NODE_SIZE];
        let x = (24150.95f32 * 256.0).round() as i32;
        let z = (54962.53f32 * 256.0).round() as i32;
        bytes[0..4].copy_from_slice(&x.to_le_bytes());
        bytes[4..8].copy_from_slice(&(312 * 256i32).to_le_bytes());
        bytes[8..12].copy_from_slice(&z.to_le_bytes());
        bytes[0x10..0x14].copy_from_slice(&(-0.8668967f32).to_le_bytes());
        bytes[0x18..0x1c].copy_from_slice(&0.4984878f32.to_le_bytes());
        bytes[0x30..0x38].copy_from_slice(&0x075ffeb53b4b09e5u64.to_le_bytes());
        let node = map_node_of(&bytes);
        assert!((node.position[0] - 24150.95).abs() < 0.01 && (node.position[1] - 54962.53).abs() < 0.01);
        assert_eq!(node.height, 312.0);
        // The map's own reading of this node (geometry::node_forward): (0.864, -0.503).
        assert!((node.forward[0] - 0.864275).abs() < 1e-3 && (node.forward[1] + 0.5030197).abs() < 1e-3);
        assert_eq!(node.uid, 0x075ffeb53b4b09e5);
    }
}
