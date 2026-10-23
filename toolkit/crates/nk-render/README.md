# nk-render

CPU painting for the shared nk-text Layout and nk-icons shapes. No text shaping,
font discovery, Wayland hosting or application logic lives here.

Raster::from_rgba validates dimensions and straight RGBA8 bytes, converting once
to the CPU engine's retained premultiplied pixmap. Canvas::image fits it into a
logical destination with explicit Contain/Cover, alpha and clipping. File IO,
decoding and work cancellation belong to application builders, outside paint.
