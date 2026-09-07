export type MouthState = 0 | 1 | 2;

export type SubtitleCue = {
  startFrame: number;
  endFrame: number;
  text: string;
};

export type Scene = {
  from: number;
  duration: number;
  title: string;
  body: string;
  narration?: string;
  emotion: 'normal' | 'surprise' | 'serious' | 'smile';
  audioSrc?: string;
  mouthCues?: MouthState[];
  subtitleCues?: SubtitleCue[];
  slideSrc?: string;
  slideSpriteSrc?: string;
  slideSpriteIndex?: number;
  slideSpriteColumns?: number;
  slideSpriteRows?: number;
  slideType?: string;
  section?: string;
  slideItems?: string[];
};

export const scenes: Scene[] = [
  {
    from: 0,
    duration: 225,
    title: 'キオクシア',
    body: '株価急騰の背景を30秒で解説',
    emotion: 'normal',
  },
  {
    from: 225,
    duration: 225,
    title: '半導体株に買いが集中',
    body: '資金流入を背景に株価は大きく上昇',
    emotion: 'surprise',
  },
  {
    from: 450,
    duration: 225,
    title: '注意ポイント',
    body: '短期的な上昇後は利益確定売りにも注意',
    emotion: 'serious',
  },
  {
    from: 675,
    duration: 225,
    title: 'まとめ',
    body: '材料と値動きを落ち着いて確認していきます',
    emotion: 'smile',
  },
];
