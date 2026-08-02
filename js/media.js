/**
 * Media preparation.
 *
 * Phone photos are 3-12 MB each and phone videos are far larger than Gemini's
 * inline request cap, so nothing is sent as-is. Images are downscaled and
 * re-encoded as JPEG; videos are reduced to a handful of representative
 * still frames sampled across their duration.
 */

import { MEDIA } from './config.js';

/** @typedef {{id:string, kind:'image'|'video', name:string, mimeType:string, dataB64:string, previewUrl:string, note:string}} Asset */

let seq = 0;
const nextId = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

const isImage = (file) => file.type.startsWith('image/');
const isVideo = (file) => file.type.startsWith('video/');

/**
 * Decode a file to a bitmap, honouring EXIF orientation so portrait photos
 * from a phone do not come out sideways.
 */
async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitWithin(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToJpegB64(canvas) {
  // Strip the "data:image/jpeg;base64," prefix — Gemini wants raw base64.
  return canvas.toDataURL('image/jpeg', MEDIA.jpegQuality).split(',')[1];
}

function drawToCanvas(source, width, height) {
  const { w, h } = fitWithin(width, height, MEDIA.maxEdgePx);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/** Compress a single image file into an Asset. */
async function prepareImage(file) {
  const bitmap = await decodeImage(file);
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const canvas = drawToCanvas(bitmap, width, height);
  if (bitmap.close) bitmap.close();

  const dataB64 = canvasToJpegB64(canvas);
  return {
    id: nextId(),
    kind: 'image',
    name: file.name || 'photo.jpg',
    mimeType: 'image/jpeg',
    dataB64,
    previewUrl: canvas.toDataURL('image/jpeg', 0.6),
    note: '',
  };
}

/**
 * Pull still frames out of a video.
 *
 * Seeking is done one frame at a time because browsers fire `seeked` per
 * request and parallel seeks on a single element clobber each other.
 */
async function prepareVideo(file, onProgress) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(new Error(`Could not read the video ${file.name}.`));
      video.onloadedmetadata = () => resolve();
      video.onerror = fail;
      video.src = url;
    });

    // Some browsers report Infinity for blob durations until they seek.
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = await new Promise((resolve) => {
        video.onseeked = () => resolve(Number.isFinite(video.duration) ? video.duration : 0);
        video.currentTime = 1e6;
      });
      video.onseeked = null;
    }

    const count = MEDIA.videoFrames;
    // Sample inside the clip rather than at the very edges; first and last
    // frames are usually a blurry hand or a pointed-at-the-floor shot.
    const timestamps = Array.from({ length: count }, (_, i) =>
      duration > 0 ? ((i + 0.5) / count) * duration : 0,
    );

    const frames = [];
    for (const [index, time] of timestamps.entries()) {
      await new Promise((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('Video seeking failed.'));
        video.currentTime = Math.min(time, Math.max(0, duration - 0.05));
      });
      // Give the compositor a beat to paint the seeked frame before reading it.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const canvas = drawToCanvas(video, video.videoWidth, video.videoHeight);
      frames.push({
        id: nextId(),
        kind: 'video',
        name: `${file.name} — frame ${index + 1}/${count}`,
        mimeType: 'image/jpeg',
        dataB64: canvasToJpegB64(canvas),
        previewUrl: canvas.toDataURL('image/jpeg', 0.6),
        note: `Still frame captured ${time.toFixed(1)}s into a video walkaround.`,
      });
      onProgress?.(index + 1, count);
    }
    video.onseeked = null;
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

/**
 * Turn a FileList into Assets ready for Gemini.
 * @returns {Promise<{assets: Asset[], errors: string[]}>}
 */
export async function prepareFiles(files, onProgress) {
  const list = Array.from(files);
  const assets = [];
  const errors = [];

  for (const [index, file] of list.entries()) {
    onProgress?.(`Processing ${file.name} (${index + 1} of ${list.length})…`);
    try {
      if (isImage(file)) {
        assets.push(await prepareImage(file));
      } else if (isVideo(file)) {
        const frames = await prepareVideo(file, (done, total) =>
          onProgress?.(`Extracting frame ${done} of ${total} from ${file.name}…`),
        );
        assets.push(...frames);
      } else {
        errors.push(`${file.name}: unsupported file type.`);
      }
    } catch (err) {
      const heic = /\.hei[cf]$/i.test(file.name);
      errors.push(
        heic
          ? `${file.name}: this browser cannot read HEIC. On iPhone set Settings > Camera > Formats to "Most Compatible", or share the photo instead of picking the raw file.`
          : `${file.name}: ${err.message}`,
      );
    }
  }

  return { assets, errors };
}

export { isImage, isVideo };
