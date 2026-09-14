import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const BLOG_ARTICLE_BLOCK = `▼今日の動画のポイント記事（ブログ）
動画の内容を文字と図解でじっくり復習したい方はこちら
https://kenmeitoushika.com/archives/xxxx`;

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

const SECURITY_CODE_PATTERN = /^(?:\d{4}|\d{3}[A-Z])$/i;

const cleanTag = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ');

const normalizeSecurityCodeValue = (raw) => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toUpperCase();
  return SECURITY_CODE_PATTERN.test(text) ? text : null;
};

const normalizeSecurityCode = (plan) => {
  for (const raw of [
    plan?.security_code,
    plan?.stock_code,
    plan?.ticker_code,
    plan?.code,
  ]) {
    const normalized = normalizeSecurityCodeValue(raw);
    if (normalized) return normalized;
  }
  return null;
};

const normalizeSecurityName = (plan) =>
  [
    plan?.security_name,
    plan?.company_name,
    plan?.issuer_name,
    plan?.stock_name,
    plan?.company,
    plan?.brand_name,
  ]
    .map(cleanTag)
    .find(Boolean) || null;

const getSavedYoutubeTags = (plan) => {
  if (!Array.isArray(plan?.youtube_tags)) {
    throw new Error(
      'video_plan.youtube_tags is required. Generate and save YouTube tags when narration_script.txt is created.',
    );
  }

  const tags = plan.youtube_tags.map(cleanTag);

  if (tags.some((tag) => !tag)) {
    throw new Error('video_plan.youtube_tags contains an empty tag.');
  }
  if (tags.some((tag) => tag.length > 60)) {
    throw new Error('video_plan.youtube_tags contains a tag longer than 60 characters.');
  }
  if (new Set(tags).size !== tags.length) {
    throw new Error('video_plan.youtube_tags contains duplicate tags.');
  }
  if (tags.length < 10 || tags.length > 30) {
    throw new Error(
      `video_plan.youtube_tags must contain 10-30 tags; got ${tags.length}.`,
    );
  }

  const securityCode = normalizeSecurityCode(plan);
  if (securityCode && !tags.includes(securityCode)) {
    throw new Error(
      `video_plan.youtube_tags must include security code ${securityCode}.`,
    );
  }

  return tags;
};

const xEstimatedLength = (body) => {
  const placeholder = '[動画URL]';
  const text = `${String(body || '').trim()}\n${placeholder}`;
  return Array.from(text.replace(placeholder, 'x'.repeat(23))).length;
};

const normalizeDescriptionPoint = (value) =>
  String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[-・●○■□◆◇▶▷]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);

