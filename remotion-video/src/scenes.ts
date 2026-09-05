export type Scene = {
  from: number;
  duration: number;
  title: string;
  body: string;
  emotion: 'normal' | 'surprise' | 'serious';
};

export const scenes: Scene[] = [
  {
    from: 0,
    duration: 240,
    title: 'キオクシア',
    body: '株価急騰の背景を30秒で解説',
    emotion: 'normal',
  },
  {
    from: 240,
    duration: 360,
    title: '半導体株に買いが集中',
    body: '資金流入を背景に株価は大きく上昇',
    emotion: 'surprise',
  },
  {
    from: 600,
    duration: 300,
    title: 'POINT',
    body: '株価上昇 / 半導体需要 / 利確売りに注意',
    emotion: 'serious',
  },
];
