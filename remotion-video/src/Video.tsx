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
} from 'remotion';
import {
  scenes as defaultScenes,
  type MouthState,
  type Scene,
} from './scenes';

export type VideoProps = {
  scenes?: Scene[];
  logoSrc?: string;
};

const CONTENT_HEIGHT = 900;
const SUBTITLE_HEIGHT = 180;
const SLIDE_WIDTH = 1440;
const SIDEBAR_WIDTH = 480;

const assetSrc = (src: string) => {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  return staticFile(src.replace(/^\//, ''));
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
        filter: 'drop-shadow(0 12px 18px rgba(0,0,0,0.14))',
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
        backgroundColor: '#ffffff',
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
          backgroundColor: '#f8fafc',
          border: '1px solid #e5e7eb',
          borderRadius: 18,
          boxShadow: '0 12px 34px rgba(15,23,42,0.10)',
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
        backgroundColor: '#ffffff',
        color: '#111827',
        fontFamily: "'Noto Sans JP', sans-serif",
      }}
    >
      {scene.audioSrc ? <Audio src={assetSrc(scene.audioSrc)} /> : null}

      <SlideArea scene={scene} />

      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: SIDEBAR_WIDTH,
          height: CONTENT_HEIGHT,
          backgroundColor: '#f8fafc',
          borderLeft: '1px solid #e5e7eb',
          boxSizing: 'border-box',
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
          backgroundColor: '#ffffff',
          borderTop: '2px solid #e5e7eb',
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
}) => {
  return (
    <AbsoluteFill>
      {scenes.map((scene, i) => (
        <Sequence key={i} from={scene.from} durationInFrames={scene.duration}>
          <SceneCard scene={scene} logoSrc={logoSrc} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
