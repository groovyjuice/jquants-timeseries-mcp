import OpenAI, {toFile} from 'openai';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'marin';
const DEFAULT_SPEED = 1.18;
const DEFAULT_INSTRUCTIONS = [
  'A woman in her twenties with a bright, cheerful, upbeat voice. Clean, polished, studio-quality narration with a clear broadcast-style sound.',
  'Speak standard Japanese clearly and neutrally.',
  'Use a slightly bright, smooth vocal tone while keeping an intelligent, trustworthy financial-news style.',
  'Keep a brisk, comfortable pace that feels a little faster than normal conversation.',
  'Keep pronunciation precise, especially for company names, numbers, and financial terms.',
  'For Japanese stock-market terminology, always pronounce 終値 as おわりね, never おわね.',
  'Always pronounce くら寿司 as くらずし, never くらすし.',
  'Always pronounce 豊和工業 as ほうわこうぎょう.',
  'Avoid breathiness, raspiness, muffled resonance, exaggerated accents, slang, childish delivery, or theatrical acting.',
  'Read the supplied text faithfully without adding commentary.',
].join(' ');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));


const PRONUNCIATION_REPLACEMENTS = [
  ['終値', 'おわりね'],
  ['くら寿司', 'くらずし'],
  ['豊和工業', 'ほうわこうぎょう'],
  ['Terra Drone', 'テラドローン'],
  ['Terra B1', 'テラ ビーワン'],
  ['Terra A1', 'テラ エーワン'],
  ['Terra A2', 'テラ エーツー'],
  ['C-UAS', 'シーユーエーエス'],
  ['UTM', 'ユーティーエム'],
  ['DEFTECH', 'デフテック'],
  ['Shahed-238', 'シャヘド にーさんはち'],
  ['Geran-3', 'ゲラン スリー'],
];

export const normalizeTtsText = (text) => {
  let normalized = String(text ?? '');
  for (const [surface, reading] of PRONUNCIATION_REPLACEMENTS) {
    normalized = normalized.split(surface).join(reading);
  }
  return normalized;
};

const splitSubtitle = (text, maxChars = 34) => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];

  const sentences = normalized
    .split(/(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      if (!current) {
        current = sentence;
      } else if ((current + sentence).length <= maxChars) {
        current += sentence;
      } else {
        pushCurrent();
        current = sentence;
      }
      continue;
    }

    pushCurrent();
    const clauses = sentence
      .split(/(?<=[、，,])/)
      .map((part) => part.trim())
      .filter(Boolean);

    let clauseBuffer = '';
    for (const clause of clauses) {
      if (!clauseBuffer) {
        clauseBuffer = clause;
      } else if ((clauseBuffer + clause).length <= maxChars) {
        clauseBuffer += clause;
      } else {
        chunks.push(clauseBuffer);
        clauseBuffer = clause;
      }
    }
    if (clauseBuffer) chunks.push(clauseBuffer);
  }

  pushCurrent();
  return chunks.length ? chunks : [normalized];
};

const alignmentUnits = (text) =>
  normalizeTtsText(text)
    .replace(/[\s。、，,.！？!?：:；;「」『』（）()\[\]【】\-ー・]/g, '')
    .length;

