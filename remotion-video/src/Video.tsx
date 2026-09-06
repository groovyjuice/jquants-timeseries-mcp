import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-jp/800.css';
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  scenes as defaultScenes,
  type MouthState,
  type Scene,
} from './scenes';

export type VideoProps = {
  scenes?: Scene[];
  logoSrc?: string;
  bgmAsset?: string;
  bgmLoop?: boolean;
  bgmVolume?: number;
  bgmFadeInFrames?: number;
  bgmFadeOutFrames?: number;
};

const CONTENT_HEIGHT = 900;
const SUBTITLE_HEIGHT = 180;
const SLIDE_WIDTH = 1440;
const SIDEBAR_WIDTH = 480;

const assetSrc = (src: string) => {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  return staticFile(src.replace(/^\//, ''));
};

const BackgroundMusic: React.FC<{
  src: string;
  loop: boolean;
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
}> = ({src, loop, volume, fadeInFrames, fadeOutFrames}) => {
  const {durationInFrames} = useVideoConfig();

  return (
    <Audio
      src={assetSrc(src)}
      loop={loop}
      volume={(frame) => {
        const fadeIn =
          fadeInFrames <= 0
            ? 1
            : Math.min(1, Math.max(0, frame / fadeInFrames));
        const framesRemaining = Math.max(0, durationInFrames - 1 - frame);
        const fadeOut =
          fadeOutFrames <= 0
            ? 1
            : Math.min(1, framesRemaining / fadeOutFrames);

        return volume * Math.min(fadeIn, fadeOut);
      }}
    />
  );
};

const avatarAssets = {
  normalBase: staticFile('character/normal_base.png'),
  seriousBase: staticFile('character/serious_base.png'),
  surpriseBase: staticFile('character/surprise_base.png'),
  eyesOpen: staticFile('character/eyes_open.png'),
  eyesBlink: staticFile('character/eyes_blink.png'),
  eyesSurprise: staticFile('character/eyes_surprise.png'),
  mouthClosed: staticFile('character/mouth_closed.png'),
  mouthHalf: staticFile('character/mouth_half.png'),
  mouthOpen: staticFile('character/mouth_open.png'),
};

const AvatarLayer: React.FC<{src: string}> = ({src}) => (
  <Img
    src={src}
    style={{
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      objectFit: 'contain',
    }}
  />
);

const Avatar: React.FC<{
  emotion: Scene['emotion'];
  mouthCues?: MouthState[];
}> = ({emotion, mouthCues}) => {
  const frame = useCurrentFrame();
  const bob = Math.sin(frame / 11) * 3;

  const isSmile = emotion === 'smile';
  const blinkPhase = frame % 120;
  const isBlinking = !isSmile && blinkPhase >= 114 && blinkPhase <= 118;

  const mouthPhase = frame % 12;
  const fallbackMouthState: MouthState =
    mouthPhase < 3 ? 0 : mouthPhase < 6 ? 1 : mouthPhase < 9 ? 2 : 1;

  const mouthState: MouthState = mouthCues
    ? (mouthCues[frame] ?? 0)
    : fallbackMouthState;

  const mouthSrc =
    mouthState === 0
      ? avatarAssets.mouthClosed
      : mouthState === 1
        ? avatarAssets.mouthHalf
        : avatarAssets.mouthOpen;

  const baseSrc =
    emotion === 'serious'
      ? avatarAssets.seriousBase
      : emotion === 'surprise'
        ? avatarAssets.surpriseBase
        : avatarAssets.normalBase;

  const eyesSrc =
    isSmile
      ? avatarAssets.eyesBlink
      : isBlinking
        ? avatarAssets.eyesBlink
        : emotion === 'surprise'
          ? avatarAssets.eyesSurprise
          : avatarAssets.eyesOpen;

  return (
    <div
      style={{
        position: 'absolute',
        left: 10,
        bottom: 18,
        width: 460,
        height: 460,
        transform: `translateY(${bob}px)`,
        filter: 'drop-shadow(0 14px 20px rgba(52, 94, 138, 0.16))',
      }}
    >
      <AvatarLayer src={baseSrc} />
      <AvatarLayer src={eyesSrc} />
      <AvatarLayer src={mouthSrc} />
    </div>
  );
};

const ChannelBrand: React.FC<{logoSrc?: string}> = ({logoSrc}) => (
  <div
    style={{
      position: 'absolute',
      top: 60,
      left: 30,
      right: 30,
      height: 260,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
    }}
  >
    {logoSrc ? (
      <Img
        src={assetSrc(logoSrc)}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
        }}
      />
    ) : (
      <div
        style={{
          fontSize: 46,
          lineHeight: 1.35,
          fontWeight: 800,
          color: '#172033',
          letterSpacing: 1.5,
        }}
      >
        賢明なる
        <br />
        投資家チャンネル
      </div>
    )}
  </div>
);