const collectSectionLabels = (plan) => {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const labels = [];
  for (const slide of slides) {
    const raw =
      slide?.type === 'section_title'
        ? slide?.section || slide?.display_title || slide?.headline
        : slide?.section;
    const label = normalizeDescriptionPoint(raw);
    if (!label || /^(?:オープニング|エンディング|まとめ)$/.test(label)) continue;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.slice(0, 6);
};

const extractDescriptionKeyPoints = (plan) => {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const candidates = [];
  const seen = new Set();

  const add = (raw, index, weight = 0) => {
    const point = normalizeDescriptionPoint(raw);
    if (point.length < 6 || point.length > 110 || seen.has(point)) return;
    if (/^(?:オープニング|エンディング|まとめ)$/.test(point)) return;
    seen.add(point);

    let score = weight;
    if (/[0-9０-９]|[%％]|円|ドル|株|倍|兆|億|万/.test(point)) score += 5;
    if (/株価|希薄化|PTS|業績|資金調達|自社株|増資|利益|売上|配当|需給|材料|リスク|決算|防衛|ドローン/i.test(point)) score += 3;
    if (point.length >= 10 && point.length <= 80) score += 1;
    candidates.push({point, index, score});
  };

  slides.forEach((slide, index) => {
    const slideText = Array.isArray(slide?.slide_text)
      ? slide.slide_text
      : slide?.slide_text
        ? [slide.slide_text]
        : [];
    for (const value of slideText) add(value, index, 2);
    if (slide?.type !== 'section_title') {
      add(slide?.display_title || slide?.headline, index, 1);
    }
  });

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const points = candidates.map((item) => item.point).slice(0, 5);

  const fallback = [
    '発表内容と、その背景にある論点を整理',
    '株価材料と残るリスクを分けて確認',
    '今後確認したい条件や追加材料を整理',
  ];
  for (const point of fallback) {
    if (points.length >= 3) break;
    if (!points.includes(point)) points.push(point);
  }
  return points.slice(0, 5);
};

const buildDescriptionHashtags = ({tags, plan}) => {
  const securityCode = normalizeSecurityCode(plan);
  const securityName = normalizeSecurityName(plan);
  const candidates = [
    securityName,
    securityCode,
    ...(Array.isArray(tags) ? tags : []),
    securityCode ? '日本株' : '投資',
    '株式投資',
  ];

  const result = [];
  for (const raw of candidates) {
    const normalized = cleanTag(raw)
      .replace(/\s+/g, '')
      .replace(/[^0-9A-Za-z\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/gu, '');
    if (!normalized || normalized.length > 40) continue;
    if (normalized === '賢明なる投資家チャンネル') continue;
    const hashtag = `#${normalized}`;
    if (!result.includes(hashtag)) result.push(hashtag);
    if (result.length >= 5) break;
  }
  return result;
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
    {index: 0, seconds: 0, title: 'オープニング', kind: 'opening'},
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
    if (chapters.some((chapter) => chapter.title === candidate.title)) continue;
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

const buildBaseMetadata = (plan) => {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  const baseTitle = String(
    plan?.video_title ||
      plan?.title ||
      slides[0]?.display_title ||
      slides[0]?.headline ||
      '動画解説',
  ).trim();

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

  const titleCandidates = [...new Set(rawTitles.map((value) => value.slice(0, 100)))];
  while (titleCandidates.length < 10) {
    titleCandidates.push(
      (baseTitle + '｜解説' + (titleCandidates.length + 1)).slice(0, 100),
    );
  }

  const securityCode = normalizeSecurityCode(plan);
  const sectionLabels = collectSectionLabels(plan);
  const descriptionKeyPoints = extractDescriptionKeyPoints(plan);
  const subject = securityCode
    ? `${baseTitle}（証券コード：${securityCode}）`
    : baseTitle;
  const sectionSummary = sectionLabels.length
    ? `具体的には、${sectionLabels.slice(0, 5).join('、')}を軸に見ていきます。`
    : '';

  const descriptionIntro = [
    `${subject}について解説します。`,
    '今回の動画では、何が起きたのか、その背景と投資家が確認しておきたい論点を、動画内の事実関係に沿って順番に整理します。',
    sectionSummary,
    '短期的な値動きだけを見るのではなく、発表内容や具体的な数字、株価に影響しうる材料、まだ残っているリスクを分けて確認し、今後どこを見ればよいのかまで整理する内容です。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const descriptionClosing =
    '今回の材料を一つだけで判断するのではなく、数字の変化、需給、事業や資本政策の進捗を分けて見ることが重要です。今後のIRや市場の反応を確認するときの整理材料としてご活用ください。';

  const xBodyBase =
    '【新着動画】' + baseTitle + 'を公開しました。背景と注目点を動画で整理しています。';
  const xPostBody =
    xEstimatedLength(xBodyBase) <= 140
      ? xBodyBase
      : '【新着動画】' + baseTitle.slice(0, 65) + 'を解説しました。';

  return {
    title_candidates: titleCandidates.slice(0, 10),
    description_intro: descriptionIntro,
    description_key_points: descriptionKeyPoints,
    description_closing: descriptionClosing,
    tags: getSavedYoutubeTags(plan),
    x_post_body: xPostBody,
    x_estimated_length_with_url: xEstimatedLength(xPostBody),
    model: 'saved-video-plan-tags',
  };
};

const finalizeDescription = ({metadata, plan, chapters = []}) => {
  const chapterText = chapters
    .map((chapter) => `${chapter.timestamp} ${chapter.title}`)
    .join('\n');
  const keyPointText = (metadata.description_key_points || [])
    .map((point) => `・${point}`)
    .join('\n');
  const descriptionHashtags = buildDescriptionHashtags({
    tags: metadata.tags,
    plan,
  }).join(' ');

  const parts = [BLOG_ARTICLE_BLOCK, '', metadata.description_intro];
  if (keyPointText) parts.push('', '【今回のポイント】', keyPointText);
  if (chapters.length >= 3) parts.push('', '【目次】', chapterText);
  if (metadata.description_closing) parts.push('', metadata.description_closing);
  if (descriptionHashtags) parts.push('', descriptionHashtags);
  parts.push('', CHANNEL_BOILERPLATE);
  return parts.join('\n');
};

export const generatePublishMetadata = async ({plan, outputDir}) => {
  const metadata = buildBaseMetadata(plan);
  const finalized = {
    ...metadata,
    chapters: [],
    chapters_enabled: false,
    description: finalizeDescription({metadata, plan, chapters: []}),
    x_post: metadata.x_post_body + '\n[動画URL]',
    channel_boilerplate: CHANNEL_BOILERPLATE,
  };
  await writePublishFiles({outputDir, metadata: finalized});
  return finalized;
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

  const savedTags = getSavedYoutubeTags(plan);
  const finalized = {
    ...metadata,
    tags: savedTags,
    chapters,
    chapters_enabled: chapters.length >= 3,
    description: finalizeDescription({
      metadata: {...metadata, tags: savedTags},
      plan,
      chapters,
    }),
    model: 'saved-video-plan-tags',
  };

  await writePublishFiles({outputDir, metadata: finalized});
  return finalized;
};

export {BLOG_ARTICLE_BLOCK, CHANNEL_BOILERPLATE};
