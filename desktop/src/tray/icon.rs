use tray_icon::Icon;

/// Calculate the shortest distance from a point to a line segment for antialiased vector drawing.
fn dist_to_segment(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    if len_sq == 0.0 {
        return ((px - ax).powi(2) + (py - ay).powi(2)).sqrt();
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / len_sq).clamp(0.0, 1.0);
    let proj_x = ax + t * dx;
    let proj_y = ay + t * dy;
    ((px - proj_x).powi(2) + (py - proj_y).powi(2)).sqrt()
}

/// Generate the high-resolution 44x44 Retina Yomi geometric icon.
/// Design concept:
/// - Body: a streamlined geometric Y representing message flow and the end-to-end channel.
/// - Detail: a small upper-right status indicator for connected, syncing, or offline state.
pub fn create_tray_icon(connected: bool, syncing: bool) -> Icon {
    let width: u32 = 44;
    let height: u32 = 44;
    let mut rgba = vec![0u8; (width * height * 4) as usize];

    let stroke_radius = 2.4; // Stroke radius, approximately 4.8 px wide.

    // Define the Y skeleton endpoints on the 44x44 canvas.
    let left_top = (11.0, 11.0);
    let right_top = (33.0, 11.0);
    let center = (22.0, 23.0);
    let bottom = (22.0, 36.0);

    // Define status-dot position and radius.
    let status_dot_pos = (35.5, 9.5);
    let status_dot_radius = 3.5;

    // Select the status-dot color.
    let status_color = if syncing {
        Some((245, 158, 11)) // Amber #F59E0B while syncing.
    } else if connected {
        Some((16, 185, 129)) // Emerald #10B981 while connected.
    } else {
        None // Keep the icon dot-free while offline.
    };

    // Use clean, high-contrast white or silver-gray for the Y body.
    let glyph_color = if connected {
        (248, 250, 252) // #F8FAFC
    } else {
        (148, 163, 184) // #94A3B8 matte metallic gray while disconnected.
    };

    for y in 0..height {
        for x in 0..width {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let idx = ((y * width + x) * 4) as usize;

            // 1. Calculate distance to each of the three Y strokes.
            let d1 = dist_to_segment(px, py, left_top.0, left_top.1, center.0, center.1);
            let d2 = dist_to_segment(px, py, right_top.0, right_top.1, center.0, center.1);
            let d3 = dist_to_segment(px, py, center.0, center.1, bottom.0, bottom.1);
            let min_d_glyph = d1.min(d2).min(d3);

            // 2. Calculate distance to the status dot.
            let d_dot = ((px - status_dot_pos.0).powi(2) + (py - status_dot_pos.1).powi(2)).sqrt();

            // Draw the status dot at the highest visual priority.
            if let Some(s_color) = status_color {
                if d_dot < status_dot_radius + 1.0 {
                    let alpha = if d_dot <= status_dot_radius - 0.5 {
                        255.0
                    } else {
                        ((status_dot_radius + 1.0 - d_dot) / 1.5 * 255.0).clamp(0.0, 255.0)
                    } as u8;

                    if alpha > 0 {
                        rgba[idx] = s_color.0;
                        rgba[idx + 1] = s_color.1;
                        rgba[idx + 2] = s_color.2;
                        rgba[idx + 3] = alpha;
                        continue;
                    }
                }
            }

            // Draw the Y body with subpixel-antialiased edges.
            if min_d_glyph < stroke_radius + 1.0 {
                let alpha = if min_d_glyph <= stroke_radius - 0.5 {
                    255.0
                } else {
                    ((stroke_radius + 1.0 - min_d_glyph) / 1.5 * 255.0).clamp(0.0, 255.0)
                } as u8;

                if alpha > 0 {
                    rgba[idx] = glyph_color.0;
                    rgba[idx + 1] = glyph_color.1;
                    rgba[idx + 2] = glyph_color.2;
                    rgba[idx + 3] = alpha;
                }
            }
        }
    }

    Icon::from_rgba(rgba, width, height).expect("Failed to create high-res Yomi tray icon")
}
