// Hand-built JPEG byte streams. They are structurally valid (SOI, JFIF, SOF0, SOS, EOI) which is
// all the server inspects; it never decodes pixels.

function segment(marker, payload) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}

function sof0(width, height) {
  const p = Buffer.alloc(15);
  p[0] = 8; p.writeUInt16BE(height, 1); p.writeUInt16BE(width, 3); p[5] = 3;
  p.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
  return segment(0xc0, p);
}

const jfif = segment(0xe0, Buffer.from('4a46494600010100000100010000', 'hex'));
const sos = segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));

/** Little-endian TIFF block with IFD0 containing Make ("Apple"). */
function exifWithMake() {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 6);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x010f, 10); tiff.writeUInt16LE(2, 12); tiff.writeUInt32LE(6, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.write('Apple\0', 26, 'latin1');
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

export function liveFrameJpeg(width = 1920, height = 1080, salt = 0) {
  const scan = Buffer.alloc(256, salt & 0xff);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, sof0(width, height), sos, scan, Buffer.from([0xff, 0xd9])]);
}

export function galleryPhotoJpeg(width = 4032, height = 3024) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exifWithMake(), jfif, sof0(width, height), sos, Buffer.alloc(256, 7), Buffer.from([0xff, 0xd9])]);
}

export const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
