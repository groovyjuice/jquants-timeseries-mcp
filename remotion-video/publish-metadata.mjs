import OpenAI from 'openai';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const CHANNEL_BOILERPLATE = `ようこそ「賢明なる投資家チャンネル」へ。
このチャンネルは、日々のマーケットニュースをコンパクトにまとめ、落ち着いて判断したい個人投資家の皆さまにお届けする投資情報チャンネルです。
株式・為替・コモディティ（原油や金などの資源）・暗号資産まで、国内外の気になるトピックを
・重要ポイントだけをピックアップ
・なぜそのニュースが相場に影響するのか
・投資家がチェックしておきたい視点はどこか
といった形で、できるだけわかりやすく整理して解説していきます。

短期の値動きに振り回されるのではなく、「賢明な投資家」として長期視点で市場を眺められるような、冷静で実務的なニュースウォッチを目指しています。スキマ時間のインプットや、毎日の相場チェックの入り口としてご活用ください。

【関連リンク】
◆公式ブログ「賢明なる投資家チャンネル」
https://kenmeitoushika.com/

◆X（旧Twitter）公式アカウント
https://x.com/kenmei_toushika

※本チャンネルの内容は情報提供のみを目的としており、特定の銘柄・金融商品の売買を推奨するものではありません。投資判断は必ずご自身の判断と責任にてお願いいたします。
※本チャンネルでは、AIツールを最大限活用しながら、最新情報をわかりやすくお届けできるよう工夫しています。`;

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title_candidates: {
      type: 'array',
      minItems: 10,
      maxItems: 10,
      items: {type: 'string'},
    },
    description_intro: {type: 'string'},
    tags: {
      type: 'array',
      minItems: 10,
      maxItems: 30,
      items: {type: 'string'},
    },
    x_post_body: {type: 'string'},
  },
  required: [
    'title_candidates',
    'description_intro',
    'tags',
    'x_post_body',
  ],
};

