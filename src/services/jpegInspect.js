/**
 * Minimal JPEG inspection for Stage 4 uploads. We never decode pixels here; we only:
 *   - confirm the bytes are a complete baseline/progressive JPEG,
 *   - read its dimensions from the SOF marker,
 *   - detect camera-origin EXIF metadata.
 *
 * A frame drawn from a live <video> onto a <canvas> and encoded with canvas.toBlob() carries
 * no camera EXIF (no Make/Model/DateTimeOriginal/GPS). A photo taken earlier with the phone's
 * camera app and picked from the gallery almost always does. Rejecting camera EXIF therefore
 * blocks the most common "re-use an old photo" path. It is a defence-in-depth heuristic, not proof:
 * a determined attacker can strip metadata.
 */

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// TIFF tags that only a camera / photo app writes.
const CAMERA_TAGS_IFD0 = new Map([
  [0x010f, 'Make'],
  [0x0110, 'Model'],
  [0x8825, 'GPSInfo'],
]);
const CAMERA_TAGS_EXIF = new Map([
  [0x9003, 'DateTimeOriginal'],
  [0x9004, 'DateTimeDigitized'],
  [0x829a, 'ExposureTime'],
  [0x829d, 'FNumber'],
  [0x8827, 'ISOSpeedRatings'],
  [0x920a, 'FocalLength'],
  [0xa434, 'LensModel'],
]);

export function inspectJpeg(buf) {
  const result = { valid: false, width: 0, height: 0, cameraExifTags: [], reason: null };
  if (!Buffer.isBuffer(buf) || buf.length < 4) return { ...result, reason: 'empty' };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return { ...result, reason: 'not_jpeg' };

  let off = 2;
  let sawSos = false;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return { ...result, reason: 'corrupt_marker' };
    const marker = buf[off + 1];
    if (marker === 0xff) { off += 1; continue; } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) return { ...result, reason: 'truncated_segment' };
    const seg = buf.subarray(off + 4, off + 2 + len);

    if (marker === 0xe1 && seg.length > 6 && seg.toString('latin1', 0, 6) === 'Exif\0\0') {
      result.cameraExifTags.push(...findCameraTags(seg.subarray(6)));
    } else if (SOF_MARKERS.has(marker) && seg.length >= 5) {
      result.height = seg.readUInt16BE(1);
      result.width = seg.readUInt16BE(3);
    } else if (marker === 0xda) {
      sawSos = true;
      break;
    }
    off += 2 + len;
  }
  if (!sawSos) return { ...result, reason: 'no_scan_data' };
  if (!result.width || !result.height) return { ...result, reason: 'no_dimensions' };
  // A complete file ends with EOI (allow a little trailing padding).
  const tail = buf.subarray(Math.max(0, buf.length - 32));
  if (tail.indexOf(Buffer.from([0xff, 0xd9])) === -1) return { ...result, reason: 'missing_eoi' };
  result.valid = true;
  return result;
}

function findCameraTags(tiff) {
  const found = [];
  try {
    if (tiff.length < 8) return found;
    const order = tiff.toString('latin1', 0, 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return found;
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const readIfd = (ifdOff, tagMap) => {
      const pointers = {};
      if (ifdOff + 2 > tiff.length) return pointers;
      const count = Math.min(u16(ifdOff), 512);
      for (let i = 0; i < count; i++) {
        const e = ifdOff + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        const tag = u16(e);
        if (tagMap.has(tag)) found.push(tagMap.get(tag));
        if (tag === 0x8769) pointers.exif = u32(e + 8);
      }
      return pointers;
    };
    const p = readIfd(u32(4), CAMERA_TAGS_IFD0);
    if (p.exif) readIfd(p.exif, CAMERA_TAGS_EXIF);
  } catch {
    found.push('UnparseableExif');
  }
  return found;
}
