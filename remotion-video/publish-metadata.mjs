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

export const generatePublishMetadata = async ({plan, outputDir}) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const source = compactSource(plan);
  if (!source.trim()) {
    throw new Error('video plan does not contain enough content for publish metadata');
  }

  const client = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
  const model = process.env.OPENAI_METADATA_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-sol';

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
      'tags must be 10-30 YouTube tags as plain terms without #. Include the company/topic, related investor terms, and important themes actually present in the video.',
      'x_post_body is a concise Japanese announcement for X. Do not include a URL; the system appends [動画URL].',
      'Keep x_post_body short enough that adding a URL still fits within 140 characters. Aim for 100 Japanese characters or less.',
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

  const generated = validate(JSON.parse(response.output_text));
  const description = [
    generated.description_intro,
    '',
    CHANNEL_BOILERPLATE,
  ].join('\n');
  const xPost = `${generated.x_post_body}\n[動画URL]`;

  const metadata = {
    ...generated,
    description,
    x_post: xPost,
    channel_boilerplate: CHANNEL_BOILERPLATE,
    model,
  };

  if (outputDir) {
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
  }

  return metadata;
};

export {CHANNEL_BOILERPLATE};
