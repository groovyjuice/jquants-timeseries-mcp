import OpenAI from 'openai';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'sage';
const DEFAULT_SPEED = 1.08;
const DEFAULT_INSTRUCTIONS = [
  'Friendly, calm, and natural.',
  'Speak standard Japanese clearly and neutrally.',
  'Use a warm, approachable tone suitable for a financial-news explainer.',
  'Keep a slightly brisk but comfortable pace.',
  'Keep pronunciation precise, especially for company names, numbers, and financial terms.',
  'Avoid exaggerated accents, slang, or theatrical delivery.',
  'Read the supplied text faithfully without adding commentary.',
].join(' ');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const getTtsConfig = () => {
  const parsedSpeed = Number(process.env.OPENAI_TTS_SPEED || DEFAULT_SPEED);
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_TTS_MODEL || DEFAULT_MODEL,
    voice: process.env.OPENAI_TTS_VOICE || DEFAULT_VOICE,
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

    for (let sampleFrame = startSampleFrame; sampleFrame < endSampleFrame; sampleFrame += 2) {
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

  // Reduce one-frame chatter without making the mouth feel sluggish.
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

  const config = getTtsConfig();
  const client = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

  const response = await client.audio.speech.create({
    model: config.model,
    voice: config.voice,
    input: text.trim(),
    instructions: config.instructions,
    response_format: 'wav',
    speed: config.speed,
  });

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, audioBuffer);

  const analysis = buildMouthCuesFromWav(audioBuffer, fps);

  return {
    path: outputPath,
    bytes: audioBuffer.length,
    model: config.model,
    voice: config.voice,
    speed: config.speed,
    ...analysis,
  };
};