const BackgroundDecor: React.FC = () => (
  <>
    <div
      style={{
        position: 'absolute',
        left: -120,
        top: -100,
        width: 480,
        height: 480,
        borderRadius: '50%',
        background:
          'radial-gradient(circle, rgba(186,214,244,0.50) 0%, rgba(186,214,244,0.16) 45%, rgba(186,214,244,0) 72%)',
        filter: 'blur(6px)',
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: 180,
        top: 120,
        width: 300,
        height: 300,
        borderRadius: '50%',
        background:
          'radial-gradient(circle, rgba(209,227,247,0.42) 0%, rgba(209,227,247,0.14) 48%, rgba(209,227,247,0) 76%)',
        filter: 'blur(4px)',
      }}
    />
    <div
      style={{
        position: 'absolute',
        left: 420,
        bottom: 110,
        width: 420,
        height: 420,
        borderRadius: '50%',
        background:
          'radial-gradient(circle, rgba(224,235,248,0.40) 0%, rgba(224,235,248,0.12) 46%, rgba(224,235,248,0) 76%)',
        filter: 'blur(8px)',
      }}
    />
  </>
);

const SlideArea: React.FC<{scene: Scene}> = ({scene}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: SLIDE_WIDTH,
        height: CONTENT_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 40px 50px 40px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          maxHeight: 810,
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: '#ffffff',
          border: '1px solid rgba(214, 224, 235, 0.95)',
          borderRadius: 22,
          boxShadow: '0 14px 34px rgba(39, 73, 111, 0.10)',
          opacity,
        }}
      >
        {scene.slideSrc ? (
          <Img
            src={assetSrc(scene.slideSrc)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              backgroundColor: '#ffffff',
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: 90,
              boxSizing: 'border-box',
              color: '#111827',
              backgroundColor: '#ffffff',
            }}
          >
            <div
              style={{
                fontSize: 88,
                fontWeight: 800,
                lineHeight: 1.15,
              }}
            >
              {scene.title}
            </div>
            <div
              style={{
                fontSize: 48,
                lineHeight: 1.5,
                marginTop: 42,
                color: '#374151',
              }}
            >
              {scene.body}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SceneCard: React.FC<{scene: Scene; logoSrc?: string}> = ({
  scene,
  logoSrc,
}) => {
  return (
    <AbsoluteFill
      style={{
        background:
          'linear-gradient(135deg, #f8fbff 0%, #f3f8fe 42%, #edf4fc 100%)',
        color: '#111827',
        fontFamily: "'Noto Sans JP', sans-serif",
        overflow: 'hidden',
      }}
    >
      <BackgroundDecor />

      {scene.audioSrc ? <Audio src={assetSrc(scene.audioSrc)} /> : null}

      <SlideArea scene={scene} />

      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: SIDEBAR_WIDTH,
          height: CONTENT_HEIGHT,
          background:
            'linear-gradient(180deg, rgba(245,249,254,0.92) 0%, rgba(236,244,252,0.96) 100%)',
          borderLeft: '1px solid rgba(214, 224, 235, 0.95)',
          boxSizing: 'border-box',
          backdropFilter: 'blur(3px)',
        }}
      >
        <ChannelBrand logoSrc={logoSrc} />
        <Avatar emotion={scene.emotion} mouthCues={scene.mouthCues} />
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: SUBTITLE_HEIGHT,
          padding: '22px 72px',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 54,
          fontWeight: 700,
          lineHeight: 1.35,
          color: '#111827',
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(248,251,255,0.98) 100%)',
          borderTop: '2px solid rgba(214, 224, 235, 0.95)',
          textAlign: 'center',
          zIndex: 20,
        }}
      >
        {scene.narration ?? scene.body}
      </div>
    </AbsoluteFill>
  );
};

export const TestVideo: React.FC<VideoProps> = ({
  scenes = defaultScenes,
  logoSrc,
  bgmAsset = 'common/bgm/main_bgm.mp3',
  bgmLoop = true,
  bgmVolume = 0.02,
  bgmFadeInFrames = 30,
  bgmFadeOutFrames = 45,
}) => {
  return (
    <AbsoluteFill>
      <BackgroundMusic
        src={bgmAsset}
        loop={bgmLoop}
        volume={bgmVolume}
        fadeInFrames={bgmFadeInFrames}
        fadeOutFrames={bgmFadeOutFrames}
      />

      {scenes.map((scene, i) => (
        <Sequence key={i} from={scene.from} durationInFrames={scene.duration}>
          <SceneCard scene={scene} logoSrc={logoSrc} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
