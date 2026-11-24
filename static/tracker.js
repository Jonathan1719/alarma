const cdn = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const model = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const handModel = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const visible = point => point && point.visibility >= 0.55;
const clamp = value => Math.max(0, Math.min(1, value));
const threatPhrases = [
  /\bte voy a (?:matar|golpear|pegar|hacer dano|lastimar|apu[nñ]alar|disparar|romper)\b/,
  /\bte (?:mato|golpeo|pego)\b/,
  /\bte voy a dar (?:un tiro|una golpiza)\b/,
  /\bvas a arrepentirte\b/,
];

export async function loadTracker() {
  const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import(cdn + '/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(cdn + '/wasm');
  const pose = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: model, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 3,
  });
  try {
    const hands = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: handModel, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 6,
    });
    return {pose, hands};
  } catch (error) {
    pose.close();
    throw error;
  }
}

export function posesToTracks(poses, previous, elapsed) {
  return poses.flatMap(pose => {
    const shoulders = [pose[11], pose[12]];
    const points = pose.filter(visible);
    if (!shoulders.every(visible) || points.length < 6) return [];
    const [left, right] = shoulders;
    const center = {x: (left.x + right.x) / 2, y: (left.y + right.y) / 2};
    const scale = Math.max(0.09, distance(left, right));
    const nearest = previous.reduce((best, track) =>
      !best || distance(center, track.center) < distance(center, best.center) ? track : best, null);
    const prior = nearest && distance(nearest.center, center) < scale * 0.8 ? nearest : null;
    const wrists = [pose[15], pose[16]].map(wrist =>
      wrist && Number.isFinite(wrist.x) && Number.isFinite(wrist.y) ? wrist : null);
    const elbows = [pose[13], pose[14]].map(elbow =>
      elbow && Number.isFinite(elbow.x) && Number.isFinite(elbow.y) ? elbow : null);
    const speed = wrists.map((wrist, index) => {
      const old = prior?.wrists[index];
      if (!old || !wrist || elapsed < 0.04 || elapsed > 0.5) return 0;
      return Math.hypot(wrist.x - old.x - center.x + prior.center.x,
                        wrist.y - old.y - center.y + prior.center.y) / scale / elapsed;
    });
    return [{
      center, wrists, elbows, speed, scale,
      box: {
        left: clamp(Math.min(...points.map(p => p.x)) - 0.045),
        top: clamp(Math.min(...points.map(p => p.y)) - 0.045),
        right: clamp(Math.max(...points.map(p => p.x)) + 0.045),
        bottom: clamp(Math.max(...points.map(p => p.y)) + 0.045),
      },
    }];
  });
}

export function possibleIncident(tracks) {
  return tracks.some((track, index) => track.wrists.some((wrist, hand) =>
    wrist && track.speed[hand] > 3.5 && tracks.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const paddingX = other.scale * 0.2;
      const paddingY = other.scale * 0.25;
      return wrist.x >= other.box.left - paddingX && wrist.x <= other.box.right + paddingX &&
        wrist.y >= other.box.top - paddingY && wrist.y <= other.box.bottom + paddingY;
    })));
}

export function containsThreatPhrase(transcript) {
  const text = transcript.toLocaleLowerCase('es-EC').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  if (/\b(?:no|nunca|jamas)\b.{0,24}\b(?:te voy a|te (?:mato|golpeo|pego))\b/.test(text)) {
    return false;
  }
  return threatPhrases.some(pattern => pattern.test(text));
}

export function handsToBoxes(hands, previous = []) {
  const boxes = hands.map(points => {
    if (!points.length) return null;
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const paddingX = (maxX - minX) * 0.06;
    const paddingY = (maxY - minY) * 0.06;
    const box = {
      left: clamp(minX - paddingX),
      top: clamp(minY - paddingY),
      right: clamp(maxX + paddingX),
      bottom: clamp(maxY + paddingY),
    };
    return box;
  }).filter(Boolean);
  const pairs = [];
  boxes.forEach((box, boxIndex) => {
    const center = {x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2};
    previous.forEach((old, oldIndex) => {
      if ((old.missed || 0) > 1) return;
      const oldCenter = {x: (old.left + old.right) / 2, y: (old.top + old.bottom) / 2};
      pairs.push({boxIndex, oldIndex, distance: distance(center, oldCenter)});
    });
  });
  pairs.sort((a, b) => a.distance - b.distance);
  const matchedBoxes = new Set(), matchedPrevious = new Set(), matches = new Map();
  for (const pair of pairs) {
    if (pair.distance > 0.24 || matchedBoxes.has(pair.boxIndex) ||
        matchedPrevious.has(pair.oldIndex)) continue;
    matchedBoxes.add(pair.boxIndex);
    matchedPrevious.add(pair.oldIndex);
    matches.set(pair.boxIndex, {box: previous[pair.oldIndex], distance: pair.distance});
  }
  const tracked = boxes.map((box, index) => {
    const match = matches.get(index);
    if (!match) return {...box, missed: 0};
    const blend = match.distance > 0.08 ? 0.8 : 0.55;
    return {
      left: match.box.left * (1 - blend) + box.left * blend,
      top: match.box.top * (1 - blend) + box.top * blend,
      right: match.box.right * (1 - blend) + box.right * blend,
      bottom: match.box.bottom * (1 - blend) + box.bottom * blend,
      missed: 0,
    };
  });
  previous.forEach((box, index) => {
    if (!matchedPrevious.has(index) && (box.missed || 0) < 1) {
      tracked.push({...box, missed: (box.missed || 0) + 1});
    }
  });
  return tracked;
}

export function drawBoxes(ctx, boxes, red = false) {
  const {width, height} = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  boxes.forEach(({left, top, right, bottom}) => {
    const x = width * left, y = height * top;
    const w = width * (right - left), h = height * (bottom - top);
    ctx.lineWidth = Math.max(3, width / 200);
    ctx.strokeStyle = red ? '#ff405b' : '#4be9cc';
    ctx.fillStyle = red ? '#ed183c44' : '#28dabe17';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  });
}
