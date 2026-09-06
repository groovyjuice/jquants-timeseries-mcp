import {readFile, writeFile} from 'node:fs/promises';

const [inputPath, indexRaw, countRaw, outputPath] = process.argv.slice(2);
if (!inputPath || !indexRaw || !countRaw || !outputPath) {
  throw new Error(
    'Usage: node segment-props.mjs <props.json> <segmentIndex0> <segmentCount> <output.json>',
  );
}

const segmentIndex = Number(indexRaw);
const segmentCount = Number(countRaw);
if (
  !Number.isInteger(segmentIndex) ||
  !Number.isInteger(segmentCount) ||
  segmentIndex < 0 ||
  segmentCount < 1 ||
  segmentIndex >= segmentCount
) {
  throw new Error('Invalid segment index/count');
}

const props = JSON.parse(await readFile(inputPath, 'utf8'));
const scenes = Array.isArray(props.scenes) ? props.scenes : [];
if (!scenes.length) throw new Error('props.scenes is empty');

const totalFrames = scenes.reduce(
  (sum, scene) => sum + Math.max(1, Number(scene.duration) || 1),
  0,
);

const boundaries = [0];
let cursor = 0;
let accumulated = 0;

for (let segment = 1; segment < segmentCount; segment++) {
  const threshold = (totalFrames * segment) / segmentCount;

  while (cursor < scenes.length) {
    const duration = Math.max(1, Number(scenes[cursor].duration) || 1);
    const nextAccumulated = accumulated + duration;
    const scenesLeft = scenes.length - (cursor + 1);
    const segmentsLeft = segmentCount - segment;

    if (
      cursor > boundaries[boundaries.length - 1] &&
      nextAccumulated > threshold &&
      scenesLeft >= segmentsLeft
    ) {
      break;
    }

    accumulated = nextAccumulated;
    cursor += 1;

    if (scenesLeft < segmentsLeft) break;
  }

  boundaries.push(cursor);
}

boundaries.push(scenes.length);

const start = boundaries[segmentIndex];
const end = boundaries[segmentIndex + 1];
const selected = scenes.slice(start, end);

if (!selected.length) {
  throw new Error(
    `Segment ${segmentIndex + 1}/${segmentCount} is empty (start=${start}, end=${end})`,
  );
}

let from = 0;
const rebased = selected.map((scene) => {
  const duration = Math.max(1, Number(scene.duration) || 1);
  const next = {...scene, from, duration};
  from += duration;
  return next;
});

const output = {
  ...props,
  scenes: rebased,
  bgmVolume: 0,
  bgmFadeInFrames: 0,
  bgmFadeOutFrames: 0,
};

await writeFile(outputPath, JSON.stringify(output), 'utf8');

console.log(
  JSON.stringify({
    segment: segmentIndex + 1,
    segmentCount,
    startScene: start + 1,
    endScene: end,
    sceneCount: selected.length,
    frames: from,
    seconds: from / 30,
  }),
);
