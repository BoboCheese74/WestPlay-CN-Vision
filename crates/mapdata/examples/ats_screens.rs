//! Lists the American Truck Simulator screens the WestPlay mod would patch, and where each vehicle's
//! interiors point for their GPS page — to find the script a layout must name.
//!
//! `cargo run -p westplay-mapdata --example ats_screens -- "D:\SteamLibrary\steamapps\common\American Truck Simulator"`

use std::path::Path;

use westplay_mapdata::files::GameFiles;

fn main() {
    let dir = std::env::args().nth(1).expect("game dir");
    let files = GameFiles::install(Path::new(&dir)).expect("game files");

    // The scripts the DLCs' interiors name, as `ui/dashboard/...`.
    let vehicles = [
        "ford.bronco_24",
        "ford.f150_23",
        "volvo.vnl2018",
        "volvo.vnl2025",
        "freightliner.cascadia2024",
        "westernstar.57x",
    ];
    for vehicle in vehicles {
        println!("\n=== {vehicle} ===");
        let dir = format!("def/vehicle/truck/{vehicle}/interior");
        let Ok(entries) = files.list(&dir) else {
            println!("  (no interior folder)");
            continue;
        };
        if entries.is_empty() {
            println!("  (no interior folder)");
            continue;
        }
        let mut pages: Vec<String> = Vec::new();
        for entry in entries {
            let path = format!("{dir}/{entry}");
            let Ok(Some(bytes)) = files.read(&path) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                let line = line.trim();
                if line.contains("gps_path") || line.contains("computer") || line.contains("display") {
                    pages.push(format!("    {entry}: {line}"));
                }
            }
        }
        pages.sort();
        pages.dedup();
        for page in pages.iter().take(12) {
            println!("{page}");
        }
        if pages.is_empty() {
            println!("  (no gps_path)");
        }
    }

    // What `ui/dashboard` holds with these names, as the mod would find them.
    println!("\n=== ui/dashboard scripts the layouts name ===");
    let wanted = [
        "ui/dashboard/ford_bronco_gps_24.sii",
        "ui/dashboard/ford_f150_gps_23.sii",
        "ui/dashboard/volvo_vnl2018_gps.sii",
        "ui/dashboard/volvo_vnl2025_gps.sii",
        "ui/dashboard/freightliner_cascadia_2024_gps.sii",
        "ui/dashboard/westernstar_57x_gps.sii",
    ];
    for path in wanted {
        let found = matches!(files.read(path), Ok(Some(_)));
        println!("  {} {path}", if found { "✓" } else { "✗" });
    }

    // Each ATS layout's script: the group ids it holds, and whether it's the whole window.
    println!("\n=== group ids in the ATS scripts ===");
    for path in [
        "ui/dashboard/ford_bronco_gps_24.sii",
        "ui/dashboard/ford_f150_gps_23.sii",
        "ui/dashboard/volvo_vnl2018_gps.sii",
        "ui/dashboard/volvo_vnl2025_gps.sii",
        "ui/dashboard/freightliner_cascadia_2024_gps.sii",
        "ui/dashboard/westernstar_57x_gps.sii",
    ] {
        let Ok(Some(bytes)) = files.read(path) else { println!("  {path}: not read"); continue };
        let text = String::from_utf8_lossy(&bytes);
        let ids: Vec<&str> = text.lines().filter_map(|l| {
            let l = l.trim();
            l.strip_prefix("id:").map(|rest| rest.trim())
        }).collect();
        let kinds: Vec<&str> = text.lines().filter_map(|l| {
            let l = l.trim();
            l.strip_prefix("type:").map(|rest| rest.trim())
        }).collect();
        println!("  {path}");
        println!("    ids: {ids:?}");
        println!("    types: {types}", types = format!("{:?}", kinds.iter().take(6).collect::<Vec<_>>()));
    }
}
