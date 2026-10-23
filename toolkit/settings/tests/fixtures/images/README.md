# Decoder fixtures

Generated locally with ffmpeg lavfi color, 16x8, one frame: PNG red, JPEG lime,
GIF blue, WebP yellow, AVIF magenta (libaom-av1, cpu-used8, still-picture1).
rotated.jpg is sample.jpg with an Exif TIFF Orientation=6 APP1 header.
These are synthetic codec fixtures, not captures or native UI evidence.
Regeneration command: ffmpeg -f lavfi -i color=c=COLOR:s=16x8:d=1 -frames:v 1 sample.EXT
AVIF adds -c:v libaom-av1 -cpu-used 8 -still-picture 1. Tests need only checked-in
fixtures and codecs; ffmpeg is not a new toolkit-test runtime dependency.