const buildFallbackSubtitleCues = ({
  text,
  durationSeconds,
  fps,
}) => {
  const chunks = splitSubtitle(text);
  const weights = chunks.map((chunk) => Math.max(1, alignmentUnits(chunk)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const totalFrames = Math.max(1, Math.ceil(durationSeconds * fps));

  let cursor = 0;
  return chunks.map((chunk, index) => {
    const startFrame = cursor;
    const proportionalEnd =
      index === chunks.length - 1
        ? totalFrames
        : Math.round(
            (weights.slice(0, index + 1).reduce((sum, value) => sum + value, 0) /
              totalWeight) *
              totalFrames,
          );
    const endFrame = Math.max(startFrame + 1, proportionalEnd);
    cursor = endFrame;
    return {startFrame, endFrame, text: chunk};
  });
};

const buildSubtitleCuesFromWords = ({
  text,
  words,
  durationSeconds,
  fps,
}) => {
  const chunks = splitSubtitle(text);
  if (chunks.length <= 1) {
    const firstWord = words?.find((word) => Number.isFinite(word?.start));
    const lastWord = [...(words || [])]
      .reverse()
      .find((word) => Number.isFinite(word?.end));

    return [
      {
        startFrame: Math.max(
          0,
          Math.floor((firstWord?.start ?? 0) * fps),
        ),
        endFrame: Math.max(
          1,
          Math.ceil((lastWord?.end ?? durationSeconds) * fps),
        ),
        text: chunks[0] ?? '',
      },
    ];
  }

  const validWords = (words || [])
    .filter(
      (word) =>
        Number.isFinite(word?.start) &&
        Number.isFinite(word?.end) &&
        word.end >= word.start,
    )
    .map((word) => ({
      ...word,
      units: Math.max(1, alignmentUnits(word.word || '')),
    }));

  if (validWords.length < 2) {
    return buildFallbackSubtitleCues({text, durationSeconds, fps});
  }

  const chunkUnits = chunks.map((chunk) =>
    Math.max(1, alignmentUnits(chunk)),
  );
  const totalChunkUnits = chunkUnits.reduce((sum, value) => sum + value, 0);
  const totalWordUnits = validWords.reduce(
    (sum, word) => sum + word.units,
    0,
  );

  const boundariesSeconds = [
    Math.max(0, validWords[0].start),
  ];

  let chunkCumulative = 0;
  let wordCumulative = 0;
  let wordIndex = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length - 1; chunkIndex++) {
    chunkCumulative += chunkUnits[chunkIndex];
    const targetWordUnits =
      (chunkCumulative / totalChunkUnits) * totalWordUnits;

    while (
      wordIndex < validWords.length - 1 &&
      wordCumulative + validWords[wordIndex].units < targetWordUnits
    ) {
      wordCumulative += validWords[wordIndex].units;
      wordIndex++;
    }

    const nextWord = validWords[Math.min(wordIndex + 1, validWords.length - 1)];
    const previousBoundary =
      boundariesSeconds[boundariesSeconds.length - 1];
    boundariesSeconds.push(
      Math.max(previousBoundary + 1 / fps, nextWord.start),
    );
  }

  boundariesSeconds.push(
    Math.max(
      boundariesSeconds[boundariesSeconds.length - 1] + 1 / fps,
      validWords[validWords.length - 1].end,
    ),
  );

  return chunks.map((chunk, index) => ({
    startFrame: Math.max(0, Math.floor(boundariesSeconds[index] * fps)),
    endFrame: Math.max(
      Math.floor(boundariesSeconds[index] * fps) + 1,
      Math.ceil(boundariesSeconds[index + 1] * fps),
    ),
    text: chunk,
  }));
};

const alignSubtitlesToAudio = async ({
  client,
  audioBuffer,
  displayText,
  durationSeconds,
  fps,
}) => {
  const file = await toFile(audioBuffer, 'narration.wav', {
    type: 'audio/wav',
  });

  const transcript = await client.audio.transcriptions.create({
    file,
    model: process.env.OPENAI_ALIGNMENT_MODEL || 'whisper-1',
    language: 'ja',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
    temperature: 0,
  });

  const words = Array.isArray(transcript.words) ? transcript.words : [];
  return {
    subtitleCues: buildSubtitleCuesFromWords({
      text: displayText,
      words,
      durationSeconds,
      fps,
    }),
    subtitleAlignment: words.length
      ? 'word-timestamps'
      : 'duration-fallback',
  };
};

export const getTtsConfig = ({speed, voice} = {}) => {
  const requestedSpeed = speed ?? process.env.OPENAI_TTS_SPEED ?? DEFAULT_SPEED;
  const parsedSpeed = Number(requestedSpeed);
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_TTS_MODEL || DEFAULT_MODEL,
    voice: voice || process.env.OPENAI_TTS_VOICE || DEFAULT_VOICE,
    speed: Number.isFinite(parsedSpeed) ? clamp(parsedSpeed, 0.25, 4) : DEFAULT_SPEED,
    instructions: process.env.OPENAI_TTS_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
    responseFormat: 'wav',
  };
};