const compactSource = (plan) => {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const title =
    plan?.video_title ||
    plan?.title ||
    slides[0]?.display_title ||
    slides[0]?.headline ||
    '';

  const narration = slides
    .map((slide) => slide?.narration || slide?.source_text || '')
    .filter(Boolean)
    .join('\n');

  return [
    title ? `動画テーマ: ${title}` : '',
    narration ? `動画ナレーション:\n${narration}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
};

const xEstimatedLength = (body) => {
  const placeholder = '[動画URL]';
  const text = `${body.trim()}\n${placeholder}`;
  // X shortens HTTP(S) URLs. Reserve 23 characters for the eventual video URL.
  return Array.from(text.replace(placeholder, 'x'.repeat(23))).length;
};

const normalizeSecurityCode = (plan) => {
  const raw =
    plan?.security_code ??
    plan?.stock_code ??
    plan?.ticker_code ??
    plan?.code ??
    null;

  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  if (!text) return null;

  // Japanese listed-equity codes are represented here as 4 digits.
  // Do not synthesize codes for crypto, FX, commodities, indices, etc.
  return /^\d{4}$/.test(text) ? text : null;
};

const ensureRequiredTags = ({tags, plan}) => {
  const required = ['賢明なる投資家チャンネル'];
  const securityCode = normalizeSecurityCode(plan);
  if (securityCode) required.push(securityCode);

  const merged = [
    ...required,
    ...(Array.isArray(tags) ? tags : []),
  ]
    .map((value) => String(value || '').trim().replace(/^#+/, ''))
    .filter(Boolean);

  return [...new Set(merged)].slice(0, 30);
};

const validate = (data) => {
  if (!Array.isArray(data.title_candidates) || data.title_candidates.length !== 10) {
    throw new Error('metadata must contain exactly 10 title candidates');
  }

  const titles = data.title_candidates.map((value) => String(value).trim());
  if (new Set(titles).size !== 10) {
    throw new Error('title candidates must be unique');
  }

  const tags = [...new Set((data.tags || []).map((value) => String(value).trim()).filter(Boolean))];
  if (tags.length < 10) {
    throw new Error('metadata must contain at least 10 unique tags');
  }

  const xBody = String(data.x_post_body || '').trim();
  if (!xBody) throw new Error('x_post_body must not be empty');

  const estimatedLength = xEstimatedLength(xBody);
  if (estimatedLength > 140) {
    throw new Error(
      `X post exceeds 140 characters including reserved video URL: ${estimatedLength}`,
    );
  }

  return {
    title_candidates: titles,
    description_intro: String(data.description_intro || '').trim(),
    tags,
    x_post_body: xBody,
    x_estimated_length_with_url: estimatedLength,
  };
};


const formatChapterTimestamp = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const cleanChapterTitle = (value, fallback = 'セクション') => {
  const title = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return (title || fallback).slice(0, 80);
};

export const buildVideoChapters = ({
  plan,
  scenes,
  fps = 30,
  totalFrames,
}) => {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const timedScenes = Array.isArray(scenes) ? scenes : [];
  if (!slides.length || !timedScenes.length) return [];

  const durationFrames =
    Number.isFinite(totalFrames) && totalFrames > 0
      ? totalFrames
      : timedScenes.reduce(
          (max, scene) =>
            Math.max(
              max,
              Number(scene?.from || 0) + Number(scene?.duration || 0),
            ),
          0,
        );
  const totalSeconds = durationFrames / fps;

  const candidates = [
    {
      index: 0,
      seconds: 0,
      title: 'オープニング',
      kind: 'opening',
    },
  ];

  const sectionTitleIndexes = slides
    .map((slide, index) => ({slide, index}))
    .filter(({slide}) => slide?.type === 'section_title');

  if (sectionTitleIndexes.length) {
    for (const {slide, index} of sectionTitleIndexes) {
      if (index === 0 || !timedScenes[index]) continue;
      candidates.push({
        index,
        seconds: Number(timedScenes[index].from || 0) / fps,
        title: cleanChapterTitle(
          slide.section || slide.display_title || slide.headline,
        ),
        kind: 'section',
      });
    }
  } else {
    let previousSection = '';
    for (let index = 0; index < slides.length; index++) {
      const slide = slides[index];
      const section = String(slide?.section || '').trim();
      if (!section || section === previousSection || !timedScenes[index]) {
        if (section) previousSection = section;
        continue;
      }
      previousSection = section;
      if (index === 0) continue;
      candidates.push({
        index,
        seconds: Number(timedScenes[index].from || 0) / fps,
        title: cleanChapterTitle(section),
        kind: 'section',
      });
    }
  }

  candidates.sort((a, b) => a.seconds - b.seconds);

  const chapters = [];
  for (const candidate of candidates) {
    if (!chapters.length) {
      chapters.push({...candidate, seconds: 0});
      continue;
    }

    const previous = chapters[chapters.length - 1];
    if (candidate.seconds - previous.seconds < 10) continue;
    if (totalSeconds - candidate.seconds < 10) continue;

    const duplicateTitle = chapters.some(
      (chapter) => chapter.title === candidate.title,
    );
    if (duplicateTitle) continue;

    chapters.push(candidate);
  }

  return chapters.map((chapter) => ({
    seconds: Math.floor(chapter.seconds),
    timestamp: formatChapterTimestamp(chapter.seconds),
    title: chapter.title,
    slide_index: chapter.index,
    kind: chapter.kind,
  }));
};

const writePublishFiles = async ({outputDir, metadata}) => {
  if (!outputDir) return;

  await mkdir(outputDir, {recursive: true});
  await Promise.all([
    writeFile(
      path.join(outputDir, 'publish_metadata.json'),
      JSON.stringify(metadata, null, 2) + '\n',
      'utf8',
    ),
    writeFile(
      path.join(outputDir, 'titles.txt'),
      metadata.title_candidates
        .map((title, index) => `${index + 1}. ${title}`)
        .join('\n') + '\n',
      'utf8',
    ),
    writeFile(
      path.join(outputDir, 'description.txt'),
      metadata.description + '\n',
      'utf8',
    ),
    writeFile(
      path.join(outputDir, 'tags.txt'),
      metadata.tags.join(', ') + '\n',
      'utf8',
    ),
    writeFile(
      path.join(outputDir, 'x_post.txt'),
      metadata.x_post + '\n',
      'utf8',
    ),
  ]);
};

export const applyChaptersToPublishMetadata = async ({
  metadata,
  plan,
  scenes,
  fps = 30,
  totalFrames,
  outputDir,
}) => {
  const chapters = buildVideoChapters({
    plan,
    scenes,
    fps,
    totalFrames,
  });

  const chapterText = chapters
    .map((chapter) => `${chapter.timestamp} ${chapter.title}`)
    .join('\n');

  const descriptionParts = [
    metadata.description_intro,
  ];

  if (chapters.length >= 3) {
    descriptionParts.push('', '【目次】', chapterText);
  }

  descriptionParts.push('', CHANNEL_BOILERPLATE);

  const finalized = {
    ...metadata,
    chapters,
    chapters_enabled: chapters.length >= 3,
    description: descriptionParts.join('\n'),
  };

  await writePublishFiles({outputDir, metadata: finalized});
  return finalized;
};


const buildDeterministicMetadata = (plan) => {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const baseTitle = String(
    plan?.video_title ||
      plan?.title ||
      slides[0]?.display_title ||
      slides[0]?.headline ||
      '動画解説',
  ).trim();
  const topic = String(plan?.topic || '').trim();
  const securityCode = normalizeSecurityCode(plan);

  const rawTitles = [
    baseTitle,
    baseTitle + '｜背景と注目点を整理',
    baseTitle + '｜投資家が確認したいポイント',
    baseTitle + '｜材料と今後の焦点',
    baseTitle + '｜何が起きているのか',
    baseTitle + '｜株価材料を整理',
    baseTitle + '｜期待と実績を分けて確認',
    baseTitle + '｜ニュースの要点を解説',
    baseTitle + '｜今後どこを見るべきか',
    baseTitle + '｜個人投資家向けに整理',
  ];
  const titleCandidates = [...new Set(rawTitles.map((v) => v.slice(0, 100)))];
  while (titleCandidates.length < 10) {
    titleCandidates.push(
      (baseTitle + '｜解説' + (titleCandidates.length + 1)).slice(0, 100),
    );
  }

  const sourceTerms = [baseTitle, topic]
    .join(' ')
    .split(/[\s、。・｜|／/（）()「」『』【】]+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 2 && v.length <= 30);

  const genericTags = securityCode
    ? ['日本株', '株式投資', '個人投資家', '企業分析', '株価', '投資ニュース', 'マーケット', '銘柄分析']
    : ['投資', '個人投資家', '投資ニュース', 'マーケット', '市場分析', '資産運用', 'ニュース解説', '相場'];

  const tags = ensureRequiredTags({
    tags: [...sourceTerms, ...genericTags],
    plan,
  });
  while (tags.length < 10) {
    tags.push('投資解説' + (tags.length + 1));
  }

  const descriptionIntro = topic
    ? baseTitle + 'について解説します。今回の動画では、' + topic +
      'を中心に、動画内で扱っている事実関係、背景、注目点を順番に整理します。短期的な値動きだけでなく、材料と実際の業績・進捗を分けて確認できる内容です。'
    : baseTitle +
      'について、動画内で扱っている事実関係、背景、注目点を順番に整理して解説します。';

  const xBodyBase =
    '【新着動画】' + baseTitle + 'を公開しました。背景と注目点を動画で整理しています。';
  const xBody =
    xEstimatedLength(xBodyBase) <= 140
      ? xBodyBase
      : '【新着動画】' + baseTitle.slice(0, 65) + 'を解説しました。';

  return validate({
    title_candidates: titleCandidates.slice(0, 10),
    description_intro: descriptionIntro,
    tags: tags.slice(0, 30),
    x_post_body: xBody,
  });
};


export const generatePublishMetadata = async ({plan, outputDir}) => {
  const source = compactSource(plan);
  if (!source.trim()) {
    throw new Error('video plan does not contain enough content for publish metadata');
  }

  let generated;
  let model = 'deterministic-plan-derived';

  if (
    process.env.OPENAI_METADATA_ENABLED === '1' &&
    process.env.OPENAI_API_KEY
  ) {
    try {
      const client = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
      model =
        process.env.OPENAI_METADATA_MODEL ||
        process.env.OPENAI_MODEL ||
        'gpt-5.6-sol';

      const response = await client.responses.create({
        model,
        reasoning: {effort: 'low'},
        instructions: [
          'You create publication metadata for the Japanese YouTube channel 賢明なる投資家チャンネル.',
          'Base every factual claim only on the supplied video plan/narration.',
          'Do not invent prices, dates, earnings figures, company claims, or conclusions.',
          'Generate exactly 10 distinct Japanese YouTube title candidates.',
          'Titles should be useful to individual investors, clear, compelling, and not misleading clickbait.',
          'Mix styles: news-focused, investor-question, risk-focused, and analytical titles.',
          'description_intro is the video-specific opening section only. Write about 250-500 Japanese characters.',
          'It should explain what the video covers and the main investor viewpoints without spoiling every conclusion.',
          'Do not include the standard channel boilerplate in description_intro; the system appends it.',
          'tags must be 10-30 YouTube tags as plain terms without #.',
          'Always include 賢明なる投資家チャンネル as a tag.',
          'If the supplied plan has a Japanese listed-equity security_code, include that 4-digit code as a tag.',
          'x_post_body is a concise Japanese announcement for X. Do not include a URL; the system appends [動画URL].',
          'Keep x_post_body short enough that adding a URL still fits within 140 characters.',
          'Do not use investment-recommendation language such as 絶対買い or 必ず上がる.',
        ].join(' '),
        input: source,
        text: {
          format: {
            type: 'json_schema',
            name: 'youtube_publish_metadata',
            strict: true,
            schema,
          },
        },
      });
      generated = validate(JSON.parse(response.output_text));
    } catch (error) {
      console.warn(
        'OpenAI publish metadata generation unavailable; using deterministic plan-derived metadata:',
        String(error),
      );
      generated = buildDeterministicMetadata(plan);
      model = 'deterministic-plan-derived';
    }
  } else {
    generated = buildDeterministicMetadata(plan);
  }

  generated.tags = ensureRequiredTags({
    tags: generated.tags,
    plan,
  });

  const description = [
    generated.description_intro,
    '',
    CHANNEL_BOILERPLATE,
  ].join('\n');
  const xPost = generated.x_post_body + '\n[動画URL]';

  const metadata = {
    ...generated,
    description,
    x_post: xPost,
    channel_boilerplate: CHANNEL_BOILERPLATE,
    model,
  };

  await writePublishFiles({outputDir, metadata});
  return metadata;
};

export {CHANNEL_BOILERPLATE};
