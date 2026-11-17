//! Patches each American Truck Simulator screen script the way the mod would, and says why one fails —
//! to find what a layout's script needs that the patcher doesn't find.
//!
//! `cargo run -p westplay-setup --example ats_patch -- "D:\SteamLibrary\steamapps\common\American Truck Simulator"`

use std::path::Path;

use westplay_mapdata::files::GameFiles;

fn main() {
    let dir = std::env::args().nth(1).expect("game dir");
    let files = GameFiles::install(Path::new(&dir)).expect("game files");

    let screens = [
        ("bronco-24", "ui/dashboard/ford_bronco_gps_24.sii", 800u32),
        ("f150-2023", "ui/dashboard/ford_f150_gps_23.sii", 800),
        ("vnl", "ui/dashboard/volvo_vnl2018_gps.sii", 768),
        ("vnl-new", "ui/dashboard/volvo_vnl2025_gps.sii", 720),
    ];
    for (layout, script, rows) in screens {
        let Ok(Some(bytes)) = files.read(script) else {
            println!("  {layout}: {script} 读不到");
            continue;
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let texture = format!("screen_{}", layout.replace('-', "_"));
        match westplay_setup::game_mod::patch_gps_script(&text, &texture, None, rows, &["100"]) {
            Ok(patched) => println!("  ✓ {layout}: 打好补丁，{} 字节 → {} 字节", text.len(), patched.len()),
            Err(why) => println!("  ✗ {layout}: {why}"),
        }
    }

    // The window screens, as `WINDOW_SCREENS` patches them.
    for (layout, script, rows) in [
        ("cascadia", "ui/dashboard/freightliner_cascadia_2024_gps.sii", 480u32),
        ("westernstar-57x", "ui/dashboard/westernstar_57x_gps.sii", 480),
    ] {
        let Ok(Some(bytes)) = files.read(script) else {
            println!("  {layout}: {script} 读不到");
            continue;
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let texture = format!("screen_{}", layout.replace('-', "_"));
        match westplay_setup::game_mod::patch_window_script(
            &text,
            &texture,
            &westplay_setup::game_mod::ShownPart { left: 0.0, right: 1.0, top: 0.0, bottom: 1.0 },
            rows,
        ) {
            Ok(patched) => println!("  ✓ {layout}（整窗）: {} 字节 → {} 字节", text.len(), patched.len()),
            Err(why) => println!("  ✗ {layout}（整窗）: {why}"),
        }
    }
}