const parseWav = (buffer) => {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Unexpected TTS audio format: WAV header not found');
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);

    if (id === 'fmt ' && size >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }

    if (id === 'data') {
      data = {
        start,
        size: Math.max(0, end - start),
      };
    }

    offset = start + size + (size % 2);
  }

  if (!fmt || !data || !fmt.byteRate) {
    throw new Error('Unexpected TTS WAV structure');
  }

  return {
    ...fmt,
    dataStart: data.start,
    dataSize: data.size,
    durationSeconds: data.size / fmt.byteRate,
  };
};

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  );
  return sorted[index];
};

export const buildMouthCuesFromWav = (buffer, fps = 30) => {
  const wav = parseWav(buffer);

  if (
    wav.audioFormat !== 1 ||
    wav.bitsPerSample !== 16 ||
    wav.channels < 1
  ) {
    return {
      durationSeconds: wav.durationSeconds,
      mouthCues: [],
      analysis: 'unsupported-pcm-layout',
    };
  }

  const bytesPerSample = wav.bitsPerSample / 8;
  const sampleFrames = Math.floor(wav.dataSize / wav.blockAlign);
  const videoFrames = Math.max(1, Math.ceil(wav.durationSeconds * fps));
  const rmsByFrame = [];

  for (let frame = 0; frame < videoFrames; frame++) {
    const startSampleFrame = Math.floor((frame * wav.sampleRate) / fps);
    const endSampleFrame = Math.min(
      sampleFrames,
      Math.ceil(((frame + 1) * wav.sampleRate) / fps),
    );

    let sumSquares = 0;
    let count = 0;

    for (
      let sampleFrame = startSampleFrame;
      sampleFrame < endSampleFrame;
      sampleFrame += 2
    ) {
      for (let channel = 0; channel < wav.channels; channel++) {
        const byteOffset =
          wav.dataStart +
          sampleFrame * wav.blockAlign +
          channel * bytesPerSample;

        if (byteOffset + 2 > buffer.length) break;

        const sample = buffer.readInt16LE(byteOffset) / 32768;
        sumSquares += sample * sample;
        count++;
      }
    }

    rmsByFrame.push(count > 0 ? Math.sqrt(sumSquares / count) : 0);
  }

  const active = rmsByFrame.filter((value) => value > 0.002);
  const reference = Math.max(percentile(active, 0.9), 0.015);

  const mouthCues = rmsByFrame.map((rms) => {
    const level = rms / reference;
    if (level < 0.08) return 0;
    if (level < 0.34) return 1;
    return 2;
  });

  for (let i = 1; i < mouthCues.length - 1; i++) {
    if (
      mouthCues[i] === 0 &&
      mouthCues[i - 1] > 0 &&
      mouthCues[i + 1] > 0
    ) {
      mouthCues[i] = 1;
    }
  }

  return {
    durationSeconds: wav.durationSeconds,
    mouthCues,
    analysis: 'pcm16-rms',
  };
};

export const synthesizeNarration = async ({
  text,
  outputPath,
  fps = 30,
  speed,
  voice,
}) => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('TTS text must be a non-empty string');
  }

  if (text.length > 4096) {
    throw new Error('TTS text is too long for a single speech request');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const config = getTtsConfig({speed, voice});
  const client = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

  const response = await client.audio.speech.create({
    model: config.model,
    voice: config.voice,
    input: normalizeTtsText(text.trim()),
    instructions: config.instructions,
    response_format: 'wav',
    speed: config.speed,
  });

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, audioBuffer);

  const analysis = buildMouthCuesFromWav(audioBuffer, fps);

  let subtitleCues;
  let subtitleAlignment;
  try {
    const aligned = await alignSubtitlesToAudio({
      client,
      audioBuffer,
      displayText: text.trim(),
      durationSeconds: analysis.durationSeconds,
      fps,
    });
    subtitleCues = aligned.subtitleCues;
    subtitleAlignment = aligned.subtitleAlignment;
  } catch (error) {
    console.warn(
      'Subtitle word alignment failed; falling back to duration-based cues:',
      String(error),
    );
    subtitleCues = buildFallbackSubtitleCues({
      text: text.trim(),
      durationSeconds: analysis.durationSeconds,
      fps,
    });
    subtitleAlignment = 'duration-fallback';
  }

  return {
    path: outputPath,
    bytes: audioBuffer.length,
    model: config.model,
    voice: config.voice,
    speed: config.speed,
    spokenText: normalizeTtsText(text.trim()),
    subtitleCues,
    subtitleAlignment,
    ...analysis,
  };
};

export const prepareNarratedScenes = async ({
  scenes,
  outputDir,
  publicPrefix = 'generated',
  fps = 30,
  paddingFrames = 12,
  jobId = String(Date.now()),
  ttsSpeed,
  ttsVoice,
}) => {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('scenes must be a non-empty array');
  }

  await mkdir(outputDir, {recursive: true});

  const prepared = [];
  const generatedFiles = [];
  const metrics = [];
  const synthesisResults = new Array(scenes.length);

  const requestedConcurrency = Number(
    process.env.TTS_CONCURRENCY || 4,
  );
  const concurrency = Math.max(
    1,
    Math.min(
      scenes.length,
      Number.isFinite(requestedConcurrency)
        ? Math.floor(requestedConcurrency)
        : 4,
    ),
  );

  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= scenes.length) return;

      const scene = scenes[index];
      const narration =
        typeof scene.narration === 'string' && scene.narration.trim()
          ? scene.narration
          : scene.body;

      const filename = `tts-${jobId}-${index}.wav`;
      const outputPath = path.join(outputDir, filename);
      const result = await synthesizeNarration({
        text: narration,
        outputPath,
        fps,
        speed: ttsSpeed,
        voice: ttsVoice,
      });

      synthesisResults[index] = {
        scene,
        narration,
        filename,
        outputPath,
        result,
      };
    }
  };

  await Promise.all(
    Array.from({length: concurrency}, () => worker()),
  );

  let cursor = 0;
  for (let index = 0; index < synthesisResults.length; index++) {
    const {
      scene,
      narration,
      filename,
      outputPath,
      result,
    } = synthesisResults[index];

    const minimumDuration =
      Math.ceil(result.durationSeconds * fps) + paddingFrames;
    const requestedDuration =
      typeof scene.duration === 'number' && scene.duration > 0
        ? Math.ceil(scene.duration)
        : 0;
    const duration = Math.max(1, requestedDuration, minimumDuration);

    prepared.push({
      ...scene,
      from: cursor,
      duration,
      narration,
      audioSrc: `${publicPrefix}/${filename}`,
      mouthCues: result.mouthCues,
      subtitleCues: result.subtitleCues,
    });

    metrics.push({
      index,
      durationSeconds: result.durationSeconds,
      durationFrames: duration,
      bytes: result.bytes,
      analysis: result.analysis,
      subtitleAlignment: result.subtitleAlignment,
    });

    generatedFiles.push(outputPath);
    cursor += duration;
  }

  return {
    scenes: prepared,
    generatedFiles,
    metrics,
    totalFrames: cursor,
    config: getTtsConfig({speed: ttsSpeed, voice: ttsVoice}),
  };
};
